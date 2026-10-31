/**
 * Utilidades de distribución. Todo es puro y determinista.
 */
import { MAX_GOALS, RHO } from './params';

const LOG_FACTORIALS: number[] = [0];

function logFactorial(n: number): number {
  while (LOG_FACTORIALS.length <= n) {
    const k = LOG_FACTORIALS.length;
    LOG_FACTORIALS.push(LOG_FACTORIALS[k - 1] + Math.log(k));
  }
  return LOG_FACTORIALS[n];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || !Number.isInteger(k)) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(lambda) - lambda - logFactorial(k));
}

export function poissonCdf(lambda: number, upTo: number): number {
  if (upTo < 0) return 0;
  let sum = 0;
  for (let k = 0; k <= upTo; k += 1) sum += poissonPmf(k, lambda);
  return clamp(sum, 0, 1);
}

export interface ScoreMatrix {
  /** Filas = goles local, columnas = goles visitante. */
  cells: number[][];
  maxGoals: number;
  lambdaHome: number;
  lambdaAway: number;
}

export interface MatrixOptions {
  rho?: number;
  maxGoals?: number;
}

/**
 * Poisson bivariado con corrección Dixon-Coles para los marcadores 0-0, 1-0,
 * 0-1 y 1-1. La matriz se normaliza tras truncar a `maxGoals`.
 */
export function buildScoreMatrix(
  lambdaHome: number,
  lambdaAway: number,
  options: MatrixOptions = {},
): ScoreMatrix {
  const { rho = RHO, maxGoals = MAX_GOALS } = options;
  const lh = Math.max(0.05, lambdaHome);
  const la = Math.max(0.05, lambdaAway);
  const cells: number[][] = [];

  for (let i = 0; i <= maxGoals; i += 1) {
    const row: number[] = [];
    for (let j = 0; j <= maxGoals; j += 1) {
      let tau = 1;
      if (rho !== 0 && i <= 1 && j <= 1) {
        if (i === 0 && j === 0) tau = 1 - lh * la * rho;
        else if (i === 0 && j === 1) tau = 1 + lh * rho;
        else if (i === 1 && j === 0) tau = 1 + la * rho;
        else tau = 1 - rho;
      }
      const value = tau * poissonPmf(i, lh) * poissonPmf(j, la);
      row.push(Number.isFinite(value) && value > 0 ? value : 0);
    }
    cells.push(row);
  }

  return normalizeMatrix({ cells, maxGoals, lambdaHome: lh, lambdaAway: la });
}

export function normalizeMatrix(matrix: ScoreMatrix): ScoreMatrix {
  let total = 0;
  for (const row of matrix.cells) for (const value of row) total += value;
  if (!Number.isFinite(total) || total <= 0) {
    const cells = matrix.cells.map((row) => row.map(() => 0));
    cells[0][0] = 1;
    return { ...matrix, cells };
  }
  const cells = matrix.cells.map((row) => row.map((value) => value / total));
  return { ...matrix, cells };
}

export function matrixProbability(
  matrix: ScoreMatrix,
  predicate: (homeGoals: number, awayGoals: number) => boolean,
): number {
  let sum = 0;
  for (let i = 0; i < matrix.cells.length; i += 1) {
    for (let j = 0; j < matrix.cells[i].length; j += 1) {
      if (predicate(i, j)) sum += matrix.cells[i][j];
    }
  }
  return clamp(sum, 0, 1);
}

export function totalOver(matrix: ScoreMatrix, line: number): number {
  return matrixProbability(matrix, (home, away) => home + away > line);
}

export function totalUnder(matrix: ScoreMatrix, line: number): number {
  return matrixProbability(matrix, (home, away) => home + away < line);
}

export function totalPush(matrix: ScoreMatrix, line: number): number {
  return matrixProbability(matrix, (home, away) => home + away === line);
}

/**
 * Probabilidad efectiva de cubrir un handicap desde la perspectiva del lado
 * indicado. Las líneas de cuarto se reparten a medias entre las dos líneas
 * adyacentes y los empates exactos valen media apuesta.
 */
export function handicapCover(
  matrix: ScoreMatrix,
  side: 'home' | 'away',
  line: number,
): number {
  const quarter = line * 4;
  const isQuarter = Math.abs(quarter - Math.round(quarter)) < 1e-9 && Math.abs(line * 2 - Math.round(line * 2)) > 1e-9;
  if (isQuarter) {
    const lower = Math.floor(line * 2) / 2;
    const upper = Math.ceil(line * 2) / 2;
    return (handicapCoverWhole(matrix, side, lower) + handicapCoverWhole(matrix, side, upper)) / 2;
  }
  return handicapCoverWhole(matrix, side, line);
}

