import { getAnalysis } from '@/lib/server/analysis-service';
import { checkRateLimit } from '@/lib/server/cache';
import { errorResponse, jsonError, requireJson } from '@/lib/server/http';
import { generateAiReport } from '@/lib/server/gemini';
import { parseMatchInput } from '@/lib/server/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RATE_WINDOW_MS = 5 * 60_000;
const CLIENT_LIMIT = 6;
// Tope global: protege la cuota de Gemini incluso si un cliente falsifica
// `x-forwarded-for` para saltarse el límite por IP.
const GLOBAL_LIMIT = 30;

function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'local';
  return `ai:${ip}`;
}

function rateLimitedResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'RATE_LIMITED',
        message: `Demasiadas solicitudes de Análisis IA. Espera ${retryAfterSeconds} s antes de reintentar.`,
      },
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Retry-After': String(retryAfterSeconds),
      },
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  const wrongType = requireJson(request);
  if (wrongType) return wrongType;

  // Primero el límite por cliente: una petición que ya va a rechazarse no debe
  // consumir el cupo global compartido.
  const limit = checkRateLimit(clientKey(request), CLIENT_LIMIT, RATE_WINDOW_MS);
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterSeconds);

  const globalLimit = checkRateLimit('ai:global', GLOBAL_LIMIT, RATE_WINDOW_MS);
  if (!globalLimit.allowed) return rateLimitedResponse(globalLimit.retryAfterSeconds);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'INVALID_JSON', 'El cuerpo de la petición debe ser JSON válido.');
  }

  try {
    const input = parseMatchInput(body);
    const envelope = await getAnalysis(input);
    const report = await generateAiReport(envelope);
    return Response.json(report, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
