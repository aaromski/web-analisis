import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORNER_DISPERSION,
  CORNER_LINES,
  TOTAL_LINES,
  calibrateCorners,
  calibrateHandicap,
  calibrateTotals,
  cornerOver,
  cornerUnder,
} from '../../src/lib/engine/calibration.ts';
import { buildScoreMatrix, handicapCover, totalOver, totalUnder } from '../../src/lib/engine/poisson.ts';
import { resultOutcomes } from '../../src/lib/engine/markets.ts';

test('las líneas de totales y córners son semienteras', () => {
  for (const line of TOTAL_LINES) assert.ok(Math.abs(line * 2 - Math.round(line * 2)) < 1e-9);
  for (const line of CORNER_LINES) assert.ok(Math.abs(line * 2 - Math.round(line * 2)) < 1e-9);
});

test('Over/Under elige la línea más ambiciosa que mantiene el umbral', () => {
  const matrix = buildScoreMatrix(1.7, 1.4); // 3.1 goles
  const calibration = calibrateTotals(matrix, 3.1, 0.75, 2.5, null, null);
  assert.equal(calibration.selection, 'over');
  const expected = [...TOTAL_LINES].reverse().find((line) => totalOver(matrix, line) >= 0.75);
  assert.equal(calibration.line, expected);
  assert.ok(calibration.probability >= 0.75);
  const moreAmbitious = TOTAL_LINES.find((line) => Math.abs(line - (calibration.line + 0.5)) < 1e-9);
  if (moreAmbitious !== undefined) assert.ok(totalOver(matrix, moreAmbitious) < 0.75);
  assert.equal(calibration.curve.filter((point) => point.selected).length, 1);
});

test('Under baja la línea hasta encontrar el umbral', () => {
  const matrix = buildScoreMatrix(0.7, 0.7); // 1.4 goles
  const calibration = calibrateTotals(matrix, 1.4, 0.75, 2.5, null, null);
  assert.equal(calibration.selection, 'under');
  const expected = TOTAL_LINES.find((line) => totalUnder(matrix, line) >= 0.75);
  assert.equal(calibration.line, expected);
  assert.ok(calibration.probability >= 0.75);
});

test('si ninguna línea alcanza el umbral, se marca no calibrada', () => {
  const matrix = buildScoreMatrix(1.6, 1.2);
  const calibration = calibrateTotals(matrix, 2.8, 0.995, null, null, null);
  assert.equal(calibration.calibrated, false);
  assert.ok(calibration.probability > 0);
});

test('handicap fuerte elige la línea negativa más exigente que cumple', () => {
  const matrix = buildScoreMatrix(2.4, 0.6);
  const win = resultOutcomes(matrix);
  const calibration = calibrateHandicap(matrix, win, 0.75, 'Fuerte', 'Débil', null, null, null);
  assert.equal(calibration.selection, 'home');
  assert.ok(calibration.line < 0, `se esperaba línea negativa, recibido ${calibration.line}`);
  assert.ok(calibration.probability >= 0.75);
  const harder = calibration.line - 0.25;
  if (harder >= -3) {
    assert.ok(handicapCover(matrix, 'home', harder) < 0.75);
  }
});

test('el favorito nunca recibe una línea positiva', () => {
  const matrix = buildScoreMatrix(1.1, 1.2);
  const win = resultOutcomes(matrix);
  const calibration = calibrateHandicap(matrix, win, 0.9, 'Local', 'Visitante', null, null, null);
  assert.equal(calibration.selection, 'away');
  assert.equal(calibration.line, -0.25);
  assert.equal(calibration.calibrated, false);
  assert.ok(calibration.probability < 0.9);
  for (const point of calibration.curve) assert.ok(point.line < 0);
  for (const option of calibration.alternatives) assert.ok(!option.label.includes('+'));
});

test('córners calibra sobre la binomial negativa', () => {
  const calibration = calibrateCorners(9.0, 0.75);
  assert.ok(calibration.probability >= 0.75);
  assert.equal(calibration.curve.filter((point) => point.selected).length, 1);
  assert.ok(CORNER_LINES.includes(calibration.line));
});

test('la binomial negativa reparte más cola que Poisson con la misma media', () => {
  const lambda = 10;
  const over = cornerOver(lambda, 9.5);
  assert.ok(over > 0 && over < 1);
  assert.ok(Math.abs(cornerOver(lambda, 9.5) + cornerUnder(lambda, 9.5) - 1) < 1e-12);
  assert.ok(cornerOver(lambda, 12.5) < over);
  // Con dispersión menor (colas más gordas) la cola alta crece.
  assert.ok(cornerOver(lambda, 14.5, 6) > cornerOver(lambda, 14.5, CORNER_DISPERSION));
  // Dispersión enorme se acerca a Poisson(10): P(X>14) ≈ 0,0835.
  assert.ok(Math.abs(cornerOver(lambda, 14.5, 1e6) - 0.0835) < 0.002);
});
