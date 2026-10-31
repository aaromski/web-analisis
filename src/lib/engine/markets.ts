import type { HtFtProbability } from '../types/analysis';
import { DEFAULT_ENGINE_PARAMS, RHO, type EngineParams } from './params';
import {
  buildScoreMatrix,
  bttsYes,
  clamp,
  matrixProbability,
  resultProbability,
  type ScoreMatrix,
} from './poisson';

export interface ResultOutcomes {
  home: number;
  draw: number;
  away: number;
}

export function resultOutcomes(matrix: ScoreMatrix): ResultOutcomes {
  return {
    home: resultProbability(matrix, 'home'),
    draw: resultProbability(matrix, 'draw'),
    away: resultProbability(matrix, 'away'),
  };
}

export function doubleChanceOutcomes(matrix: ScoreMatrix): { homeDraw: number; drawAway: number; homeAway: number } {
  const result = resultOutcomes(matrix);
  return {
    homeDraw: result.home + result.draw,
    drawAway: result.draw + result.away,
    homeAway: result.home + result.away,
  };
}

export function bttsProbabilities(matrix: ScoreMatrix): { yes: number; no: number } {
  const yes = bttsYes(matrix);
  return { yes, no: 1 - yes };
}

export function oddEvenProbabilities(matrix: ScoreMatrix): { odd: number; even: number } {
  const odd = matrixProbability(matrix, (home, away) => (home + away) % 2 === 1);
  return { odd, even: 1 - odd };
}

/**
 * Procesos de Poisson independientes: la probabilidad de quién marca primero
 * es la proporción de la tasa de cada equipo, condicionada a que haya gol.
 * Si se pasa la probabilidad de 0-0 de la matriz Dixon-Coles, «sin goles» usa
 * ese valor para no contradecir al resto de mercados.
 */
export function firstGoalProbabilities(
  lambdaHome: number,
  lambdaAway: number,
  noneProbability?: number,
): { home: number; away: number; none: number } {
  const total = Math.max(0.0001, lambdaHome + lambdaAway);
  const none = clamp(noneProbability ?? Math.exp(-total), 0, 0.9999);
  const anyGoal = 1 - none;
  const home = anyGoal * (lambdaHome / total);
  const away = anyGoal * (lambdaAway / total);
  const sum = home + away + none;
  return { home: home / sum, away: away / sum, none: none / sum };
}

export interface HtFtResult {
  combos: HtFtProbability[];
  matrix: number[][];
}

const HT_MAX_GOALS = 8;

/**
 * Modela los goles de cada mitad como procesos Poisson independientes con la
 * fracción `params.lambda.htShare` del total en la primera parte (44 % por
 * defecto), y convoluciona para obtener el resultado final. Devuelve la matriz
 * conjunta HT/FT 3×3.
 */
export function htFtProbabilities(
  lambdaHome: number,
  lambdaAway: number,
  rho = RHO,
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): HtFtResult {
  const share = params.lambda.htShare;
  const first = buildScoreMatrix(lambdaHome * share, lambdaAway * share, { rho, maxGoals: HT_MAX_GOALS });
  const second = buildScoreMatrix(lambdaHome * (1 - share), lambdaAway * (1 - share), { rho, maxGoals: HT_MAX_GOALS });
  const joint: number[][] = Array.from({ length: 3 }, () => [0, 0, 0]);

  for (let hi = 0; hi < first.cells.length; hi += 1) {
    for (let hj = 0; hj < first.cells[hi].length; hj += 1) {
      const pHt = first.cells[hi][hj];
      if (pHt === 0) continue;
      const htResult = category(hi, hj);
      for (let si = 0; si < second.cells.length; si += 1) {
        for (let sj = 0; sj < second.cells[si].length; sj += 1) {
          const pSecond = second.cells[si][sj];
          if (pSecond === 0) continue;
          const ftResult = category(hi + si, hj + sj);
          joint[htResult][ftResult] += pHt * pSecond;
        }
      }
    }
  }

  let total = 0;
  for (const row of joint) for (const value of row) total += value;
  if (total > 0) {
    for (let i = 0; i < joint.length; i += 1) {
      for (let j = 0; j < joint[i].length; j += 1) joint[i][j] /= total;
    }
  }

  const codes: Array<'1' | 'X' | '2'> = ['1', 'X', '2'];
  const labels: Record<'1' | 'X' | '2', string> = { '1': 'Local', X: 'Empate', '2': 'Visitante' };
  const combos: HtFtProbability[] = [];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      combos.push({
        ht: codes[i],
        ft: codes[j],
        label: `${labels[codes[i]]} / ${labels[codes[j]]}`,
        probability: joint[i][j],
      });
    }
  }
  combos.sort((a, b) => b.probability - a.probability);
  return { combos, matrix: joint };
}

function category(home: number, away: number): number {
  if (home > away) return 0;
  if (home === away) return 1;
  return 2;
}

export function fairOdds(probability: number): number {
  if (!Number.isFinite(probability) || probability <= 0.0005) return 999;
  return Math.min(999, 1 / probability);
}

export function clampProbability(probability: number): number {
  return clamp(probability, 0, 1);
}

/** Suma de la matriz que satisface varias condiciones a la vez (combinada). */
export function jointMatrixProbability(
  matrix: ScoreMatrix,
  predicates: Array<(home: number, away: number) => boolean>,
): number {
  if (predicates.length === 0) return 1;
  return matrixProbability(matrix, (home, away) => predicates.every((predicate) => predicate(home, away)));
}
