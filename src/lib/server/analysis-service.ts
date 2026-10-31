import { analyzeMatch } from '../engine/analyze';
import type { AnalysisEnvelope } from '../types/analysis';
import type { AggregatedResponse } from '../types/api';
import { TtlCache } from './cache';
import { fetchMatchStats } from './stats-client';
import { matchInputKey, type MatchInput } from './validation';

/** Envelope público + respuesta cruda, que solo necesita la persistencia. */
export interface AnalysisCapture {
  envelope: AnalysisEnvelope;
  response: AggregatedResponse;
}

const cache = new TtlCache<AnalysisCapture>(180_000, 60);

/**
 * Igual que `getAnalysis`, pero conserva la respuesta agregada original para
 * que el servidor pueda capturar el snapshot pre-partido sin volver a pedirla.
 * La respuesta cruda nunca sale en el JSON de `/api/analyze`.
 */
export async function getAnalysisCapture(input: MatchInput): Promise<AnalysisCapture> {
  const key = matchInputKey(input);
  const cached = cache.get(key);
  if (cached) return cached;

  const { data, latencyMs } = await fetchMatchStats(input);
  const analysis = analyzeMatch(data);
  const capture: AnalysisCapture = {
    response: data,
    envelope: {
      analysis,
      source: {
        canonicalVersion: data.meta?.canonical_version ?? null,
        generatedAt: data.meta?.generated_at ?? null,
        preMatchStatus: data.pre_match?.status ?? null,
        coverage: data.pre_match?.meta?.coverage
          ? {
              available: data.pre_match.meta.coverage.available,
              total: data.pre_match.meta.coverage.total,
            }
          : null,
        apiLatencyMs: latencyMs,
      },
    },
  };
  cache.set(key, capture);
  return capture;
}

export async function getAnalysis(input: MatchInput): Promise<AnalysisEnvelope> {
  const capture = await getAnalysisCapture(input);
  return capture.envelope;
}

export function clearAnalysisCache(): void {
  cache.clear();
}
