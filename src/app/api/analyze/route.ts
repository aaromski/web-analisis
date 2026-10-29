import { getAnalysis } from '@/lib/server/analysis-service';
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
    const envelope = await getAnalysis(input);
    return Response.json(envelope, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
