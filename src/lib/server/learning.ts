import { analyzeMatch } from '../engine/analyze';
import type { EngineParams } from '../engine/params';
import { resolveShadowParams } from '../engine/shadow';
import type { AggregatedResponse } from '../types/api';
import {
  getEngineConfigs,
  insertEngineCandidate,
  listEngineHistory,
  listScoredPredictions,
  listTuningDataset,
  promoteParamsVersion,
  retireEngineVersion,
  REFERENCE_PARAMS_VERSION,
  type ScoredPrediction,
  type ShadowConfig,
} from './db';

/**
 * Ciclo automático de mejora: walk-forward multi-fold sobre la escala del ancla,
 * candidatas sombra en paralelo, promoción con guardarraíles y control fijo de
 * referencia. Todo falla en silencio hacia producción: si algo no cuadra, se
 * devuelve un estado y no se toca la fila promovida.
 *
 * El vector sigue siendo de una dimensión (escala del ancla). Con la muestra de
 * la compuerta (~100 partidos) más perillas memorizarían ruido; lo que crece es
 * la evidencia (folds, candidatas y referencia), no el número de parámetros.
 */

const DAY_MS = 86_400_000;

export const LEARNING_GATE_MATCHES = 100;
export const CANDIDATE_MIN_MATCHES = 50;
export const CANDIDATE_MIN_AGE_MS = 7 * DAY_MS;
export const CANDIDATE_STALE_MS = 21 * DAY_MS;
export const MAX_AUTO_CANDIDATES = 2;
export const PROMOTION_MARGIN = 0.004;
export const PROMOTION_CONFIDENCE = 0.95;
export const PROMOTION_COOLDOWN_MS = 30 * DAY_MS;
export const ROLLBACK_MIN_MATCHES = 30;
export const ROLLBACK_MARGIN = 0.01;
export const ROLLBACK_CONFIDENCE = 0.95;
/** Deriva frente al control fijo: más sensible que el rollback entre versiones. */
export const DRIFT_MIN_MATCHES = 50;
export const DRIFT_MARGIN = 0.004;
export const DRIFT_CONFIDENCE = 0.95;
/** Un mercado secundario no puede empeorar más que esto al crear/promover. */
export const GUARDRAIL_MARGIN = 0.004;
export const GUARDRAIL_MIN_MATCHES = 10;
/** El marcador exacto es más ruidoso: su Brier grueso tolera más deriva. */
export const EXACT_GUARDRAIL_MARGIN = 0.02;
/**
 * Segmento donde el motor manda: peso del ancla en producción por debajo de
 * este umbral (incluye los partidos sin cuotas, peso 0). Evita promover una
 * escala que solo gana por acercarse más al mercado.
 */
export const LOW_ANCHOR_MAX_WEIGHT = 0.4;
/** Camino secuencial: dos hipótesis sobre la tasa de aciertos por partido. */
export const SEQUENTIAL_ALT_RATE = 0.65;
export const SEQUENTIAL_ALPHA = 0.05;
export const SEQUENTIAL_BETA = 0.1;
export const SEQUENTIAL_MIN_MATCHES = 25;
export const ANCHOR_SCALES = [0.7, 0.8, 0.9, 1.0, 1.1] as const;
export const FOLD_COUNT = 3;
const VALIDATION_SHARE = 0.2;
const MIN_VALIDATION = 20;
const MIN_TRAIN = 40;
const BOOTSTRAP_SAMPLES = 2_000;
const BOOTSTRAP_SEED = 20261031;
const PROBABILITY_FLOOR = 1e-15;

export type ActualResult = 'home' | 'draw' | 'away';

export interface ProbabilityTriple {
  home: number;
  draw: number;
  away: number;
}

export interface ScoreSummary {
  matches: number;
  brier: number;
  logLoss: number;
}

export interface BinarySummary {
  matches: number;
  brier: number;
}

export function resultOf(homeScore: number, awayScore: number): ActualResult {
  if (homeScore > awayScore) return 'home';
  if (homeScore === awayScore) return 'draw';
  return 'away';
}

export function brierOf(probabilities: ProbabilityTriple, actual: ActualResult): number | null {
  const values = [probabilities.home, probabilities.draw, probabilities.away];
  if (values.some((value) => !Number.isFinite(value))) return null;
  const target = [actual === 'home', actual === 'draw', actual === 'away'];
  return values.reduce((sum, value, index) => sum + (value - (target[index] ? 1 : 0)) ** 2, 0);
}

export function logLossOf(probabilities: ProbabilityTriple, actual: ActualResult): number | null {
  const picked = probabilities[actual];
  if (!Number.isFinite(picked) || picked <= 0) return null;
  return -Math.log(Math.max(picked, PROBABILITY_FLOOR));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Probabilidad bootstrap de que la media quede por debajo (o encima) de cero. */
export function bootstrapProbability(
  values: number[],
  direction: 'below' | 'above',
  samples = BOOTSTRAP_SAMPLES,
  seed = BOOTSTRAP_SEED,
): number {
  if (values.length === 0) return 0;
  const random = mulberry32(seed);
  let hits = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(random() * values.length)];
    }
    const average = sum / values.length;
    if (direction === 'below' ? average < 0 : average > 0) hits += 1;
  }
  return hits / samples;
}

export interface PromotionDecision {
  matches: number;
  mean: number;
  probability: number;
  promote: boolean;
}

/**
 * `diffs = candidata − producción` (Brier); negativo significa mejora.
 * La confianza se puede ajustar (Bonferroni) cuando compiten varias candidatas.
 */
export function evaluatePromotion(
  diffs: number[],
  confidence = PROMOTION_CONFIDENCE,
  margin = PROMOTION_MARGIN,
): PromotionDecision {
  const matches = diffs.length;
  if (matches < CANDIDATE_MIN_MATCHES) {
    return { matches, mean: 0, probability: 0, promote: false };
  }
  const average = mean(diffs);
  const probability = bootstrapProbability(diffs, 'below');
  return {
    matches,
    mean: average,
    probability,
    promote: average <= -margin && probability >= confidence,
  };
}

