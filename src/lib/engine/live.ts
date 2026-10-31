import type { AggregatedResponse } from '../types/api';
import type { LiveMeta } from '../types/analysis';
import { clamp, round } from './poisson';

/** 90 minutos más descuento típico: referencia para repartir λ restante. */
export const MATCH_DURATION = 95;

export function estimateElapsedMinutes(kickoff: string | null | undefined, now = Date.now()): number | null {
  if (!kickoff) return null;
  const start = Date.parse(kickoff);
  if (!Number.isFinite(start)) return null;
  const minutes = (now - start) / 60000;
  if (!Number.isFinite(minutes)) return null;
  return clamp(minutes, 0, 120);
}

/**
 * Contexto de un partido en juego. El tiempo transcurrido se estima desde el
 * inicio declarado por la API; sin ese dato se asume el descanso.
 */
export function buildLiveMeta(
  response: AggregatedResponse,
  lambdaHome: number,
  lambdaAway: number,
  now = Date.now(),
): LiveMeta | null {
  if (response.match.status !== 'live') return null;
  const elapsed = estimateElapsedMinutes(response.match.date, now) ?? 45;
  const remainingShare = clamp((MATCH_DURATION - elapsed) / MATCH_DURATION, 0.02, 1);
  return {
    elapsedMinutes: Math.round(elapsed),
    remainingShare: round(remainingShare, 3),
    currentScore: {
      home: response.match.score?.home ?? 0,
      away: response.match.score?.away ?? 0,
    },
    remainingLambdaHome: round(lambdaHome * remainingShare, 2),
    remainingLambdaAway: round(lambdaAway * remainingShare, 2),
  };
}
