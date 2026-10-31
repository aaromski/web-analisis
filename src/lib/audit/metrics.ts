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

/** Brier binario de una selección; `hit` es el resultado real de esa apuesta. */
export function binaryBrier(probability: number, hit: boolean): number {
  return (probability - (hit ? 1 : 0)) ** 2;
}

export function binaryLogLoss(probability: number, hit: boolean, epsilon = 1e-12): number {
  const picked = hit ? probability : 1 - probability;
  return -Math.log(Math.max(epsilon, picked));
}

export type TotalOutcome = 'over' | 'under' | 'push';

export function totalOutcome(total: number, line: number): TotalOutcome {
  if (Math.abs(total - line) < 1e-9) return 'push';
  return total > line ? 'over' : 'under';
}

/**
 * Resultado de una apuesta de hándicap desde el margen del lado apostado.
 * Devuelve 1 (gana), 0,5 (push) o 0 (pierde). Las líneas de cuarto se
 * reparten a medias entre las dos líneas adyacentes, igual que en la casa.
 */
export function handicapOutcome(margin: number, line: number): number {
  const twice = line * 2;
  if (Math.abs(twice - Math.round(twice)) > 1e-9) {
    const lower = Math.floor(twice) / 2;
    const upper = Math.ceil(twice) / 2;
    return (handicapOutcomeWhole(margin, lower) + handicapOutcomeWhole(margin, upper)) / 2;
  }
  return handicapOutcomeWhole(margin, line);
}

function handicapOutcomeWhole(margin: number, line: number): number {
  const adjusted = margin + line;
  if (adjusted > 1e-9) return 1;
  if (Math.abs(adjusted) <= 1e-9) return 0.5;
  return 0;
}

/**
 * Habilidad relativa (skill score) frente a una referencia: 1 = perfecto,
 * 0 = igual que la referencia, negativo = peor.
 */
export function brierSkill(modelBrier: number, referenceBrier: number): number | null {
  if (!Number.isFinite(modelBrier) || !Number.isFinite(referenceBrier) || referenceBrier <= 0) return null;
  return 1 - modelBrier / referenceBrier;
}

/**
 * Valor de línea de cierre para el lado respaldado: cuánto subió su
 * probabilidad sin vig entre la captura inicial y la final. Positivo = la
 * cuota se acortó después de apostar, señal favorable de CLV.
 */
export function closingLineValue(
  open: OutcomeProbabilities,
  close: OutcomeProbabilities,
  side: Outcome,
): number | null {
  const before = open[side];
  const after = close[side];
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return round(after - before, 4);
}

/** Muestras de calibración del 1X2: una por signo, con su acierto real. */
export function outcomeCalibrationSamples(
  probabilities: OutcomeProbabilities,
  outcome: Outcome,
): CalibrationSample[] {
  return OUTCOMES.map((side) => ({
    probability: probabilities[side],
    hit: side === outcome,
  }));
}

export function topPick(probabilities: OutcomeProbabilities): Outcome {
  return favoriteSide(probabilities);
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

export interface ReliabilityBin {
  low: number;
  high: number;
  predicted: number;
  observed: number;
  count: number;
}

export interface CalibrationSample {
  probability: number;
  hit: boolean;
}

/** Bins de fiabilidad (ancho 0.1): probabilidad media frente a frecuencia real. */
export function reliabilityBins(samples: CalibrationSample[], binWidth = 0.1): ReliabilityBin[] {
  if (samples.length === 0) return [];
  const width = clamp(binWidth, 0.02, 0.5);
  const bins = new Map<number, CalibrationSample[]>();
  for (const sample of samples) {
    // El epsilon evita que 0.3/0.1 = 2.9999 caiga en el bin anterior.
    const index = Math.min(
      Math.floor((clamp(sample.probability, 0, 0.999999) + 1e-9) / width),
      Math.ceil(1 / width) - 1,
    );
    const bucket = bins.get(index) ?? [];
    bucket.push(sample);
    bins.set(index, bucket);
  }
  return [...bins.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, bucket]) => ({
      low: round(index * width, 3),
      high: round(Math.min(1, (index + 1) * width), 3),
      predicted: round(mean(bucket.map((item) => item.probability)) ?? 0, 4),
      observed: round(bucket.filter((item) => item.hit).length / bucket.length, 4),
      count: bucket.length,
    }));
}

/** Error de calibración esperado: media de |predicho − observado| ponderada por bin. */
export function expectedCalibrationError(samples: CalibrationSample[], binWidth = 0.1): number | null {
  const bins = reliabilityBins(samples, binWidth);
  if (bins.length === 0) return null;
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);
  return round(
    bins.reduce((sum, bin) => sum + (bin.count / total) * Math.abs(bin.predicted - bin.observed), 0),
    4,
  );
}

export interface IsotonicCalibrator {
  /** Puntos (x = probabilidad cruda, y = probabilidad calibrada), crecientes. */
  knots: Array<{ x: number; y: number }>;
}

/**
 * Regresión isotónica por PAVA (pool adjacent violators). Devuelve una función
 * escalonada monótona para recalibrar probabilidades con datos históricos.
 */
export function fitIsotonic(samples: CalibrationSample[]): IsotonicCalibrator {
  const sorted = [...samples]
    .filter((sample) => Number.isFinite(sample.probability))
    .sort((left, right) => left.probability - right.probability);
  if (sorted.length === 0) return { knots: [] };

  interface Block {
    sum: number;
    weight: number;
    minX: number;
    maxX: number;
  }
  const blocks: Block[] = [];
  for (const sample of sorted) {
    blocks.push({
      sum: sample.hit ? 1 : 0,
      weight: 1,
      minX: sample.probability,
      maxX: sample.probability,
    });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const previous = blocks[blocks.length - 2];
      if (previous.sum / previous.weight <= last.sum / last.weight) break;
      blocks.splice(blocks.length - 2, 2, {
        sum: previous.sum + last.sum,
        weight: previous.weight + last.weight,
        minX: previous.minX,
        maxX: last.maxX,
      });
    }
  }

  const knots: IsotonicCalibrator['knots'] = [];
  for (const block of blocks) {
    const value = round(block.sum / block.weight, 4);
    if (knots.length > 0 && knots[knots.length - 1].y === value) {
      knots[knots.length - 1].x = round(block.maxX, 4);
    } else {
      knots.push({ x: round(block.maxX, 4), y: value });
    }
  }
  return { knots };
}

export function applyIsotonic(calibrator: IsotonicCalibrator, probability: number): number {
  if (calibrator.knots.length === 0) return clamp(probability, 0, 1);
  let value = calibrator.knots[0].y;
  for (const knot of calibrator.knots) {
    if (probability >= knot.x) value = knot.y;
    else break;
  }
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
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
