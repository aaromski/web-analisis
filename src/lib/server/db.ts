import 'server-only';

import type { AggregatedResponse } from '../types/api';
import type { AnalysisResult, MarketResult } from '../types/analysis';
import { analyzeMatch } from '../engine/analyze';
import { resolveShadowParams, SHADOW_PARAMS_VERSION } from '../engine/shadow';
import {
  binaryBrier,
  brierScore,
  brierSkill,
  closingLineValue,
  expectedCalibrationError,
  fitIsotonic,
  handicapOutcome,
  logLoss,
  outcomeCalibrationSamples,
  reliabilityBins,
  topPick,
  totalOutcome,
  type CalibrationSample,
  type IsotonicCalibrator,
  type Outcome,
  type ReliabilityBin,
} from '../audit/metrics';
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
  /** Exactitud por variante sobre los mismos partidos; null sin muestra. */
  backtest: LabBacktest | null;
  /** Scoring de totales y hándicap en la línea exacta de la casa. */
  scoring: LabScoring | null;
  /** Calibración 1X2: ECE, bins de fiabilidad e isotónica. */
  calibration: LabCalibration | null;
  /** Baseline sin vig, skill frente a mercado/azar y CLV del pick. */
  baseline: LabBaseline | null;
  /** Cobertura de la instrumentación; explica muestras pequeñas. */
  dataHealth: LabDataHealth;
  /** Rendimiento por liga y por signo del 1X2. */
  trackRecord: LabTrackRow[];
  /** Versión promovida y candidata vigentes del ciclo automático. */
  engine: LabEngineState;
  /** Memoria del ciclo: últimas pasadas y versiones creadas/promovidas. */
  learning: LabLearningState;
}

export interface LabScoringRow {
  matches: number;
  production: number | null;
  shadow: number | null;
  /** Brier binario del mercado sin vig en la misma línea, si hay cuotas. */
  market: number | null;
}

export interface LabScoring {
  totals: LabScoringRow | null;
  handicap: LabScoringRow | null;
}

export interface LabCalibration {
  matches: number;
  productionEce: number | null;
  shadowEce: number | null;
  bins: ReliabilityBin[];
  shadowBins: ReliabilityBin[];
  isotonic: IsotonicCalibrator | null;
  /** La sombra no debe empeorar la calibración más de un punto porcentual. */
  guard: { ok: boolean; margin: number };
}

export interface LabClv {
  matches: number;
  /** Cambio medio de probabilidad sin vig del pick, positivo = el mercado se movió a favor. */
  mean: number | null;
  /** Proporción de picks cuyo precio se acortó. */
  positiveShare: number | null;
}

export interface LabBaseline {
  /** Partidos con cuotas de mercado comparables en ambos lados. */
  matches: number;
  productionBrier: number | null;
  shadowBrier: number | null;
  marketBrier: number | null;
  naiveBrier: number | null;
  productionSkillVsMarket: number | null;
  shadowSkillVsMarket: number | null;
  productionSkillVsNaive: number | null;
  clv: LabClv;
}

export interface LabDataHealth {
  pairedMatches: number;
  /** Partidos con cuotas de mercado en la traza. */
  marketWin: number;
  /** Partidos con más de una captura pre (permite CLV). */
  recaptured: number;
  /** Pares sin traza de motor (predicciones anteriores a la instrumentación). */
  traceMissing: number;
  totalsAtLine: number;
  handicapAtLine: number;
  lastCaptureAt: string | null;
}

export interface LabTrackRow {
  key: string;
  label: string;
  kind: 'league' | 'market';
  matches: number;
  productionBrier: number | null;
  shadowBrier: number | null;
  marketBrier: number | null;
  /** Sombra − producción; negativo significa que la sombra mejora. */
  delta: number | null;
}

export interface LabEngineState {
  promoted: string | null;
  /** Candidatas automáticas vivas (la referencia fija se informa aparte). */
  candidates: string[];
  /** Control fijo de referencia; acumula para detectar deriva frente a los defaults. */
  reference: string | null;
}

export interface LabLearningVersion {
  version: string;
  status: string;
  createdAt: string | null;
  promotedAt: string | null;
  retiredAt: string | null;
  notes: string | null;
}

export interface LabLearningState {
  /** Una fila por pasada del cron, la más reciente primero. */
  runs: LearningRunRow[];
  /** Versiones del motor de más reciente a más antigua. */
  versions: LabLearningVersion[];
}

export interface LabAccuracy {
  /** Brier multiclase (suma de cuadrados por resultado); menor es mejor. */
  brier: number;
  /** Log-loss de la probabilidad del resultado real; menor es mejor. */
  logLoss: number;
}

