import { createHash } from 'node:crypto';
import type {
  PostMatchConflict,
  PostMatchCoverage,
  PostMatchEvent,
  PostMatchLineupPlayer,
  PostMatchLineupSide,
  PostMatchOutput,
  PostMatchPeriod,
  PostMatchPeriodTeam,
  PostMatchPlayerStats,
  PostMatchScoreValue,
  PostMatchSection,
  PostMatchSourceId,
  PostMatchSourceRun,
  PostMatchSourceStatus,
  PostMatchStatus,
  PostMatchTotalsTeam,
} from '../types/api';
import { ValidationError } from './errors';

/**
 * Lógica pura de la ingesta post-partido: validación del cuerpo, lectura del
 * marcador, control de cobertura, detección de prórroga, proyección canónica y
 * hash de contenido. No toca red ni base de datos para poder probarse aislada.
 */

const MATCH_ID = /^[A-Za-z0-9._:-]{1,300}$/;

export interface PostIngestInput {
  matchId: string;
}

/** Mismo estilo que `parseMatchInput`: devuelve solo lo relevante o lanza ValidationError. */
export function parsePostIngestBody(body: unknown): PostIngestInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('El cuerpo debe ser un objeto JSON.');
  }
  const raw = body as Record<string, unknown>;
  const candidate = raw.id ?? raw.matchId ?? raw.match_id;
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new ValidationError('Indica el ID del partido en el campo "id".');
  }
  const matchId = candidate.trim();
  if (matchId.length > 300) {
    throw new ValidationError('El campo supera 300 caracteres.');
  }
  if (!MATCH_ID.test(matchId)) {
    throw new ValidationError('El ID del partido contiene caracteres no permitidos.');
  }
  return { matchId };
}

export interface DerivedResult {
  home: number;
  away: number;
  result: 'home' | 'draw' | 'away';
  total: number;
}

/**
 * Marcador final canónico. `partial` con `score.ft` es válido; `unavailable`,
 * un `ft` ausente o valores no enteros/negativos devuelven `null`.
 */
export function deriveResult(post: PostMatchOutput | null | undefined): DerivedResult | null {
  if (!post || post.status === 'unavailable') return null;
  const ft = post.score?.ft ?? null;
  if (!ft) return null;
  const { home, away } = ft;
  if (!Number.isInteger(home) || !Number.isInteger(away)) return null;
  if (home < 0 || away < 0) return null;
  return {
    home,
    away,
    result: home > away ? 'home' : home < away ? 'away' : 'draw',
    total: home + away,
  };
}

export type CalibrationLevel = 'full' | 'limited';
export type CalibrationSection = 'xg' | 'halves';

export interface Acceptance {
  accepted: boolean;
  reason?: string;
  /** `full` con score+xg+halves; `limited` si solo sirve para el marcador. */
  calibration: CalibrationLevel;
  /** Secciones que faltan para calibración fina (no bloquean el marcador). */
  missing: CalibrationSection[];
}

/**
 * Criterio de aceptación de un bloque post-partido: `score` es obligatorio
 * (marcador), mientras que `xg` y `halves` solo se exigen para calibración fina
 * y se reportan sin bloquear el registro del resultado.
 */
export function acceptance(post: PostMatchOutput): Acceptance {
  if (post.status === 'unavailable') {
    return {
      accepted: false,
      reason: 'El bloque post_match está marcado como unavailable.',
      calibration: 'limited',
      missing: ['xg', 'halves'],
    };
  }
  const sections = post.meta?.coverage?.sections;
  if (!sections?.score) {
    return {
      accepted: false,
      reason: 'La cobertura no incluye el marcador final (score).',
      calibration: 'limited',
      missing: ['xg', 'halves'],
    };
  }
  const missing: CalibrationSection[] = [];
  if (!sections.xg) missing.push('xg');
  if (!sections.halves) missing.push('halves');
  if (missing.length > 0) {
    return {
      accepted: true,
      reason: `Aceptado para marcador; falta ${missing.join(' y ')} para calibración fina.`,
      calibration: 'limited',
      missing,
    };
  }
  return { accepted: true, calibration: 'full', missing: [] };
}

/** `true` si el timeline incluye eventos de prórroga: excluir de modelos a 90'. */
export function isExtraTime(post: Pick<PostMatchOutput, 'timeline'>): boolean {
  return (post.timeline ?? []).some((event) => event.period === 'extra_time');
}

