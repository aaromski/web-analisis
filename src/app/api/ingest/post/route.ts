import { createHash, timingSafeEqual } from 'node:crypto';
import { errorResponse, jsonError, requireJson } from '@/lib/server/http';
import { parsePostIngestBody } from '@/lib/server/post-ingest';
import { ingestPostMatch } from '@/lib/server/post-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Comparación en tiempo constante. Se comparan digests SHA-256 para que la
 * longitud de ambos lados sea siempre la misma (timingSafeEqual lo exige).
 */
function tokenMatches(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Con `INGEST_TOKEN` definido la cabecera `x-ingest-token` es obligatoria.
 * Sin token solo se permite en desarrollo; en producción la ruta queda cerrada.
 */
function authorizeIngest(request: Request): Response | null {
  const expected = process.env.INGEST_TOKEN;
  if (expected) {
    const provided = request.headers.get('x-ingest-token');
    if (!provided || !tokenMatches(provided, expected)) {
      return jsonError(
        401,
        'UNAUTHORIZED',
        'La cabecera x-ingest-token es obligatoria y debe coincidir con INGEST_TOKEN.',
      );
    }
    return null;
  }
  if ((process.env.NODE_ENV ?? 'development') === 'production') {
    return jsonError(
      503,
      'INGEST_DISABLED',
      'La ingesta post-partido está desactivada: define INGEST_TOKEN en el servidor.',
    );
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const unauthorized = authorizeIngest(request);
  if (unauthorized) return unauthorized;

  const wrongType = requireJson(request);
  if (wrongType) return wrongType;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'INVALID_JSON', 'El cuerpo de la petición debe ser JSON válido.');
  }

  try {
    const input = parsePostIngestBody(body);
    const outcome = await ingestPostMatch(input.matchId);

    if (outcome.status === 'skipped' || outcome.status === 'error') {
      return jsonError(outcome.httpStatus, outcome.code, outcome.message);
    }

    return Response.json(
      {
        matchId: outcome.matchId,
        status: outcome.postStatus,
        inserted: outcome.inserted,
        snapshotId: outcome.snapshotId,
        score: outcome.score,
        coverage: outcome.coverage,
        warnings: outcome.warnings,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
