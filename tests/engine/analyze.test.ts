import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AnalysisError, analyzeMatch } from '../../src/lib/engine/analyze.ts';
import { buildScoreMatrix } from '../../src/lib/engine/poisson.ts';
import type { AggregatedResponse } from '../../src/lib/types/api.ts';

function loadFixture(name: string): AggregatedResponse {
  const path = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as AggregatedResponse;
}

function assertFiniteMarkets(response: ReturnType<typeof analyzeMatch>): void {
  for (const market of response.markets) {
    assert.ok(Number.isFinite(market.probability), `${market.key}: probabilidad no finita`);
    assert.ok(market.probability >= 0 && market.probability <= 1, `${market.key}: fuera de rango`);
    assert.ok(Number.isFinite(market.fairOdds));
    assert.ok(market.confidence >= 0 && market.confidence <= 100);
    assert.ok(['Bajo', 'Medio', 'Alto'].includes(market.risk));
    for (const point of market.curve) {
      assert.ok(Number.isFinite(point.probability));
      assert.ok(Number.isFinite(point.line));
    }
    for (const option of market.alternatives) {
      assert.ok(Number.isFinite(option.probability));
    }
  }
  assert.ok(!JSON.stringify(response).includes('NaN'));
}

test('el motor analiza el derbi real y publica los 10 mercados', () => {
  const analysis = analyzeMatch(loadFixture('derby.json'));
  assert.equal(analysis.markets.length, 10);
  assert.deepEqual(
    analysis.markets.map((market) => market.key),
    ['result', 'double_chance', 'totals', 'handicap', 'first_goal', 'odd_even', 'ht_ft', 'exact_score', 'btts', 'corners'],
  );
  assert.equal(analysis.markets.map((market) => market.index).join(','), '1,2,3,4,5,6,7,8,9,10');
  assertFiniteMarkets(analysis);

  const total = analysis.winProbabilities.home + analysis.winProbabilities.draw + analysis.winProbabilities.away;
  assert.ok(Math.abs(total - 1) < 1e-3);

  const totals = analysis.markets.find((market) => market.key === 'totals');
  assert.ok(totals);
  assert.equal(totals.calibrated, true);
  assert.equal(totals.curve.length, 7);
  assert.equal(totals.curve.filter((point) => point.selected).length, 1);
  assert.ok(totals.probability >= analysis.model.threshold - 1e-9);
  assert.ok(Math.abs((totals.line ?? 0) * 2 - Math.round((totals.line ?? 0) * 2)) < 1e-9);
  assert.equal(totals.marketLine, 2.5);
  assert.equal(totals.baseLine, 3.5);
  assert.ok(totals.explanation.includes('umbral'));

  const exact = analysis.markets.find((market) => market.key === 'exact_score');
  assert.equal(exact?.calibrated, false);
  assert.equal(exact?.curve.length, 0);
  assert.ok(exact?.scores && exact.scores.length === 6);
  for (let index = 1; index < (exact.scores?.length ?? 0); index += 1) {
    assert.ok((exact.scores?.[index - 1].probability ?? 0) >= (exact.scores?.[index].probability ?? 0));
  }

  const htft = analysis.markets.find((market) => market.key === 'ht_ft');
  assert.ok(htft?.combos && htft.combos.length === 6);
  assert.ok((htft.combos?.[0].probability ?? 0) >= (htft.combos?.[1].probability ?? 0));

  const firstGoal = analysis.markets.find((market) => market.key === 'first_goal');
  const noneOption = firstGoal?.alternatives.find((option) => option.code === 'none');
  const matrix = buildScoreMatrix(analysis.lambdas.home, analysis.lambdas.away, { rho: -0.1, maxGoals: 12 });
  assert.ok(noneOption);
  assert.ok(Math.abs(noneOption.probability - matrix.cells[0][0]) < 1e-4);

  const corners = analysis.markets.find((market) => market.key === 'corners');
  assert.ok(corners);
  assert.ok(Math.abs((corners.line ?? 0) * 2 - Math.round((corners.line ?? 0) * 2)) < 1e-9);

  assert.ok(analysis.parlay);
  assert.ok(analysis.parlay.legs.length >= 2 && analysis.parlay.legs.length <= 3);
  assert.ok(analysis.parlay.probability >= 0.45);
  const minLeg = Math.min(...analysis.parlay.legs.map((leg) => leg.probability));
  assert.ok(analysis.parlay.probability <= minLeg + 1e-9);
  assert.ok(analysis.dataQuality.label === 'Alta');
  assert.ok(analysis.dataQuality.caveats.length > 0);
});

test('un partido finalizado se bloquea en vez de inventar una proyección', () => {
  assert.throws(
    () => analyzeMatch(loadFixture('parma-finished.json')),
    (error: unknown) =>
      error instanceof AnalysisError &&
      error.code === 'MATCH_NOT_PROJECTABLE' &&
      typeof error.details === 'object' &&
      (error.details as { score?: { home?: number } }).score?.home === 0,
  );
});

test('un partido finalizado con más goles también se bloquea', () => {
  assert.throws(
    () => analyzeMatch(loadFixture('mci-finished.json')),
    (error: unknown) =>
      error instanceof AnalysisError &&
      error.code === 'MATCH_NOT_PROJECTABLE' &&
      (error.details as { score?: { home?: number; away?: number } }).score?.home === 2 &&
      (error.details as { score?: { home?: number; away?: number } }).score?.away === 2,
  );
});

test('una respuesta sin estadísticas no lanza y activa la advertencia de datos', () => {
  const sparse: AggregatedResponse = {
    match: {
      match_id: 'test:1',
      league: { id: 'test.1', name: 'Liga de prueba' },
      date: '2026-11-01T18:00:00.000Z',
      status: 'scheduled',
      score: { home: null, away: null },
    },
    teams: {
      home: { name: 'Equipo A', side: 'home', sample: null, stats: {} },
      away: { name: 'Equipo B', side: 'away', sample: null, stats: {} },
    },
    meta: {},
  };
  const analysis = analyzeMatch(sparse);
  assert.equal(analysis.dataQuality.insufficient, true);
  assert.ok(analysis.dataQuality.caveats.some((caveat) => caveat.includes('media de liga')));
  assert.ok(analysis.lambdas.home >= 0.15 && analysis.lambdas.home <= 4.5);
  assert.ok(analysis.lambdas.away >= 0.15 && analysis.lambdas.away <= 4.5);
  assert.ok(analysis.lambdas.total >= 0.8 && analysis.lambdas.total <= 7);
  assert.equal(analysis.markets.length, 9);
  assertFiniteMarkets(analysis);
});

test('rechaza respuestas sin partido o sin equipos', () => {
  assert.throws(() => analyzeMatch({} as AggregatedResponse), AnalysisError);
  const missingNames = {
    match: { match_id: 'x', league: { id: 'x', name: 'X' }, date: '', status: 'scheduled', score: { home: null, away: null } },
    teams: { home: { name: '', side: 'home', stats: {} }, away: { name: 'B', side: 'away', stats: {} } },
    meta: {},
  } as unknown as AggregatedResponse;
  assert.throws(() => analyzeMatch(missingNames), (error: unknown) => error instanceof AnalysisError && error.code === 'MISSING_TEAMS');
});