/** `diffs = nueva promovida − anterior`; positivo significa degradación. */
export function evaluateRollback(diffs: number[]): PromotionDecision {
  const matches = diffs.length;
  if (matches < ROLLBACK_MIN_MATCHES) {
    return { matches, mean: 0, probability: 0, promote: false };
  }
  const average = mean(diffs);
  const probability = bootstrapProbability(diffs, 'above');
  return {
    matches,
    mean: average,
    probability,
    promote: average >= ROLLBACK_MARGIN && probability >= ROLLBACK_CONFIDENCE,
  };
}

/** `diffs = producción − referencia fija`; positivo significa deriva. */
export function evaluateDrift(diffs: number[]): PromotionDecision {
  const matches = diffs.length;
  if (matches < DRIFT_MIN_MATCHES) {
    return { matches, mean: 0, probability: 0, promote: false };
  }
  const average = mean(diffs);
  const probability = bootstrapProbability(diffs, 'above');
  return {
    matches,
    mean: average,
    probability,
    promote: average >= DRIFT_MARGIN && probability >= DRIFT_CONFIDENCE,
  };
}

export interface GuardrailDecision {
  matches: number;
  mean: number;
  ok: boolean;
}

/**
 * Guardarraíl de un mercado secundario. Sin muestra suficiente se deja pasar
 * (la decisión principal ya exige 50 partidos emparejados).
 */
export function evaluateGuardrail(diffs: number[]): GuardrailDecision {
  if (diffs.length < GUARDRAIL_MIN_MATCHES) {
    return { matches: diffs.length, mean: 0, ok: true };
  }
  const average = mean(diffs);
  return { matches: diffs.length, mean: average, ok: average <= GUARDRAIL_MARGIN };
}

export interface SequentialDecision {
  matches: number;
  wins: number;
  losses: number;
  /** Log-verosimilitud acumulada (H1 frente a H0). */
  logLikelihood: number;
  promote: boolean;
}

/**
 * Prueba secuencial de Wald sobre el signo del diferencial emparejado.
 *
 * H0: la candidata acierta el 50 % de los partidos; H1: el 65 %. El umbral
 * superior `ln((1−β)/α)` acota el error tipo I, así que una racha fuerte puede
 * promover antes de los 50 pares sin inflar los falsos positivos. Los empates
 * no votan pero sí cuentan para el mínimo de muestra y para la media.
 */
export function evaluateSequential(
  diffs: number[],
  options: {
    /** α por candidata (dividido entre las que compiten, Bonferroni). */
    alpha?: number;
    beta?: number;
    alternative?: number;
    margin?: number;
    minMatches?: number;
  } = {},
): SequentialDecision {
  const alpha = options.alpha ?? SEQUENTIAL_ALPHA;
  const beta = options.beta ?? SEQUENTIAL_BETA;
  const alternative = options.alternative ?? SEQUENTIAL_ALT_RATE;
  const margin = options.margin ?? PROMOTION_MARGIN;
  const minMatches = options.minMatches ?? SEQUENTIAL_MIN_MATCHES;

  let wins = 0;
  let losses = 0;
  for (const diff of diffs) {
    if (diff < 0) wins += 1;
    else if (diff > 0) losses += 1;
  }
  const logLikelihood =
    wins * Math.log(alternative / 0.5) + losses * Math.log((1 - alternative) / 0.5);
  const upper = Math.log((1 - beta) / alpha);
  const matches = diffs.length;
  return {
    matches,
    wins,
    losses,
    logLikelihood,
    promote:
      matches >= minMatches &&
      wins + losses >= minMatches &&
      logLikelihood >= upper &&
      mean(diffs) <= -margin,
  };
}

/** Brier binario del total publicado; `null` sin línea, sin marcador o con push. */
export function totalsBrier(row: ScoredPrediction): number | null {
  if (row.totalsLine === null || row.totalsSide === null || row.totalsProbability === null) return null;
  if (row.homeScore === null || row.awayScore === null) return null;
  const total = row.homeScore + row.awayScore;
  if (Math.abs(total - row.totalsLine) < 1e-9) return null;
  const target = row.totalsSide === 'over' ? total > row.totalsLine : total < row.totalsLine;
  return (row.totalsProbability - (target ? 1 : 0)) ** 2;
}

/** Mejor escala por Brier; empate resuelto por cercanía a 1 (neutro). */
export function pickBestScale(rows: Array<{ scale: number; brier: number }>): number | null {
  let best: { scale: number; brier: number } | null = null;
  for (const row of rows) {
    if (!Number.isFinite(row.brier)) continue;
    if (!best) {
      best = row;
      continue;
    }
    const tolerance = 1e-12;
    if (row.brier < best.brier - tolerance) best = row;
    else if (Math.abs(row.brier - best.brier) <= tolerance && Math.abs(row.scale - 1) < Math.abs(best.scale - 1)) {
      best = row;
    }
  }
  return best?.scale ?? null;
}

export interface WalkForwardWindow {
  /** Partidos usados como entrenamiento (crece con cada fold). */
  trainMatches: number;
  validationStart: number;
  validationEnd: number;
}

/**
 * Ventanas expansivas con validaciones contiguas y disjuntas al final de la
 * serie. Cada partido se valida una sola vez y el entrenamiento nunca ve el
 * futuro de su ventana.
 */
export function walkForwardWindows(total: number): WalkForwardWindow[] {
  const size = Math.max(MIN_VALIDATION, Math.floor(total * VALIDATION_SHARE));
  const available = Math.floor((total - MIN_TRAIN) / size);
  const folds = Math.min(FOLD_COUNT, available);
  if (folds < 2) return [];
  const windows: WalkForwardWindow[] = [];
  for (let index = 0; index < folds; index += 1) {
    const validationStart = total - (folds - index) * size;
    windows.push({
      trainMatches: validationStart,
      validationStart,
      validationEnd: validationStart + size,
    });
  }
  return windows;
}