export interface LabBacktest {
  matches: number;
  production: LabAccuracy;
  shadow: LabAccuracy;
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

type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PATCH';

interface RequestOptions {
  method: HttpMethod;
  /** Ruta relativa a la URL del proyecto, p. ej. `/rest/v1/matches`. */
  path: string;
  query?: string;
  body?: unknown;
  prefer?: string;
  /** Tiempo máximo propio para lecturas grandes (el default es 1,2 s). */
  timeoutMs?: number;
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
      signal: AbortSignal.timeout(options.timeoutMs ?? config.timeoutMs),
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

type IngestionOperation =
  | 'capture_pre'
  | 'capture_post'
  | 'generate_predictions'
  | 'promote_params'
  | 'purge_payloads'
  | 'backtest';
type IngestionStatus = 'ok' | 'duplicate' | 'skipped' | 'error';

interface IngestionEvent {
  /** Vacío en eventos de proceso (p. ej. una pasada de aprendizaje). */
  matchId?: string | null;
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
      match_id: event.matchId ?? null,
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

export interface LearningRunRow {
  occurredAt: string;
  status: 'ok' | 'duplicate' | 'skipped' | 'error';
  /** Motivo corto de la pasada, p. ej. `candidate-accumulating`. */
  reason: string | null;
  /** Versión promovida o revertida en esa pasada, si hubo. */
  paramsVersion: string | null;
}

const LEARNING_REQUEST_ID = 'learning';

/**
 * Diario del ciclo: una fila por pasada de aprendizaje. Reutiliza la auditoría
 * de ingesta (`operation = backtest`, `request_id = learning`) para no añadir
 * esquema. Es best-effort: un fallo del diario nunca rompe el aprendizaje.
 */
export async function recordLearningRun(input: {
  status: 'ok' | 'skipped' | 'error';
  reason?: string | null;
  paramsVersion?: string | null;
  latencyMs?: number | null;
}): Promise<void> {
  const config = readConfig();
  if (!config) return;
  await recordIngestionEvent(config, {
    operation: 'backtest',
    status: input.status,
    errorCode: input.reason ?? null,
    latencyMs: input.latencyMs ?? null,
    paramsVersion: input.paramsVersion ?? null,
    requestId: LEARNING_REQUEST_ID,
  });
}

/** Últimas pasadas del ciclo, de la más reciente a la más antigua. */
export async function listLearningRuns(limit = 8): Promise<LearningRunRow[] | null> {
  const config = readConfig();
  if (!config) return null;
  const res = await rest(config, {
    method: 'GET',
    path: '/rest/v1/ingestion_events',
    query:
      'select=occurred_at,status,error_code,params_version' +
      `&operation=eq.backtest&request_id=eq.${LEARNING_REQUEST_ID}` +
      `&order=occurred_at.desc&limit=${clampLimit(limit, 1, 20)}`,
    timeoutMs: 10_000,
  });
  if (res.errorCode || !Array.isArray(res.data)) return null;
  return res.data.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const occurredAt = toIsoTimestamp(row.occurred_at);
    const status = row.status;
    if (!occurredAt) return [];
    if (status !== 'ok' && status !== 'duplicate' && status !== 'skipped' && status !== 'error') return [];
    return [{
      occurredAt,
      status,
      reason: text(row.error_code),
      paramsVersion: text(row.params_version),
    }];
  });
}

function emptyDataHealth(): LabDataHealth {
  return {
    pairedMatches: 0,
    marketWin: 0,
    recaptured: 0,
    traceMissing: 0,
    totalsAtLine: 0,
    handicapAtLine: 0,
    lastCaptureAt: null,
  };
}

export function emptyLabSummary(state: LabState): LabSummary {
  return {
    state,
    matchesWithResult: 0,
    required: LAB_REQUIRED_MATCHES,
    markets: [],
    backtest: null,
    scoring: null,
    calibration: null,
    baseline: null,
    dataHealth: emptyDataHealth(),
    trackRecord: [],
    engine: { promoted: null, candidates: [], reference: null },
    learning: { runs: [], versions: [] },
  };
}

interface MarketWinProbability {
  home: number;
  draw: number;
  away: number;
  source: string | null;
}

interface TotalsAtLine {
  line: number;
  over: number;
  under: number;
  push: number;
}

interface HandicapAtLine {
  line: number;
  home: number;
  away: number;
}

interface LabPrediction {
  home: number;
  draw: number;
  away: number;
  totalsLine: number | null;
  totalsSide: 'over' | 'under' | null;
  totalsProbability: number | null;
  totalsAtLine: TotalsAtLine | null;
  handicapAtLine: HandicapAtLine | null;
  marketWin: MarketWinProbability | null;
  marketTotals: { line: number; over: number; under: number } | null;
  marketSpread: { line: number | null; home: number | null; away: number | null } | null;
}

interface SnapshotPair {
  matchId: string;
  leagueId: string | null;
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

function objectField(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function marketWinOf(value: unknown): MarketWinProbability | null {
  const row = objectField(value);
  if (!row) return null;
  const home = probability(row.home);
  const draw = probability(row.draw);
  const away = probability(row.away);
  if (home === null || draw === null || away === null) return null;
  return { home, draw, away, source: text(row.source) };
}

function totalsAtLineOf(value: unknown): TotalsAtLine | null {
  const row = objectField(value);
  if (!row) return null;
  const line = finiteNumber(row.line);
  const over = probability(row.over);
  const under = probability(row.under);
  if (line === null || over === null || under === null) return null;
  return { line, over, under, push: probability(row.push) ?? 0 };
}

function handicapAtLineOf(value: unknown): HandicapAtLine | null {
  const row = objectField(value);
  if (!row) return null;
  const line = finiteNumber(row.line);
  const home = probability(row.home);
  const away = probability(row.away);
  if (line === null || home === null || away === null) return null;
  return { line, home, away };
}

function marketTotalsOf(value: unknown): LabPrediction['marketTotals'] {
  const row = objectField(value);
  if (!row) return null;
  const line = finiteNumber(row.line);
  const over = probability(row.over);
  const under = probability(row.under);
  if (line === null || over === null || under === null) return null;
  return { line, over, under };
}

function marketSpreadOf(value: unknown): LabPrediction['marketSpread'] {
  const row = objectField(value);
  if (!row) return null;
  return { line: finiteNumber(row.line), home: probability(row.home), away: probability(row.away) };
}

function embeddedSnapshot(
  value: unknown,
): { matchId: string; leagueId: string | null; createdAt: number } | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object') return null;
  const matchId = (row as { match_id?: unknown }).match_id;
  if (typeof matchId !== 'string' || !matchId) return null;
  const raw = (row as { created_at?: unknown }).created_at;
  const createdAt = typeof raw === 'string' ? Date.parse(raw) : NaN;
  const match = (row as { matches?: unknown }).matches;
  const matchRow = Array.isArray(match) ? match[0] : match;
  const leagueId = matchRow && typeof matchRow === 'object'
    ? text((matchRow as { league_id?: unknown }).league_id)
    : null;
  return { matchId, leagueId, createdAt: Number.isFinite(createdAt) ? createdAt : 0 };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

type ActualResult = 'home' | 'draw' | 'away';

const PROBABILITY_FLOOR = 1e-15;

/**
 * Brier multiclase y log-loss del resultado real, promediados sobre los
 * partidos con ambas variantes. Ambas métricas son "menor es mejor".
 */
function accuracyOf(
  pairs: SnapshotPair[],
  pick: (pair: SnapshotPair) => LabPrediction,
  actualByMatch: Map<string, ActualResult>,
): LabAccuracy | null {
  const briers: number[] = [];
  const losses: number[] = [];
  for (const pair of pairs) {
    const actual = actualByMatch.get(pair.matchId);
    if (!actual) continue;
    const prediction = pick(pair);
    const probabilities = [prediction.home, prediction.draw, prediction.away];
    const actualIndex = actual === 'home' ? 0 : actual === 'draw' ? 1 : 2;
    let brier = 0;
    for (let index = 0; index < probabilities.length; index += 1) {
      brier += (probabilities[index] - (index === actualIndex ? 1 : 0)) ** 2;
    }
    briers.push(brier);
    losses.push(-Math.log(Math.max(probabilities[actualIndex], PROBABILITY_FLOOR)));
  }
  if (briers.length === 0) return null;
  return {
    brier: Math.round(mean(briers) * 10_000) / 10_000,
    logLoss: Math.round(mean(losses) * 10_000) / 10_000,
  };
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

const LAB_CALIBRATION_MARGIN = 0.01;
/** Muestras mínimas para publicar la isotónica en el laboratorio. */
const LAB_ISOTONIC_MIN_SAMPLES = 30;

function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000) / 10_000;
}

/** Brier/log-loss del 1X2 sin vig de la casa; solo filas con cuotas reales. */
function marketAccuracy(
  pairs: SnapshotPair[],
  actualByMatch: Map<string, ActualResult>,
): LabAccuracy | null {
  const briers: number[] = [];
  const losses: number[] = [];
  for (const pair of pairs) {
    const actual = actualByMatch.get(pair.matchId);
    const market = pair.production?.marketWin ?? pair.shadow?.marketWin ?? null;
    if (!actual || !market || market.source !== 'odds') continue;
    briers.push(brierScore(market, actual));
    losses.push(logLoss(market, actual));
  }
  if (briers.length === 0) return null;
  return { brier: rounded(mean(briers))!, logLoss: rounded(mean(losses))! };
}

/** Baseline trivial: frecuencias históricas de local/empate/visitante. */
function naiveAccuracy(
  pairs: SnapshotPair[],
  actualByMatch: Map<string, ActualResult>,
): LabAccuracy | null {
  const outcomes = pairs
    .map((pair) => actualByMatch.get(pair.matchId))
    .filter((outcome): outcome is ActualResult => Boolean(outcome));
  if (outcomes.length === 0) return null;
  const counts: Record<ActualResult, number> = { home: 0, draw: 0, away: 0 };
  for (const outcome of outcomes) counts[outcome] += 1;
  const base = {
    home: counts.home / outcomes.length,
    draw: counts.draw / outcomes.length,
    away: counts.away / outcomes.length,
  };
  return {
    brier: rounded(mean(outcomes.map((outcome) => brierScore(base, outcome))))!,
    logLoss: rounded(mean(outcomes.map((outcome) => logLoss(base, outcome))))!,
  };
}

/** CLV por partido: apertura y cierre de la cuota sin vig sobre el pick vigente. */
function clvOf(pairs: SnapshotPair[]): LabClv {
  const byMatch = new Map<string, SnapshotPair[]>();
  for (const pair of pairs) {
    const market = pair.production?.marketWin;
    if (!market || market.source !== 'odds') continue;
    const bucket = byMatch.get(pair.matchId) ?? [];
    bucket.push(pair);
    byMatch.set(pair.matchId, bucket);
  }
  const values: number[] = [];
  for (const snapshots of byMatch.values()) {
    if (snapshots.length < 2) continue;
    const ordered = [...snapshots].sort((left, right) => left.createdAt - right.createdAt);
    const open = ordered[0].production!.marketWin;
    const last = ordered[ordered.length - 1].production!;
    const close = last.marketWin;
    if (!open || !close) continue;
    const value = closingLineValue(open, close, topPick(last));
    if (value !== null) values.push(value);
  }
  if (values.length === 0) return { matches: 0, mean: null, positiveShare: null };
  return {
    matches: values.length,
    mean: rounded(mean(values)),
    positiveShare: rounded(values.filter((value) => value > 0).length / values.length),
  };
}

function scoringOf(
  pairs: SnapshotPair[],
  scoresByMatch: Map<string, { home: number; away: number }>,
): LabScoring | null {
  const totals = { production: [] as number[], shadow: [] as number[], market: [] as number[] };
  const handicap = { production: [] as number[], shadow: [] as number[], market: [] as number[] };

  for (const pair of pairs) {
    const score = scoresByMatch.get(pair.matchId);
    const production = pair.production;
    if (!score || !production) continue;

    const totalsTrace = production.totalsAtLine;
    if (totalsTrace) {
      const outcome = totalOutcome(score.home + score.away, totalsTrace.line);
      if (outcome !== 'push') {
        const hit = outcome === 'over';
        totals.production.push(binaryBrier(totalsTrace.over, hit));
        const shadowTrace = pair.shadow?.totalsAtLine;
        if (shadowTrace && Math.abs(shadowTrace.line - totalsTrace.line) < 1e-9) {
          totals.shadow.push(binaryBrier(shadowTrace.over, hit));
        }
        const market = production.marketTotals;
        if (market && Math.abs(market.line - totalsTrace.line) < 1e-9) {
          totals.market.push(binaryBrier(market.over, hit));
        }
      }
    }

    const handicapTrace = production.handicapAtLine;
    if (handicapTrace) {
      const graded = handicapOutcome(score.home - score.away, handicapTrace.line);
      handicap.production.push((handicapTrace.home - graded) ** 2);
      const shadowTrace = pair.shadow?.handicapAtLine;
      if (shadowTrace && Math.abs(shadowTrace.line - handicapTrace.line) < 1e-9) {
        handicap.shadow.push((shadowTrace.home - graded) ** 2);
      }
      const spread = production.marketSpread;
      if (spread && spread.home !== null && spread.line !== null && Math.abs(spread.line - handicapTrace.line) < 1e-9) {
        handicap.market.push((spread.home - graded) ** 2);
      }
    }
  }

  const row = (bucket: { production: number[]; shadow: number[]; market: number[] }): LabScoringRow | null =>
    bucket.production.length === 0
      ? null
      : {
          matches: bucket.production.length,
          production: rounded(mean(bucket.production)),
          shadow: rounded(mean(bucket.shadow)),
          market: rounded(mean(bucket.market)),
        };

  const totalsRow = row(totals);
  const handicapRow = row(handicap);
  if (!totalsRow && !handicapRow) return null;
  return { totals: totalsRow, handicap: handicapRow };
}

function calibrationOf(
  pairs: SnapshotPair[],
  actualByMatch: Map<string, ActualResult>,
): LabCalibration | null {
  const productionSamples: CalibrationSample[] = [];
  const shadowSamples: CalibrationSample[] = [];
  for (const pair of pairs) {
    const actual = actualByMatch.get(pair.matchId);
    if (!actual) continue;
    if (pair.production) productionSamples.push(...outcomeCalibrationSamples(pair.production, actual));
    if (pair.shadow) shadowSamples.push(...outcomeCalibrationSamples(pair.shadow, actual));
  }
  if (productionSamples.length === 0) return null;
  const productionEce = expectedCalibrationError(productionSamples);
  const shadowEce = shadowSamples.length > 0 ? expectedCalibrationError(shadowSamples) : null;
  const ok =
    productionEce === null || shadowEce === null || shadowEce <= productionEce + LAB_CALIBRATION_MARGIN;
  return {
    matches: pairs.length,
    productionEce,
    shadowEce,
    bins: reliabilityBins(productionSamples),
    shadowBins: reliabilityBins(shadowSamples),
    isotonic: productionSamples.length >= LAB_ISOTONIC_MIN_SAMPLES ? fitIsotonic(productionSamples) : null,
    guard: { ok, margin: LAB_CALIBRATION_MARGIN },
  };
}

const TRACK_RECORD_LEAGUE_CAP = 8;
const MARKET_SIDE_LABELS: Record<Outcome, string> = {
  home: 'Local',
  draw: 'Empate',
  away: 'Visitante',
};

function trackRecordOf(
  pairs: SnapshotPair[],
  actualByMatch: Map<string, ActualResult>,
): LabTrackRow[] {
  const byLeague = new Map<string, SnapshotPair[]>();
  for (const pair of pairs) {
    if (!pair.leagueId) continue;
    const bucket = byLeague.get(pair.leagueId) ?? [];
    bucket.push(pair);
    byLeague.set(pair.leagueId, bucket);
  }

  const rows: LabTrackRow[] = [];
  for (const [key, bucket] of byLeague) {
    const production = accuracyOf(bucket, (pair) => pair.production!, actualByMatch);
    const shadow = accuracyOf(bucket, (pair) => pair.shadow!, actualByMatch);
    const market = marketAccuracy(bucket, actualByMatch);
    rows.push({
      key,
      label: key,
      kind: 'league',
      matches: bucket.length,
      productionBrier: production?.brier ?? null,
      shadowBrier: shadow?.brier ?? null,
      marketBrier: market?.brier ?? null,
      delta: production && shadow ? rounded(shadow.brier - production.brier) : null,
    });
  }
  rows.sort((left, right) => right.matches - left.matches || left.key.localeCompare(right.key));

  const marketRows: LabTrackRow[] = [];
  for (const side of ['home', 'draw', 'away'] as Outcome[]) {
    const production: number[] = [];
    const shadow: number[] = [];
    const market: number[] = [];
    for (const pair of pairs) {
      const actual = actualByMatch.get(pair.matchId);
      if (!actual) continue;
      const hit = actual === side;
      if (pair.production) production.push(binaryBrier(pair.production[side], hit));
      if (pair.shadow) shadow.push(binaryBrier(pair.shadow[side], hit));
      const marketWin = pair.production?.marketWin ?? pair.shadow?.marketWin;
      if (marketWin && marketWin.source === 'odds') market.push(binaryBrier(marketWin[side], hit));
    }
    if (production.length === 0) continue;
    const productionBrier = mean(production);
    const shadowBrier = mean(shadow);
    marketRows.push({
      key: `1x2_${side}`,
      label: MARKET_SIDE_LABELS[side],
      kind: 'market',
      matches: production.length,
      productionBrier: rounded(productionBrier),
      shadowBrier: rounded(shadowBrier),
      marketBrier: rounded(mean(market)),
      delta:
        productionBrier !== null && shadowBrier !== null
          ? rounded(shadowBrier - productionBrier)
          : null,
    });
  }

  return [...rows.slice(0, TRACK_RECORD_LEAGUE_CAP), ...marketRows];
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
  if (!config) return emptyLabSummary('disabled');

  try {
    const [predictions, results] = await Promise.all([
      rest(config, {
        method: 'GET',
        path: '/rest/v1/predictions',
        query:
          'select=snapshot_id,variant,prob_home,prob_draw,prob_away,totals_line,totals_side,totals_probability' +
          ',model_totals:payload->model->trace->modelTotalsAtMarketLine' +
          ',model_handicap:payload->model->trace->modelHandicapAtMarketLine' +
          ',market_win:payload->model->trace->marketWin' +
          ',market_totals:payload->model->trace->marketTotals' +
          ',market_spread:payload->model->trace->marketSpread' +
          ',match_snapshots!inner(match_id,created_at,matches!inner(league_id))' +
          `&variant=in.(production,shadow)&limit=${LAB_COUNT_CAP}`,
        // La traza y el embed de liga pesan más que una lectura simple.
        timeoutMs: 3_500,
      }),
      rest(config, {
        method: 'GET',
        path: '/rest/v1/matches',
        query:
          'select=match_id,home_score,away_score&status=eq.finished' +
          `&home_score=not.is.null&away_score=not.is.null&limit=${LAB_COUNT_CAP}`,
        timeoutMs: 3_500,
      }),
    ]);
    if (predictions.errorCode || results.errorCode) return emptyLabSummary('error');

    const actualByMatch = new Map<string, ActualResult>();
    const scoresByMatch = new Map<string, { home: number; away: number }>();
    for (const row of Array.isArray(results.data) ? results.data : []) {
      const record = row as { match_id?: unknown; home_score?: unknown; away_score?: unknown } | null;
      const matchId = record?.match_id;
      const homeScore = record?.home_score;
      const awayScore = record?.away_score;
      if (typeof matchId !== 'string' || !matchId) continue;
      if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore)) continue;
      const home = homeScore as number;
      const away = awayScore as number;
      actualByMatch.set(matchId, home > away ? 'home' : home < away ? 'away' : 'draw');
      scoresByMatch.set(matchId, { home, away });
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
        leagueId: snapshot.leagueId,
        createdAt: snapshot.createdAt,
      };
      pair[variant] = {
        home,
        draw,
        away,
        totalsLine: finiteNumber(record.totals_line),
        totalsSide: side === 'over' || side === 'under' ? side : null,
        totalsProbability: probability(record.totals_probability),
        totalsAtLine: totalsAtLineOf(record.model_totals),
        handicapAtLine: handicapAtLineOf(record.model_handicap),
        marketWin: marketWinOf(record.market_win),
        marketTotals: marketTotalsOf(record.market_totals),
        marketSpread: marketSpreadOf(record.market_spread),
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
    const comparable = [...latest.values()].filter((pair) => actualByMatch.has(pair.matchId));

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

    const productionAccuracy = accuracyOf(
      comparable,
      (pair) => pair.production!,
      actualByMatch,
    );
    const shadowAccuracy = accuracyOf(comparable, (pair) => pair.shadow!, actualByMatch);

    const marketPairs = comparable.filter((pair) => {
      const market = pair.production?.marketWin ?? pair.shadow?.marketWin;
      return market?.source === 'odds';
    });
    const marketBaseline = marketAccuracy(marketPairs, actualByMatch);
    const naiveBaseline = naiveAccuracy(marketPairs, actualByMatch);
    const productionOnMarket = accuracyOf(marketPairs, (pair) => pair.production!, actualByMatch);
    const shadowOnMarket = accuracyOf(marketPairs, (pair) => pair.shadow!, actualByMatch);
    // CLV usa todas las capturas pre, no solo la más reciente de cada partido.
    const clv = clvOf([...bySnapshot.values()]);
    const baseline: LabBaseline | null =
      marketBaseline && naiveBaseline && productionOnMarket && shadowOnMarket
        ? {
            matches: marketPairs.length,
            productionBrier: productionOnMarket.brier,
            shadowBrier: shadowOnMarket.brier,
            marketBrier: marketBaseline.brier,
            naiveBrier: naiveBaseline.brier,
            productionSkillVsMarket: brierSkill(productionOnMarket.brier, marketBaseline.brier),
            shadowSkillVsMarket: brierSkill(shadowOnMarket.brier, marketBaseline.brier),
            productionSkillVsNaive: brierSkill(productionOnMarket.brier, naiveBaseline.brier),
            clv,
          }
        : null;

    const scoring = scoringOf(comparable, scoresByMatch);
    const calibration = calibrationOf(comparable, actualByMatch);
    const trackRecord = trackRecordOf(comparable, actualByMatch);

    const snapshotsByMatch = new Map<string, Set<number>>();
    for (const pair of bySnapshot.values()) {
      const bucket = snapshotsByMatch.get(pair.matchId) ?? new Set<number>();
      bucket.add(pair.createdAt);
      snapshotsByMatch.set(pair.matchId, bucket);
    }
    const lastCaptureAt = comparable.reduce(
      (latestAt, pair) => (pair.createdAt > latestAt ? pair.createdAt : latestAt),
      0,
    );
    const dataHealth: LabDataHealth = {
      pairedMatches: comparable.length,
      marketWin: marketPairs.length,
      recaptured: [...snapshotsByMatch.values()].filter((set) => set.size > 1).length,
      traceMissing: comparable.filter(
        (pair) => !pair.production?.totalsAtLine && !pair.production?.marketWin,
      ).length,
      totalsAtLine: scoring?.totals?.matches ?? 0,
      handicapAtLine: scoring?.handicap?.matches ?? 0,
      lastCaptureAt: lastCaptureAt > 0 ? new Date(lastCaptureAt).toISOString() : null,
    };

    const engineConfigs = await getEngineConfigs().catch(() => null);
    const [learningRuns, versions] = await Promise.all([
      listLearningRuns(8).catch(() => null),
      listEngineHistory(6).catch(() => null),
    ]);

    return {
      state,
      matchesWithResult,
      required: LAB_REQUIRED_MATCHES,
      markets: rows,
      backtest:
        productionAccuracy && shadowAccuracy && matchesWithResult > 0
          ? { matches: matchesWithResult, production: productionAccuracy, shadow: shadowAccuracy }
          : null,
      scoring,
      calibration,
      baseline,
      dataHealth,
      trackRecord,
      engine: {
        promoted: engineConfigs?.promoted?.version ?? null,
        candidates:
          engineConfigs?.shadows
            .map((shadow) => shadow.version)
            .filter((version) => version !== REFERENCE_PARAMS_VERSION) ?? [],
        reference:
          engineConfigs?.shadows.find((shadow) => shadow.version === REFERENCE_PARAMS_VERSION)?.version ??
          null,
      },
      learning: {
        runs: learningRuns ?? [],
        versions: versions ?? [],
      },
    };
  } catch {
    return emptyLabSummary('error');
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
  /** Versión con la que se calculó el análisis; por defecto, los defaults. */
  paramsVersion?: string | null;
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
    const paramsVersion = text(input.paramsVersion) ?? PARAMS_VERSION;
    const status: PersistPreAnalysisResult['status'] = snapshot.inserted ? 'ok' : 'duplicate';

    await recordIngestionEvent(config, {
      matchId,
      snapshotId: snapshot.snapshotId,
      operation: 'capture_pre',
      status,
      latencyMs: elapsedMs(started),
      engineVersion,
      paramsVersion,
    });

    // Un duplicado también intenta la predicción: pudo faltar en una corrida previa.
    const prediction = predictionRow(snapshot.snapshotId, input.analysis, PRODUCTION_VARIANT, paramsVersion);
    if (!prediction) {
      await recordIngestionEvent(config, {
        matchId,
        snapshotId: snapshot.snapshotId,
        operation: 'generate_predictions',
        status: 'error',
        errorCode: 'invalid_analysis',
        latencyMs: elapsedMs(started),
        engineVersion,
        paramsVersion,
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
        paramsVersion,
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
  createdAt: string | null;
  promotedAt: string | null;
}

/** Control fijo: los defaults de 1.2.0 como sombra permanente. */
export const REFERENCE_PARAMS_VERSION = 'baseline-1.2.0-defaults';
/** Tope de sombras evaluadas por análisis (referencia + candidatas). */
export const MAX_SHADOW_VERSIONS = 3;
const SHADOW_READ_LIMIT = 6;

const PARAMS_CACHE_MS = 60_000;
/** Un fallo de red cachea `null` poco tiempo para no añadir latencia al análisis. */
const PARAMS_ERROR_BACKOFF_MS = 10_000;

interface ParamsCacheEntry<T> {
  at: number;
  value: T;
  ttl: number;
}

let promotedCache: ParamsCacheEntry<ShadowConfig | null> | null = null;
let shadowsCache: ParamsCacheEntry<ShadowConfig[] | null> | null = null;

function parseParamsRow(raw: unknown): ShadowConfig | null {
  const row = raw as
    | { version?: unknown; params?: unknown; created_at?: unknown; promoted_at?: unknown }
    | undefined;
  const version = text(row?.version);
  if (!version) return null;
  return {
    version,
    params: resolveShadowParams(row?.params),
    createdAt: toIsoTimestamp(row?.created_at),
    promotedAt: toIsoTimestamp(row?.promoted_at),
  };
}

/**
 * Fila promovida, cacheada un minuto por instancia. Sin fila se usan los
 * defaults; la captura no se ve afectada.
 */
async function readPromotedRow(config: SupabaseConfig): Promise<ShadowConfig | null> {
  const now = Date.now();
  if (promotedCache && now - promotedCache.at < promotedCache.ttl) return promotedCache.value;

  const res = await rest(config, {
    method: 'GET',
    path: '/rest/v1/engine_params',
    query: 'status=eq.promoted&select=version,params,created_at,promoted_at&order=created_at.desc&limit=1',
  });
  if (res.errorCode) {
    promotedCache = { at: now, value: null, ttl: PARAMS_ERROR_BACKOFF_MS };
    return null;
  }

  const value = Array.isArray(res.data) ? parseParamsRow(res.data[0]) : null;
  promotedCache = { at: now, value, ttl: PARAMS_CACHE_MS };
  return value;
}

/**
 * Todas las sombras vigentes (control fijo + candidatas), de la más reciente a
 * la más antigua. `null` si no se pudo leer: el llamador omite la escritura.
 */
async function readShadowRows(config: SupabaseConfig): Promise<ShadowConfig[] | null> {
  const now = Date.now();
  if (shadowsCache && now - shadowsCache.at < shadowsCache.ttl) return shadowsCache.value;

  const res = await rest(config, {
    method: 'GET',
    path: '/rest/v1/engine_params',
    query:
      'select=version,params,created_at,promoted_at' +
      `&or=(version.eq.${REFERENCE_PARAMS_VERSION},status.eq.shadow)` +
      `&order=created_at.desc&limit=${SHADOW_READ_LIMIT}`,
  });
  if (res.errorCode || !Array.isArray(res.data)) {
    shadowsCache = { at: now, value: null, ttl: PARAMS_ERROR_BACKOFF_MS };
    return null;
  }

  const parsed = res.data.flatMap((raw) => {
    const config = parseParamsRow(raw);
    return config ? [config] : [];
  });
  // La referencia va primero para que la ventana de análisis nunca la excluya.
  const reference = parsed.find((config) => config.version === REFERENCE_PARAMS_VERSION) ?? null;
  const others = parsed.filter((config) => config.version !== REFERENCE_PARAMS_VERSION);
  const value = (reference ? [reference, ...others] : others).slice(0, MAX_SHADOW_VERSIONS);
  shadowsCache = { at: now, value, ttl: PARAMS_CACHE_MS };
  return value;
}

/**
 * Parámetros con los que se publica el análisis de producción. `null` cuando
 * la persistencia está desactivada o la base no responde: el llamador cae a
 * los defaults del motor (comportamiento histórico).
 */
export async function getPromotedConfig(): Promise<ShadowConfig | null> {
  const config = readConfig();
  if (!config) return null;
  return readPromotedRow(config);
}

/** Invalida la caché tras una promoción o rollback (proceso actual). */
export function clearParamsCache(): void {
  promotedCache = null;
  shadowsCache = null;
}

export interface EngineConfigs {
  promoted: ShadowConfig | null;
  shadows: ShadowConfig[];
}

/** Configuración activa y sombras; `null` si la persistencia está apagada o falla. */
export async function getEngineConfigs(): Promise<EngineConfigs | null> {
  const config = readConfig();
  if (!config) return null;
  const [promoted, shadows] = await Promise.all([
    readPromotedRow(config),
    readShadowRows(config),
  ]);
  if (shadows === null) return null;
  return { promoted, shadows };
}

export interface EngineHistoryRow {
  version: string;
  status: string;
  createdAt: string | null;
  promotedAt: string | null;
  retiredAt: string | null;
  /** Explicación legible de por qué existe la versión. */
  notes: string | null;
}

export async function listEngineHistory(limit = 20): Promise<EngineHistoryRow[] | null> {
  const config = readConfig();
  if (!config) return null;
  const res = await rest(config, {
    method: 'GET',
    path: '/rest/v1/engine_params',
    query:
      'select=version,status,created_at,promoted_at,retired_at,notes' +
      `&order=created_at.desc&limit=${clampLimit(limit, 1, 50)}`,
  });
  if (res.errorCode || !Array.isArray(res.data)) return null;
  return res.data.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const version = text(row.version);
    const status = text(row.status);
    if (!version || !status) return [];
    return [{
      version,
      status,
      createdAt: toIsoTimestamp(row.created_at),
      promotedAt: toIsoTimestamp(row.promoted_at),
      retiredAt: toIsoTimestamp(row.retired_at),
      notes: text(row.notes),
    }];
  });
}

const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;

function validVersion(value: string | null | undefined): string | null {
  const version = text(value);
  return version && VERSION_PATTERN.test(version) ? version : null;
}

export async function retireEngineVersion(version: string): Promise<{ ok: boolean; errorCode?: string }> {
  const config = readConfig();
  const safe = validVersion(version);
  if (!config) return { ok: false, errorCode: 'disabled' };
  if (!safe) return { ok: false, errorCode: 'invalid_version' };
  const res = await rest(config, {
    method: 'PATCH',
    path: '/rest/v1/engine_params',
    query: `version=eq.${safe}&status=eq.shadow`,
    prefer: 'return=minimal',
    body: { status: 'retired', retired_at: new Date().toISOString() },
  });
  if (res.errorCode) return { ok: false, errorCode: res.errorCode };
  clearParamsCache();
  return { ok: true };
}

export async function insertEngineCandidate(input: {
  version: string;
  params: Record<string, unknown>;
  metrics: Record<string, unknown>;
  notes: string;
}): Promise<{ ok: boolean; errorCode?: string }> {
  const config = readConfig();
  const safe = validVersion(input?.version);
  if (!config) return { ok: false, errorCode: 'disabled' };
  if (!safe) return { ok: false, errorCode: 'invalid_version' };
  const res = await rest(config, {
    method: 'POST',
    path: '/rest/v1/engine_params',
    query: 'on_conflict=version',
    prefer: 'resolution=ignore-duplicates,return=minimal',
    body: {
      version: safe,
      status: 'shadow',
      params: input.params,
      metrics: input.metrics,
      notes: input.notes,
    },
    timeoutMs: 10_000,
  });
  if (res.errorCode) return { ok: false, errorCode: res.errorCode };
  clearParamsCache();
  return { ok: true };
}

export async function promoteParamsVersion(
  version: string,
): Promise<{ ok: boolean; promoted?: string; retired?: string | null; errorCode?: string }> {
  const config = readConfig();
  const safe = validVersion(version);
  if (!config) return { ok: false, errorCode: 'disabled' };
  if (!safe) return { ok: false, errorCode: 'invalid_version' };
  const res = await rest(config, {
    method: 'POST',
    path: '/rest/v1/rpc/set_promoted_params',
    prefer: 'return=representation',
    body: { p_version: safe },
    timeoutMs: 10_000,
  });
  if (res.errorCode) return { ok: false, errorCode: res.errorCode };
  const row = Array.isArray(res.data) ? (res.data[0] as Record<string, unknown> | undefined) : undefined;
  clearParamsCache();
  return {
    ok: true,
    promoted: text(row?.promoted_version) ?? safe,
    retired: text(row?.retired_version),
  };
}

export interface ScoredPrediction {
  matchId: string;
  /** Liga de la vista; null si la fila no la trae. */
  leagueId: string | null;
  snapshotId: string | null;
  variant: string;
  paramsVersion: string;
  brier: number;
  logLoss: number;
  preCapturedAt: string | null;
  /** Probabilidades publicadas del 1X2, para calibrar. */
  probHome: number | null;
  probDraw: number | null;
  probAway: number | null;
  /** λ final y λ pre-ancla (esta última solo con la vista v2). */
  lambdaHome: number | null;
  lambdaAway: number | null;
  preAnchorLambdaHome: number | null;
  preAnchorLambdaAway: number | null;
  /** Línea y lado del total publicado, para el guardarraíl por mercado. */
  totalsLine: number | null;
  totalsSide: 'over' | 'under' | null;
  totalsProbability: number | null;
  /** Línea de totales de la casa. */
  marketTotalLine: number | null;
  /** 1X2 sin vig guardado en la traza (vista v2); null en filas antiguas. */
  marketWin: { home: number; draw: number; away: number; source: string | null } | null;
  /** Línea y precios del hándicap de la casa (vista v2). */
  marketSpread: { line: number | null; home: number | null; away: number | null } | null;
  homeScore: number | null;
  awayScore: number | null;
  /** Peso final del ancla en esa predicción; 0 = motor puro sin mercado. */
  anchorWeight: number | null;
}

const SCORED_PAGE_SIZE = 1_000;
/** Tope defensivo: 5 páginas cubren años de compuerta sin agotar el cron. */
const SCORED_MAX_ROWS = 5_000;

/** Columnas disponibles desde la primera vista. */
const SCORED_BASE_COLUMNS =
  'match_id,league_id,pre_snapshot_id,variant,params_version,brier,log_loss,pre_captured_at' +
  ',prob_home,prob_draw,prob_away,lambda_home,lambda_away' +
  ',totals_line,totals_side,totals_probability,market_total_line,home_score,away_score,anchor_weight';

/** Columnas de la vista v2 (traza de mercado). Se piden solo si existen. */
const SCORED_TRACE_COLUMNS =
  ',pre_anchor_lambda_home,pre_anchor_lambda_away,market_win,market_spread';

let scoredTraceAvailable: boolean | null = null;

/** Los tests que simulan PostgREST necesitan olvidar la capacidad detectada. */
export function resetScoredPredictionCapability(): void {
  scoredTraceAvailable = null;
}

async function fetchScoredPage(
  config: SupabaseConfig,
  columns: string,
  versions: string[],
  offset: number,
): Promise<{ rows: unknown[] | null; errorCode: string | null }> {
  const res = await rest(config, {
    method: 'GET',
    path: '/rest/v1/v_match_backtest',
    query:
      `select=${columns}` +
      `&params_version=in.(${versions.join(',')})&brier=not.is.null&log_loss=not.is.null` +
      '&order=pre_captured_at.asc,match_id.asc,variant.asc,params_version.asc' +
      `&limit=${SCORED_PAGE_SIZE}&offset=${offset}`,
    timeoutMs: 15_000,
  });
  if (res.errorCode || !Array.isArray(res.data)) {
    return { rows: null, errorCode: res.errorCode ?? 'invalid_response' };
  }
  return { rows: res.data, errorCode: null };
}

async function collectScoredRows(
  config: SupabaseConfig,
  columns: string,
  versions: string[],
): Promise<unknown[] | null> {
  const rows: unknown[] = [];
  for (let offset = 0; offset < SCORED_MAX_ROWS; offset += SCORED_PAGE_SIZE) {
    const page = await fetchScoredPage(config, columns, versions, offset);
    if (!page.rows) return null;
    rows.push(...page.rows);
    if (page.rows.length < SCORED_PAGE_SIZE) break;
  }
  return rows;
}

function marketWinTrace(value: unknown): ScoredPrediction['marketWin'] {
  const row = objectField(value);
  if (!row) return null;
  const home = probability(row.home);
  const draw = probability(row.draw);
  const away = probability(row.away);
  if (home === null || draw === null || away === null) return null;
  return { home, draw, away, source: text(row.source) };
}

function marketSpreadTrace(value: unknown): ScoredPrediction['marketSpread'] {
  const row = objectField(value);
  if (!row) return null;
  return { line: finiteNumber(row.line), home: probability(row.home), away: probability(row.away) };
}

/**
 * Métricas por predicción ya calculadas por la vista (incluye versión).
 * Pagina porque la vista crece con cada variante y cada reanálisis; el tope
 * evita que una respuesta enorme tumbe el presupuesto del cron.
 *
 * La traza de mercado vive en la vista v2. Mientras no esté aplicada se cae a
 * las columnas base y se recuerda la capacidad para no repetir el fallo.
 */
export async function listScoredPredictions(versions: string[]): Promise<ScoredPrediction[] | null> {
  const config = readConfig();
  if (!config) return null;
  const safe = versions.map(validVersion).filter((value): value is string => Boolean(value));
  if (safe.length === 0) return [];

  let rows: unknown[] | null = null;
  if (scoredTraceAvailable !== false) {
    rows = await collectScoredRows(config, `${SCORED_BASE_COLUMNS}${SCORED_TRACE_COLUMNS}`, safe);
    scoredTraceAvailable = rows !== null;
  }
  if (!rows) rows = await collectScoredRows(config, SCORED_BASE_COLUMNS, safe);
  if (!rows) return null;

  return rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const matchId = text(row.match_id);
    const variant = text(row.variant);
    const paramsVersion = text(row.params_version);
    const brier = finiteNumber(row.brier);
    const logLoss = finiteNumber(row.log_loss);
    if (!matchId || !variant || !paramsVersion || brier === null || logLoss === null) return [];
    const side = row.totals_side;
    const anchorWeight = finiteNumber(row.anchor_weight);
    return [{
      matchId,
      leagueId: text(row.league_id),
      snapshotId: text(row.pre_snapshot_id),
      variant,
      paramsVersion,
      brier,
      logLoss,
      preCapturedAt: toIsoTimestamp(row.pre_captured_at),
      probHome: probability(row.prob_home),
      probDraw: probability(row.prob_draw),
      probAway: probability(row.prob_away),
      lambdaHome: finiteNumber(row.lambda_home),
      lambdaAway: finiteNumber(row.lambda_away),
      preAnchorLambdaHome: finiteNumber(row.pre_anchor_lambda_home),
      preAnchorLambdaAway: finiteNumber(row.pre_anchor_lambda_away),
      totalsLine: finiteNumber(row.totals_line),
      totalsSide: side === 'over' || side === 'under' ? side : null,
      totalsProbability: probability(row.totals_probability),
      marketTotalLine: finiteNumber(row.market_total_line),
      marketWin: marketWinTrace(row.market_win),
      marketSpread: marketSpreadTrace(row.market_spread),
      homeScore: Number.isInteger(row.home_score) ? (row.home_score as number) : null,
      awayScore: Number.isInteger(row.away_score) ? (row.away_score as number) : null,
      anchorWeight:
        anchorWeight !== null && anchorWeight >= 0 && anchorWeight <= 1 ? anchorWeight : null,
    }];
  });
}

export interface TuningMatch {
  matchId: string;
  kickoffAt: string;
  homeScore: number;
  awayScore: number;
}

export interface TuningSnapshot {
  matchId: string;
  capturedAt: string;
  payload: Record<string, unknown>;
}

export interface TuningDataset {
  matches: TuningMatch[];
  snapshots: TuningSnapshot[];
}

const TUNING_MATCH_LIMIT = 150;
const TUNING_SNAPSHOT_LIMIT = 450;

/**
 * Partidos cerrados y sus capturas pre para recalcular el motor sin red
 * externa. El `payload` canónico reproduce el análisis original bit a bit.
 */
export async function listTuningDataset(): Promise<TuningDataset | null> {
  const config = readConfig();
  if (!config) return null;
  const matchesRes = await rest(config, {
    method: 'GET',
    path: '/rest/v1/matches',
    query:
      'select=match_id,kickoff_at,home_score,away_score&home_score=not.is.null&away_score=not.is.null' +
      `&order=kickoff_at.desc&limit=${TUNING_MATCH_LIMIT}`,
    timeoutMs: 15_000,
  });
  if (matchesRes.errorCode || !Array.isArray(matchesRes.data)) return null;

  const matches = matchesRes.data.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const matchId = text(row.match_id);
    const kickoffAt = toIsoTimestamp(row.kickoff_at);
    const homeScore = typeof row.home_score === 'number' ? row.home_score : null;
    const awayScore = typeof row.away_score === 'number' ? row.away_score : null;
    if (!matchId || !kickoffAt || homeScore === null || awayScore === null) return [];
    return [{ matchId, kickoffAt, homeScore, awayScore }];
  });
  if (matches.length === 0) return { matches, snapshots: [] };

  const snapshotsRes = await rest(config, {
    method: 'GET',
    path: '/rest/v1/match_snapshots',
    query:
      'select=match_id,captured_at,payload&phase=eq.pre&payload=not.is.null' +
      `&match_id=in.(${matches.map((match) => match.matchId).join(',')})` +
      `&order=captured_at.desc&limit=${TUNING_SNAPSHOT_LIMIT}`,
    timeoutMs: 25_000,
  });
  if (snapshotsRes.errorCode || !Array.isArray(snapshotsRes.data)) return null;

  const snapshots = snapshotsRes.data.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const matchId = text(row.match_id);
    const capturedAt = toIsoTimestamp(row.captured_at);
    const payload = row.payload;
    if (!matchId || !capturedAt || !payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
    return [{ matchId, capturedAt, payload: payload as Record<string, unknown> }];
  });
  return { matches, snapshots };
}

