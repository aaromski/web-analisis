import 'server-only';

import type { AggregatedResponse } from '../types/api';
import type { AnalysisResult, MarketResult } from '../types/analysis';
import { analyzeMatch } from '../engine/analyze';
import { resolveShadowParams, SHADOW_PARAMS_VERSION } from '../engine/shadow';
import { canonicalPreSnapshot, hashCanonical } from './canonical';

/**
 * Persistencia del ciclo de aprendizaje contra Supabase (PostgREST) sin
 * dependencias nuevas.
 *
 * Reglas de la capa:
 * - La configuración se lee en cada llamada (tests y arranques en frío).
 * - Fail-open absoluto: ninguna función lanza hacia el llamador. Un fallo de
 *   red, de configuración o de PostgREST se devuelve como estado.
 * - Nunca se registran payloads, cabeceras, URLs firmadas ni claves.
 *
 * Las tablas tienen RLS activo sin políticas: solo `service_role` escribe, y
 * esa clave vive únicamente en el proceso del servidor.
 */

export type LabState = 'disabled' | 'insufficient' | 'partial' | 'complete' | 'error';

export interface LabMarketRow {
  market: string;
  label: string;
  /** Probabilidad de producción (0–1) o null si el mercado no tiene lectura. */
  production: number | null;
  /** Probabilidad de la sombra (0–1) o null si aún no hay sombra. */
  shadow: number | null;
  /** Diferencia en puntos porcentuales: 1.4 → +1,4 pp. */
  deltaPp: number | null;
  n: number;
  /** Intervalo de confianza 95 % en fracción 0–1. */
  interval: [number, number] | null;
  promotion: 'observing' | 'pending' | 'none';
}

export interface LabSummary {
  state: LabState;
  matchesWithResult: number;
  required: number;
  markets: LabMarketRow[];
}

/** Partidos con resultado que la compuerta exige antes de revisar la sombra. */
export const LAB_REQUIRED_MATCHES = 100;

const LAB_COUNT_CAP = 1000;
const SNAPSHOT_SOURCE = 'stats_api';
const PRODUCTION_VARIANT = 'production';
/** Fila base promovida en `engine_params`; nunca se edita. */
const PARAMS_VERSION = 'engine-1.2.0-defaults';
const DEFAULT_TIMEOUT_MS = 1200;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 10_000;

interface SupabaseConfig {
  baseUrl: string;
  serviceKey: string;
  timeoutMs: number;
}

function persistenceTimeoutMs(): number {
  const raw = Number(process.env.SUPABASE_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(raw)));
}

function readConfig(): SupabaseConfig | null {
  if ((process.env.SUPABASE_PERSISTENCE_ENABLED ?? '').trim().toLowerCase() === 'false') {
    return null;
  }
  const baseUrl = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!baseUrl || !serviceKey) return null;
  return { baseUrl, serviceKey, timeoutMs: persistenceTimeoutMs() };
}

type HttpMethod = 'GET' | 'HEAD' | 'POST';

interface RequestOptions {
  method: HttpMethod;
  /** Ruta relativa a la URL del proyecto, p. ej. `/rest/v1/matches`. */
  path: string;
  query?: string;
  body?: unknown;
  prefer?: string;
}

interface HttpOutcome {
  status: number;
  ok: boolean;
  data: unknown;
  contentRange: string | null;
  errorCode: string | null;
}

function transportErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError'
    ? 'supabase_timeout'
    : 'supabase_unreachable';
}

/** Código corto y estable; nunca incluye el cuerpo ni datos del proyecto. */
function httpErrorCode(status: number, data: unknown): string {
  const candidate = data && typeof data === 'object' ? (data as { code?: unknown }).code : null;
  const suffix =
    typeof candidate === 'string' && /^[A-Za-z0-9_]{2,12}$/.test(candidate) ? `_${candidate}` : '';
  return `http_${status}${suffix}`;
}

async function rest(config: SupabaseConfig, options: RequestOptions): Promise<HttpOutcome> {
  const url = `${config.baseUrl}${options.path}${options.query ? `?${options.query}` : ''}`;
  const headers: Record<string, string> = {
    apikey: config.serviceKey,
    authorization: `Bearer ${config.serviceKey}`,
    accept: 'application/json',
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.prefer) headers.prefer = options.prefer;

  try {
    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    const contentRange = response.headers.get('content-range');
    let data: unknown = null;
    if (options.method !== 'HEAD') {
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      data,
      contentRange,
      errorCode: response.ok ? null : httpErrorCode(response.status, data),
    };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      data: null,
      contentRange: null,
      errorCode: transportErrorCode(error),
    };
  }
}

