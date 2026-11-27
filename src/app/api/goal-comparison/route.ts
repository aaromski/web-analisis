import { getGoalComparison } from '@/lib/server/db';
import { errorResponse, jsonError, requireJson } from '@/lib/server/http';
import { parseMatchInput, type MatchInput } from '@/lib/server/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Comparativo de gol previo de ambos equipos. Las vistas solo son legibles con
 * `service_role`, así que el navegador pasa por esta ruta. Un fallo de Supabase
 * se publica como 502 sin tumbar el análisis principal.
 */
export async function POST(request: Request): Promise<Response> {
  const unsupported = requireJson(request);
  if (unsupported) return unsupported;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Cuerpo no JSON: parseMatchInput lo rechaza con un 400.
  }

  let input: MatchInput;
  try {
    input = parseMatchInput(body);
  } catch (error) {
    return errorResponse(error);
  }
  if (!input.matchId) {
    return jsonError(400, 'INVALID_INPUT', 'Indica el ID del partido para consultar su comparativo.');
  }

  const result = await getGoalComparison(input.matchId);
  if (result.state === 'not_found') {
    return jsonError(
      404,
      'GOAL_COMPARISON_NOT_FOUND',
      'Aún no hay historial previo guardado para este partido. El análisis principal sigue disponible.',
    );
  }
  if (result.state === 'disabled') {
    return jsonError(
      503,
      'PERSISTENCE_DISABLED',
      'La persistencia no está configurada en este entorno.',
    );
  }
  if (result.state === 'error') {
    return jsonError(
      502,
      'GOAL_COMPARISON_UNAVAILABLE',
      'No se pudo leer el comparativo de goles. Vuelve a intentarlo.',
    );
  }

  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