function clampLimit(value: unknown, min: number, max: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return min;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

export interface PersistShadowResult {
  status: 'ok' | 'skipped' | 'error';
  errorCode?: string;
}

/**
 * Predicciones de las variantes sombra para un snapshot pre ya guardado.
 *
 * Evalúa la referencia fija y las candidatas vigentes (hasta
 * `MAX_SHADOW_VERSIONS`), corre el motor con cada configuración e inserta una
 * predicción `variant=shadow` por versión. Nunca lanza y nunca altera la
 * predicción de producción: un fallo en una versión no bloquea a las demás.
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
    const shadows = await readShadowRows(config);
    if (!shadows || shadows.length === 0) return { status: 'skipped' };

    let failure: string | null = null;
    for (const shadow of shadows.slice(0, MAX_SHADOW_VERSIONS)) {
      const analysis = analyzeMatch(input.response, { params: shadow.params });
      const prediction = predictionRow(snapshotId, analysis, 'shadow', shadow.version);
      if (!prediction) {
        failure ??= 'invalid_analysis';
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
        continue;
      }

      const write = await rest(config, {
        method: 'POST',
        path: '/rest/v1/predictions',
        query: 'on_conflict=snapshot_id,variant,params_version',
        prefer: 'resolution=ignore-duplicates,return=minimal',
        body: prediction,
      });
      if (write.errorCode) {
        failure ??= write.errorCode;
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
        continue;
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
    }

    return failure ? { status: 'error', errorCode: failure } : { status: 'ok' };
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

export interface RecaptureCandidate {
  matchId: string;
  kickoffAt: string;
}

export interface ListRecaptureCandidatesResult {
  status: 'ok' | 'disabled' | 'error';
  matches: RecaptureCandidate[];
}

/** Ventana por defecto: la última captura útil antes del cierre de cuotas. */
export const RECAPTURE_WINDOW_MS = 3 * 3_600_000;

/**
 * Partidos ya analizados que empiezan dentro de la ventana y siguen
 * programados. Recapturarlos cerca del inicio permite medir CLV entre la
 * primera cuota guardada y el cierre, sin depender de que alguien reanalice.
 */
export async function listRecaptureCandidates(
  options: { nowMs?: number; windowMs?: number; limit?: number } = {},
): Promise<ListRecaptureCandidatesResult> {
  const config = readConfig();
  if (!config) return { status: 'disabled', matches: [] };

  const now = options.nowMs ?? Date.now();
  const windowMs = clampInt(options.windowMs, 60_000, 12 * 3_600_000, RECAPTURE_WINDOW_MS);
  const limit = clampInt(options.limit, 1, 10, 3);
  const end = now + windowMs;

  const res = await rest(config, {
    method: 'GET',
    path: '/rest/v1/matches',
    query: [
      'select=match_id,kickoff_at',
      'status=eq.scheduled',
      `kickoff_at=gte.${encodeURIComponent(new Date(now).toISOString())}`,
      `kickoff_at=lte.${encodeURIComponent(new Date(end).toISOString())}`,
      'match_snapshots!inner(id)',
      'match_snapshots.phase=eq.pre',
      'order=kickoff_at.asc',
      `limit=${limit}`,
    ].join('&'),
  });
  if (res.errorCode) return { status: 'error', matches: [] };

  const matches = (Array.isArray(res.data) ? res.data : []).flatMap((raw) => {
    const row = raw as { match_id?: unknown; kickoff_at?: unknown } | null;
    const matchId = text(row?.match_id);
    const kickoffAt = toIsoTimestamp(row?.kickoff_at);
    if (!matchId || !kickoffAt) return [];
    return [{ matchId, kickoffAt }];
  });
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
