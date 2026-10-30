import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  anchorLambdas,
  fitSupremacy,
  fitWinProbabilities,
  impliedTotalFromOver,
} from '../../src/lib/engine/anchor.ts';
import { buildLambdas } from '../../src/lib/engine/lambdas.ts';
import { resultOutcomes } from '../../src/lib/engine/markets.ts';
import { extractTotalsMarket, extractWinMarket, modelAgreement } from '../../src/lib/engine/odds.ts';
import { buildScoreMatrix } from '../../src/lib/engine/poisson.ts';
import { assessQuality } from '../../src/lib/engine/quality.ts';
import { winMeanAbsoluteError } from '../../src/lib/audit/metrics.ts';
import type { AggregatedResponse } from '../../src/lib/types/api.ts';

function loadFixture(name: string): AggregatedResponse {
  const path = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as AggregatedResponse;
}

test('el total implícito invierte la Poisson de la línea de mercado', () => {
  const total = impliedTotalFromOver(2.5, 0.5888);
  assert.ok(total !== null);
  assert.ok(Math.abs(total - 3.05) < 0.1, `total implícito ${total}`);
  const lower = impliedTotalFromOver(2.5, 0.5);
  const higher = impliedTotalFromOver(2.5, 0.65);
  assert.ok(lower !== null && higher !== null && lower < higher);
  assert.equal(impliedTotalFromOver(2.5, 1), null);
  assert.equal(impliedTotalFromOver(2.5, 0), null);
});

test('fitSupremacy reproduce la probabilidad de victoria local con el total fijo', () => {
  const split = fitSupremacy(3.05, 0.4834);
  assert.ok(Math.abs(split.home + split.away - 3.05) < 1e-6);
  const matrix = buildScoreMatrix(split.home, split.away);
  assert.ok(Math.abs(resultOutcomes(matrix).home - 0.4834) < 0.01);
});

test('fitWinProbabilities aproxima el 1X2 cuando solo hay moneyline', () => {
  const source = resultOutcomes(buildScoreMatrix(1.4, 1.7));
  const target = { ...source, source: 'odds' as const };
  const fit = fitWinProbabilities(target, { home: 1, away: 1 });
  assert.ok(fit.error < 1e-4, `error ${fit.error}`);
  const fitted = resultOutcomes(buildScoreMatrix(fit.home, fit.away));
  assert.ok(Math.abs(fitted.home - target.home) < 0.01);
  assert.ok(Math.abs(fitted.draw - target.draw) < 0.01);
  assert.ok(Math.abs(fitted.away - target.away) < 0.01);
});

test('el ancla acerca λ y el 1X2 al mercado en el derbi', () => {
  const response = loadFixture('derby.json');
  const lambdas = buildLambdas(response);
  const quality = assessQuality(response);
  const winMarket = extractWinMarket(response.pre_match);
  assert.equal(winMarket?.source, 'odds');
  const totals = extractTotalsMarket(response.pre_match);

  const motorMatrix = buildScoreMatrix(lambdas.lambdaHome, lambdas.lambdaAway);
  const motorWin = resultOutcomes(motorMatrix);
  const agreement = modelAgreement(motorWin, winMarket);

  const anchored = anchorLambdas({
    lambdaHome: lambdas.lambdaHome,
    lambdaAway: lambdas.lambdaAway,
    winMarket,
    totalsMarket: totals,
    quality: quality.score,
    agreement,
  });

  assert.equal(anchored.applied, true);
  assert.equal(anchored.source, 'moneyline+totals');
  assert.ok(anchored.weight >= 0.5 && anchored.weight <= 0.85);
  assert.ok(anchored.marketTotal !== null);

  const implied = impliedTotalFromOver(totals.line as number, totals.over as number);
  assert.ok(implied !== null);
  const motorTotal = lambdas.lambdaHome + lambdas.lambdaAway;
  const anchoredTotal = anchored.lambdaHome + anchored.lambdaAway;
  assert.ok(Math.abs(anchoredTotal - implied) < Math.abs(motorTotal - implied));

  const anchoredWin = resultOutcomes(buildScoreMatrix(anchored.lambdaHome, anchored.lambdaAway));
  const motorError = winMeanAbsoluteError(motorWin, winMarket as { home: number; draw: number; away: number });
  const anchoredError = winMeanAbsoluteError(anchoredWin, winMarket as { home: number; draw: number; away: number });
  assert.ok(anchoredError < motorError, `anclado ${anchoredError} vs motor ${motorError}`);
});

test('sin cuotas el ancla no se aplica', () => {
  const response = loadFixture('derby.json');
  const lambdas = buildLambdas(response);
  const anchored = anchorLambdas({
    lambdaHome: lambdas.lambdaHome,
    lambdaAway: lambdas.lambdaAway,
    winMarket: null,
    totalsMarket: { line: null, over: null, under: null },
    quality: 0.8,
    agreement: 0.5,
  });
  assert.equal(anchored.applied, false);
  assert.equal(anchored.source, 'none');
  assert.equal(anchored.lambdaHome, lambdas.lambdaHome);
  assert.equal(anchored.lambdaAway, lambdas.lambdaAway);
});
