import { createHash, timingSafeEqual } from 'node:crypto';
import { getAnalysisCapture } from '@/lib/server/analysis-service';
import {
  listPendingPostMatches,
  listRecaptureCandidates,
  persistPreAnalysis,
  persistShadowAnalysis,
} from '@/lib/server/db';
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
/** Capturas de cierre: pocas y acotadas para no consumir el presupuesto. */
const MAX_RECAPTURES_PER_RUN = 3;
const RECAPTURE_BUDGET_MS = 20_000;

interface RecaptureSummary {
  status: 'ok' | 'disabled' | 'error';
  attempted: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  errors: number;
}

/**
 * Recaptura la última lectura pre de los partidos que empiezan pronto. El
 * snapshot es idempotente por contenido: si las cuotas no cambiaron, no hay
 * fila nueva. Así se puede medir CLV entre apertura y cierre.
 */
async function recaptureClosingLines(started: number, nowMs: number): Promise<RecaptureSummary> {
  const summary: RecaptureSummary = {
    status: 'ok',
    attempted: 0,
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    errors: 0,
  };
  const candidates = await listRecaptureCandidates({ nowMs, limit: MAX_RECAPTURES_PER_RUN });
  summary.status = candidates.status;
  if (candidates.status !== 'ok') return summary;

  for (const candidate of candidates.matches) {
    if (Date.now() - started >= RECAPTURE_BUDGET_MS) break;
    summary.attempted += 1;
    try {
      const capture = await getAnalysisCapture({ matchId: candidate.matchId });
      const saved = await persistPreAnalysis({
        response: capture.response,
        analysis: capture.envelope.analysis,
        paramsVersion: capture.paramsVersion,
      });
      if (saved.snapshotId) {
        await persistShadowAnalysis({
          response: capture.response,
          matchId: candidate.matchId,
          snapshotId: saved.snapshotId,
        });
      }
      if (saved.status === 'ok') summary.inserted += 1;
      else if (saved.status === 'duplicate') summary.duplicates += 1;
      else if (saved.status === 'skipped') summary.skipped += 1;
      else summary.errors += 1;
    } catch {
      summary.errors += 1;
    }
  }
  return summary;
}

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

  // Cierre de cuotas: recalcula los partidos inminentes ya analizados para
  // guardar la última lectura pre. Nunca bloquea la ingesta ni el aprendizaje.
  const recapture = await recaptureClosingLines(started, Date.now());

  // El aprendizaje nunca puede tumbar la ingesta: si no cabe en el presupuesto
  // o falla, se publica su estado y se reintenta en la pasada siguiente.
  let learning: LearningSummary;
  if (60_000 - (Date.now() - started) < MIN_LEARNING_BUDGET_MS) {
    learning = { state: 'skipped', reason: 'budget' };
  } else {
    learning = await runLearning(Date.now(), { deadlineMs: started + 55_000 });
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
      recapture,
      learning,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