type IngestionOperation = 'capture_pre' | 'capture_post' | 'generate_predictions';
type IngestionStatus = 'ok' | 'duplicate' | 'skipped' | 'error';

interface IngestionEvent {
  matchId: string;
  operation: IngestionOperation;
  status: IngestionStatus;
  snapshotId?: string | null;
  errorCode?: string | null;
  latencyMs?: number | null;
  engineVersion?: string | null;
  paramsVersion?: string | null;
  /** Etiqueta corta para distinguir, p. ej., la predicción sombra. */
  requestId?: string | null;
}

/**
 * Auditoría de escrituras, best-effort: un fallo aquí se descarta y nunca
 * genera otro evento (sin recursión).
 */
async function recordIngestionEvent(
  config: SupabaseConfig,
  event: IngestionEvent,
): Promise<void> {
  await rest(config, {
    method: 'POST',
    path: '/rest/v1/ingestion_events',
    prefer: 'return=minimal',
    body: {
      match_id: event.matchId,
      snapshot_id: event.snapshotId ?? null,
      operation: event.operation,
      status: event.status,
      error_code: event.errorCode ?? null,
      latency_ms: event.latencyMs ?? null,
      engine_version: event.engineVersion ?? null,
      params_version: event.paramsVersion ?? null,
      request_id: event.requestId ?? null,
    },
  });
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(Date.now() - started));
}

function emptySummary(state: LabState): LabSummary {
  return {
    state,
    matchesWithResult: 0,
    required: LAB_REQUIRED_MATCHES,
    markets: [],
  };
}

interface LabPrediction {
  home: number;
  draw: number;
  away: number;
  totalsLine: number | null;
  totalsSide: 'over' | 'under' | null;
  totalsProbability: number | null;
}

interface SnapshotPair {
  matchId: string;
  createdAt: number;
  production?: LabPrediction;
  shadow?: LabPrediction;
}

