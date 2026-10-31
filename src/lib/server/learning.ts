import { analyzeMatch } from '../engine/analyze';
import type { EngineParams } from '../engine/params';
import type { AggregatedResponse } from '../types/api';
import {
  getEngineConfigs,
  insertEngineCandidate,
  listEngineHistory,
  listScoredPredictions,
  listTuningDataset,
  promoteParamsVersion,
  retireEngineVersion,
  type ScoredPrediction,
  type ShadowConfig,
} from './db';

/**
 * Ciclo automático de mejora: ajuste walk-forward del ancla, candidata sombra y
 * promoción con guardarraíles. Todo falla en silencio hacia producción: si algo
 * no cuadra, se devuelve un estado y no se toca la fila promovida.
 *
 * El vector es deliberadamente de una dimensión (escala del ancla). Con la
 * muestra de la compuerta (~100 partidos) más perillas memorizarían ruido.
 */

const DAY_MS = 86_400_000;

export const LEARNING_GATE_MATCHES = 100;
export const CANDIDATE_MIN_MATCHES = 50;
export const CANDIDATE_MIN_AGE_MS = 7 * DAY_MS;
export const CANDIDATE_STALE_MS = 21 * DAY_MS;
export const PROMOTION_MARGIN = 0.004;
export const PROMOTION_CONFIDENCE = 0.95;
export const PROMOTION_COOLDOWN_MS = 30 * DAY_MS;
export const ROLLBACK_MIN_MATCHES = 30;
export const ROLLBACK_MARGIN = 0.01;
export const ROLLBACK_CONFIDENCE = 0.95;
export const ANCHOR_SCALES = [0.7, 0.8, 0.9, 1.0, 1.1] as const;
const VALIDATION_SHARE = 0.3;
const MIN_VALIDATION = 20;
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

/** `diffs = candidata − producción` (Brier); negativo significa mejora. */
export function evaluatePromotion(diffs: number[]): PromotionDecision {
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
    promote: average <= -PROMOTION_MARGIN && probability >= PROMOTION_CONFIDENCE,
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
  payload: Record<string, unknown>;
  actual: ActualResult;
}

