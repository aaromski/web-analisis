import { getLabSummary, LAB_REQUIRED_MATCHES, type LabSummary } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Estado de la comparación sombra. Siempre 200 y sin caché: el dashboard lo
 * consume como dato informativo y un fallo de Supabase se publica como
 * `state: 'error'`, nunca como error HTTP.
 */
export async function GET(): Promise<Response> {
  let summary: LabSummary;
  try {
    summary = await getLabSummary();
  } catch {
    summary = { state: 'error', matchesWithResult: 0, required: LAB_REQUIRED_MATCHES, markets: [] };
  }

  return Response.json(summary, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
