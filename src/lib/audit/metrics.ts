/**
 * Métricas puras del arnés de medición. No conocen el motor ni la API: reciben
 * números ya calculados y devuelven errores en unidades de probabilidad.
 */

export interface OutcomeProbabilities {
  home: number;
  draw: number;
  away: number;
}

export type Outcome = 'home' | 'draw' | 'away';

const OUTCOMES: Outcome[] = ['home', 'draw', 'away'];

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function meanAbsoluteError(pairs: Array<[number, number]>): number {
  if (pairs.length === 0) return 0;
  return pairs.reduce((sum, [left, right]) => sum + Math.abs(left - right), 0) / pairs.length;
}

/** Error medio absoluto del 1X2 completo, en unidades de probabilidad (0–1). */
export function winMeanAbsoluteError(model: OutcomeProbabilities, market: OutcomeProbabilities): number {
  return meanAbsoluteError([
    [model.home, market.home],
    [model.draw, market.draw],
    [model.away, market.away],
  ]);
}

export function favoriteSide(probabilities: OutcomeProbabilities): Outcome {
  return OUTCOMES.reduce((best, side) => (probabilities[side] > probabilities[best] ? side : best), OUTCOMES[0]);
}

export interface FavoriteError {
  side: Outcome;
  modelProbability: number;
  marketProbability: number;
  /** model − market en unidades de probabilidad. Negativo = favorito infravalorado. */
  delta: number;
}

/**
 * Error del favorito según el mercado. Se toma el lado favorito del mercado
 * para que el sesgo sea comparable entre partidos y variantes.
 */
export function favoriteError(model: OutcomeProbabilities, market: OutcomeProbabilities): FavoriteError {
  const side = favoriteSide(market);
  return {
    side,
    modelProbability: model[side],
    marketProbability: market[side],
    delta: model[side] - market[side],
  };
}

/** Brier multiclase: 0 es perfecto, 2 es el peor caso. */
export function brierScore(probabilities: OutcomeProbabilities, outcome: Outcome): number {
  return OUTCOMES.reduce((sum, side) => {
    const expected = side === outcome ? 1 : 0;
    return sum + (probabilities[side] - expected) ** 2;
  }, 0);
}

export function logLoss(probabilities: OutcomeProbabilities, outcome: Outcome, epsilon = 1e-12): number {
  return -Math.log(Math.max(epsilon, probabilities[outcome]));
}

export function outcomeFromScore(score: { home: number | null; away: number | null } | null | undefined): Outcome | null {
  if (!score || typeof score.home !== 'number' || typeof score.away !== 'number') return null;
  if (score.home > score.away) return 'home';
  if (score.home < score.away) return 'away';
  return 'draw';
}

/** λ_total − total implícito del mercado, en goles. */
export function totalDelta(lambdaTotal: number, marketTotal: number | null): number | null {
  if (marketTotal === null || !Number.isFinite(marketTotal)) return null;
  return lambdaTotal - marketTotal;
}

export interface MatchMetrics {
  label: string;
  variant: 'motor' | 'anclado';
  lambdaTotal: number;
  marketTotal: number | null;
  totalDelta: number | null;
  mae1x2: number | null;
  favoriteDelta: number | null;
  favoriteMarket: number | null;
  favoriteModel: number | null;
  favoriteSide: Outcome | null;
  brier: number | null;
  logLoss: number | null;
  totalsLineGap: number | null;
  edgesComputed: number;
  markets: number;
}

export interface AggregateMetrics {
  matches: number;
  meanMae1x2: number | null;
  meanAbsTotalDelta: number | null;
  meanAbsFavoriteDelta: number | null;
  meanBrier: number | null;
  edgesComputed: number;
  markets: number;
}

export function aggregateMetrics(rows: MatchMetrics[]): AggregateMetrics {
  const numericOrNull = (values: Array<number | null>): number[] =>
    values.filter((value): value is number => value !== null && Number.isFinite(value));

  return {
    matches: rows.length,
    meanMae1x2: mean(numericOrNull(rows.map((row) => row.mae1x2))),
    meanAbsTotalDelta: mean(numericOrNull(rows.map((row) => (row.totalDelta === null ? null : Math.abs(row.totalDelta))))),
    meanAbsFavoriteDelta: mean(
      numericOrNull(rows.map((row) => (row.favoriteDelta === null ? null : Math.abs(row.favoriteDelta)))),
    ),
    meanBrier: mean(numericOrNull(rows.map((row) => row.brier))),
    edgesComputed: rows.reduce((sum, row) => sum + row.edgesComputed, 0),
    markets: rows.reduce((sum, row) => sum + row.markets, 0),
  };
}
