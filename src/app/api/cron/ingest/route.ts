import { createHash, timingSafeEqual } from 'node:crypto';
import { listPendingPostMatches } from '@/lib/server/db';
import { StatsApiError } from '@/lib/server/errors';
import { jsonError } from '@/lib/server/http';
import { runLearning, type LearningSummary } from '@/lib/server/learning';
import { ingestPostMatch } from '@/lib/server/post-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Tope por ejecución: el plan Hobby solo permite un cron diario. */
const MAX_MATCHES_PER_RUN = 10;
/** Deja margen al límite de 60 s de la función. */
const TIME_BUDGET_MS = 45_000;
/** Por debajo de este margen el ajuste se pospone a la pasada siguiente. */
const MIN_LEARNING_BUDGET_MS = 12_000;

interface CronEntry {
  matchId: string;
  outcome: 'inserted' | 'duplicate' | 'skipped' | 'error';
  code?: string;
}

/**
 * Comparación en tiempo constante sobre digests SHA-256, igual que la ingesta.
 */
function secretMatches(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Vercel Cron envía `Authorization: Bearer $CRON_SECRET` automáticamente.
 * Sin `CRON_SECRET` solo se permite en desarrollo; en producción queda cerrado.
 */
function authorizeCron(request: Request): Response | null {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const header = request.headers.get('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!provided || !secretMatches(provided, expected)) {
      return jsonError(
        401,
        'UNAUTHORIZED',
        'La cabecera Authorization: Bearer CRON_SECRET es obligatoria.',
      );
    }
    return null;
  }
  if ((process.env.NODE_ENV ?? 'development') === 'production') {
    return jsonError(
      503,
      'CRON_DISABLED',
      'El cron de ingesta está desactivado: define CRON_SECRET en el servidor.',
    );
  }
  return null;
}

/**
 * Cierre automático de partidos analizados: busca en Supabase los que tienen
 * captura `pre` y ningún `post` vigente, y registra el resultado de cada uno.
 *
 * Es idempotente: un resultado ya guardado devuelve `duplicate` sin duplicar
 * snapshots, y un partido sin marcador disponible se omite hasta la próxima
 * pasada. Un fallo por partido no aborta el resto.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthorized = authorizeCron(request);
  if (unauthorized) return unauthorized;

  const started = Date.now();
  const listing = await listPendingPostMatches({ limit: MAX_MATCHES_PER_RUN });

  if (listing.status === 'disabled') {
    return jsonError(
      503,
      'PERSISTENCE_UNAVAILABLE',
      'La persistencia está desactivada: el cron no puede registrar resultados.',
    );
  }
  if (listing.status === 'error') {
    return jsonError(
      503,
      'PENDING_QUERY_FAILED',
      'No se pudo leer la lista de partidos pendientes en Supabase.',
    );
  }

  const entries: CronEntry[] = [];
  let stopReason: 'done' | 'budget' = 'done';

  for (const pending of listing.matches) {
    if (Date.now() - started >= TIME_BUDGET_MS) {
      stopReason = 'budget';
      break;
    }
    try {
      const outcome = await ingestPostMatch(pending.matchId);
      if (outcome.status === 'ok') {
        entries.push({
          matchId: outcome.matchId,
          outcome: outcome.inserted ? 'inserted' : 'duplicate',
        });
      } else {
        entries.push({
          matchId: outcome.matchId,
          outcome: outcome.status === 'skipped' ? 'skipped' : 'error',
          code: outcome.code,
        });
      }
    } catch (error) {
      entries.push({
        matchId: pending.matchId,
        outcome: 'error',
        code: error instanceof StatsApiError ? error.code : 'unexpected',
      });
    }
  }

  const count = (value: CronEntry['outcome']): number =>
    entries.filter((entry) => entry.outcome === value).length;

  // El aprendizaje nunca puede tumbar la ingesta: si no cabe en el presupuesto
  // o falla, se publica su estado y se reintenta en la pasada siguiente.
  let learning: LearningSummary;
  if (60_000 - (Date.now() - started) < MIN_LEARNING_BUDGET_MS) {
    learning = { state: 'skipped', reason: 'budget' };
  } else {
    learning = await runLearning();
  }

  return Response.json(
    {
      state: count('error') > 0 ? 'partial' : 'ok',
      pending: listing.matches.length,
      processed: entries.length,
      inserted: count('inserted'),
      duplicates: count('duplicate'),
      skipped: count('skipped'),
      errors: count('error'),
      remaining: listing.matches.length - entries.length,
      stopReason,
      elapsedMs: Date.now() - started,
      results: entries,
      learning,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
