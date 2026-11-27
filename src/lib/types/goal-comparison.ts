/** Contrato del comparativo de gol previo por partido (`v_match_goal_comparison`). */

export const GOAL_BANDS = ['1_15', '16_30', '31_45', '46_60', '61_75', '76_90'] as const;

export type GoalBand = (typeof GOAL_BANDS)[number];

/** Goles en cada franja de 15 minutos. */
export type GoalBands = Record<GoalBand, number>;

/** Perfil de un equipo en un conjunto de partidos previos. */
export interface GoalMetrics {
  matches: number;
  goalsFor: number;
  goalsAgainst: number;
  goalsForAvg: number | null;
  goalsAgainstAvg: number | null;
  minutesPerGoalFor: number | null;
  minutesPerGoalAgainst: number | null;
  firstHalfGoalsFor: number;
  secondHalfGoalsFor: number;
  /** Porcentaje (0–100) de los goles a favor marcados en cada mitad. */
  firstHalfPctFor: number | null;
  secondHalfPctFor: number | null;
  firstHalfGoalsAgainst: number;
  secondHalfGoalsAgainst: number;
  firstHalfPctAgainst: number | null;
  secondHalfPctAgainst: number | null;
  firstGoals: number;
  firstGoalsConceded: number;
  firstGoalPct: number | null;
  firstGoalMinuteAvg: number | null;
  firstGoalMinuteMedian: number | null;
  cleanSheets: number;
  failedToScore: number;
  bttsPct: number | null;
  over25Pct: number | null;
  bandsFor: GoalBands;
  bandsAgainst: GoalBands;
}

export interface TeamGoalProfile extends GoalMetrics {
  teamId: string | null;
  teamName: string;
  /** Partidos previos en la condición de este equipo (local en casa, visitante fuera). */
  venueMatches: number;
  venue: GoalMetrics | null;
}

export interface GoalComparison {
  matchId: string;
  kickoffAt: string;
  homeTeamName: string;
  awayTeamName: string;
  home: TeamGoalProfile;
  away: TeamGoalProfile;
}

export type GoalComparisonResult =
  | { state: 'ok'; comparison: GoalComparison }
  | { state: 'not_found' }
  | { state: 'disabled' }
  | { state: 'error'; errorCode: string | null };