function probability(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function embeddedSnapshot(value: unknown): { matchId: string; createdAt: number } | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object') return null;
  const matchId = (row as { match_id?: unknown }).match_id;
  if (typeof matchId !== 'string' || !matchId) return null;
  const raw = (row as { created_at?: unknown }).created_at;
  const createdAt = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return { matchId, createdAt: Number.isFinite(createdAt) ? createdAt : 0 };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** IC 95 % de la diferencia media de probabilidad (fracción 0–1). */
function interval95(diffs: number[], center: number): [number, number] | null {
  if (diffs.length < 2) return null;
  const variance = diffs.reduce((sum, value) => sum + (value - center) ** 2, 0) / (diffs.length - 1);
  const margin = 1.96 * Math.sqrt(variance / diffs.length);
  return [center - margin, center + margin];
}

type PairSelection = (pair: SnapshotPair) => [production: number, shadow: number] | null;

function marketRow(
  market: string,
  label: string,
  pairs: SnapshotPair[],
  selectionOf: PairSelection,
): LabMarketRow | null {
  const production: number[] = [];
  const shadow: number[] = [];
  const diffs: number[] = [];
  for (const pair of pairs) {
    const selection = selectionOf(pair);
    if (!selection) continue;
    production.push(selection[0]);
    shadow.push(selection[1]);
    diffs.push(selection[1] - selection[0]);
  }
  if (diffs.length === 0) return null;

  const productionMean = mean(production);
  const shadowMean = mean(shadow);
  const diffMean = mean(diffs);
  return {
    market,
    label,
    production: productionMean,
    shadow: shadowMean,
    deltaPp: Math.round(diffMean * 1000) / 10,
    n: diffs.length,
    interval: interval95(diffs, diffMean),
    promotion: pairs.length >= LAB_REQUIRED_MATCHES ? 'pending' : 'observing',
  };
}

/**
 * Estado de la sección de sombra para el dashboard.
 *
 * Compara, por mercado, las predicciones de producción y sombra del último
 * snapshot pre de cada partido con resultado. Sin pares comparables no hay
 * filas y la compuerta queda en cero.
 */
export async function getLabSummary(): Promise<LabSummary> {
  const config = readConfig();
  if (!config) return emptySummary('disabled');

  try {
    const [predictions, results] = await Promise.all([
      rest(config, {
        method: 'GET',
        path: '/rest/v1/predictions',
        query:
          'select=snapshot_id,variant,prob_home,prob_draw,prob_away,totals_line,totals_side,totals_probability,match_snapshots!inner(match_id,created_at)' +
          `&variant=in.(production,shadow)&limit=${LAB_COUNT_CAP}`,
      }),
      rest(config, {
        method: 'GET',
        path: '/rest/v1/matches',
        query:
          'select=match_id,home_score,away_score&status=eq.finished' +
          `&home_score=not.is.null&away_score=not.is.null&limit=${LAB_COUNT_CAP}`,
      }),
    ]);
    if (predictions.errorCode || results.errorCode) return emptySummary('error');

    const finished = new Set<string>();
    for (const row of Array.isArray(results.data) ? results.data : []) {
      const matchId = (row as { match_id?: unknown } | null)?.match_id;
      if (typeof matchId === 'string' && matchId) finished.add(matchId);
    }

    const bySnapshot = new Map<string, SnapshotPair>();
    for (const row of Array.isArray(predictions.data) ? predictions.data : []) {
      const record = row as Record<string, unknown>;
      const snapshotId = record.snapshot_id;
      const variant = record.variant;
      if (typeof snapshotId !== 'string' || (variant !== 'production' && variant !== 'shadow')) continue;
      const snapshot = embeddedSnapshot(record.match_snapshots);
      if (!snapshot) continue;

      const home = probability(record.prob_home);
      const draw = probability(record.prob_draw);
      const away = probability(record.prob_away);
      if (home === null || draw === null || away === null) continue;
      const side = record.totals_side;

      const pair = bySnapshot.get(snapshotId) ?? {
        matchId: snapshot.matchId,
        createdAt: snapshot.createdAt,
      };
      pair[variant] = {
        home,
        draw,
        away,
        totalsLine: finiteNumber(record.totals_line),
        totalsSide: side === 'over' || side === 'under' ? side : null,
        totalsProbability: probability(record.totals_probability),
      };
      bySnapshot.set(snapshotId, pair);
    }

    // El snapshot pre más reciente con ambas variantes representa al partido.
    const latest = new Map<string, SnapshotPair>();
    for (const pair of bySnapshot.values()) {
      if (!pair.production || !pair.shadow) continue;
      const previous = latest.get(pair.matchId);
      if (!previous || pair.createdAt > previous.createdAt) latest.set(pair.matchId, pair);
    }
    const comparable = [...latest.values()].filter((pair) => finished.has(pair.matchId));

    const rows = [
      marketRow('1x2_home', 'Local', comparable, (pair) => [
        pair.production!.home,
        pair.shadow!.home,
      ]),
      marketRow('1x2_draw', 'Empate', comparable, (pair) => [
        pair.production!.draw,
        pair.shadow!.draw,
      ]),
      marketRow('1x2_away', 'Visitante', comparable, (pair) => [
        pair.production!.away,
        pair.shadow!.away,
      ]),
      marketRow('totals', 'Altas/bajas', comparable, (pair) => {
        const production = pair.production!;
        const shadow = pair.shadow!;
        if (
          production.totalsSide === null ||
          shadow.totalsSide === null ||
          production.totalsSide !== shadow.totalsSide ||
          production.totalsProbability === null ||
          shadow.totalsProbability === null
        ) {
          return null;
        }
        if (
          production.totalsLine === null ||
          shadow.totalsLine === null ||
          Math.abs(production.totalsLine - shadow.totalsLine) > 0.001
        ) {
          return null;
        }
        return [production.totalsProbability, shadow.totalsProbability];
      }),
    ].filter((row): row is LabMarketRow => row !== null);

    const matchesWithResult = comparable.length;
    const state: LabState =
      matchesWithResult >= LAB_REQUIRED_MATCHES
        ? rows.length > 0
          ? 'complete'
          : 'partial'
        : 'insufficient';

    return {
      state,
      matchesWithResult,
      required: LAB_REQUIRED_MATCHES,
      markets: rows,
    };
  } catch {
    return emptySummary('error');
  }
}

export interface PersistPreAnalysisResult {
  status: 'ok' | 'duplicate' | 'skipped' | 'error';
  snapshotId?: string;
  errorCode?: string;
}

export interface PersistPreAnalysisInput {
  response: AggregatedResponse;
  analysis: AnalysisResult;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toIsoTimestamp(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function round(value: unknown, digits: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function bounded(value: unknown, min: number, max: number, digits: number): number | null {
  const rounded = round(value, digits);
  if (rounded === null) return null;
  return Math.min(max, Math.max(min, rounded));
}

function matchRow(
  response: AggregatedResponse,
  analysis: AnalysisResult,
): Record<string, unknown> | null {
  const match = response.match;
  const kickoffAt = toIsoTimestamp(match?.date) ?? toIsoTimestamp(analysis?.match?.date);
  const leagueId = text(match?.league?.id) ?? text(analysis?.match?.leagueId);
  const homeName = text(response.teams?.home?.name) ?? text(analysis?.match?.homeName);
  const awayName = text(response.teams?.away?.name) ?? text(analysis?.match?.awayName);
  const matchId = text(match?.match_id) ?? text(analysis?.match?.id);
  if (!matchId || !kickoffAt || !leagueId || !homeName || !awayName) return null;

  return {
    match_id: matchId,
    league_id: leagueId,
    league_name: text(match?.league?.name) ?? text(analysis?.match?.leagueName),
    season: text(match?.season) ?? text(analysis?.match?.season),
    kickoff_at: kickoffAt,
    status: 'scheduled',
    home_name: homeName,
    away_name: awayName,
    venue: text(match?.venue) ?? text(analysis?.match?.venue),
  };
}

interface TotalsSnapshot {
  line: number | null;
  side: 'over' | 'under' | null;
  probability: number | null;
}

function totalsSnapshot(markets: MarketResult[] | undefined): TotalsSnapshot | null {
  if (!Array.isArray(markets)) return null;
  const totals =
    markets.find((market) => market?.key === 'totals' && market.available) ??
    markets.find((market) => market?.key === 'totals');
  if (!totals) return null;

  const side =
    totals.selectionCode === 'over' || totals.selectionCode === 'under'
      ? totals.selectionCode
      : null;
  const line =
    typeof totals.line === 'number' && Number.isFinite(totals.line)
      ? totals.line
      : typeof totals.baseLine === 'number' && Number.isFinite(totals.baseLine)
        ? totals.baseLine
        : null;

  return {
    line,
    side,
    probability:
      typeof totals.probability === 'number' && Number.isFinite(totals.probability)
        ? totals.probability
        : null,
  };
}

/**
 * Mapea el resultado del motor a columnas de `predictions`. Solo se envían
 * campos que existen en `AnalysisResult`; el resto queda null y la base aplica
 * sus propias restricciones.
 */
function predictionRow(
  snapshotId: string,
  analysis: AnalysisResult,
  variant: 'production' | 'shadow' = PRODUCTION_VARIANT,
  paramsVersion: string = PARAMS_VERSION,
): Record<string, unknown> | null {
  if (!analysis || typeof analysis !== 'object') return null;

  const engineVersion = text(analysis.model?.version);
  if (!engineVersion) return null;

  const lambdaHome = round(analysis.lambdas?.home, 3);
  const lambdaAway = round(analysis.lambdas?.away, 3);
  const lambdaTotal = round(
    analysis.lambdas?.total ??
      (lambdaHome !== null && lambdaAway !== null ? lambdaHome + lambdaAway : null),
    3,
  );
  const probHome = round(analysis.winProbabilities?.home, 5);
  const probDraw = round(analysis.winProbabilities?.draw, 5);
  const probAway = round(analysis.winProbabilities?.away, 5);

  if (lambdaHome === null || lambdaAway === null || lambdaTotal === null) return null;
  if (probHome === null || probDraw === null || probAway === null) return null;

  const totals = totalsSnapshot(analysis.markets);
  const anchor = analysis.model?.marketAnchor;

  return {
    snapshot_id: snapshotId,
    variant,
    engine_version: engineVersion,
    params_version: paramsVersion,
    generated_at: toIsoTimestamp(analysis.model?.generatedAt) ?? new Date().toISOString(),
    lambda_home: lambdaHome,
    lambda_away: lambdaAway,
    lambda_total: lambdaTotal,
    prob_home: probHome,
    prob_draw: probDraw,
    prob_away: probAway,
    totals_line: round(totals?.line, 2),
    totals_side: totals?.side ?? null,
    totals_probability: round(totals?.probability, 5),
    market_total_line: round(anchor?.marketTotal, 2),
    anchor_weight: bounded(anchor?.weight, 0, 1, 3),
    data_quality: bounded(analysis.dataQuality?.score, 0, 1, 3),
    // Contrato completo del motor: permite recalcular sin volver a la API.
    payload: analysis,
  };
}

function snapshotResult(data: unknown): { snapshotId: string; inserted: boolean } | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  const { snapshot_id: snapshotId, inserted } = row as {
    snapshot_id?: unknown;
    inserted?: unknown;
  };
  if (typeof snapshotId !== 'string' || !snapshotId) return null;
  return { snapshotId, inserted: inserted === true };
}

/**
 * Captura pre-partido idempotente:
 * 1. Upsert del partido (siempre `scheduled`).
 * 2. `record_snapshot('pre', …)` con el payload canónico; `inserted=false`
 *    significa que el contenido ya estaba guardado.
 * 3. Predicción de producción, ignorando duplicados.
 * 4. Evento de auditoría, best-effort.
 *
 * Nunca lanza: devuelve `error` con un código corto si algo falla.
 */
export async function persistPreAnalysis(
  input: PersistPreAnalysisInput,
): Promise<PersistPreAnalysisResult> {
  const started = Date.now();
  const config = readConfig();
  if (!config) return { status: 'skipped' };

  const response = input?.response;
  const matchId = text(response?.match?.match_id);
  if (!response || !matchId) return { status: 'skipped' };

  if (response.match.status !== 'scheduled') {
    await recordIngestionEvent(config, {
      matchId,
      operation: 'capture_pre',
      status: 'skipped',
      latencyMs: elapsedMs(started),
    });
    return { status: 'skipped' };
  }

  try {
    const canonical = canonicalPreSnapshot(response);
    const contentHash = hashCanonical(canonical);
    // El payload guardado es el canónico (sin campos volátiles) más su propia
    // identidad de contenido: así `record_snapshot` detecta repeticiones.
    const payload = { ...canonical, content_hash: contentHash };

    const row = matchRow(response, input.analysis);
    if (!row) {
      await recordIngestionEvent(config, {
        matchId,
        operation: 'capture_pre',
        status: 'error',
        errorCode: 'invalid_match',
        latencyMs: elapsedMs(started),
      });
      return { status: 'error', errorCode: 'invalid_match' };
    }

    const upsert = await rest(config, {
      method: 'POST',
      path: '/rest/v1/matches',
      query: 'on_conflict=match_id',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: row,
    });
    if (upsert.errorCode) {
      await recordIngestionEvent(config, {
        matchId,
        operation: 'capture_pre',
        status: 'error',
        errorCode: upsert.errorCode,
        latencyMs: elapsedMs(started),
      });
      return { status: 'error', errorCode: upsert.errorCode };
    }

    const rpc = await rest(config, {
      method: 'POST',
      path: '/rest/v1/rpc/record_snapshot',
      prefer: 'return=representation',
      body: {
        p_match_id: matchId,
        p_phase: 'pre',
        p_payload: payload,
        p_completeness: 'complete',
        p_source: SNAPSHOT_SOURCE,
      },
    });
    if (rpc.errorCode) {
      await recordIngestionEvent(config, {
        matchId,
        operation: 'capture_pre',
        status: 'error',
        errorCode: rpc.errorCode,
        latencyMs: elapsedMs(started),
      });
      return { status: 'error', errorCode: rpc.errorCode };
    }

    const snapshot = snapshotResult(rpc.data);
    if (!snapshot) {
      await recordIngestionEvent(config, {
        matchId,
        operation: 'capture_pre',
        status: 'error',
        errorCode: 'invalid_snapshot_response',
        latencyMs: elapsedMs(started),
      });
      return { status: 'error', errorCode: 'invalid_snapshot_response' };
    }

    const engineVersion = text(input.analysis?.model?.version);
    const status: PersistPreAnalysisResult['status'] = snapshot.inserted ? 'ok' : 'duplicate';

    await recordIngestionEvent(config, {
      matchId,
      snapshotId: snapshot.snapshotId,
      operation: 'capture_pre',
      status,
      latencyMs: elapsedMs(started),
      engineVersion,
      paramsVersion: PARAMS_VERSION,
    });

    // Un duplicado también intenta la predicción: pudo faltar en una corrida previa.
    const prediction = predictionRow(snapshot.snapshotId, input.analysis);
    if (!prediction) {
      await recordIngestionEvent(config, {
        matchId,
        snapshotId: snapshot.snapshotId,
        operation: 'generate_predictions',
        status: 'error',
        errorCode: 'invalid_analysis',
        latencyMs: elapsedMs(started),
        engineVersion,
        paramsVersion: PARAMS_VERSION,
      });
      return { status, snapshotId: snapshot.snapshotId };
    }

    const predictionWrite = await rest(config, {
      method: 'POST',
      path: '/rest/v1/predictions',
      query: 'on_conflict=snapshot_id,variant,params_version',
      prefer: 'resolution=ignore-duplicates,return=minimal',
      body: prediction,
    });
    if (predictionWrite.errorCode) {
      await recordIngestionEvent(config, {
        matchId,
        snapshotId: snapshot.snapshotId,
        operation: 'generate_predictions',
        status: 'error',
        errorCode: predictionWrite.errorCode,
        latencyMs: elapsedMs(started),
        engineVersion,
        paramsVersion: PARAMS_VERSION,
      });
    }

    return { status, snapshotId: snapshot.snapshotId };
  } catch {
    await recordIngestionEvent(config, {
      matchId,
      operation: 'capture_pre',
      status: 'error',
      errorCode: 'unexpected',
      latencyMs: elapsedMs(started),
    });
    return { status: 'error', errorCode: 'unexpected' };
  }
}

export interface ShadowConfig {
  version: string;
  params: ReturnType<typeof resolveShadowParams>;
}

const SHADOW_CACHE_MS = 60_000;
let shadowCache: { at: number; value: ShadowConfig | null } | null = null;

/**
 * Fila `shadow` más reciente de `engine_params`, cacheada un minuto por
 * instancia. Sin fila no hay sombra; la captura de producción no se afecta.
 */
async function readShadowConfig(config: SupabaseConfig): Promise<ShadowConfig | null> {
  const now = Date.now();
  if (shadowCache && now - shadowCache.at < SHADOW_CACHE_MS) return shadowCache.value;

  const res = await rest(config, {
    method: 'GET',
    path: '/rest/v1/engine_params',
    query: 'status=eq.shadow&select=version,params&order=created_at.desc&limit=1',
  });
  // Un fallo transitorio no se cachea: la sombra se reintenta en el próximo análisis.
  if (res.errorCode) return null;

  const row = Array.isArray(res.data) ? (res.data[0] as { version?: unknown; params?: unknown } | undefined) : undefined;
  const version = text(row?.version);
  const value: ShadowConfig | null = version
    ? { version, params: resolveShadowParams(row?.params) }
    : null;
  shadowCache = { at: now, value };
  return value;
}

export interface PersistShadowResult {
  status: 'ok' | 'skipped' | 'error';
  errorCode?: string;
}

/**
 * Predicción de la variante sombra para un snapshot pre ya guardado.
 *
 * Usa la fila `shadow` de `engine_params` (si existe), corre el motor con esos
 * parámetros e inserta una predicción `variant=shadow`. Nunca lanza y nunca
 * altera la predicción de producción.
 */
export async function persistShadowAnalysis(input: {
  response: AggregatedResponse;
  matchId: string;
  snapshotId: string;
}): Promise<PersistShadowResult> {
  const started = Date.now();
  const config = readConfig();
  if (!config) return { status: 'skipped' };

  const matchId = text(input?.matchId);
  const snapshotId = text(input?.snapshotId);
  if (!input?.response || !matchId || !snapshotId) return { status: 'skipped' };

  try {
    const shadow = await readShadowConfig(config);
    if (!shadow) return { status: 'skipped' };

    const analysis = analyzeMatch(input.response, { params: shadow.params });
    const prediction = predictionRow(snapshotId, analysis, 'shadow', shadow.version);
    if (!prediction) {
      await recordIngestionEvent(config, {
        matchId,
        snapshotId,
        operation: 'generate_predictions',
        status: 'error',
        errorCode: 'invalid_analysis',
        latencyMs: elapsedMs(started),
        paramsVersion: shadow.version,
        requestId: 'shadow',
      });
      return { status: 'error', errorCode: 'invalid_analysis' };
    }

    const write = await rest(config, {
      method: 'POST',
      path: '/rest/v1/predictions',
      query: 'on_conflict=snapshot_id,variant,params_version',
      prefer: 'resolution=ignore-duplicates,return=minimal',
      body: prediction,
    });
    if (write.errorCode) {
      await recordIngestionEvent(config, {
        matchId,
        snapshotId,
        operation: 'generate_predictions',
        status: 'error',
        errorCode: write.errorCode,
        latencyMs: elapsedMs(started),
        engineVersion: text(analysis.model?.version),
        paramsVersion: shadow.version,
        requestId: 'shadow',
      });
      return { status: 'error', errorCode: write.errorCode };
    }

    await recordIngestionEvent(config, {
      matchId,
      snapshotId,
      operation: 'generate_predictions',
      status: 'ok',
      latencyMs: elapsedMs(started),
      engineVersion: text(analysis.model?.version),
      paramsVersion: shadow.version,
      requestId: 'shadow',
    });
    return { status: 'ok' };
  } catch {
    await recordIngestionEvent(config, {
      matchId,
      snapshotId,
      operation: 'generate_predictions',
      status: 'error',
      errorCode: 'unexpected',
      latencyMs: elapsedMs(started),
      requestId: 'shadow',
    });
    return { status: 'error', errorCode: 'unexpected' };
  }
}

export interface PostMatchInput {
  matchId: string;
  kickoffAt: string;
  leagueId: string;
  leagueName?: string | null;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  phasePayload: unknown;
  completeness: 'partial' | 'complete';
}

/**
 * Registro post-partido: upsert del partido a `finished` con marcador y
 * snapshot `post` (el vigente lo decide `record_snapshot`).
 *
 * Solo se registra si el partido ya tiene captura `pre`: un post suelto no
 * tendría predicción que comparar y quedaría huérfano. Un trigger en la base
 * repite la comprobación para escrituras que no pasan por esta capa.
 * Nunca lanza.
 */
export type RecordPostMatchResult =
  | { status: 'ok'; snapshotId: string; inserted: boolean }
  | { status: 'missing_pre' }
  | { status: 'error'; errorCode: string };

export interface PendingPostMatch {
  matchId: string;
  kickoffAt: string | null;
}

export interface ListPendingPostMatchesOptions {
  /** Máximo de partidos a devolver (1–50). */
  limit?: number;
  /** Solo partidos ya iniciados hace al menos estas horas (1–168). */
  minAgeHours?: number;
}

export type ListPendingPostMatchesResult =
  | { status: 'ok'; matches: PendingPostMatch[] }
  | { status: 'disabled' }
  | { status: 'error'; errorCode: string };

/** Filas de pre que se escanean para construir la lista de pendientes. */
const PENDING_SCAN_CAP = 200;
const DEFAULT_PENDING_LIMIT = 10;
const DEFAULT_MIN_AGE_HOURS = 2;
const PENDING_MATCH_ID = /^[A-Za-z0-9._:-]+$/;

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value as number)));
}

