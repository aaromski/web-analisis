import type { PostMatchEvent } from '../types/api';

/**
 * Proyección de los goles del timeline post a filas de `match_goal_events`.
 *
 * Lógica pura, sin red ni base de datos. El equipo acreditado sale de
 * `event.side`: en esta API coincide con el marcador final en los 188 partidos
 * cerrados. Los 8 goles en propia servidos por ESPN traen un `score_after`
 * invertido (el post lo advierte en `meta.warnings`), así que el delta solo se
 * usa cuando el evento no trae lado. El marcador acumulado se recalcula desde
 * los créditos para que sea coherente con el resultado final.
 */

export type GoalEventType = 'goal' | 'own_goal' | 'penalty_goal';

const GOAL_TYPES: ReadonlySet<string> = new Set(['goal', 'own_goal', 'penalty_goal']);

export interface GoalTeams {
  homeTeamId?: string | null;
  awayTeamId?: string | null;
  homeName?: string | null;
  awayName?: string | null;
}

export interface GoalEventSeed {
  seq: number;
  minute: number;
  added_time: number | null;
  period: PostMatchEvent['period'];
  event_type: GoalEventType;
  side: 'home' | 'away';
  credited_side: 'home' | 'away' | null;
  team_id: string | null;
  opponent_team_id: string | null;
  team_name: string | null;
  player_id: string | null;
  player_name: string | null;
  assist_name: string | null;
  score_home_after: number | null;
  score_away_after: number | null;
}

export interface GoalEventRow extends GoalEventSeed {
  snapshot_id: string;
  match_id: string;
}

export interface GoalEventsInput extends GoalTeams {
  timeline: readonly PostMatchEvent[] | null | undefined;
  snapshotId: string;
  matchId: string;
}

type Side = 'home' | 'away';
type Score = { home: number; away: number };

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function scoreValue(value: unknown): Score | null {
  if (!value || typeof value !== 'object') return null;
  const { home, away } = value as { home?: unknown; away?: unknown };
  if (typeof home !== 'number' || typeof away !== 'number') return null;
  if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) return null;
  return { home, away };
}

/** Solo un incremento exacto de un gol resuelve el crédito. */
function creditedFromDelta(previous: Score, next: Score): Side | null {
  const homeDelta = next.home - previous.home;
  const awayDelta = next.away - previous.away;
  if (homeDelta === 1 && awayDelta === 0) return 'home';
  if (homeDelta === 0 && awayDelta === 1) return 'away';
  return null;
}

function increment(score: Score, side: Side): Score {
  return side === 'home'
    ? { home: score.home + 1, away: score.away }
    : { home: score.home, away: score.away + 1 };
}

export function goalEventsFromTimeline(
  timeline: readonly PostMatchEvent[] | null | undefined,
  teams: GoalTeams = {},
): GoalEventSeed[] {
  const events: GoalEventSeed[] = [];
  const list = timeline ?? [];
  let running: Score = { home: 0, away: 0 };

  for (let seq = 0; seq < list.length; seq += 1) {
    const event = list[seq];
    if (!event || !GOAL_TYPES.has(event.type)) continue;

    const minute = Number.isFinite(event.minute) ? Math.trunc(event.minute) : 0;
    if (minute < 1 || minute > 130) continue;

    const rawSide: Side | null =
      event.side === 'home' || event.side === 'away' ? event.side : null;
    const after = scoreValue(event.score_after);
    const credited: Side | null = rawSide ?? (after ? creditedFromDelta(running, after) : null);
    if (credited) running = increment(running, credited);

    const side: Side | null = rawSide ?? credited;
    if (!side) continue;

    const homeTeamId = cleanText(teams.homeTeamId);
    const awayTeamId = cleanText(teams.awayTeamId);
    const homeName = cleanText(teams.homeName);
    const awayName = cleanText(teams.awayName);

    const teamId = credited ? (credited === 'home' ? homeTeamId : awayTeamId) : null;
    const opponentTeamId = credited ? (credited === 'home' ? awayTeamId : homeTeamId) : null;
    const teamName = credited ? (credited === 'home' ? homeName : awayName) : null;

    const addedTime =
      typeof event.added_time === 'number' && Number.isInteger(event.added_time) && event.added_time >= 0
        ? event.added_time
        : null;

    events.push({
      seq,
      minute,
      added_time: addedTime,
      period: event.period,
      event_type: event.type as GoalEventType,
      side,
      credited_side: credited,
      team_id: teamId,
      opponent_team_id: opponentTeamId,
      team_name: teamName,
      player_id: cleanText(event.player_id),
      player_name: cleanText(event.player_name),
      assist_name: cleanText(event.assist_name),
      score_home_after: running.home,
      score_away_after: running.away,
    });
  }

  return events;
}

export function goalEventRows(input: GoalEventsInput): GoalEventRow[] {
  return goalEventsFromTimeline(input.timeline, input).map((seed) => ({
    ...seed,
    snapshot_id: input.snapshotId,
    match_id: input.matchId,
  }));
}