function scoreEntries(entries: TuningEntry[], params: EngineParams): ScoreSummary | null {
  const brierValues: number[] = [];
  const logLossValues: number[] = [];
  for (const entry of entries) {
    const response = canonicalToResponse(entry.payload);
    if (!response) continue;
    let analysis;
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
    brierValues.push(brier);
    logLossValues.push(logLoss);
  }
  if (brierValues.length === 0) return null;
  return {
    matches: brierValues.length,
    brier: mean(brierValues),
    logLoss: mean(logLossValues),
  };
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

export interface LearningSummary {
  state: 'ok' | 'disabled' | 'skipped' | 'error';
  reason?: string;
  datasetMatches?: number;
  shadowMatches?: number;
  candidate?: { version: string; scale: number; validationBrier: number; baselineBrier: number } | null;
  promotion?: { version: string; retired: string | null } | null;
  rollback?: { version: string; retired: string | null } | null;
}

/**
 * Una pasada del ciclo. No lanza: devuelve `state` y, si aplica, la decisión.
 * Pensado para el cron diario tras la ingesta de resultados.
 */
export async function runLearning(nowMs = Date.now()): Promise<LearningSummary> {
  try {
    return await run(nowMs);
  } catch {
    return { state: 'error', reason: 'unexpected' };
  }
}

async function run(nowMs: number): Promise<LearningSummary> {
  const configs = await getEngineConfigs();
  if (!configs) return { state: 'disabled' };
  const promoted = configs.promoted;
  if (!promoted) return { state: 'skipped', reason: 'no-promoted' };

  const rollback = await checkRollback(promoted);
  if (rollback) return rollback;

  let shadow = configs.shadow;
  if (shadow && !isAutoCandidate(shadow.version)) {
    // El brazo de control no es promocionable. Se retira en cuanto hay muestra
    // suficiente para ajustar una candidata real.
    const gate = await countShadowMatches(shadow.version);
    if (gate < LEARNING_GATE_MATCHES) {
      return { state: 'skipped', reason: 'control-accumulating', shadowMatches: gate };
    }
    const retired = await retireEngineVersion(shadow.version);
    if (!retired.ok) return { state: 'error', reason: retired.errorCode ?? 'retire-failed' };
    shadow = null;
  }

  if (shadow) {
    const shadowScored = await listScoredPredictions([shadow.version, promoted.version]);
    if (!shadowScored) return { state: 'error', reason: 'query-failed' };
    const shadowMatches = countDistinctMatches(shadowScored, shadow.version, 'shadow');
    const decision = evaluatePromotion(promotionDiffs(shadowScored, shadow.version, promoted.version));
    const cooldownOver =
      !promoted.promotedAt || nowMs - Date.parse(promoted.promotedAt) >= PROMOTION_COOLDOWN_MS;
    if (decision.promote && cooldownOver) {
      const result = await promoteParamsVersion(shadow.version);
      if (!result.ok) return { state: 'error', reason: result.errorCode ?? 'promote-failed' };
      return {
        state: 'ok',
        reason: 'promoted',
        shadowMatches,
        promotion: { version: shadow.version, retired: result.retired ?? null },
      };
    }
    if (shadowMatches < CANDIDATE_MIN_MATCHES) {
      const age = shadow.createdAt ? nowMs - Date.parse(shadow.createdAt) : 0;
      if (Number.isFinite(age) && age < CANDIDATE_MIN_AGE_MS) {
        return { state: 'skipped', reason: 'candidate-accumulating', shadowMatches };
      }
      if (!Number.isFinite(age) || age < CANDIDATE_STALE_MS) {
        return { state: 'skipped', reason: 'candidate-accumulating', shadowMatches };
      }
      const retired = await retireEngineVersion(shadow.version);
      if (!retired.ok) return { state: 'error', reason: retired.errorCode ?? 'retire-failed' };
    } else {
      return {
        state: 'ok',
        reason: cooldownOver ? 'candidate-kept' : 'promotion-cooldown',
        shadowMatches,
      };
    }
  }

  return tuneCandidate(promoted, nowMs);
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

async function tuneCandidate(promoted: ShadowConfig, nowMs: number): Promise<LearningSummary> {
  // La compuerta también protege el ajuste: sin muestra no se toca nada.
  const shadowCount = await countProductionMatches(promoted.version);
  if (shadowCount < LEARNING_GATE_MATCHES) {
    return { state: 'skipped', reason: 'insufficient-data', datasetMatches: shadowCount };
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
      payload: snapshot.payload,
      actual: resultOf(match.homeScore, match.awayScore),
    }];
  });

  if (entries.length < LEARNING_GATE_MATCHES) {
    return { state: 'skipped', reason: 'insufficient-dataset', datasetMatches: entries.length };
  }

  const split = Math.floor(entries.length * (1 - VALIDATION_SHARE));
  const train = entries.slice(0, split);
  const validation = entries.slice(split);
  if (validation.length < MIN_VALIDATION) {
    return { state: 'skipped', reason: 'insufficient-dataset', datasetMatches: entries.length };
  }

  const rows: Array<{ scale: number; brier: number; logLoss: number }> = [];
  for (const scale of ANCHOR_SCALES) {
    const summary = scoreEntries(train, withAnchorScale(promoted.params, scale));
    if (summary) rows.push({ scale, ...summary });
  }
  const scale = pickBestScale(rows);
  if (scale === null) return { state: 'skipped', reason: 'no-signal', datasetMatches: entries.length };

  const candidateParams = withAnchorScale(promoted.params, scale);
  const candidateScore = scoreEntries(validation, candidateParams);
  const baselineScore = scoreEntries(validation, promoted.params);
  if (!candidateScore || !baselineScore) {
    return { state: 'skipped', reason: 'no-signal', datasetMatches: entries.length };
  }

  const improves =
    candidateScore.brier <= baselineScore.brier - PROMOTION_MARGIN &&
    candidateScore.logLoss <= baselineScore.logLoss + 0.002;
  if (!improves) {
    return {
      state: 'ok',
      reason: 'candidate-not-better',
      datasetMatches: entries.length,
      candidate: null,
    };
  }

  const date = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');
  const version = `auto-anchor-s${formatScale(scale)}-${date}`;
  const write = await insertEngineCandidate({
    version,
    params: candidateParams as unknown as Record<string, unknown>,
    metrics: {
      scale,
      train: { matches: train.length, best: rows.find((row) => row.scale === scale) ?? null, grid: rows },
      validation: {
        matches: validation.length,
        candidate: candidateScore,
        baseline: baselineScore,
      },
    },
    notes: `Ajuste automático del ancla (escala ${scale.toFixed(2)}). Walk-forward ${train.length}/${validation.length}; solo se promueve si gana en sombra.`,
  });
  if (!write.ok) return { state: 'error', reason: write.errorCode ?? 'insert-failed' };

  return {
    state: 'ok',
    reason: 'candidate-created',
    datasetMatches: entries.length,
    candidate: {
      version,
      scale,
      validationBrier: candidateScore.brier,
      baselineBrier: baselineScore.brier,
    },
  };
}

async function countProductionMatches(version: string): Promise<number> {
  const scored = await listScoredPredictions([version]);
  if (!scored) return 0;
  return countDistinctMatches(scored, version, 'production');
}
