/**
 * Tipos del contrato público de la Aggregator API (v1.2.0).
 * Se declaran permisivos a propósito: la app tolera campos opcionales y
 * secciones nulas sin romper el análisis.
 */

export type StatStatus = 'observed' | 'projected' | 'missing';

export interface CanonicalStat {
  value: number | null;
  unit: 'count' | 'percent' | 'goals' | string;
  status: StatStatus;
  source: string | null;
  derived?: boolean;
  derived_from?: string[];
}

export type TeamStats = Record<string, CanonicalStat | undefined>;

export interface ProjectionMeta {
  method: 'season_average' | string;
  sample_size: number;
  window: string;
  generated_at: string;
  sources: string[];
  coverage: { projected: number; missing: number };
}

export interface TeamPayload {
  team_id?: string;
  name: string;
  side: 'home' | 'away';
  sample?: number | null;
  stats: TeamStats;
  projection?: ProjectionMeta;
}

export interface MatchPayload {
  match_id: string;
  source_ids?: Record<string, string>;
  league: { id: string; name: string };
  season?: string;
  date: string;
  status: 'finished' | 'scheduled' | 'live' | 'unknown';
  venue?: string;
  score: { home: number | null; away: number | null };
}

export interface OddsPrice {
  american: number | null;
  decimal: number | null;
  implied_probability: number | null;
  no_vig_probability: number | null;
}

export interface MoneylineOdds {
  home: OddsPrice;
  draw: OddsPrice;
  away: OddsPrice;
}

export interface TotalsOdds {
  line: number | null;
  over: OddsPrice;
  under: OddsPrice;
}

export interface SpreadOdds {
  line: number | null;
  home: OddsPrice;
  away: OddsPrice;
}

export interface PreMatchOdds {
  provider?: string | null;
  captured_at?: string;
  provider_count?: number | null;
  moneyline?: MoneylineOdds | null;
  totals?: TotalsOdds | null;
  spread?: SpreadOdds | null;
  open?: {
    home_american: number | null;
    draw_american: number | null;
    away_american: number | null;
    total: number | null;
  } | null;
  movement?: {
    home: 'shortening' | 'drifting' | 'stable' | null;
    draw: 'shortening' | 'drifting' | 'stable' | null;
    away: 'shortening' | 'drifting' | 'stable' | null;
  } | null;
  extra_markets?: Array<{
    market: string;
    line: number | null;
    outcomes: Array<{
      label: string;
      decimal: number | null;
      implied_probability: number | null;
      bookmaker_count: number | null;
    }>;
  }>;
  source?: 'espn' | 'bzzoiro' | string;
}

export interface PreMatchPredictionLine {
  line: number;
  probability: number | null;
}

export interface PreMatchPrediction {
  model?: string | null;
  confidence?: number | null;
  created_at?: string | null;
  match_result?: {
    home: number | null;
    draw: number | null;
    away: number | null;
    predicted?: 'home' | 'draw' | 'away' | null;
  } | null;
  expected_goals?: {
    home: number | null;
    away: number | null;
  } | null;
  over_under?: PreMatchPredictionLine[] | null;
  btts?: { yes: number | null } | null;
  most_likely_score?: string | null;
  corners?: PreMatchPredictionLine[] | null;
  source?: string;
}

export interface RecentFormSplit {
  matches: number | null;
  wins: number | null;
  draws: number | null;
  losses: number | null;
  goals_for: number | null;
  goals_against: number | null;
  form: string | null;
  points_per_match?: number | null;
}

export interface RecentForm {
  method?: string;
  window?: string;
  matches: number | null;
  results: RecentFormSplit;
  splits?: {
    home: RecentFormSplit | null;
    away: RecentFormSplit | null;
    vs_stronger: RecentFormSplit | null;
    vs_weaker: RecentFormSplit | null;
  } | null;
  metrics?: Record<string, { average: number | null; total: number | null; matches: number | null }>;
  captured_at?: string;
}

export interface FormEntry {
  date: string;
  opponent: string | null;
  score: string | null;
  result: 'W' | 'D' | 'L' | null;
  competition: string | null;
  home_away: 'home' | 'away' | null;
}

