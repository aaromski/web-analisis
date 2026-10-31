import type { TotalsMarket, WinMarket } from './odds';
import { DEFAULT_ENGINE_PARAMS, MAX_GOALS, RHO, type AnchorWeightKey, type EngineParams } from './params';
import {
  buildScoreMatrix,
  clamp,
  poissonOver,
  resultProbability,
  round,
  type ScoreMatrix,
} from './poisson';

export type AnchorSource =
  | 'moneyline+totals'
  | 'moneyline+prediction'
  | 'moneyline'
  | 'totals'
  | 'prediction'
  | 'none';

export interface MarketAnchor {
  applied: boolean;
  weight: number;
  source: AnchorSource;
  marketTotal: number | null;
  marketHome: number | null;
  marketAway: number | null;
  totalSource: 'odds' | 'prediction' | 'none';
  note: string | null;
}

export interface AnchorInput {
  lambdaHome: number;
  lambdaAway: number;
  winMarket: WinMarket | null;
  totalsMarket: TotalsMarket;
  /** Total implícito de la predicción externa, si no hay cuotas de totales. */
  predictionTotal?: number | null;
  /** 1X2 de la predicción externa, usado si no hay moneyline. */
  predictionWin?: WinMarket | null;
  quality: number;
  agreement: number;
  /** Escala el peso (p. ej. según el movimiento de la línea). 1 = neutro. */
  weightScale?: number;
}

export interface AnchorResult extends MarketAnchor {
  lambdaHome: number;
  lambdaAway: number;
}

function homeProbability(lambdaHome: number, lambdaAway: number): number {
  const matrix = buildScoreMatrix(lambdaHome, lambdaAway, { rho: RHO, maxGoals: MAX_GOALS });
  return resultProbability(matrix, 'home');
}

/**
 * Total de goles implícito en una línea de totales y su probabilidad over sin
 * vig. Invierte la Poisson 1D por bisección: P(total > línea) crece con λ.
 */
export function impliedTotalFromOver(
  line: number,
  over: number,
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): number | null {
  if (!Number.isFinite(line) || !Number.isFinite(over)) return null;
  const { anchor } = params;
  if (over <= anchor.overMin || over >= anchor.overMax) return null;
  let low = params.lambda.minLambda;
  let high = anchor.impliedTotalMax;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const mid = (low + high) / 2;
    if (poissonOver(mid, line) < over) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Reparte un total de mercado entre local y visitante para reproducir la
 * probabilidad de victoria local. La probabilidad local crece de forma monótona
 * con la cuota de goles del local, así que basta una bisección.
 */
export function fitSupremacy(
  total: number,
  targetHome: number,
  rho = RHO,
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): { home: number; away: number } {
  const { anchor } = params;
  const safeTotal = clamp(total, anchor.supremacyTotalMin, anchor.supremacyTotalMax);
  const target = clamp(targetHome, anchor.supremacyHomeMin, anchor.supremacyHomeMax);
  let low = anchor.supremacyShareMin;
  let high = anchor.supremacyShareMax;
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const mid = (low + high) / 2;
    if (homeProbability(safeTotal * mid, safeTotal * (1 - mid)) < target) low = mid;
    else high = mid;
  }
  const share = (low + high) / 2;
  return { home: safeTotal * share, away: safeTotal * (1 - share) };
}

function winError(lambdaHome: number, lambdaAway: number, target: WinMarket): number {
  const matrix: ScoreMatrix = buildScoreMatrix(lambdaHome, lambdaAway, { rho: RHO, maxGoals: MAX_GOALS });
  const home = resultProbability(matrix, 'home');
  const draw = resultProbability(matrix, 'draw');
  const away = resultProbability(matrix, 'away');
  return (home - target.home) ** 2 + (draw - target.draw) ** 2 + (away - target.away) ** 2;
}

/**
 * Ajuste 2D cuando solo hay moneyline: descenso por coordenadas con paso
 * decreciente. Devuelve el par de λ que mejor reproduce el 1X2 sin vig.
 */
export function fitWinProbabilities(
  target: WinMarket,
  start: { home: number; away: number },
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): { home: number; away: number; error: number } {
  const { minLambda, maxLambda } = params.lambda;
  let home = clamp(start.home, minLambda, maxLambda);
  let away = clamp(start.away, minLambda, maxLambda);
  let best = winError(home, away, target);
  let step = 0.4;
  const moves: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ];
  for (let iteration = 0; iteration < 80 && step > 0.004; iteration += 1) {
    let improved = false;
    for (const [homeStep, awayStep] of moves) {
      const candidateHome = clamp(home + homeStep * step, minLambda, maxLambda);
      const candidateAway = clamp(away + awayStep * step, minLambda, maxLambda);
      const error = winError(candidateHome, candidateAway, target);
      if (error < best - 1e-10) {
        best = error;
        home = candidateHome;
        away = candidateAway;
        improved = true;
      }
    }
    if (!improved) step /= 2;
  }
  return { home, away, error: best };
}

function scaleToTotal(
  lambdaHome: number,
  lambdaAway: number,
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): { home: number; away: number } {
  const { minLambda, maxLambda, minTotal, maxTotal } = params.lambda;
  let home = clamp(lambdaHome, minLambda, maxLambda);
  let away = clamp(lambdaAway, minLambda, maxLambda);
  const total = home + away;
  if (total > maxTotal) {
    const factor = maxTotal / total;
    home *= factor;
    away *= factor;
  } else if (total < minTotal) {
    const factor = minTotal / total;
    home *= factor;
    away *= factor;
  }
  return { home: round(home, 2), away: round(away, 2) };
}