function canonicalToResponse(payload: Record<string, unknown>): AggregatedResponse | null {
  const matchId = typeof payload.match_id === 'string' ? payload.match_id : null;
  if (!matchId) return null;
  const league = payload.league as { id?: unknown; name?: unknown } | undefined;
  const teams = payload.teams as AggregatedResponse['teams'] | undefined;
  if (!teams?.home || !teams?.away) return null;
  return {
    match: {
      match_id: matchId,
      league: {
        id: typeof league?.id === 'string' ? league.id : '',
        name: typeof league?.name === 'string' ? league.name : 'Liga',
      },
      season: typeof payload.season === 'string' ? payload.season : undefined,
      date: typeof payload.kickoff_at === 'string' ? payload.kickoff_at : new Date(0).toISOString(),
      status: 'scheduled',
      venue: typeof payload.venue === 'string' ? payload.venue : undefined,
      score: { home: null, away: null },
    },
    teams,
    pre_match: (payload.pre_match as AggregatedResponse['pre_match']) ?? null,
    meta: {},
  };
}

interface TuningEntry {
  matchId: string;
  payload: Record<string, unknown>;
  homeScore: number;
  awayScore: number;
  actual: ActualResult;
}

interface AnchorSummary {
  matches: number;
  /** Partidos donde el ancla de mercado se aplicó. */
  applied: number;
  /** Suma de pesos finales (solo partidos anclados) para promediar. */
  weightSum: number;
}

interface DetailedScore extends ScoreSummary {
  /** Objetivo compuesto 1X2 + totales (0–1, menor es mejor). */
  composite: number;
  totals: BinarySummary | null;
  btts: BinarySummary | null;
  exact: BinarySummary | null;
  anchor: AnchorSummary;
}

type Analysis = ReturnType<typeof analyzeMatch>;

/**
 * Brier grueso del marcador exacto: top de la matriz más una categoría
 * "otro" con la probabilidad residual. Es una puntuación propia, así que
 * castiga tanto ignorar el marcador real como repartir masa de más.
 */
