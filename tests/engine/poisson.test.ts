import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScoreMatrix,
  handicapCover,
  resultProbability,
  totalOver,
  totalUnder,
} from '../../src/lib/engine/poisson.ts';
import {
  bttsProbabilities,
  firstGoalProbabilities,
  htFtProbabilities,
  oddEvenProbabilities,
} from '../../src/lib/engine/markets.ts';

function approx(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected} (±${epsilon})`);
}

test('la matriz de marcadores suma 1 y el 1X2 también', () => {
  const matrix = buildScoreMatrix(1.7, 1.4);
  let sum = 0;
  for (const row of matrix.cells) for (const value of row) sum += value;
  approx(sum, 1, 1e-6);
  const total = resultProbability(matrix, 'home') + resultProbability(matrix, 'draw') + resultProbability(matrix, 'away');
  approx(total, 1, 1e-6);
});

test('over y under son complementarios en líneas semienteras', () => {
  const matrix = buildScoreMatrix(1.6, 1.2);
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    approx(totalOver(matrix, line) + totalUnder(matrix, line), 1, 1e-6);
  }
});

test('el hándicap de cuarto promedia las dos líneas adyacentes', () => {
  const matrix = buildScoreMatrix(1.8, 1.1);
  const quarter = handicapCover(matrix, 'home', -0.25);
  const zero = handicapCover(matrix, 'home', 0);
  const minusHalf = handicapCover(matrix, 'home', -0.5);
  approx(quarter, (zero + minusHalf) / 2, 1e-6);
  // Con empate, la línea 0 devuelve media apuesta.
  approx(zero, resultProbability(matrix, 'home') + 0.5 * resultProbability(matrix, 'draw'), 1e-6);
});

test('BTTS, par/impar y primer gol forman distribuciones completas', () => {
  const matrix = buildScoreMatrix(1.5, 1.1);
  const btts = bttsProbabilities(matrix);
  approx(btts.yes + btts.no, 1, 1e-9);

  const parity = oddEvenProbabilities(matrix);
  approx(parity.odd + parity.even, 1, 1e-9);

  const first = firstGoalProbabilities(1.5, 1.1);
  approx(first.home + first.away + first.none, 1, 1e-9);
  assert.ok(first.home > first.away);
});

test('HT/FT devuelve nueve combinaciones que suman 1', () => {
  const htft = htFtProbabilities(1.5, 1.2);
  assert.equal(htft.combos.length, 9);
  const sum = htft.combos.reduce((acc, combo) => acc + combo.probability, 0);
  approx(sum, 1, 1e-6);
  for (let index = 1; index < htft.combos.length; index += 1) {
    assert.ok(htft.combos[index - 1].probability >= htft.combos[index].probability);
  }
});