const SOURCE_LABEL: Record<AnchorSource, string> = {
  'moneyline+totals': 'total y supremacía',
  'moneyline+prediction': 'predicción externa',
  moneyline: 'solo 1X2',
  totals: 'solo total',
  prediction: 'solo predicción',
  none: 'sin cuotas',
};

const WEIGHT_KEY: Record<Exclude<AnchorSource, 'none'>, AnchorWeightKey> = {
  'moneyline+totals': 'moneylineTotals',
  'moneyline+prediction': 'moneylinePrediction',
  totals: 'totals',
  prediction: 'prediction',
  moneyline: 'moneyline',
};

/**
 * Ancla λ al mercado. El mercado resume la expectativa agregada de goles y
 * supremacía; el modelo aporta la estructura de la matriz. El peso es mayor
 * cuando los datos propios son débiles o el modelo se aleja del mercado.
 * Sin cuotas, la predicción externa actúa como referencia de menor peso.
 */
export function anchorLambdas(
  input: AnchorInput,
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): AnchorResult {
  const empty: AnchorResult = {
    lambdaHome: input.lambdaHome,
    lambdaAway: input.lambdaAway,
    applied: false,
    weight: 0,
    source: 'none',
    marketTotal: null,
    marketHome: null,
    marketAway: null,
    totalSource: 'none',
    note: null,
  };

  const totals = input.totalsMarket;
  const hasTotals =
    totals.line !== null &&
    totals.over !== null &&
    Number.isFinite(totals.line) &&
    totals.over > 0.02 &&
    totals.over < 0.98;
  const oddsTotal = hasTotals ? impliedTotalFromOver(totals.line as number, totals.over as number) : null;
  const predictedTotal =
    typeof input.predictionTotal === 'number' && Number.isFinite(input.predictionTotal) && input.predictionTotal > 0.4
      ? input.predictionTotal
      : null;
  const marketTotal = oddsTotal ?? predictedTotal;
  const totalSource: MarketAnchor['totalSource'] =
    oddsTotal !== null ? 'odds' : predictedTotal !== null ? 'prediction' : 'none';

  const hasWin = Boolean(input.winMarket && input.winMarket.home > 0.01 && input.winMarket.away > 0.01);
  const winTarget: WinMarket | null = hasWin
    ? (input.winMarket as WinMarket)
    : input.predictionWin && input.predictionWin.home > 0.01
      ? input.predictionWin
      : null;

  let source: AnchorSource = 'none';
  let marketHome: number | null = null;
  let marketAway: number | null = null;

  if (marketTotal !== null && winTarget) {
    const split = fitSupremacy(marketTotal, winTarget.home);
    marketHome = split.home;
    marketAway = split.away;
    source = totalSource === 'odds' ? 'moneyline+totals' : 'moneyline+prediction';
  } else if (marketTotal !== null) {
    const share = input.lambdaHome / Math.max(0.2, input.lambdaHome + input.lambdaAway);
    marketHome = marketTotal * share;
    marketAway = marketTotal * (1 - share);
    source = totalSource === 'odds' ? 'totals' : 'prediction';
  } else if (winTarget) {
    const fit = fitWinProbabilities(winTarget, {
      home: input.lambdaHome,
      away: input.lambdaAway,
    });
    marketHome = fit.home;
    marketAway = fit.away;
    source = 'moneyline';
  }

  if (
    source === 'none' ||
    marketHome === null ||
    marketAway === null ||
    !Number.isFinite(marketHome) ||
    !Number.isFinite(marketAway)
  ) {
    return empty;
  }

  const quality = clamp(input.quality, 0, 1);
  const agreement = clamp(input.agreement, 0, 1);
  const modelTotal = input.lambdaHome + input.lambdaAway;
  const referenceTotal = marketTotal ?? marketHome + marketAway;
  const { anchor: knobs } = params;
  // Una discrepancia grande de total suele ser un problema de escala del motor
  // (promedios de temporada), no información nueva: se refuerza el ancla.
  const gapBoost =
    clamp((Math.abs(modelTotal - referenceTotal) - knobs.gapThreshold) / knobs.gapRange, 0, 1) *
    knobs.gapWeight;
  const config = knobs.weight[WEIGHT_KEY[source]];
  let weight = clamp(
    config.base +
      config.quality * (1 - quality) +
      config.agreement * (1 - agreement) +
      gapBoost * config.gapScale,
    config.min,
    config.max,
  );
  if (input.weightScale !== undefined) {
    weight = clamp(
      weight * clamp(input.weightScale, knobs.scaleMin, knobs.scaleMax),
      knobs.finalWeightMin,
      knobs.finalWeightMax,
    );
  }

  const blended = scaleToTotal(
    (1 - weight) * input.lambdaHome + weight * marketHome,
    (1 - weight) * input.lambdaAway + weight * marketAway,
    params,
  );

  return {
    lambdaHome: blended.home,
    lambdaAway: blended.away,
    applied: true,
    weight: round(weight, 3),
    source,
    marketTotal: marketTotal === null ? null : round(marketTotal, 2),
    marketHome: round(marketHome, 2),
    marketAway: round(marketAway, 2),
    totalSource,
    note: `λ anclada al mercado (${SOURCE_LABEL[source]}, peso ${Math.round(weight * 100)} %).`,
  };
}
