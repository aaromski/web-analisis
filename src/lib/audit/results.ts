import { existsSync, readFileSync } from 'node:fs';
import type { AggregatedResponse } from '../types/api';

export type MatchResults = Map<string, { home: number; away: number }>;

/**
 * Resultados reales para el backtest. Formato aceptado:
 * { "match_id": { "home": 2, "away": 1 } }
 * También admite un objeto con la clave "matches".
 */
export function loadResults(path: string): MatchResults {
  const results: MatchResults = new Map();
  if (!existsSync(path)) return results;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const source =
    parsed && typeof parsed === 'object' && 'matches' in parsed
      ? (parsed as { matches: Record<string, unknown> }).matches
      : parsed;
  if (!source || typeof source !== 'object') return results;
  for (const [matchId, value] of Object.entries(source as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const score = value as { home?: unknown; away?: unknown };
    if (typeof score.home === 'number' && typeof score.away === 'number') {
      results.set(matchId, { home: score.home, away: score.away });
    }
  }
  return results;
}

/**
 * Copia la respuesta con el marcador final inyectado, para puntuar snapshots
 * capturados antes del partido sin perder el estado original.
 */
export function withResult(response: AggregatedResponse, results: MatchResults): AggregatedResponse {
  const result = results.get(response.match?.match_id);
  if (!result) return response;
  return {
    ...response,
    match: {
      ...response.match,
      score: { home: result.home, away: result.away },
    },
  };
}
