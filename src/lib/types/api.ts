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

export interface AggregatedResponse {
  match: MatchPayload;
  teams: { home: TeamPayload; away: TeamPayload };
  pre_match?: PreMatchPayload | null;
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