export interface LineupPlayer {
  name: string;
  status?: 'available' | 'doubtful' | 'unavailable';
  unavailability_type?: string | null;
  reason?: string | null;
  expected_return?: string | null;
}

export interface PreMatchTeam {
  team_id?: string;
  name: string;
  side: 'home' | 'away';
  coach?: string | null;
  form?: FormEntry[];
  rest_days?: number | null;
  advanced?: Record<string, number>;
  recent_form?: RecentForm | null;
  standings?: {
    rank: number | null;
    points: number | null;
    played: number | null;
    wins: number | null;
    draws: number | null;
    losses: number | null;
    goal_difference: number | null;
  } | null;
  lineup?: {
    status?: string;
    formation?: string | null;
    unavailable?: LineupPlayer[];
    starters?: Array<{ name: string; status?: string; season_goals?: number | null; season_rating?: number | null }>;
    source?: string;
  } | null;
}

export interface PreMatchH2H {
  summary?: string | null;
  summary_source?: string | null;
  aggregate?: {
    total_matches: number | null;
    home_wins: number | null;
    draws: number | null;
    away_wins: number | null;
    home_goals: number | null;
    away_goals: number | null;
  } | null;
  matches?: Array<{
    date: string;
    home: string | null;
    away: string | null;
    score: string | null;
    competition: string | null;
    source?: string;
  }>;
  source?: string;
}

export interface PreMatchPayload {
  version?: string;
  status?: 'complete' | 'partial' | 'unavailable';
  generated_at?: string;
  odds?: PreMatchOdds | null;
  referee?: {
    name: string;
    country?: string | null;
    matches?: number | null;
    yellow_cards_per_match?: number | null;
    fouls_per_match?: number | null;
    source?: string;
  } | null;
  weather?: {
    temperature_c: number | null;
    precipitation_chance_pct: number | null;
    description: string | null;
    wind_speed: number | null;
    source?: string;
  } | null;
  venue?: {
    name: string | null;
    city: string | null;
    country: string | null;
    source?: string;
  } | null;
  teams: { home: PreMatchTeam; away: PreMatchTeam };
  h2h?: PreMatchH2H | null;
  insights?: Array<{ team_id?: string | null; side?: 'home' | 'away' | null; text: string }>;
  prediction?: PreMatchPrediction | null;
  meta?: {
    sources?: Array<{ source: string; dataset: string; status: string; duration_ms: number }>;
    coverage?: {
      sections: Record<string, boolean>;
      available: number;
      total: number;
    };
    deadline_ms?: number;
    timed_out?: boolean;
  };
}

/**
 * Bloque post-partido (`post_match` v1.0.0). Solo aparece con
 * `?include=post_match` en partidos `finished`; cualquier sección puede ser
 * `null` y cualquier métrica puede faltar, así que el consumidor debe tolerarlo.
 */
export type PostMatchStatus = 'complete' | 'partial' | 'unavailable';

export type PostMatchSourceId = 'fotmob' | 'espn';

export type PostMatchSourceStatus = 'ok' | 'not_found' | 'error' | 'timeout';

export type PostMatchSection = 'halves' | 'timeline' | 'lineups' | 'players' | 'xg';

export interface PostMatchSourceRun {
  source: PostMatchSourceId;
  status: PostMatchSourceStatus;
  duration_ms: number;
  sections: PostMatchSection[];
  detail?: string;
}

export interface PostMatchScoreValue {
  home: number;
  away: number;
}

export interface PostMatchScore {
  ht: PostMatchScoreValue | null;
  ft: PostMatchScoreValue | null;
}

export interface PostMatchTotalsTeam {
  xg: number | null;
  xga: number | null;
}

export interface PostMatchPeriodTeam {
  xg: number | null;
  non_penalty_xg: number | null;
  shots: number | null;
  shots_on_target: number | null;
  shots_off_target: number | null;
  blocked_shots: number | null;
  big_chances: number | null;
  big_chances_missed: number | null;
  possession_pct: number | null;
  accurate_passes: number | null;
  passes_opposition_half: number | null;
  corners: number | null;
  fouls: number | null;
  yellow_cards: number | null;
  red_cards: number | null;
  offsides: number | null;
  saves: number | null;
  tackles: number | null;
  interceptions: number | null;
  clearances: number | null;
  duels_won: number | null;
}

