import 'server-only';

import type { PostMatchStatus } from '../types/api';
import { recordPostMatch } from './db';
import {
  acceptance,
  canonicalPostPayload,
  completenessOf,
  deriveResult,
  isExtraTime,
  sanitizeConflicts,
} from './post-ingest';
import { fetchMatchStats } from './stats-client';

/**
 * Orquestación de la ingesta post-partido: consulta la API de estadísticas,
 * aplica el contrato (`post-ingest.ts`) y persiste el resultado.
 *
 * La comparten la ruta manual `/api/ingest/post` y el cron `/api/cron/ingest`.
 * Los fallos de transporte de `fetchMatchStats` (StatsApiError) se propagan:
 * la ruta los mapea a HTTP y el cron los captura por partido.
 */

export interface PostIngestSuccess {
  status: 'ok';
  matchId: string;
  postStatus: PostMatchStatus;
  inserted: boolean;
  snapshotId: string;
  score: { home: number; away: number; result: 'home' | 'draw' | 'away'; total: number };
  coverage: { available: number; total: number };
  warnings: string[];
}

export type PostIngestSkipCode =
  | 'POST_MATCH_UNAVAILABLE'
  | 'POST_MATCH_INCOMPLETE'
  | 'POST_MATCH_NO_SCORE'
  | 'POST_MATCH_NOT_ACCEPTABLE'
  | 'POST_MATCH_WITHOUT_PRE';

export interface PostIngestSkip {
  status: 'skipped';
  matchId: string;
  code: PostIngestSkipCode;
  message: string;
  /** Estado HTTP sugerido para la ruta manual; el cron lo ignora. */
  httpStatus: 409 | 422;
}

export interface PostIngestFailure {
  status: 'error';
  matchId: string;
  code: 'PERSISTENCE_UNAVAILABLE';
  message: string;
  httpStatus: 503;
}

export type PostIngestOutcome = PostIngestSuccess | PostIngestSkip | PostIngestFailure;

export async function ingestPostMatch(matchId: string): Promise<PostIngestOutcome> {
  const { data } = await fetchMatchStats({ matchId }, { include: ['post_match'] });
  const postMatch = data.post_match ?? null;

  if (!postMatch) {
    return {
      status: 'skipped',
      matchId,
      code: 'POST_MATCH_UNAVAILABLE',
      httpStatus: 409,
      message:
        'La API de estadísticas no devolvió el bloque post_match: la instancia consultada todavía no sirve ?include=post_match. Reintenta cuando esté publicado o apunta STATS_API_BASE_URL a una instancia actualizada.',
    };
  }

  if (postMatch.status === 'unavailable') {
    const detail = postMatch.meta?.warnings?.join(' ') ?? '';
    return {
      status: 'skipped',
      matchId,
      code: 'POST_MATCH_INCOMPLETE',
      httpStatus: 422,
      message: `El bloque post_match está marcado como unavailable (cobertura ${postMatch.meta?.coverage?.available ?? 0}/${postMatch.meta?.coverage?.total ?? 6}).${detail ? ` ${detail}` : ''}`,
    };
  }

  // Los campos en conflicto se anulan y quedan como warnings: no se persisten.
  const sanitized = sanitizeConflicts(postMatch);
  const result = deriveResult(sanitized.post);
  if (!result) {
    return {
      status: 'skipped',
      matchId,
      code: 'POST_MATCH_NO_SCORE',
      httpStatus: 422,
      message:
        'El bloque post_match no tiene un marcador final válido (score.ft entero y no negativo); no se puede registrar el resultado.',
    };
  }

  const check = acceptance(sanitized.post);
  if (!check.accepted) {
    return {
      status: 'skipped',
      matchId,
      code: 'POST_MATCH_NOT_ACCEPTABLE',
      httpStatus: 422,
      message: check.reason ?? 'El bloque no es aceptable.',
    };
  }

  const warnings = [...(sanitized.post.meta?.warnings ?? [])];
  if (check.reason) warnings.push(check.reason);
  if (isExtraTime(sanitized.post)) {
    warnings.push('El partido incluyó prórroga: queda excluido de los modelos calibrados a 90 minutos.');
  }

  const canonicalId = data.match?.match_id ?? matchId;
  const saved = await recordPostMatch({
    matchId: canonicalId,
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
    return {
      status: 'skipped',
      matchId: canonicalId,
      code: 'POST_MATCH_WITHOUT_PRE',
      httpStatus: 409,
      message:
        'No hay captura pre-partido para este partido: analízalo primero para que el resultado tenga una predicción que comparar y no quede un registro huérfano.',
    };
  }
  if (saved.status === 'error') {
    return {
      status: 'error',
      matchId: canonicalId,
      code: 'PERSISTENCE_UNAVAILABLE',
      httpStatus: 503,
      message:
        'El bloque post_match es válido pero no se pudo persistir el snapshot: revisa la configuración de Supabase en el servidor.',
    };
  }

  const coverage = postMatch.meta?.coverage;
  return {
    status: 'ok',
    matchId: canonicalId,
    postStatus: postMatch.status,
    inserted: saved.inserted,
    snapshotId: saved.snapshotId,
    score: result,
    coverage: {
      available: coverage?.available ?? 0,
      total: coverage?.total ?? 6,
    },
    warnings,
  };
}