/**
 * Partidos con captura `pre` y sin ningún snapshot `post`, ya iniciados.
 *
 * Se consultan snapshots, no la vista del laboratorio: el contrato de la
 * ingesta solo exige la captura pre, aunque falten predicciones (por ejemplo
 * si la escritura de `predictions` falló). Se deduplica porque un partido puede
 * tener varias capturas pre, y se ordena por captura reciente para que un
 * partido sin resultado disponible no bloquee a los demás.
 */
export async function listPendingPostMatches(
  options: ListPendingPostMatchesOptions = {},
): Promise<ListPendingPostMatchesResult> {
  const config = readConfig();
  if (!config) return { status: 'disabled' };

  const limit = clampInt(options.limit, 1, 50, DEFAULT_PENDING_LIMIT);
  const minAgeHours = clampInt(options.minAgeHours, 1, 24 * 7, DEFAULT_MIN_AGE_HOURS);
  const cutoff = new Date(Date.now() - minAgeHours * 3_600_000).toISOString();

  const pre = await rest(config, {
    method: 'GET',
    path: '/rest/v1/match_snapshots',
    query: [
      'select=match_id,captured_at,matches!inner(kickoff_at)',
      'phase=eq.pre',
      `matches.kickoff_at=lt.${encodeURIComponent(cutoff)}`,
      'order=captured_at.desc',
      `limit=${PENDING_SCAN_CAP}`,
    ].join('&'),
  });
  if (pre.errorCode) return { status: 'error', errorCode: pre.errorCode };

  const candidates = new Map<string, string | null>();
  for (const row of Array.isArray(pre.data) ? pre.data : []) {
    if (!row || typeof row !== 'object') continue;
    const matchId = text((row as { match_id?: unknown }).match_id);
    if (!matchId || !PENDING_MATCH_ID.test(matchId) || candidates.has(matchId)) continue;
    const kickoff = (row as { matches?: { kickoff_at?: unknown } }).matches?.kickoff_at;
    candidates.set(matchId, toIsoTimestamp(kickoff));
  }
  const ids = [...candidates.keys()];
  if (ids.length === 0) return { status: 'ok', matches: [] };

  // Un partido ya cerrado tiene al menos un snapshot post; no importa cuál sea
  // el vigente para decidir si se reintenta la ingesta.
  const closed = await rest(config, {
    method: 'GET',
    path: '/rest/v1/match_snapshots',
    query: [
      'select=match_id',
      'phase=eq.post',
      `match_id=in.(${ids.join(',')})`,
      `limit=${PENDING_SCAN_CAP * 4}`,
    ].join('&'),
  });
  if (closed.errorCode) return { status: 'error', errorCode: closed.errorCode };

  const closedIds = new Set<string>();
  for (const row of Array.isArray(closed.data) ? closed.data : []) {
    const matchId = text((row as { match_id?: unknown })?.match_id);
    if (matchId) closedIds.add(matchId);
  }

  const matches: PendingPostMatch[] = [];
  for (const [matchId, kickoffAt] of candidates) {
    if (closedIds.has(matchId)) continue;
    matches.push({ matchId, kickoffAt });
    if (matches.length >= limit) break;
  }
  return { status: 'ok', matches };
}

