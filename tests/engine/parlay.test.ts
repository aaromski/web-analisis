import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScoreMatrix, matrixProbability } from '../../src/lib/engine/poisson.ts';
import { buildParlay, type ParlayCandidate } from '../../src/lib/engine/parlay.ts';

test('la combinada usa la probabilidad conjunta y respeta la correlación', () => {
  const matrix = buildScoreMatrix(1.7, 1.4);
  const candidates: ParlayCandidate[] = [
    {
      marketKey: 'double_chance',
      market: 'Doble oportunidad',
      selection: '1X',
      probability: 0.78,
      predicate: (home, away) => home >= away,
    },
    {
      marketKey: 'totals',
      market: 'Altas / Bajas',
      selection: 'Over 1.5',
      probability: 0.8,
      predicate: (home, away) => home + away > 1.5,
    },
    {
      marketKey: 'btts',
      market: 'Ambos anotan',
      selection: 'Sí',
      probability: 0.67,
      predicate: (home, away) => home > 0 && away > 0,
    },
  ];
  const parlay = buildParlay(matrix, candidates);
  assert.ok(parlay);
  assert.ok(parlay.legs.length >= 2);
  const expected = matrixProbability(matrix, (home, away) => {
    const predicates = parlay.legs.map((leg) => {
      if (leg.marketKey === 'double_chance') return (h: number, a: number) => h >= a;
      if (leg.marketKey === 'totals') return (h: number, a: number) => h + a > 1.5;
      return (h: number, a: number) => h > 0 && a > 0;
    });
    return predicates.every((predicate) => predicate(home, away));
  });
  assert.ok(Math.abs(parlay.probability - expected) < 1e-9);
  assert.ok(parlay.probability <= Math.min(...parlay.legs.map((leg) => leg.probability)) + 1e-9);
});

test('una combinada contradictoria no se publica', () => {
  const matrix = buildScoreMatrix(1.7, 1.4);
  const candidates: ParlayCandidate[] = [
    {
      marketKey: 'result',
      market: 'Resultado final',
      selection: 'Local',
      probability: 0.8,
      predicate: (home, away) => home > away,
    },
    {
      marketKey: 'double_chance',
      market: 'Doble oportunidad',
      selection: 'X2',
      probability: 0.8,
      predicate: (home, away) => away >= home,
    },
  ];
  assert.equal(buildParlay(matrix, candidates), null);
});

test('no se combinan patas anidadas', () => {
  const matrix = buildScoreMatrix(1.8, 1.1);
  const resultP = matrixProbability(matrix, (home, away) => home > away);
  const dcP = matrixProbability(matrix, (home, away) => home >= away);
  const overP = matrixProbability(matrix, (home, away) => home + away > 1.5);
  const candidates: ParlayCandidate[] = [
    {
      marketKey: 'result',
      market: 'Resultado final',
      selection: 'Local',
      probability: resultP,
      predicate: (home, away) => home > away,
    },
    {
      marketKey: 'double_chance',
      market: 'Doble oportunidad',
      selection: '1X',
      probability: dcP,
      predicate: (home, away) => home >= away,
    },
    {
      marketKey: 'totals',
      market: 'Altas / Bajas',
      selection: 'Over 1.5',
      probability: overP,
      predicate: (home, away) => home + away > 1.5,
    },
  ];
  const parlay = buildParlay(matrix, candidates);
  assert.ok(parlay);
  const keys = parlay.legs.map((leg) => leg.marketKey);
  assert.ok(keys.includes('totals'));
  assert.ok(!(keys.includes('result') && keys.includes('double_chance')));
});

test('con una sola selección elegible no hay combinada', () => {
  const matrix = buildScoreMatrix(1.4, 1.2);
  const candidates: ParlayCandidate[] = [
    {
      marketKey: 'totals',
      market: 'Altas / Bajas',
      selection: 'Over 1.5',
      probability: 0.75,
      predicate: (home, away) => home + away > 1.5,
    },
  ];
  assert.equal(buildParlay(matrix, candidates), null);
});
