import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateMetrics,
  applyIsotonic,
  brierScore,
  expectedCalibrationError,
  favoriteError,
  fitIsotonic,
  logLoss,
  outcomeFromScore,
  reliabilityBins,
  totalDelta,
  winMeanAbsoluteError,
  type MatchMetrics,
} from '../../src/lib/audit/metrics.ts';

test('MAE del 1X2 mide el error medio en unidades de probabilidad', () => {
  const identical = winMeanAbsoluteError(
    { home: 0.5, draw: 0.25, away: 0.25 },
    { home: 0.5, draw: 0.25, away: 0.25 },
  );
  assert.equal(identical, 0);
  const shifted = winMeanAbsoluteError(
    { home: 0.4, draw: 0.3, away: 0.3 },
    { home: 0.5, draw: 0.25, away: 0.25 },
  );
  assert.ok(Math.abs(shifted - 0.0666667) < 1e-6);
});

test('el error del favorito se firma contra el favorito del mercado', () => {
  const error = favoriteError(
    { home: 0.4, draw: 0.3, away: 0.3 },
    { home: 0.5, draw: 0.25, away: 0.25 },
  );
  assert.equal(error.side, 'home');
  assert.ok(Math.abs(error.delta + 0.1) < 1e-9);
});

test('Brier y log-loss castigan la probabilidad del resultado observado', () => {
  assert.equal(brierScore({ home: 1, draw: 0, away: 0 }, 'home'), 0);
  assert.ok(Math.abs(brierScore({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 }, 'home') - 2 / 3) < 1e-9);
  assert.ok(logLoss({ home: 1, draw: 0, away: 0 }, 'home') < 1e-9);
  assert.ok(Math.abs(logLoss({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 }, 'home') - Math.log(3)) < 1e-9);
});

test('el resultado se deriva del marcador y el delta de total se firma', () => {
  assert.equal(outcomeFromScore({ home: 2, away: 1 }), 'home');
  assert.equal(outcomeFromScore({ home: 0, away: 0 }), 'draw');
  assert.equal(outcomeFromScore({ home: 0, away: 2 }), 'away');
  assert.equal(outcomeFromScore({ home: null, away: 1 }), null);
  assert.ok(Math.abs((totalDelta(3.1, 2.9) ?? 0) - 0.2) < 1e-9);
  assert.equal(totalDelta(3.1, null), null);
});

test('el agregado ignora mercados ausentes y promedia solo valores presentes', () => {
  const base: MatchMetrics = {
    label: 'A – B',
    variant: 'motor',
    lambdaTotal: 2.8,
    marketTotal: 3,
    totalDelta: -0.2,
    mae1x2: 0.05,
    favoriteDelta: -0.03,
    favoriteMarket: 0.5,
    favoriteModel: 0.47,
    favoriteSide: 'home',
    brier: 0.4,
    logLoss: 0.7,
    totalsLineGap: -1,
    edgesComputed: 2,
    markets: 10,
  };
  const withoutMarket: MatchMetrics = {
    ...base,
    totalDelta: null,
    mae1x2: null,
    favoriteDelta: null,
    brier: null,
    edgesComputed: 0,
    markets: 9,
  };
  const aggregate = aggregateMetrics([base, withoutMarket]);
  assert.equal(aggregate.matches, 2);
  assert.ok(Math.abs((aggregate.meanMae1x2 ?? 0) - 0.05) < 1e-9);
  assert.ok(Math.abs((aggregate.meanAbsTotalDelta ?? 0) - 0.2) < 1e-9);
  assert.ok(Math.abs((aggregate.meanAbsFavoriteDelta ?? 0) - 0.03) < 1e-9);
  assert.ok(Math.abs((aggregate.meanBrier ?? 0) - 0.4) < 1e-9);
  assert.equal(aggregate.edgesComputed, 2);
  assert.equal(aggregate.markets, 19);
});

test('la fiabilidad agrupa por bins y el ECE penaliza el desvío', () => {
  const samples = [
    { probability: 0.8, hit: true },
    { probability: 0.8, hit: false },
    { probability: 0.2, hit: false },
    { probability: 0.2, hit: true },
  ];
  const bins = reliabilityBins(samples);
  assert.equal(bins.length, 2);
  assert.ok(Math.abs(bins[0].observed - 0.5) < 1e-9);
  const ece = expectedCalibrationError(samples);
  assert.ok(ece !== null && Math.abs(ece - 0.3) < 1e-9);

  const perfect = expectedCalibrationError([
    { probability: 1, hit: true },
    { probability: 0, hit: false },
  ]);
  assert.equal(perfect, 0);
});

test('la isotónica es monótona y corrige el exceso de confianza', () => {
  const samples = [
    { probability: 0.9, hit: false },
    { probability: 0.9, hit: false },
    { probability: 0.9, hit: false },
    { probability: 0.1, hit: false },
    { probability: 0.1, hit: true },
    { probability: 0.1, hit: false },
  ];
  const calibrator = fitIsotonic(samples);
  assert.ok(calibrator.knots.length > 0);
  const values = calibrator.knots.map((knot) => knot.y);
  for (let index = 1; index < values.length; index += 1) {
    assert.ok(values[index] >= values[index - 1]);
  }
  assert.ok(applyIsotonic(calibrator, 0.9) < 0.9);
  assert.ok(applyIsotonic(calibrator, 0.1) <= 0.5);
  const before = expectedCalibrationError(samples);
  const after = expectedCalibrationError(
    samples.map((sample) => ({ probability: applyIsotonic(calibrator, sample.probability), hit: sample.hit })),
  );
  assert.ok(before !== null && after !== null && after <= before);
});
