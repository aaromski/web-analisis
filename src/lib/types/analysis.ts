/**
 * Contrato de salida del motor. Es serializable (JSON) y lo consumen tanto la
 * UI como el prompt de Gemini.
 */

export type RiskLevel = 'Bajo' | 'Medio' | 'Alto';

export type MarketKey =
  | 'result'
  | 'double_chance'
  | 'totals'
  | 'handicap'
  | 'first_goal'
  | 'odd_even'
  | 'ht_ft'
  | 'exact_score'
  | 'btts'
  | 'corners';

export interface CalibrationPoint {
  line: number;
  probability: number;
  over?: number;
  under?: number;
  meetsThreshold: boolean;
  selected: boolean;
}

export interface MarketOption {
  label: string;
  code?: string;
  probability: number;
  fairOdds: number;
  selected?: boolean;
  marketProbability?: number | null;
  edge?: number | null;
}

export interface ScoreProbability {
  score: string;
  home: number;
  away: number;
  probability: number;
}

export interface HtFtProbability {
  ht: '1' | 'X' | '2';
  ft: '1' | 'X' | '2';
  label: string;
  probability: number;
}

export interface MarketResult {
  key: MarketKey;
  index: number;
  name: string;
  tagline: string;
  /** Selección recomendada, p. ej. "Over 2.5" o "AC Milan -0.5". */
  selection: string;
  /** Código corto para depuración, p. ej. "over", "home", "yes". */
  selectionCode: string;
  line: number | null;
  baseLine: number | null;
  marketLine: number | null;
  probability: number;
  fairOdds: number;
  threshold: number;
  confidence: number;
  risk: RiskLevel;
  calibrated: boolean;
  available: boolean;
  marketProbability: number | null;
  edge: number | null;
  curve: CalibrationPoint[];
  alternatives: MarketOption[];
  scores?: ScoreProbability[];
  combos?: HtFtProbability[];
  explanation: string;
  note?: string;
}

export interface ParlayLeg {
  marketKey: MarketKey;
  market: string;
  selection: string;
  probability: number;
  fairOdds: number;
}

export interface ParlaySuggestion {
  legs: ParlayLeg[];
  probability: number;
  fairOdds: number;
  correlationNote: string;
}

export interface DataQuality {
  /** 0–1. */
  score: number;
  label: 'Alta' | 'Media' | 'Baja';
  /** 0–1: proporción de estadísticas clave presentes. */
  coverage: number;
  sample: number | null;
  signals: string[];
  caveats: string[];
  insufficient: boolean;
}

export interface TeamModel {
  name: string;
  side: 'home' | 'away';
  lambda: number;
  attack: number;
  defense: number;
  sample: number | null;
  stats: {
    xg: number | null;
    xga: number | null;
    goals: number | null;
    conceded: number | null;
    shotsOnTarget: number | null;
    corners: number | null;
    form: string | null;
  };
  sources: string[];
}

export interface MatchSummary {
  id: string;
  leagueId: string;
  leagueName: string;
  season: string | null;
  date: string;
  status: 'finished' | 'scheduled' | 'live' | 'unknown';
  venue: string | null;
  homeName: string;
  awayName: string;
  score: { home: number | null; away: number | null };
  isRetrospective: boolean;
}

export interface MatchContext {
  referee: { name: string; cardsPerMatch: number | null } | null;
  weather: { description: string | null; temperatureC: number | null; precipitationPct: number | null } | null;
  prediction: {
    model: string | null;
    result: { home: number | null; draw: number | null; away: number | null };
    expectedGoals: { home: number | null; away: number | null };
    mostLikelyScore: string | null;
    bttsYes: number | null;
  } | null;
  recentForm: {
    home: { form: string | null; goalsFor: number | null; goalsAgainst: number | null; matches: number | null };
    away: { form: string | null; goalsFor: number | null; goalsAgainst: number | null; matches: number | null };
  } | null;
  injuries: Array<{ side: 'home' | 'away'; name: string; status: string; reason: string | null }>;
  h2h: { summary: string | null; totalMatches: number | null } | null;
  odds: {
    provider: string | null;
    capturedAt: string | null;
    moneylineNoVig: { home: number; draw: number; away: number } | null;
    totalsLine: number | null;
    totalsOverNoVig: number | null;
    spreadLine: number | null;
  } | null;
  insights: string[];
}

export interface ModelMeta {
  version: string;
  generatedAt: string;
  rho: number;
  maxGoals: number;
  /** Umbral de confianza aplicado a las líneas dinámicas. */
  threshold: number;
  /** Línea base de goles usada antes de calibrar. */
  baseTotalLine: number;
  marketAgreement: number;
  lambdaSources: string[];
}

export interface AnalysisResult {
  match: MatchSummary;
  teams: { home: TeamModel; away: TeamModel };
  lambdas: { home: number; away: number; total: number };
  winProbabilities: { home: number; draw: number; away: number };
  dataQuality: DataQuality;
  markets: MarketResult[];
  parlay: ParlaySuggestion | null;
  context: MatchContext;
  model: ModelMeta;
}

export interface AnalysisEnvelope {
  analysis: AnalysisResult;
  source: {
    canonicalVersion: string | null;
    generatedAt: string | null;
    preMatchStatus: string | null;
    coverage: { available: number; total: number } | null;
    apiLatencyMs: number;
  };
}

export interface AiReport {
  report: string;
  model: string;
  generatedAt: string;
  latencyMs: number;
}
