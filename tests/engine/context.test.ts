import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAdjustments, lineupAverageRating, pointsPerMatch } from '../../src/lib/engine/adjustments.ts';
import { analyzeMatch } from '../../src/lib/engine/analyze.ts';
import { anchorLambdas, impliedTotalFromOver } from '../../src/lib/engine/anchor.ts';
import { buildContext } from '../../src/lib/engine/context.ts';
import { buildLiveMeta, estimateElapsedMinutes } from '../../src/lib/engine/live.ts';
import {
  buildMarketSignal,
  extraCornersMarket,
  extraMarketProbability,
  extractExtraMarkets,
  movementWeightScale,
  pickBalancedLine,
} from '../../src/lib/engine/odds.ts';
import { buildScoreMatrix, resultProbability, shiftMatrix } from '../../src/lib/engine/poisson.ts';
import { assessQuality, statDetail } from '../../src/lib/engine/quality.ts';
import { buildUncertainty } from '../../src/lib/engine/uncertainty.ts';
import type { AggregatedResponse } from '../../src/lib/types/api.ts';

function loadFixture(name: string): AggregatedResponse {
  const path = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as AggregatedResponse;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('statDetail pondera observed, projected y missing', () => {
  const team = (stat: { value: number | null; unit: string; status: 'observed' | 'projected' | 'missing'; source: string | null; derived?: boolean }) =>
    ({ name: 'Equipo', side: 'home' as const, stats: { xg: stat } });
  const observed = team({ value: 1.8, unit: 'goals', status: 'observed', source: 'espn' });
  const projected = team({ value: 1.4, unit: 'goals', status: 'projected', source: null });
  const derived = team({ value: 1.2, unit: 'goals', status: 'observed', source: null, derived: true });
  const missing = team({ value: null, unit: 'goals', status: 'missing', source: null });

  assert.equal(statDetail(observed, 'xg').confidence, 1);
  assert.equal(statDetail(projected, 'xg').confidence, 0.65);
  assert.ok(Math.abs(statDetail(derived, 'xg').confidence - 0.85) < 1e-9);
  assert.equal(statDetail(missing, 'xg').confidence, 0);
  assert.equal(statDetail(observed, 'xga').status, 'missing');
});

test('la calidad separa cobertura de presencia y de observación', () => {
  const quality = assessQuality(loadFixture('derby.json'));
  assert.ok(quality.confidenceCoverage > 0);
  assert.ok(quality.confidenceCoverage <= quality.coverage + 1e-9);
  assert.ok(quality.observedShare >= 0);
  assert.ok(quality.observedShare <= 1);
});

test('los ajustes contextuales acotan descanso, rival y alineación', () => {
  const response = loadFixture('derby.json');
  const bundle = buildAdjustments(response, 2.7);
  assert.ok(bundle.home.attack >= 0.85 && bundle.home.attack <= 1.15);
  assert.ok(bundle.away.defense >= 0.85 && bundle.away.defense <= 1.15);
  assert.ok(bundle.total >= 0.9 && bundle.total <= 1.1);
  assert.ok(bundle.sigmaBoost >= 0 && bundle.sigmaBoost <= 0.08);

  // El derbi trae descanso de 3 días y alineaciones proyectadas.
  const keys = bundle.adjustments.map((item) => item.key);
  assert.ok(keys.includes('rest'));
  assert.ok(keys.includes('lineup'));
  assert.ok(bundle.sigmaBoost > 0);
  assert.equal(pointsPerMatch(response.pre_match?.teams.home), 2);
  assert.equal(lineupAverageRating(response.pre_match?.teams.home), null);
});

test('sin cuotas el ancla usa la predicción como referencia de menor peso', () => {
  const response = clone(loadFixture('derby.json'));
  assert.ok(response.pre_match);
  response.pre_match.odds = null;

  const line = pickBalancedLine(response.pre_match.prediction?.over_under);
  assert.ok(line && line.probability !== null);
  const predictionTotal = impliedTotalFromOver(line.line, line.probability as number);
  assert.ok(predictionTotal !== null);

  const anchored = anchorLambdas({
    lambdaHome: 1.2,
    lambdaAway: 1.5,
    winMarket: null,
    totalsMarket: { line: null, over: null, under: null },
    predictionTotal,
    predictionWin: { home: 0.42, draw: 0.28, away: 0.3, source: 'prediction' },
    quality: 0.6,
    agreement: 0.5,
  });

  assert.equal(anchored.applied, true);
  assert.equal(anchored.totalSource, 'prediction');
  assert.equal(anchored.source, 'moneyline+prediction');
  assert.ok(anchored.weight >= 0.36 && anchored.weight <= 0.62);
  assert.ok(anchored.marketTotal !== null && anchored.marketTotal > 2);
});

test('el movimiento de línea y los proveedores escalan el peso del ancla', () => {
  assert.equal(movementWeightScale(null), 1);
  const signal = {
    openTotalLine: 2.5,
    currentTotalLine: 3,
    totalLineDrift: 0.5,
    openMoneylineNoVig: null,
    currentMoneylineNoVig: null,
    moneylineDrift: null,
    movement: null,
    providerCount: 4,
  };
  assert.ok(movementWeightScale(signal) > 1);
});

test('los mercados extra se normalizan y se buscan por alias', () => {
  const markets = extractExtraMarkets({
    odds: {
      extra_markets: [
        { market: 'btts', line: null, outcomes: [{ label: 'Yes', decimal: 1.9, implied_probability: 0.55, bookmaker_count: 2 }, { label: 'No', decimal: 2.1, implied_probability: 0.5, bookmaker_count: 2 }] },
        { market: 'corners', line: 9.5, outcomes: [{ label: 'Over 9.5', decimal: 1.95, implied_probability: 0.52, bookmaker_count: 2 }, { label: 'Under 9.5', decimal: 1.95, implied_probability: 0.52, bookmaker_count: 2 }] },
      ],
    },
  } as never);
  assert.equal(markets.length, 2);
  const yes = extraMarketProbability(markets, ['btts'], ['yes']);
  assert.ok(yes !== null && Math.abs(yes - 0.5238) < 0.001);
  const corners = extraCornersMarket({
    odds: {
      extra_markets: [
        { market: 'corners', line: 9.5, outcomes: [{ label: 'Over 9.5', decimal: 1.95, implied_probability: 0.52, bookmaker_count: 2 }, { label: 'Under 9.5', decimal: 1.95, implied_probability: 0.52, bookmaker_count: 2 }] },
      ],
    },
  } as never);
  assert.equal(corners.line, 9.5);
  assert.ok(corners.over !== null && corners.under !== null);
});

test('la señal de movimiento compara apertura y estado actual del derbi', () => {
  const signal = buildMarketSignal(loadFixture('derby.json').pre_match);
  assert.ok(signal);
  assert.equal(signal.openTotalLine, 2.5);
  assert.equal(signal.currentTotalLine, 2.5);
  assert.equal(signal.totalLineDrift, 0);
  assert.ok(signal.openMoneylineNoVig !== null);
  assert.ok(signal.currentMoneylineNoVig !== null);
});

test('shiftMatrix traslada la matriz al marcador actual', () => {
  const matrix = buildScoreMatrix(0.8, 0.6);
  const shifted = shiftMatrix(matrix, 1, 0);
  const before = resultProbability(matrix, 'home');
  const after = resultProbability(shifted, 'home');
  assert.ok(after > before + 0.2);
  assert.equal(shifted.maxGoals, matrix.maxGoals + 1);
});

test('el contexto expone alineaciones, descanso, posiciones, apertura y lugar', () => {
  const context = buildContext(loadFixture('derby.json'));
  assert.ok(context.lineups?.home);
  assert.equal(context.lineups?.home?.status, 'predicted');
  assert.ok((context.lineups?.home?.unavailable ?? 0) >= 0);
  assert.equal(context.rest?.home, 3);
  assert.ok(context.standings?.home && context.standings.home.ppg !== null);
  assert.ok(context.odds?.openTotalLine !== null);
  assert.ok(context.odds?.openMoneylineNoVig !== null);
  assert.ok(context.prediction?.overUnder.length ?? 0);
});

test('el contexto en vivo calcula el tiempo y λ restante', () => {
  const response = clone(loadFixture('derby.json'));
  response.match.status = 'live';
  response.match.score = { home: 1, away: 0 };
  response.match.date = new Date(Date.now() - 60 * 60000).toISOString();

  const elapsed = estimateElapsedMinutes(response.match.date);
  assert.ok(elapsed !== null && elapsed > 59 && elapsed < 61);

  const live = buildLiveMeta(response, 1.4, 1.2);
  assert.ok(live);
  assert.equal(live.currentScore.home, 1);
  assert.ok(live.remainingShare > 0.3 && live.remainingShare < 0.5);
  assert.ok(live.remainingLambdaHome < 1.4);
});

test('el análisis en vivo omite mercados pre-partido y la combinada', () => {
  const response = clone(loadFixture('derby.json'));
  response.match.status = 'live';
  response.match.score = { home: 1, away: 1 };
  response.match.date = new Date(Date.now() - 55 * 60000).toISOString();

  const analysis = analyzeMatch(response);
  assert.equal(analysis.match.status, 'live');
  assert.ok(analysis.model.live);
  assert.equal(analysis.parlay, null);
  const keys = analysis.markets.map((market) => market.key);
  assert.ok(!keys.includes('ht_ft'));
  assert.ok(!keys.includes('first_goal'));
  assert.ok(!keys.includes('corners'));
  assert.ok(analysis.dataQuality.caveats.some((caveat) => caveat.includes('en vivo')));
  assert.equal(analysis.model.marketAnchor.applied, false);
  assert.equal(analysis.model.marketSignal.openTotalLine, null);
  // Las cuotas previas al partido no condicionan al marcador actual: sin valor.
  for (const market of analysis.markets) {
    assert.equal(market.comparisonSource ?? null, null);
    assert.equal(market.marketProbability ?? null, null);
    assert.equal(market.edge ?? null, null);
  }
});

test('la incertidumbre es determinista e incluye λ y el 1X2', () => {
  const first = buildUncertainty({ lambdaHome: 1.5, lambdaAway: 1.1, quality: 0.7, sigmaBoost: 0.02, totalLine: 2.5 });
  const second = buildUncertainty({ lambdaHome: 1.5, lambdaAway: 1.1, quality: 0.7, sigmaBoost: 0.02, totalLine: 2.5 });

  assert.deepEqual(first, second);
  assert.ok(first.lambdas.home.low < 1.5 && first.lambdas.home.high > 1.5);
  assert.ok(first.lambdas.total.low < 2.6 && first.lambdas.total.high > 2.6);
  assert.ok(first.win.home.low < first.win.home.high);
  assert.ok(first.total && first.total.low < first.total.high);
  assert.ok(first.sigma > 0.08);
});

test('el análisis programado publica ajustes, señal e intervalos', () => {
  const analysis = analyzeMatch(loadFixture('derby.json'));
  assert.ok(Array.isArray(analysis.model.adjustments));
  assert.ok(analysis.model.marketSignal.openTotalLine !== null);
  assert.ok(analysis.model.uncertainty);
  assert.equal(analysis.model.uncertainty?.samples, 240);

  const result = analysis.markets.find((market) => market.key === 'result');
  assert.ok(result?.interval && result.interval.low < result.interval.high);
  const totals = analysis.markets.find((market) => market.key === 'totals');
  assert.equal(totals?.comparisonSource, 'odds');
});
