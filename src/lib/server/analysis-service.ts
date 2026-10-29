import { analyzeMatch } from '../engine/analyze';
import type { AnalysisEnvelope } from '../types/analysis';
import { TtlCache } from './cache';
import { fetchMatchStats } from './stats-client';
import { matchInputKey, type MatchInput } from './validation';

const cache = new TtlCache<AnalysisEnvelope>(180_000, 60);

export async function getAnalysis(input: MatchInput): Promise<AnalysisEnvelope> {
  const key = matchInputKey(input);
  const cached = cache.get(key);
  if (cached) return cached;

  const { data, latencyMs } = await fetchMatchStats(input);
  const analysis = analyzeMatch(data);
  const envelope: AnalysisEnvelope = {
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
  };
  cache.set(key, envelope);
  return envelope;
}

export function clearAnalysisCache(): void {
  cache.clear();
}
