import { geminiConfigured, geminiModel } from '@/lib/server/gemini';
import { getStatsApiHealth } from '@/lib/server/stats-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(): Promise<Response> {
  const health = await getStatsApiHealth();
  return Response.json(
    {
      ok: health.reachable,
      statsApi: {
        reachable: health.reachable,
        version: health.version,
        preMatchEnabled: health.preMatchEnabled,
        latencyMs: health.latencyMs,
        error: health.error,
      },
      gemini: {
        configured: geminiConfigured(),
        model: geminiModel(),
      },
    },
    {
      status: health.reachable ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