/** `true` si el partido ya tiene captura pre; `null` si no se pudo comprobar. */
async function hasPreSnapshot(config: SupabaseConfig, matchId: string): Promise<boolean | null> {
  const res = await rest(config, {
    method: 'GET',
    path: '/rest/v1/match_snapshots',
    query: `match_id=eq.${encodeURIComponent(matchId)}&phase=eq.pre&select=id&limit=1`,
  });
  if (res.errorCode) return null;
  return Array.isArray(res.data) && res.data.length > 0;
}

export async function recordPostMatch(input: PostMatchInput): Promise<RecordPostMatchResult> {
  const started = Date.now();
  const config = readConfig();
  if (!config) return { status: 'error', errorCode: 'persistence_disabled' };

  const matchId = text(input?.matchId);
  if (!matchId) return { status: 'error', errorCode: 'invalid_match' };

  try {
    const kickoffAt = toIsoTimestamp(input.kickoffAt);
    const leagueId = text(input.leagueId);
    const homeName = text(input.homeName);
    const awayName = text(input.awayName);
    const homeScore = input.homeScore;
    const awayScore = input.awayScore;
    const payload = input.phasePayload;
    const completeness = input.completeness === 'partial' ? 'partial' : 'complete';

    const validScores =
      Number.isInteger(homeScore) && homeScore >= 0 && Number.isInteger(awayScore) && awayScore >= 0;
    if (!kickoffAt || !leagueId || !homeName || !awayName || !validScores) {
      const errorCode = !validScores ? 'invalid_score' : 'invalid_match';
      await recordIngestionEvent(config, {
        matchId,
        operation: 'capture_post',
        status: 'error',
        errorCode,
        latencyMs: elapsedMs(started),
      });
      return { status: 'error', errorCode };
    }
    if (!payload || typeof payload !== 'object') {
      await recordIngestionEvent(config, {
        matchId,
        operation: 'capture_post',
        status: 'error',
        errorCode: 'invalid_payload',
        latencyMs: elapsedMs(started),
      });
      return { status: 'error', errorCode: 'invalid_payload' };
    }

    const preExists = await hasPreSnapshot(config, matchId);
    if (preExists === null) {
      await recordIngestionEvent(config, {
        matchId,
        operation: 'capture_post',
        status: 'error',
        errorCode: 'pre_check_failed',
        latencyMs: elapsedMs(started),
      });
      return { status: 'error', errorCode: 'pre_check_failed' };
    }
    if (!preExists) {
      await recordIngestionEvent(config, {
        matchId,
        operation: 'capture_post',
        status: 'skipped',
        errorCode: 'post_without_pre',
        latencyMs: elapsedMs(started),
      });
      return { status: 'missing_pre' };
    }

    const upsert = await rest(config, {
      method: 'POST',
      path: '/rest/v1/matches',
      query: 'on_conflict=match_id',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: {
        match_id: matchId,
        league_id: leagueId,
        league_name: text(input.leagueName),
        kickoff_at: kickoffAt,
        status: 'finished',
        home_name: homeName,
        away_name: awayName,
        home_score: homeScore,
        away_score: awayScore,
      },
    });
    if (upsert.errorCode) {
      await recordIngestionEvent(config, {
        matchId,
        operation: 'capture_post',
        status: 'error',
        errorCode: upsert.errorCode,
        latencyMs: elapsedMs(started),
      });
      return { status: 'error', errorCode: upsert.errorCode };
    }

    const rpc = await rest(config, {
      method: 'POST',
      path: '/rest/v1/rpc/record_snapshot',
      prefer: 'return=representation',
      body: {
        p_match_id: matchId,
        p_phase: 'post',
        p_payload: payload,
        p_completeness: completeness,
        p_source: SNAPSHOT_SOURCE,
      },
    });
    if (rpc.errorCode) {
      await recordIngestionEvent(config, {
        matchId,
        operation: 'capture_post',
        status: 'error',
        errorCode: rpc.errorCode,
        latencyMs: elapsedMs(started),
      });
      return { status: 'error', errorCode: rpc.errorCode };
    }

    const snapshot = snapshotResult(rpc.data);
    if (!snapshot) {
      await recordIngestionEvent(config, {
        matchId,
        operation: 'capture_post',
        status: 'error',
        errorCode: 'invalid_snapshot_response',
        latencyMs: elapsedMs(started),
      });
      return { status: 'error', errorCode: 'invalid_snapshot_response' };
    }

    await recordIngestionEvent(config, {
      matchId,
      snapshotId: snapshot.snapshotId,
      operation: 'capture_post',
      status: snapshot.inserted ? 'ok' : 'duplicate',
      latencyMs: elapsedMs(started),
    });

    return { status: 'ok', ...snapshot };
  } catch {
    await recordIngestionEvent(config, {
      matchId,
      operation: 'capture_post',
      status: 'error',
      errorCode: 'unexpected',
      latencyMs: elapsedMs(started),
    });
    return { status: 'error', errorCode: 'unexpected' };
  }
}
