import { after } from 'next/server';
import { getAnalysisCapture } from '@/lib/server/analysis-service';
import { persistPreAnalysis, persistShadowAnalysis } from '@/lib/server/db';
import { errorResponse, jsonError, requireJson } from '@/lib/server/http';
import { parseMatchInput } from '@/lib/server/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const wrongType = requireJson(request);
  if (wrongType) return wrongType;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'INVALID_JSON', 'El cuerpo de la petición debe ser JSON válido.');
  }

  try {
    const input = parseMatchInput(body);
    const capture = await getAnalysisCapture(input);
    const { envelope, response } = capture;

    // La captura corre después de enviar la respuesta y nunca puede romperla:
    // `persistPreAnalysis` es fail-open y respeta el interruptor de persistencia.
    after(async () => {
      const saved = await persistPreAnalysis({
        response,
        analysis: envelope.analysis,
        paramsVersion: capture.paramsVersion,
      });
      if (!saved.snapshotId) return;
      await persistShadowAnalysis({
        response,
        matchId: response.match.match_id,
        snapshotId: saved.snapshotId,
      });
    });

    return Response.json(envelope, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