export interface PostMatchPeriod {
  home: PostMatchPeriodTeam;
  away: PostMatchPeriodTeam;
}

export type PostMatchEventType =
  | 'goal'
  | 'own_goal'
  | 'penalty_goal'
  | 'penalty_missed'
  | 'yellow_card'
  | 'red_card'
  | 'second_yellow'
  | 'substitution';

export type PostMatchPeriodName = 'first_half' | 'second_half' | 'extra_time';

export interface PostMatchEvent {
  minute: number;
  added_time: number | null;
  period: PostMatchPeriodName;
  type: PostMatchEventType;
  side: 'home' | 'away' | null;
  player_id: string | null;
  player_name: string | null;
  assist_id: string | null;
  assist_name: string | null;
  player_in_id: string | null;
  player_in_name: string | null;
  player_out_id: string | null;
  player_out_name: string | null;
  score_after: PostMatchScoreValue | null;
  detail: string | null;
}

export interface PostMatchLineupPlayer {
  player_id: string | null;
  name: string;
  position: string | null;
  position_id: number | null;
  shirt_number: string | null;
  rating: number | null;
}

export interface PostMatchLineupSide {
  formation: string | null;
  coach: string | null;
  starters: PostMatchLineupPlayer[];
  substitutes: PostMatchLineupPlayer[];
}

export interface PostMatchPlayerStats {
  player_id: string | null;
  name: string;
  side: 'home' | 'away';
  starter: boolean;
  position: string | null;
  position_id: number | null;
  shirt_number: string | null;
  minutes: number | null;
  rating: number | null;
  goals: number | null;
  assists: number | null;
  xg: number | null;
  xa: number | null;
  shots: number | null;
  shots_on_target: number | null;
  goals_conceded: number | null;
  saves: number | null;
  xgot_faced: number | null;
  goals_prevented: number | null;
  passes_accurate: number | null;
  passes_total: number | null;
  chances_created: number | null;
  touches: number | null;
  touches_opp_box: number | null;
  tackles: number | null;
  interceptions: number | null;
  clearances: number | null;
  duels_won: number | null;
  duels_lost: number | null;
  aerials_won: number | null;
  fouls: number | null;
  was_fouled: number | null;
  yellow_cards: number;
  red_cards: number;
}

export interface PostMatchCoverage {
  sections: {
    score: boolean;
    halves: boolean;
    timeline: boolean;
    lineups: boolean;
    players: boolean;
    xg: boolean;
  };
  available: number;
  total: number;
}

export interface PostMatchConflict {
  field: string;
  chosen_source: PostMatchSourceId;
  chosen_value: number | string;
  alternatives: Partial<Record<PostMatchSourceId, number | string>>;
}

export interface PostMatchOutput {
  version: string;
  status: PostMatchStatus;
  generated_at: string;
  score: PostMatchScore;
  totals: {
    home: PostMatchTotalsTeam;
    away: PostMatchTotalsTeam;
  } | null;
  periods: {
    first_half: PostMatchPeriod | null;
    second_half: PostMatchPeriod | null;
  } | null;
  timeline: PostMatchEvent[];
  lineups: {
    home: PostMatchLineupSide | null;
    away: PostMatchLineupSide | null;
  } | null;
  players: {
    home: PostMatchPlayerStats[];
    away: PostMatchPlayerStats[];
  };
  meta: {
    sources: PostMatchSourceRun[];
    coverage: PostMatchCoverage;
    conflicts: PostMatchConflict[];
    warnings: string[];
    deadline_ms: number;
    timed_out: boolean;
  };
}

export interface AggregatedResponse {
  match: MatchPayload;
  teams: { home: TeamPayload; away: TeamPayload };
  pre_match?: PreMatchPayload | null;
  post_match?: PostMatchOutput | null;
  meta: {
    canonical_version?: string;
    generated_at?: string;
    sources?: Array<{ source: string; status: string; duration_ms?: number }>;
    validation?: {
      matches_played_consistent?: boolean | null;
      checks?: Array<{ check: string; status: string; detail: string }>;
      conflicts?: unknown[];
    };
    findings?: { detected?: number; documented?: number; document?: string };
    cache?: { hit?: boolean; ttl_seconds?: number };
  };
}

export interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    request_id?: string;
  };
}