function handicapCoverWhole(matrix: ScoreMatrix, side: 'home' | 'away', line: number): number {
  let win = 0;
  let push = 0;
  for (let i = 0; i < matrix.cells.length; i += 1) {
    for (let j = 0; j < matrix.cells[i].length; j += 1) {
      const margin = side === 'home' ? i - j : j - i;
      const adjusted = margin + line;
      if (adjusted > 1e-9) win += matrix.cells[i][j];
      else if (Math.abs(adjusted) <= 1e-9) push += matrix.cells[i][j];
    }
  }
  return clamp(win + push / 2, 0, 1);
}

export function resultProbability(
  matrix: ScoreMatrix,
  result: 'home' | 'draw' | 'away',
): number {
  if (result === 'home') return matrixProbability(matrix, (i, j) => i > j);
  if (result === 'away') return matrixProbability(matrix, (i, j) => j > i);
  return matrixProbability(matrix, (i, j) => i === j);
}

export function bttsYes(matrix: ScoreMatrix): number {
  return matrixProbability(matrix, (i, j) => i > 0 && j > 0);
}

export function oddTotal(matrix: ScoreMatrix): number {
  return matrixProbability(matrix, (i, j) => (i + j) % 2 === 1);
}

export function exactScores(matrix: ScoreMatrix, limit = 6): Array<{ home: number; away: number; probability: number }> {
  const scores: Array<{ home: number; away: number; probability: number }> = [];
  for (let i = 0; i < matrix.cells.length; i += 1) {
    for (let j = 0; j < matrix.cells[i].length; j += 1) {
      const probability = matrix.cells[i][j];
      if (probability > 0.0005) scores.push({ home: i, away: j, probability });
    }
  }
  scores.sort((a, b) => b.probability - a.probability);
  return scores.slice(0, limit);
}

/** Convolución de dos matrices de marcadores (p. ej. primera y segunda parte). */
export function convolveMatrices(first: ScoreMatrix, second: ScoreMatrix): ScoreMatrix {
  const maxGoals = first.maxGoals + second.maxGoals;
  const cells: number[][] = Array.from({ length: maxGoals + 1 }, () =>
    Array.from({ length: maxGoals + 1 }, () => 0),
  );
  for (let i1 = 0; i1 < first.cells.length; i1 += 1) {
    for (let j1 = 0; j1 < first.cells[i1].length; j1 += 1) {
      const p1 = first.cells[i1][j1];
      if (p1 === 0) continue;
      for (let i2 = 0; i2 < second.cells.length; i2 += 1) {
        for (let j2 = 0; j2 < second.cells[i2].length; j2 += 1) {
          const p2 = second.cells[i2][j2];
          if (p2 === 0) continue;
          cells[i1 + i2][j1 + j2] += p1 * p2;
        }
      }
    }
  }
  return normalizeMatrix({
    cells,
    maxGoals,
    lambdaHome: first.lambdaHome + second.lambdaHome,
    lambdaAway: first.lambdaAway + second.lambdaAway,
  });
}

/**
 * Desplaza una matriz de goles restantes al marcador actual: la celda (i, j)
 * pasa a representar el marcador absoluto (i + offsetHome, j + offsetAway).
 * Así los mercados existentes operan sobre el resultado final.
 */
export function shiftMatrix(
  matrix: ScoreMatrix,
  offsetHome: number,
  offsetAway: number,
): ScoreMatrix {
  const home = Math.max(0, Math.round(offsetHome));
  const away = Math.max(0, Math.round(offsetAway));
  if (home === 0 && away === 0) return matrix;
  const maxGoals = matrix.maxGoals + home + away;
  const cells: number[][] = Array.from({ length: maxGoals + 1 }, () =>
    Array.from({ length: maxGoals + 1 }, () => 0),
  );
  for (let i = 0; i < matrix.cells.length; i += 1) {
    for (let j = 0; j < matrix.cells[i].length; j += 1) {
      cells[i + home][j + away] = matrix.cells[i][j];
    }
  }
  return {
    cells,
    maxGoals,
    lambdaHome: matrix.lambdaHome + home,
    lambdaAway: matrix.lambdaAway + away,
  };
}

/** Probabilidad de que un total Poisson 1D supere una línea semientera. */
export function poissonOver(lambda: number, line: number): number {
  const safeLambda = Math.max(0, lambda);
  const threshold = Math.floor(line);
  return clamp(1 - poissonCdf(safeLambda, threshold), 0, 1);
}

export function poissonUnder(lambda: number, line: number): number {
  return clamp(1 - poissonOver(lambda, line), 0, 1);
}
