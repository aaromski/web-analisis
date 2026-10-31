import type { ModelUncertainty, ProbabilityInterval } from '../types/analysis';
import { buildScoreMatrix, clamp, resultProbability, round, totalOver } from './poisson';

const MAX_GOALS = 12;
const RHO = -0.1;

/** Generador determinista (mulberry32) para que los intervalos sean estables. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller a partir de dos uniformes. */
function standardNormal(random: () => number): number {
  const u = Math.max(random(), 1e-9);
  const v = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = clamp(p, 0, 1) * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  const weight = index - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function interval(values: number[]): ProbabilityInterval {
  const sorted = [...values].sort((a, b) => a - b);
  return { low: round(quantile(sorted, 0.1), 4), high: round(quantile(sorted, 0.9), 4) };
}

export interface UncertaintyInput {
  lambdaHome: number;
  lambdaAway: number;
  quality: number;
  /** Extra de incertidumbre por alineación no confirmada. */
  sigmaBoost?: number;
  samples?: number;
  totalLine?: number | null;
  seed?: number;
}

/**
 * Incertidumbre del pronóstico por Monte Carlo: se perturban λ en escala
 * lognormal y se recalculan matriz y mercados. El intervalo p10–p90 comunica
 * cuánto puede moverse el resultado si los datos de entrada están sesgados.
 */
export function buildUncertainty(input: UncertaintyInput): ModelUncertainty {
  const samples = clamp(Math.round(input.samples ?? 240), 40, 800);
  const quality = clamp(input.quality, 0, 1);
  const sigma = clamp(0.1 + 0.2 * (1 - quality) + (input.sigmaBoost ?? 0), 0.08, 0.4);
  const totalLine =
    typeof input.totalLine === 'number' && Number.isFinite(input.totalLine) ? input.totalLine : null;
  const random = seededRandom(input.seed ?? 20261030);

  const lambdaHomeSamples: number[] = [];
  const lambdaAwaySamples: number[] = [];
  const totalSamples: number[] = [];
  const overSamples: number[] = [];
  const winHome: number[] = [];
  const winDraw: number[] = [];
  const winAway: number[] = [];

  for (let sample = 0; sample < samples; sample += 1) {
    const home = clamp(input.lambdaHome * Math.exp(sigma * standardNormal(random)), 0.1, 5);
    const away = clamp(input.lambdaAway * Math.exp(sigma * standardNormal(random)), 0.1, 5);
    lambdaHomeSamples.push(home);
    lambdaAwaySamples.push(away);
    totalSamples.push(home + away);
    const matrix = buildScoreMatrix(home, away, { rho: RHO, maxGoals: MAX_GOALS });
    winHome.push(resultProbability(matrix, 'home'));
    winDraw.push(resultProbability(matrix, 'draw'));
    winAway.push(resultProbability(matrix, 'away'));
    if (totalLine !== null) overSamples.push(totalOver(matrix, totalLine));
  }

  return {
    samples,
    sigma: round(sigma, 3),
    lambdas: {
      home: interval(lambdaHomeSamples),
      away: interval(lambdaAwaySamples),
      total: interval(totalSamples),
    },
    win: {
      home: interval(winHome),
      draw: interval(winDraw),
      away: interval(winAway),
    },
    totalLine,
    total: totalLine === null ? null : interval(overSamples),
  };
}
