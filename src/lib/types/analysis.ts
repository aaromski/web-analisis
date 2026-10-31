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

export interface ProbabilityInterval {
  low: number;
  high: number;
}

/** Origen de la probabilidad externa con la que se compara el modelo. */
export type ComparisonSource = 'odds' | 'extra_market' | 'prediction';

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
  /** Probabilidad del modelo evaluada en la línea de mercado (misma apuesta). */
  marketModelProbability: number | null;
  edge: number | null;
  /** De dónde sale la referencia externa: cuotas, mercado extra o predicción. */
  comparisonSource?: ComparisonSource | null;
  /** Rango p10-p90 de Monte Carlo para la selección publicada. */
  interval?: ProbabilityInterval | null;
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
  /** 0–1: cobertura ponderada por observed/projected, no solo presencia. */
  confidenceCoverage: number;
  /** 0–1: proporción de estadísticas realmente observadas. */
  observedShare: number;
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
  lineupStatus?: string | null;
  unavailable?: number | null;
  restDays?: number | null;
  strengthPpg?: number | null;
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

export interface LineupInfo {
  status: string | null;
  starters: number | null;
  unavailable: number;
  averageRating: number | null;
}

export interface TeamStanding {
  rank: number | null;
  points: number | null;
  played: number | null;
  ppg: number | null;
}

export interface MatchContext {
  referee: { name: string; cardsPerMatch: number | null } | null;
  weather: {
    description: string | null;
    temperatureC: number | null;
    precipitationPct: number | null;
    windSpeed: number | null;
  } | null;
  prediction: {
    model: string | null;
    confidence: number | null;
    result: { home: number | null; draw: number | null; away: number | null };
    expectedGoals: { home: number | null; away: number | null };
    mostLikelyScore: string | null;
    bttsYes: number | null;
    overUnder: Array<{ line: number; probability: number | null }>;
    corners: Array<{ line: number; probability: number | null }>;
  } | null;
  lineups: {
    home: LineupInfo | null;
    away: LineupInfo | null;
  } | null;
  rest: { home: number | null; away: number | null } | null;
  standings: { home: TeamStanding | null; away: TeamStanding | null } | null;
  recentForm: {
    home: { form: string | null; goalsFor: number | null; goalsAgainst: number | null; matches: number | null };
    away: { form: string | null; goalsFor: number | null; goalsAgainst: number | null; matches: number | null };
  } | null;
  injuries: Array<{ side: 'home' | 'away'; name: string; status: string; reason: string | null }>;
  h2h: { summary: string | null; totalMatches: number | null } | null;
  odds: {
    provider: string | null;
    providerCount: number | null;
    capturedAt: string | null;
    moneylineNoVig: { home: number; draw: number; away: number } | null;
    totalsLine: number | null;
    totalsOverNoVig: number | null;
    spreadLine: number | null;
    openTotalLine: number | null;
    openMoneylineNoVig: { home: number; draw: number; away: number } | null;
    movement: { home: string | null; draw: string | null; away: string | null } | null;
  } | null;
  venue: { name: string | null; city: string | null; country: string | null } | null;
  insights: string[];
}

export interface MarketAnchorMeta {
  applied: boolean;
  /** Peso del mercado en λ (0–1). */
  weight: number;
  source: 'moneyline+totals' | 'moneyline+prediction' | 'moneyline' | 'totals' | 'prediction' | 'none';
  marketTotal: number | null;
  marketHome: number | null;
  marketAway: number | null;
  /** De dónde sale el total de referencia: cuotas o predicción. */
  totalSource: 'odds' | 'prediction' | 'none';
}

export interface MarketSignal {
  openTotalLine: number | null;
  currentTotalLine: number | null;
  totalLineDrift: number | null;
  openMoneylineNoVig: { home: number; draw: number; away: number } | null;
  currentMoneylineNoVig: { home: number; draw: number; away: number } | null;
  moneylineDrift: { home: number; draw: number; away: number } | null;
  movement: { home: string | null; draw: string | null; away: string | null } | null;
  providerCount: number | null;
}

export interface ModelAdjustment {
  key: string;
  label: string;
  side: 'home' | 'away' | 'both';
  /** Cambio porcentual aplicado a λ; negativo reduce los goles esperados. */
  deltaPct: number;
  detail: string;
}

export interface ModelUncertainty {
  samples: number;
  /** Desviación lognormal usada para perturbar λ. */
  sigma: number;
  lambdas: {
    home: ProbabilityInterval;
    away: ProbabilityInterval;
    total: ProbabilityInterval;
  };
  win: {
    home: ProbabilityInterval;
    draw: ProbabilityInterval;
    away: ProbabilityInterval;
  };
  totalLine: number | null;
  total: ProbabilityInterval | null;
}

export interface LiveMeta {
  elapsedMinutes: number;
  remainingShare: number;
  currentScore: { home: number; away: number };
  remainingLambdaHome: number;
  remainingLambdaAway: number;
}

export interface MarketWinTrace {
  home: number;
  draw: number;
  away: number;
  source: 'odds' | 'prediction';
}

/**
 * Traza auditable del paso por el mercado. Permite comparar el motor puro con
 * la referencia sin vig y recalcular el valor en la línea exacta de la casa.
 */
export interface EngineTrace {
  /** λ antes de mezclar con el mercado (motor propio). */
  preAnchorLambdas: { home: number; away: number; total: number };
  /** 1X2 de referencia sin vig; null en vivo o sin cuotas/predicción. */
  marketWin: MarketWinTrace | null;
  marketTotals: { line: number | null; over: number | null; under: number | null } | null;
  marketSpread: { line: number | null; home: number | null; away: number | null } | null;
  /** Probabilidad del modelo final en la línea de totales del mercado. */
  modelTotalsAtMarketLine: { line: number; over: number; under: number; push: number } | null;
  /** Cobertura del modelo en la línea de hándicap del mercado (perspectiva local). */
  modelHandicapAtMarketLine: { line: number; home: number; away: number } | null;
}

export interface ModelMeta {
  version: string;
  generatedAt: string;
  rho: number;
  maxGoals: number;
  /** Umbral de confianza por defecto aplicado a las líneas dinámicas. */
  threshold: number;
  thresholds: {
    default: number;
    totals: number;
    handicap: number;
    corners: number;
  };
  /** Línea base de goles usada antes de calibrar. */
  baseTotalLine: number;
  /** Media de goles por partido de la liga usada como escala. */
  leagueBaseline: number;
  marketAgreement: number;
  marketAnchor: MarketAnchorMeta;
  marketSignal: MarketSignal;
  trace: EngineTrace;
  adjustments: ModelAdjustment[];
  uncertainty: ModelUncertainty | null;
  live: LiveMeta | null;
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