/** `completeness` del snapshot según el estado del bloque. */
export function completenessOf(post: Pick<PostMatchOutput, 'status'>): 'partial' | 'complete' {
  return post.status === 'complete' ? 'complete' : 'partial';
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describeConflict(conflict: PostMatchConflict): string {
  const alternatives = Object.entries(conflict.alternatives ?? {})
    .map(([source, value]) => `${source}=${String(value)}`)
    .sort(([a], [b]) => compareText(a, b))
    .join(', ');
  return `${conflict.chosen_source}=${String(conflict.chosen_value)}${alternatives ? `; alternativas: ${alternatives}` : ''}`;
}

export interface SanitizedPostMatch {
  post: PostMatchOutput;
  /** Campos en conflicto que no se persisten. */
  dropped: string[];
}

/**
 * Los campos en conflicto no se aceptan: se anulan en la proyección y se anota
 * el motivo en `meta.warnings`. `score.ft` en conflicto deja el bloque sin
 * marcador, de modo que `deriveResult` devuelve `null` y la ruta responde 422.
 */
export function sanitizeConflicts(post: PostMatchOutput): SanitizedPostMatch {
  const conflicts = post.meta?.conflicts ?? [];
  if (conflicts.length === 0) return { post, dropped: [] };

  let next: PostMatchOutput = post;
  const dropped: string[] = [];
  const warnings: string[] = [...(post.meta?.warnings ?? [])];

  for (const conflict of conflicts) {
    if (conflict.field === 'score.ht') {
      next = { ...next, score: { ...next.score, ht: null } };
      dropped.push('score.ht');
      warnings.push(
        `Marcador al descanso en conflicto (${describeConflict(conflict)}); no se persiste score.ht.`,
      );
      continue;
    }
    if (conflict.field === 'score.ft') {
      next = { ...next, score: { ...next.score, ft: null } };
      dropped.push('score.ft');
      warnings.push(
        `Marcador final en conflicto (${describeConflict(conflict)}); no se persiste score.ft.`,
      );
      continue;
    }
    dropped.push(conflict.field);
    warnings.push(
      `Campo en conflicto no persistido: ${conflict.field} (${describeConflict(conflict)}).`,
    );
  }

  return {
    post: { ...next, meta: { ...next.meta, warnings } },
    dropped,
  };
}

const XG_METRICS = new Set<string>([
  'xg',
  'xga',
  'xa',
  'non_penalty_xg',
  'xgot_faced',
  'goals_prevented',
]);

const PERCENT_METRICS = new Set<string>(['possession_pct']);

const PERIOD_METRICS: ReadonlyArray<keyof PostMatchPeriodTeam> = [
  'xg',
  'non_penalty_xg',
  'shots',
  'shots_on_target',
  'shots_off_target',
  'blocked_shots',
  'big_chances',
  'big_chances_missed',
  'possession_pct',
  'accurate_passes',
  'passes_opposition_half',
  'corners',
  'fouls',
  'yellow_cards',
  'red_cards',
  'offsides',
  'saves',
  'tackles',
  'interceptions',
  'clearances',
  'duels_won',
];

function roundTo(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/** Redondeo por métrica: xG a 3 decimales, porcentajes a 2, resto tal cual. */
function normalizeMetric(key: string, value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (XG_METRICS.has(key)) return roundTo(value, 3);
  if (PERCENT_METRICS.has(key)) return roundTo(value, 2);
  return value;
}

function normalizeScoreValue(value: PostMatchScoreValue | null | undefined): PostMatchScoreValue | null {
  if (!value) return null;
  const home = Number.isInteger(value.home) && value.home >= 0 ? value.home : null;
  const away = Number.isInteger(value.away) && value.away >= 0 ? value.away : null;
  return home === null || away === null ? null : { home, away };
}

function normalizePeriodTeam(team: PostMatchPeriodTeam | null | undefined): PostMatchPeriodTeam | null {
  if (!team) return null;
  const out = {} as PostMatchPeriodTeam;
  for (const key of PERIOD_METRICS) {
    out[key] = normalizeMetric(key, team[key]);
  }
  return out;
}

function normalizePeriod(period: PostMatchPeriod | null | undefined): PostMatchPeriod | null {
  if (!period) return null;
  const home = normalizePeriodTeam(period.home);
  const away = normalizePeriodTeam(period.away);
  return home && away ? { home, away } : null;
}

function playerKey(player: { player_id?: string | null; name?: string | null }): string {
  const id = typeof player.player_id === 'string' ? player.player_id.trim() : '';
  if (id) return `id:${id}`;
  return `name:${(player.name ?? '').trim().toLowerCase()}`;
}

function sortPlayers<T extends { player_id?: string | null; name?: string | null }>(players: T[]): T[] {
  return [...players].sort((a, b) => compareText(playerKey(a), playerKey(b)));
}

function normalizeLineupPlayer(player: PostMatchLineupPlayer): PostMatchLineupPlayer {
  return {
    player_id: player.player_id ?? null,
    name: player.name ?? '',
    position: player.position ?? null,
    position_id: player.position_id ?? null,
    shirt_number: player.shirt_number ?? null,
    rating: typeof player.rating === 'number' ? roundTo(player.rating, 2) : null,
  };
}

function normalizeLineupSide(side: PostMatchLineupSide | null | undefined): PostMatchLineupSide | null {
  if (!side) return null;
  return {
    formation: side.formation ?? null,
    coach: side.coach ?? null,
    starters: sortPlayers(side.starters ?? []).map(normalizeLineupPlayer),
    substitutes: sortPlayers(side.substitutes ?? []).map(normalizeLineupPlayer),
  };
}

function normalizePlayer(player: PostMatchPlayerStats): PostMatchPlayerStats {
  return {
    player_id: player.player_id ?? null,
    name: player.name ?? '',
    side: player.side,
    starter: Boolean(player.starter),
    position: player.position ?? null,
    position_id: player.position_id ?? null,
    shirt_number: player.shirt_number ?? null,
    minutes: player.minutes ?? null,
    rating: typeof player.rating === 'number' ? roundTo(player.rating, 2) : null,
    goals: player.goals ?? null,
    assists: player.assists ?? null,
    xg: normalizeMetric('xg', player.xg),
    xa: normalizeMetric('xa', player.xa),
    shots: player.shots ?? null,
    shots_on_target: player.shots_on_target ?? null,
    goals_conceded: player.goals_conceded ?? null,
    saves: player.saves ?? null,
    xgot_faced: normalizeMetric('xgot_faced', player.xgot_faced),
    goals_prevented: normalizeMetric('goals_prevented', player.goals_prevented),
    passes_accurate: player.passes_accurate ?? null,
    passes_total: player.passes_total ?? null,
    chances_created: player.chances_created ?? null,
    touches: player.touches ?? null,
    touches_opp_box: player.touches_opp_box ?? null,
    tackles: player.tackles ?? null,
    interceptions: player.interceptions ?? null,
    clearances: player.clearances ?? null,
    duels_won: player.duels_won ?? null,
    duels_lost: player.duels_lost ?? null,
    aerials_won: player.aerials_won ?? null,
    fouls: player.fouls ?? null,
    was_fouled: player.was_fouled ?? null,
    yellow_cards: Number.isFinite(player.yellow_cards) ? player.yellow_cards : 0,
    red_cards: Number.isFinite(player.red_cards) ? player.red_cards : 0,
  };
}

function normalizeTotals(
  totals: { home: PostMatchTotalsTeam; away: PostMatchTotalsTeam } | null | undefined,
): { home: PostMatchTotalsTeam; away: PostMatchTotalsTeam } | null {
  if (!totals) return null;
  const side = (team: PostMatchTotalsTeam): PostMatchTotalsTeam => ({
    xg: normalizeMetric('xg', team?.xg),
    xga: normalizeMetric('xga', team?.xga),
  });
  return { home: side(totals.home), away: side(totals.away) };
}

function normalizeEvent(event: PostMatchEvent): PostMatchEvent {
  return {
    minute: Number.isFinite(event.minute) ? event.minute : 0,
    added_time: event.added_time ?? null,
    period: event.period,
    type: event.type,
    side: event.side ?? null,
    player_id: event.player_id ?? null,
    player_name: event.player_name ?? null,
    assist_id: event.assist_id ?? null,
    assist_name: event.assist_name ?? null,
    player_in_id: event.player_in_id ?? null,
    player_in_name: event.player_in_name ?? null,
    player_out_id: event.player_out_id ?? null,
    player_out_name: event.player_out_name ?? null,
    score_after: normalizeScoreValue(event.score_after),
    detail: event.detail ?? null,
  };
}

function normalizeCoverage(coverage: PostMatchCoverage | undefined): PostMatchCoverage {
  const sections = coverage?.sections;
  const normalized = {
    score: Boolean(sections?.score),
    halves: Boolean(sections?.halves),
    timeline: Boolean(sections?.timeline),
    lineups: Boolean(sections?.lineups),
    players: Boolean(sections?.players),
    xg: Boolean(sections?.xg),
  };
  const available =
    typeof coverage?.available === 'number'
      ? coverage.available
      : Object.values(normalized).filter(Boolean).length;
  return { sections: normalized, available, total: coverage?.total ?? 6 };
}

function normalizeSourceRun(run: PostMatchSourceRun): {
  source: PostMatchSourceId;
  status: PostMatchSourceStatus;
  sections: PostMatchSection[];
} {
  // duration_ms y detail quedan fuera: son latencias, no datos del partido.
  return {
    source: run.source,
    status: run.status,
    sections: [...new Set(run.sections ?? [])].sort(compareText),
  };
}

function normalizeConflict(conflict: PostMatchConflict): PostMatchConflict {
  const alternatives: Record<string, number | string> = {};
  for (const [source, value] of Object.entries(conflict.alternatives ?? {}).sort(([a], [b]) =>
    compareText(a, b),
  )) {
    if (value !== undefined) alternatives[source] = value;
  }
  return {
    field: conflict.field,
    chosen_source: conflict.chosen_source,
    chosen_value: conflict.chosen_value,
    alternatives,
  };
}

/**
 * Se declara como alias (no interfaz) para que TS le aplique la firma de índice
 * implícita y sea asignable a `Record<string, unknown>` / columnas `jsonb`.
 */
export type CanonicalPostPayload = {
  version: string;
  status: PostMatchStatus;
  extra_time: boolean;
  score: { ht: PostMatchScoreValue | null; ft: PostMatchScoreValue | null };
  totals: { home: PostMatchTotalsTeam; away: PostMatchTotalsTeam } | null;
  periods: { first_half: PostMatchPeriod | null; second_half: PostMatchPeriod | null } | null;
  timeline: PostMatchEvent[];
  lineups: { home: PostMatchLineupSide | null; away: PostMatchLineupSide | null } | null;
  players: { home: PostMatchPlayerStats[]; away: PostMatchPlayerStats[] };
  coverage: PostMatchCoverage;
  conflicts: PostMatchConflict[];
  warnings: string[];
  sources: Array<{
    source: PostMatchSourceId;
    status: PostMatchSourceStatus;
    sections: PostMatchSection[];
  }>;
};

/**
 * Proyección estable del bloque para hashear y persistir. Excluye
 * `generated_at`, `deadline_ms`, `timed_out`, duraciones/latencias y el orden de
 * `meta.sources`; ordena jugadores, conflictos, warnings y secciones de fuente.
 * El timeline conserva su orden cronológico (semántico).
 */
export function canonicalPostPayload(post: PostMatchOutput): CanonicalPostPayload {
  const sources = (post.meta?.sources ?? [])
    .map(normalizeSourceRun)
    .sort((a, b) => compareText(a.source, b.source) || compareText(a.status, b.status));

  const warnings = [...new Set((post.meta?.warnings ?? []).map((warning) => String(warning).trim()))]
    .filter((warning) => warning.length > 0)
    .sort(compareText);

  const conflicts = (post.meta?.conflicts ?? [])
    .map(normalizeConflict)
    .sort((a, b) => compareText(a.field, b.field) || compareText(a.chosen_source, b.chosen_source));

  return {
    version: post.version,
    status: post.status,
    extra_time: isExtraTime(post),
    score: {
      ht: normalizeScoreValue(post.score?.ht),
      ft: normalizeScoreValue(post.score?.ft),
    },
    totals: normalizeTotals(post.totals),
    periods: post.periods
      ? {
          first_half: normalizePeriod(post.periods.first_half),
          second_half: normalizePeriod(post.periods.second_half),
        }
      : null,
    timeline: (post.timeline ?? []).map(normalizeEvent),
    lineups: post.lineups
      ? {
          home: normalizeLineupSide(post.lineups.home),
          away: normalizeLineupSide(post.lineups.away),
        }
      : null,
    players: {
      home: sortPlayers(post.players?.home ?? []).map(normalizePlayer),
      away: sortPlayers(post.players?.away ?? []).map(normalizePlayer),
    },
    coverage: normalizeCoverage(post.meta?.coverage),
    conflicts,
    warnings,
    sources,
  };
}

function normalizeForHash(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) ? value : Number(value.toFixed(6));
  }
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareText)) {
      out[key] = normalizeForHash(source[key]);
    }
    return out;
  }
  return value;
}

/** Serialización estable: claves ordenadas, `null` explícito y floats acotados. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForHash(value));
}

/** SHA-256 hexadecimal de la serialización estable. */
export function hashPayload(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

/**
 * Contrato de persistencia (`src/lib/server/db.ts`, otra tarea):
 * `recordPostMatch(input): Promise<RecordPostMatchResult>`. Solo persiste si el
 * partido ya tiene snapshot `pre`; si no, devuelve `missing_pre`.
 * `phasePayload` es la proyección canónica y `completeness` sale del status.
 */
export interface RecordPostMatchInput {
  matchId: string;
  kickoffAt: string;
  leagueId: string;
  leagueName: string | null;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  phasePayload: CanonicalPostPayload;
  completeness: 'partial' | 'complete';
}

export interface RecordPostMatchResult {
  snapshotId: string;
  inserted: boolean;
}