export function exactScoreBrier(
  scores: Array<{ home: number; away: number; probability: number }>,
  home: number,
  away: number,
): number | null {
  const seen = new Set<string>();
  let residual = 1;
  let sum = 0;
  let covered = false;
  for (const score of scores) {
    if (!Number.isFinite(score.probability) || score.probability < 0) continue;
    const key = `${score.home}-${score.away}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const probabilityValue = Math.min(1, score.probability);
    residual -= probabilityValue;
    const target = score.home === home && score.away === away;
    if (target) covered = true;
    sum += (probabilityValue - (target ? 1 : 0)) ** 2;
  }
  if (seen.size === 0) return null;
  // "Otro" es la séptima categoría; incluye el marcador real si no está arriba.
  sum += (Math.max(0, residual) - (covered ? 0 : 1)) ** 2;
  return sum;
}

function exactFromAnalysis(analysis: Analysis, entry: TuningEntry): number | null {
  const market = analysis.markets.find((candidate) => candidate.key === 'exact_score');
  if (!market?.scores || market.scores.length === 0) return null;
  return exactScoreBrier(market.scores, entry.homeScore, entry.awayScore);
}

/** Brier binario del mercado de totales tal como se publicaría. */
function totalsFromAnalysis(analysis: Analysis, entry: TuningEntry): number | null {
  const market = analysis.markets.find((candidate) => candidate.key === 'totals');
  if (!market || !market.available || market.line === null) return null;
  if (market.selectionCode !== 'over' && market.selectionCode !== 'under') return null;
  const total = entry.homeScore + entry.awayScore;
  if (Math.abs(total - market.line) < 1e-9) return null;
  const target = market.selectionCode === 'over' ? total > market.line : total < market.line;
  return (market.probability - (target ? 1 : 0)) ** 2;
}

/** Brier binario del mercado de ambos anotan. */
function bttsFromAnalysis(analysis: Analysis, entry: TuningEntry): number | null {
  const market = analysis.markets.find((candidate) => candidate.key === 'btts');
  if (!market || !market.available) return null;
  if (market.selectionCode !== 'yes' && market.selectionCode !== 'no') return null;
  const both = entry.homeScore > 0 && entry.awayScore > 0;
  const target = market.selectionCode === 'yes' ? both : !both;
  return (market.probability - (target ? 1 : 0)) ** 2;
}

function scoreDetailed(entries: TuningEntry[], params: EngineParams): DetailedScore | null {
  let matches = 0;
  let brierSum = 0;
  let lossSum = 0;
  let compositeSum = 0;
  let totalsSum = 0;
  let totalsCount = 0;
  let bttsSum = 0;
  let bttsCount = 0;
  let exactSum = 0;
  let exactCount = 0;
  let anchorApplied = 0;
  let anchorWeightSum = 0;

  for (const entry of entries) {
    const response = canonicalToResponse(entry.payload);
    if (!response) continue;
    let analysis: Analysis;
    try {
      analysis = analyzeMatch(response, { params });
    } catch {
      continue;
    }
    const probabilities = analysis.winProbabilities;
    if (!probabilities) continue;
    const brier = brierOf(probabilities, entry.actual);
    const logLoss = logLossOf(probabilities, entry.actual);
    if (brier === null || logLoss === null) continue;
    matches += 1;
    brierSum += brier;
    lossSum += logLoss;

    const totals = totalsFromAnalysis(analysis, entry);
    if (totals !== null) {
      totalsSum += totals;
      totalsCount += 1;
    }
    compositeSum += totals === null ? brier / 2 : 0.5 * (brier / 2) + 0.5 * totals;

    const btts = bttsFromAnalysis(analysis, entry);
    if (btts !== null) {
      bttsSum += btts;
      bttsCount += 1;
    }
    const exact = exactFromAnalysis(analysis, entry);
    if (exact !== null) {
      exactSum += exact;
      exactCount += 1;
    }
    const anchor = analysis.model.marketAnchor;
    if (anchor.applied && Number.isFinite(anchor.weight)) {
      anchorApplied += 1;
      anchorWeightSum += anchor.weight;
    }
  }

  if (matches === 0) return null;
  return {
    matches,
    brier: brierSum / matches,
    logLoss: lossSum / matches,
    composite: compositeSum / matches,
    totals: totalsCount > 0 ? { matches: totalsCount, brier: totalsSum / totalsCount } : null,
    btts: bttsCount > 0 ? { matches: bttsCount, brier: bttsSum / bttsCount } : null,
    exact: exactCount > 0 ? { matches: exactCount, brier: exactSum / exactCount } : null,
    anchor: { matches, applied: anchorApplied, weightSum: anchorWeightSum },
  };
}

/** Media ponderada por número de partidos de varios tramos disjuntos. */
function combineScores(scores: DetailedScore[]): DetailedScore | null {
  if (scores.length === 0) return null;
  let matches = 0;
  let brierSum = 0;
  let lossSum = 0;
  let compositeSum = 0;
  let totalsMatches = 0;
  let totalsSum = 0;
  let bttsMatches = 0;
  let bttsSum = 0;
  let exactMatches = 0;
  let exactSum = 0;
  let anchorApplied = 0;
  let anchorWeightSum = 0;
  for (const score of scores) {
    matches += score.matches;
    brierSum += score.brier * score.matches;
    lossSum += score.logLoss * score.matches;
    compositeSum += score.composite * score.matches;
    anchorApplied += score.anchor.applied;
    anchorWeightSum += score.anchor.weightSum;
    if (score.totals) {
      totalsMatches += score.totals.matches;
      totalsSum += score.totals.brier * score.totals.matches;
    }
    if (score.btts) {
      bttsMatches += score.btts.matches;
      bttsSum += score.btts.brier * score.btts.matches;
    }
    if (score.exact) {
      exactMatches += score.exact.matches;
      exactSum += score.exact.brier * score.exact.matches;
    }
  }
  return {
    matches,
    brier: brierSum / matches,
    logLoss: lossSum / matches,
    composite: compositeSum / matches,
    totals: totalsMatches > 0 ? { matches: totalsMatches, brier: totalsSum / totalsMatches } : null,
    btts: bttsMatches > 0 ? { matches: bttsMatches, brier: bttsSum / bttsMatches } : null,
    exact: exactMatches > 0 ? { matches: exactMatches, brier: exactSum / exactMatches } : null,
    anchor: { matches, applied: anchorApplied, weightSum: anchorWeightSum },
  };
}

function secondaryGuard(
  candidate: BinarySummary | null,
  baseline: BinarySummary | null,
  margin = GUARDRAIL_MARGIN,
): boolean {
  if (!candidate || !baseline) return true;
  if (candidate.matches < GUARDRAIL_MIN_MATCHES) return true;
  return candidate.brier <= baseline.brier + margin;
}

function withAnchorScale(base: EngineParams, scale: number): EngineParams {
  return { ...base, anchor: { ...base.anchor, scaleMin: scale, scaleMax: scale } };
}

function isAutoCandidate(version: string): boolean {
  return version.startsWith('auto-anchor-');
}

function latestBy(
  rows: ScoredPrediction[],
  paramsVersion: string,
  variant: string,
  keyOf: (row: ScoredPrediction) => string,
): Map<string, ScoredPrediction> {
  const latest = new Map<string, ScoredPrediction>();
  for (const row of rows) {
    if (row.paramsVersion !== paramsVersion || row.variant !== variant) continue;
    const key = keyOf(row);
    const current = latest.get(key);
    if (!current) {
      latest.set(key, row);
      continue;
    }
    const currentTime = current.preCapturedAt ? Date.parse(current.preCapturedAt) : 0;
    const rowTime = row.preCapturedAt ? Date.parse(row.preCapturedAt) : 0;
    if (rowTime > currentTime) latest.set(key, row);
  }
  return latest;
}

const byMatch = (row: ScoredPrediction): string => row.matchId;
const bySnapshot = (row: ScoredPrediction): string => row.snapshotId ?? `match:${row.matchId}`;

/**
 * Brier sombra − producción por partido. Se empareja por snapshot (ambas
 * variantes se calculan sobre la misma captura) y, si hubo reanálisis, se
 * conserva el par más reciente para no ponderar dos veces el mismo partido.
 */
function promotionDiffs(
  rows: ScoredPrediction[],
  shadowVersion: string,
  promotedVersion: string,
): number[] {
  const shadow = latestBy(rows, shadowVersion, 'shadow', bySnapshot);
  const production = latestBy(rows, promotedVersion, 'production', bySnapshot);
  const perMatch = new Map<string, { at: number; diff: number }>();
  for (const [snapshotId, shadowRow] of shadow) {
    const productionRow = production.get(snapshotId);
    if (!productionRow) continue;
    const at = shadowRow.preCapturedAt ? Date.parse(shadowRow.preCapturedAt) : 0;
    const current = perMatch.get(shadowRow.matchId);
    if (!current || at >= current.at) {
      perMatch.set(shadowRow.matchId, { at, diff: shadowRow.brier - productionRow.brier });
    }
  }
  return [...perMatch.values()].map((entry) => entry.diff);
}

/**
 * Objetivo compuesto: 0,5 × Brier 1X2 normalizado + 0,5 × Brier del total
 * publicado. Sin línea se puntúa solo el 1X2 normalizado, así ninguna fila
 * queda fuera del objetivo.
 */
export function compositeBrier(row: ScoredPrediction): number {
  const result = row.brier / 2;
  const totals = totalsBrier(row);
  return totals === null ? result : 0.5 * result + 0.5 * totals;
}

function pairedDiffBy(
  rows: ScoredPrediction[],
  shadowVersion: string,
  promotedVersion: string,
  scoreOf: (row: ScoredPrediction) => number | null,
): number[] {
  const shadow = latestBy(rows, shadowVersion, 'shadow', bySnapshot);
  const production = latestBy(rows, promotedVersion, 'production', bySnapshot);
  const perMatch = new Map<string, { at: number; diff: number }>();
  for (const [snapshotId, shadowRow] of shadow) {
    const productionRow = production.get(snapshotId);
    if (!productionRow) continue;
    const left = scoreOf(shadowRow);
    const right = scoreOf(productionRow);
    if (left === null || right === null) continue;
    const at = shadowRow.preCapturedAt ? Date.parse(shadowRow.preCapturedAt) : 0;
    const current = perMatch.get(shadowRow.matchId);
    if (!current || at >= current.at) {
      perMatch.set(shadowRow.matchId, { at, diff: left - right });
    }
  }
  return [...perMatch.values()].map((entry) => entry.diff);
}

/** Brier de totales sombra − producción por partido, cuando la vista lo permite. */
export function totalsDiffs(
  rows: ScoredPrediction[],
  shadowVersion: string,
  promotedVersion: string,
): number[] {
  return pairedDiffBy(rows, shadowVersion, promotedVersion, totalsBrier);
}

/** Objetivo compuesto sombra − producción por partido (negativo = mejora). */
export function compositeDiffs(
  rows: ScoredPrediction[],
  shadowVersion: string,
  promotedVersion: string,
): number[] {
  return pairedDiffBy(rows, shadowVersion, promotedVersion, compositeBrier);
}

/**
 * Mismo diferencial compuesto, restringido a partidos donde producción apenas
 * se ancló al mercado. Si la candidata gana solo porque copia más las cuotas,
 * este segmento lo delata: ahí el motor decide.
 */
export function lowAnchorDiffs(
  rows: ScoredPrediction[],
  shadowVersion: string,
  promotedVersion: string,
): number[] {
  const shadow = latestBy(rows, shadowVersion, 'shadow', bySnapshot);
  const production = latestBy(rows, promotedVersion, 'production', bySnapshot);
  const perMatch = new Map<string, { at: number; diff: number }>();
  for (const [snapshotId, productionRow] of production) {
    const weight = productionRow.anchorWeight;
    if (weight === null || weight > LOW_ANCHOR_MAX_WEIGHT) continue;
    const shadowRow = shadow.get(snapshotId);
    if (!shadowRow) continue;
    const at = productionRow.preCapturedAt ? Date.parse(productionRow.preCapturedAt) : 0;
    const current = perMatch.get(productionRow.matchId);
    if (!current || at >= current.at) {
      perMatch.set(productionRow.matchId, {
        at,
        diff: compositeBrier(shadowRow) - compositeBrier(productionRow),
      });
    }
  }
  return [...perMatch.values()].map((entry) => entry.diff);
}

function pairedDiffs(left: Map<string, ScoredPrediction>, right: Map<string, ScoredPrediction>, since?: number): number[] {
  const diffs: number[] = [];
  for (const [matchId, leftRow] of left) {
    const rightRow = right.get(matchId);
    if (!rightRow) continue;
    if (since !== undefined) {
      const captured = leftRow.preCapturedAt ? Date.parse(leftRow.preCapturedAt) : 0;
      if (!Number.isFinite(captured) || captured <= since) continue;
    }
    diffs.push(leftRow.brier - rightRow.brier);
  }
  return diffs;
}

function formatScale(scale: number): string {
  return String(Math.round(scale * 100)).padStart(3, '0');
}

function dateStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');
}

/** Huella FNV-1a del conjunto de partidos: audita qué muestra produjo la candidata. */
function datasetHash(keys: string[]): string {
  let hash = 0x811c9dc5;
  for (const key of keys) {
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

export interface LearningOptions {
  /** Marca temporal límite (epoch ms) para no agotar el presupuesto del cron. */
  deadlineMs?: number;
}

export interface LearningSummary {
  state: 'ok' | 'disabled' | 'skipped' | 'error';
  reason?: string;
  datasetMatches?: number;
  shadowMatches?: number;
  reference?: string | null;
  candidate?: {
    version: string;
    scale: number;
    validationComposite: number;
    baselineComposite: number;
  } | null;
  candidates?: Array<{ version: string; scale: number }>;
  promotion?: { version: string; retired: string | null } | null;
  rollback?: { version: string; retired: string | null } | null;
  drift?: { matches: number; mean: number; probability: number };
}

/**
 * Una pasada del ciclo. No lanza: devuelve `state` y, si aplica, la decisión.
 * Pensado para el cron diario tras la ingesta de resultados.
 */
export async function runLearning(
  nowMs = Date.now(),
  options: LearningOptions = {},
): Promise<LearningSummary> {
  try {
    return await run(nowMs, options);
  } catch {
    return { state: 'error', reason: 'unexpected' };
  }
}

function budgetExceeded(deadlineMs?: number): boolean {
  return deadlineMs !== undefined && Date.now() > deadlineMs;
}

async function run(nowMs: number, options: LearningOptions): Promise<LearningSummary> {
  const configs = await getEngineConfigs();
  if (!configs) return { state: 'disabled' };
  const promoted = configs.promoted;
  if (!promoted) return { state: 'skipped', reason: 'no-promoted' };

  const shadows = [...configs.shadows];
  if (!shadows.some((shadow) => shadow.version === REFERENCE_PARAMS_VERSION)) {
    const ensured = await ensureReference();
    if (ensured) shadows.unshift(ensured);
  }
  const reference = shadows.find((shadow) => shadow.version === REFERENCE_PARAMS_VERSION) ?? null;

  const rollback = await checkRollback(promoted);
  if (rollback) return rollback;

  const drift = await checkDrift(promoted, reference, nowMs);
  if (drift) return drift;

  // Controles heredados (sombra sin ancla): solo acumulan y se retiran a la compuerta.
  const accumulatingControls: number[] = [];
  for (const control of shadows) {
    if (control.version === REFERENCE_PARAMS_VERSION || isAutoCandidate(control.version)) continue;
    const matches = await countShadowMatches(control.version);
    if (matches < LEARNING_GATE_MATCHES) {
      accumulatingControls.push(matches);
      continue;
    }
    const retired = await retireEngineVersion(control.version);
    if (!retired.ok) return { state: 'error', reason: retired.errorCode ?? 'retire-failed' };
  }
  if (accumulatingControls.length > 0) {
    return {
      state: 'skipped',
      reason: 'control-accumulating',
      shadowMatches: Math.max(...accumulatingControls),
    };
  }

  const candidates = shadows.filter(
    (shadow) => shadow.version !== REFERENCE_PARAMS_VERSION && isAutoCandidate(shadow.version),
  );
  if (candidates.length > 0) return evaluateCandidates(candidates, promoted, nowMs, options.deadlineMs);

  return tuneCandidate(promoted, nowMs, options.deadlineMs);
}

async function ensureReference(): Promise<ShadowConfig | null> {
  const write = await insertEngineCandidate({
    version: REFERENCE_PARAMS_VERSION,
    params: {},
    metrics: { role: 'reference', anchor: 'defaults-1.2.0' },
    notes:
      'Control fijo: defaults de 1.2.0 como sombra permanente. Mide la deriva del motor promovido y nunca se promociona.',
  });
  if (!write.ok) return null;
  return {
    version: REFERENCE_PARAMS_VERSION,
    params: resolveShadowParams({}),
    createdAt: null,
    promotedAt: null,
  };
}

async function countShadowMatches(version: string): Promise<number> {
  const scored = await listScoredPredictions([version]);
  if (!scored) return 0;
  return countDistinctMatches(scored, version, 'shadow');
}

function countDistinctMatches(rows: ScoredPrediction[], version: string, variant: string): number {
  const matches = new Set<string>();
  for (const row of rows) {
    if (row.paramsVersion === version && row.variant === variant) matches.add(row.matchId);
  }
  return matches.size;
}

async function checkRollback(promoted: ShadowConfig): Promise<LearningSummary | null> {
  if (!promoted.promotedAt) return null;
  const since = Date.parse(promoted.promotedAt);
  if (!Number.isFinite(since)) return null;

  const history = await listEngineHistory(30);
  if (!history) return null;
  const previous = history
    .filter((row) => row.version !== promoted.version && row.promotedAt && row.retiredAt)
    .sort((left, right) => Date.parse(right.retiredAt ?? '') - Date.parse(left.retiredAt ?? ''))[0];
  if (!previous) return null;

  const scored = await listScoredPredictions([promoted.version, previous.version]);
  if (!scored) return null;
  const current = latestBy(scored, promoted.version, 'production', byMatch);
  const older = latestBy(scored, previous.version, 'production', byMatch);
  const decision = evaluateRollback(pairedDiffs(current, older, since));
  if (!decision.promote) return null;

  const result = await promoteParamsVersion(previous.version);
  if (!result.ok) return { state: 'error', reason: result.errorCode ?? 'rollback-failed' };
  return {
    state: 'ok',
    reason: 'rolled-back',
    rollback: { version: previous.version, retired: result.retired ?? null },
  };
}

/**
 * Deriva frente al control fijo: si la producción empeora de forma sostenida
 * contra los defaults, se vuelve a ellos con una versión nueva (la referencia
 * sigue siendo sombra para seguir midiendo).
 */
async function checkDrift(
  promoted: ShadowConfig,
  reference: ShadowConfig | null,
  nowMs: number,
): Promise<LearningSummary | null> {
  if (!reference || promoted.version === REFERENCE_PARAMS_VERSION) return null;
  const scored = await listScoredPredictions([promoted.version, reference.version]);
  if (!scored) return null; // fail-open: la deriva no puede romper el ciclo
  // promotionDiffs mide sombra − producción; aquí la referencia es la sombra y
  // la deriva es producción − referencia, así que se invierte el signo.
  const diffs = promotionDiffs(scored, reference.version, promoted.version).map((value) => -value);
  const decision = evaluateDrift(diffs);
  if (!decision.promote) return null;

  const version = `auto-rollback-${dateStamp(nowMs)}`;
  const write = await insertEngineCandidate({
    version,
    params: resolveShadowParams({}) as unknown as Record<string, unknown>,
    metrics: {
      role: 'drift-rollback',
      reference: reference.version,
      matches: decision.matches,
      mean: decision.mean,
      probability: decision.probability,
    },
    notes: `Deriva frente a la referencia (${decision.matches} partidos, ΔBrier ${decision.mean.toFixed(4)}): vuelta a los defaults.`,
  });
  if (!write.ok) return { state: 'error', reason: write.errorCode ?? 'rollback-failed' };

  const result = await promoteParamsVersion(version);
  if (!result.ok) return { state: 'error', reason: result.errorCode ?? 'rollback-failed' };
  return {
    state: 'ok',
    reason: 'drifted',
    shadowMatches: decision.matches,
    rollback: { version, retired: result.retired ?? null },
    drift: {
      matches: decision.matches,
      mean: decision.mean,
      probability: decision.probability,
    },
  };
}

/** Promoción de la mejor candidata; las que pierden con muestra se retiran. */
async function evaluateCandidates(
  candidates: ShadowConfig[],
  promoted: ShadowConfig,
  nowMs: number,
  deadlineMs: number | undefined,
): Promise<LearningSummary> {
  const scored = await listScoredPredictions([
    promoted.version,
    ...candidates.map((candidate) => candidate.version),
  ]);
  if (!scored) return { state: 'error', reason: 'query-failed' };

  const alpha = (1 - PROMOTION_CONFIDENCE) / candidates.length;
  const confidence = 1 - alpha;
  const evaluated = candidates.map((candidate) => {
    const composite = compositeDiffs(scored, candidate.version, promoted.version);
    return {
      candidate,
      matches: countDistinctMatches(scored, candidate.version, 'shadow'),
      mean: composite.length > 0 ? mean(composite) : 0,
      decision: evaluatePromotion(composite, confidence),
      // Camino rápido: una señal de signo muy consistente puede promover
      // antes de los 50 pares, con el error tipo I acotado por α.
      sequential: evaluateSequential(composite, { alpha }),
      guards: {
        result: evaluateGuardrail(promotionDiffs(scored, candidate.version, promoted.version)),
        totals: evaluateGuardrail(totalsDiffs(scored, candidate.version, promoted.version)),
        modelLed: evaluateGuardrail(lowAnchorDiffs(scored, candidate.version, promoted.version)),
      },
    };
  });

  const eligible = evaluated
    .filter(
      (entry) =>
        (entry.decision.promote || entry.sequential.promote) &&
        entry.guards.result.ok &&
        entry.guards.totals.ok &&
        entry.guards.modelLed.ok,
    )
    .sort((left, right) => left.mean - right.mean);
  const cooldownOver =
    !promoted.promotedAt || nowMs - Date.parse(promoted.promotedAt) >= PROMOTION_COOLDOWN_MS;

  if (eligible.length > 0) {
    if (!cooldownOver) {
      return { state: 'ok', reason: 'promotion-cooldown', shadowMatches: eligible[0].matches };
    }
    const best = eligible[0];
    const result = await promoteParamsVersion(best.candidate.version);
    if (!result.ok) return { state: 'error', reason: result.errorCode ?? 'promote-failed' };

    for (const loser of evaluated) {
      if (loser.candidate.version === best.candidate.version) continue;
      if (loser.matches < CANDIDATE_MIN_MATCHES) continue;
      await retireEngineVersion(loser.candidate.version);
    }

    return {
      state: 'ok',
      reason: 'promoted',
      shadowMatches: best.matches,
      promotion: { version: best.candidate.version, retired: result.retired ?? null },
    };
  }

  const active: typeof evaluated = [];
  for (const entry of evaluated) {
    if (entry.matches >= CANDIDATE_MIN_MATCHES) {
      active.push(entry);
      continue;
    }
    const age = entry.candidate.createdAt ? nowMs - Date.parse(entry.candidate.createdAt) : 0;
    if (!Number.isFinite(age) || age < CANDIDATE_STALE_MS) {
      active.push(entry);
      continue;
    }
    const retired = await retireEngineVersion(entry.candidate.version);
    if (!retired.ok) return { state: 'error', reason: retired.errorCode ?? 'retire-failed' };
  }

  if (active.length === 0) return tuneCandidate(promoted, nowMs, deadlineMs);

  const maxMatches = Math.max(...active.map((entry) => entry.matches));
  if (active.some((entry) => entry.matches < CANDIDATE_MIN_MATCHES)) {
    return { state: 'skipped', reason: 'candidate-accumulating', shadowMatches: maxMatches };
  }
  return { state: 'ok', reason: 'candidate-kept', shadowMatches: maxMatches };
}

interface ScaleAudit {
  scale: number;
  votes: number;
  matches: number;
  composite: number;
  brier: number;
  logLoss: number;
  totals: BinarySummary | null;
  btts: BinarySummary | null;
  exact: BinarySummary | null;
  guardrails: { result: boolean; totals: boolean; btts: boolean; exact: boolean };
}

async function tuneCandidate(
  promoted: ShadowConfig,
  nowMs: number,
  deadlineMs: number | undefined,
): Promise<LearningSummary> {
  // La compuerta también protege el ajuste: sin muestra no se toca nada.
  const productionMatches = await countProductionMatches(promoted.version);
  if (productionMatches < LEARNING_GATE_MATCHES) {
    return { state: 'skipped', reason: 'insufficient-data', datasetMatches: productionMatches };
  }

  const dataset = await listTuningDataset();
  if (!dataset) return { state: 'error', reason: 'query-failed' };

  const latestSnapshot = new Map<string, { capturedAt: string; payload: Record<string, unknown> }>();
  for (const snapshot of dataset.snapshots) {
    const current = latestSnapshot.get(snapshot.matchId);
    if (!current || Date.parse(snapshot.capturedAt) > Date.parse(current.capturedAt)) {
      latestSnapshot.set(snapshot.matchId, snapshot);
    }
  }

  const ordered = [...dataset.matches].sort(
    (left, right) => Date.parse(left.kickoffAt) - Date.parse(right.kickoffAt),
  );
  const entries: TuningEntry[] = ordered.flatMap((match) => {
    const snapshot = latestSnapshot.get(match.matchId);
    if (!snapshot) return [];
    return [{
      matchId: match.matchId,
      payload: snapshot.payload,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      actual: resultOf(match.homeScore, match.awayScore),
    }];
  });

  if (entries.length < LEARNING_GATE_MATCHES) {
    return { state: 'skipped', reason: 'insufficient-dataset', datasetMatches: entries.length };
  }

  const windows = walkForwardWindows(entries.length);
  if (windows.length < 2) {
    return { state: 'skipped', reason: 'insufficient-dataset', datasetMatches: entries.length };
  }
  if (budgetExceeded(deadlineMs)) {
    return { state: 'skipped', reason: 'budget', datasetMatches: entries.length };
  }

  const folds: Array<{
    window: WalkForwardWindow;
    baseline: DetailedScore;
    scales: Array<{ scale: number; candidate: DetailedScore; beats: boolean }>;
  }> = [];

  for (const window of windows) {
    if (budgetExceeded(deadlineMs)) {
      return { state: 'skipped', reason: 'budget', datasetMatches: entries.length };
    }
    const validation = entries.slice(window.validationStart, window.validationEnd);
    const baseline = scoreDetailed(validation, promoted.params);
    if (!baseline) continue;
    const scales: Array<{ scale: number; candidate: DetailedScore; beats: boolean }> = [];
    for (const scale of ANCHOR_SCALES) {
      const candidate = scoreDetailed(validation, withAnchorScale(promoted.params, scale));
      if (!candidate) continue;
      const beats =
        candidate.composite <= baseline.composite - PROMOTION_MARGIN &&
        candidate.logLoss <= baseline.logLoss + 0.002;
      scales.push({ scale, candidate, beats });
    }
    folds.push({ window, baseline, scales });
  }

  if (folds.length < 2) {
    return { state: 'skipped', reason: 'insufficient-dataset', datasetMatches: entries.length };
  }

  const baselineAggregate = combineScores(folds.map((fold) => fold.baseline));
  if (!baselineAggregate) {
    return { state: 'skipped', reason: 'no-signal', datasetMatches: entries.length };
  }

  const votesNeeded = Math.ceil(folds.length / 2);
  const audits: ScaleAudit[] = [];
  for (const scale of ANCHOR_SCALES) {
    const aggregate = combineScores(
      folds.flatMap((fold) => fold.scales.filter((entry) => entry.scale === scale).map((entry) => entry.candidate)),
    );
    if (!aggregate) continue;
    audits.push({
      scale,
      votes: folds.filter((fold) => fold.scales.some((entry) => entry.scale === scale && entry.beats)).length,
      matches: aggregate.matches,
      composite: aggregate.composite,
      brier: aggregate.brier,
      logLoss: aggregate.logLoss,
      totals: aggregate.totals,
      btts: aggregate.btts,
      exact: aggregate.exact,
      guardrails: {
        result: secondaryGuard(aggregate, baselineAggregate),
        totals: secondaryGuard(aggregate.totals, baselineAggregate.totals),
        btts: secondaryGuard(aggregate.btts, baselineAggregate.btts),
        exact: secondaryGuard(aggregate.exact, baselineAggregate.exact, EXACT_GUARDRAIL_MARGIN),
      },
    });
  }

  const eligible = audits
    .filter(
      (audit) =>
        audit.votes >= votesNeeded &&
        audit.composite <= baselineAggregate.composite - PROMOTION_MARGIN &&
        audit.logLoss <= baselineAggregate.logLoss + 0.002 &&
        audit.guardrails.result &&
        audit.guardrails.totals &&
        audit.guardrails.btts &&
        audit.guardrails.exact,
    )
    .sort((left, right) =>
      left.composite === right.composite
        ? Math.abs(left.scale - 1) - Math.abs(right.scale - 1)
        : left.composite - right.composite,
    );

  if (eligible.length === 0) {
    return { state: 'ok', reason: 'candidate-not-better', datasetMatches: entries.length, candidate: null };
  }

  const date = dateStamp(nowMs);
  const hash = datasetHash(entries.map((entry) => entry.matchId));
  const created: Array<{
    version: string;
    scale: number;
    validationComposite: number;
    baselineComposite: number;
  }> = [];

  for (const audit of eligible.slice(0, MAX_AUTO_CANDIDATES)) {
    if (budgetExceeded(deadlineMs)) {
      return {
        state: 'skipped',
        reason: 'budget',
        datasetMatches: entries.length,
        candidate: created[0] ?? null,
      };
    }
    const version = `auto-anchor-s${formatScale(audit.scale)}-${date}`;
    const write = await insertEngineCandidate({
      version,
      params: withAnchorScale(promoted.params, audit.scale) as unknown as Record<string, unknown>,
      metrics: {
        objective: 'walk_forward_composite',
        weights: { result: 0.5, totals: 0.5 },
        reference: REFERENCE_PARAMS_VERSION,
        promoted: promoted.version,
        seed: BOOTSTRAP_SEED,
        votesNeeded,
        folds: folds.map((fold) => ({
          train: fold.window.trainMatches,
          validation: `${fold.window.validationStart}-${fold.window.validationEnd}`,
          matches: fold.window.validationEnd - fold.window.validationStart,
          baseline: fold.baseline.composite,
          beats: fold.scales.filter((entry) => entry.beats).map((entry) => entry.scale),
        })),
        grid: audits,
        baseline: baselineAggregate,
        anchorShare: {
          matches: baselineAggregate.anchor.matches,
          applied: baselineAggregate.anchor.applied,
          meanWeight:
            baselineAggregate.anchor.applied > 0
              ? baselineAggregate.anchor.weightSum / baselineAggregate.anchor.applied
              : 0,
        },
        dataset: {
          matches: entries.length,
          validationSize: windows[0].validationEnd - windows[0].validationStart,
          folds: folds.length,
          hash,
        },
      },
      notes: `Ajuste walk-forward multi-fold del ancla con objetivo compuesto 1X2+totales y guardarraíles (escala ${audit.scale.toFixed(2)}; ${audit.votes}/${folds.length} folds). Solo se promueve si gana en sombra.`,
    });
    if (!write.ok) return { state: 'error', reason: write.errorCode ?? 'insert-failed' };
    created.push({
      version,
      scale: audit.scale,
      validationComposite: audit.composite,
      baselineComposite: baselineAggregate.composite,
    });
  }

  return {
    state: 'ok',
    reason: 'candidate-created',
    datasetMatches: entries.length,
    candidate: created[0] ?? null,
    candidates: created.map((entry) => ({ version: entry.version, scale: entry.scale })),
  };
}

async function countProductionMatches(version: string): Promise<number> {
  const scored = await listScoredPredictions([version]);
  if (!scored) return 0;
  return countDistinctMatches(scored, version, 'production');
}
