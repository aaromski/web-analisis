import { createHash, timingSafeEqual } from 'node:crypto';
import { recordPostMatch } from '@/lib/server/db';
import { errorResponse, jsonError, requireJson } from '@/lib/server/http';
import {
  acceptance,
  canonicalPostPayload,
  completenessOf,
  deriveResult,
  isExtraTime,
  parsePostIngestBody,
  sanitizeConflicts,
} from '@/lib/server/post-ingest';
import { fetchMatchStats } from '@/lib/server/stats-client';

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

    const { data } = await fetchMatchStats({ matchId: input.matchId }, { include: ['post_match'] });
    const postMatch = data.post_match ?? null;

    if (!postMatch) {
      return jsonError(
        409,
        'POST_MATCH_UNAVAILABLE',
        'La API de estadísticas no devolvió el bloque post_match: la instancia consultada todavía no sirve ?include=post_match. Reintenta cuando esté publicado o apunta STATS_API_BASE_URL a una instancia actualizada.',
      );
    }

    if (postMatch.status === 'unavailable') {
      const detail = postMatch.meta?.warnings?.join(' ') ?? '';
      return jsonError(
        422,
        'POST_MATCH_INCOMPLETE',
        `El bloque post_match está marcado como unavailable (cobertura ${postMatch.meta?.coverage?.available ?? 0}/${postMatch.meta?.coverage?.total ?? 6}).${detail ? ` ${detail}` : ''}`,
      );
    }

    // Los campos en conflicto se anulan y quedan como warnings: no se persisten.
    const sanitized = sanitizeConflicts(postMatch);
    const result = deriveResult(sanitized.post);
    if (!result) {
      return jsonError(
        422,
        'POST_MATCH_NO_SCORE',
        'El bloque post_match no tiene un marcador final válido (score.ft entero y no negativo); no se puede registrar el resultado.',
      );
    }

    const check = acceptance(sanitized.post);
    if (!check.accepted) {
      return jsonError(422, 'POST_MATCH_NOT_ACCEPTABLE', check.reason ?? 'El bloque no es aceptable.');
    }

    const warnings = [...(sanitized.post.meta?.warnings ?? [])];
    if (check.reason) warnings.push(check.reason);
    if (isExtraTime(sanitized.post)) {
      warnings.push('El partido incluyó prórroga: queda excluido de los modelos calibrados a 90 minutos.');
    }

    const matchId = data.match?.match_id ?? input.matchId;
    const saved = await recordPostMatch({
      matchId,
      kickoffAt: data.match.date,
      leagueId: data.match.league.id,
      leagueName: data.match.league.name ?? null,
      homeName: data.teams.home.name,
      awayName: data.teams.away.name,
      homeScore: result.home,
      awayScore: result.away,
      phasePayload: canonicalPostPayload(sanitized.post),
      completeness: completenessOf(sanitized.post),
    });

    if (saved.status === 'missing_pre') {
      return jsonError(
        409,
        'POST_MATCH_WITHOUT_PRE',
        'No hay captura pre-partido para este partido: analízalo primero para que el resultado tenga una predicción que comparar y no quede un registro huérfano.',
      );
    }
    if (saved.status === 'error') {
      return jsonError(
        503,
        'PERSISTENCE_UNAVAILABLE',
        'El bloque post_match es válido pero no se pudo persistir el snapshot: revisa la configuración de Supabase en el servidor.',
      );
    }

    const coverage = postMatch.meta?.coverage;
    return Response.json(
      {
        matchId,
        status: postMatch.status,
        inserted: saved.inserted,
        snapshotId: saved.snapshotId,
        score: result,
        coverage: {
          available: coverage?.available ?? 0,
          total: coverage?.total ?? 6,
        },
        warnings,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
