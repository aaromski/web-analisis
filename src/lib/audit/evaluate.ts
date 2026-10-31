import type { AggregatedResponse } from '../types/api';
import type { AnalysisResult } from '../types/analysis';
import { anchorLambdas, impliedTotalFromOver, type AnchorResult } from '../engine/anchor';
import { buildLambdas, type LambdaModel } from '../engine/lambdas';
import { resultOutcomes } from '../engine/markets';
import {
  buildMarketSignal,
  extractTotalsMarket,
  extractWinMarket,
  modelAgreement,
  movementWeightScale,
  pickBalancedLine,
} from '../engine/odds';
import { buildScoreMatrix, round } from '../engine/poisson';
import { assessQuality } from '../engine/quality';
import {
  brierScore,
  favoriteError,
  logLoss,
  outcomeFromScore,
  totalDelta,
  winMeanAbsoluteError,
  type MatchMetrics,
  type Outcome,
  type OutcomeProbabilities,
} from './metrics';

const RHO = -0.1;
const MAX_GOALS = 12;

export type Variant = 'motor' | 'anclado';

export interface EvaluatedVariant {
  variant: Variant;
  lambdaHome: number;
  lambdaAway: number;
  lambdaTotal: number;
  marketTotal: number | null;
  anchor: AnchorResult | null;
  winProbabilities: OutcomeProbabilities;
  outcome: Outcome | null;
  metrics: MatchMetrics;
}

function round2(value: number): number {
  return round(value, 2);
}

export interface EvaluateOptions {
  /** Escala manual del peso del ancla (además del movimiento real). */
  weightScale?: number;
}

/**
 * Evalúa una respuesta de la API con el motor puro (sin ancla) o con el ancla
 * de mercado. `analysis` es opcional y solo aporta cobertura de valor y la
 * distancia entre la línea recomendada y la de mercado.
 */
export function evaluateResponse(
  response: AggregatedResponse,
  variant: Variant,
  analysis?: AnalysisResult | null,
  options: EvaluateOptions = {},
): EvaluatedVariant {
  const lambdas: LambdaModel = buildLambdas(response);
  const quality = assessQuality(response);
  const winMarket = extractWinMarket(response.pre_match);
  const oddsWin = winMarket?.source === 'odds' ? winMarket : null;
  const predictionWin = winMarket?.source === 'prediction' ? winMarket : null;
  const totalsMarket = extractTotalsMarket(response.pre_match);
  const signal = buildMarketSignal(response.pre_match);
  const predictionLines = pickBalancedLine(response.pre_match?.prediction?.over_under);
  const predictionTotal =
    predictionLines && predictionLines.probability !== null
      ? impliedTotalFromOver(predictionLines.line, predictionLines.probability)
      : null;

  let lambdaHome = lambdas.lambdaHome;
  let lambdaAway = lambdas.lambdaAway;
  let anchor: AnchorResult | null = null;

  if (variant === 'anclado') {
    const provisional = buildScoreMatrix(lambdaHome, lambdaAway, { rho: RHO, maxGoals: MAX_GOALS });
    const provisionalWin = resultOutcomes(provisional);
    const agreement = modelAgreement(provisionalWin, winMarket);
    anchor = anchorLambdas({
      lambdaHome,
      lambdaAway,
      winMarket: oddsWin,
      totalsMarket,
      predictionTotal,
      predictionWin,
      quality: quality.score,
      agreement,
      weightScale: movementWeightScale(signal) * (options.weightScale ?? 1),
    });
    if (anchor.applied) {
      lambdaHome = anchor.lambdaHome;
      lambdaAway = anchor.lambdaAway;
    }
  }

  const matrix = buildScoreMatrix(lambdaHome, lambdaAway, { rho: RHO, maxGoals: MAX_GOALS });
  const modelWin = resultOutcomes(matrix);
  const marketWin: OutcomeProbabilities | null = oddsWin
    ? { home: oddsWin.home, draw: oddsWin.draw, away: oddsWin.away }
    : null;
  const marketTotal =
    totalsMarket.line !== null && totalsMarket.over !== null
      ? impliedTotalFromOver(totalsMarket.line, totalsMarket.over)
      : null;
  const outcome: Outcome | null = outcomeFromScore(response.match.score);
  const favorite = marketWin ? favoriteError(modelWin, marketWin) : null;
  const lambdaTotal = lambdaHome + lambdaAway;

  const totals = analysis?.markets.find((market) => market.key === 'totals');
  const totalsLineGap =
    totals && totals.marketLine !== null && totals.line !== null ? totals.line - totals.marketLine : null;

  return {
    variant,
    lambdaHome: round2(lambdaHome),
    lambdaAway: round2(lambdaAway),
    lambdaTotal: round2(lambdaTotal),
    marketTotal: marketTotal === null ? null : round2(marketTotal),
    anchor,
    winProbabilities: {
      home: round(modelWin.home, 4),
      draw: round(modelWin.draw, 4),
      away: round(modelWin.away, 4),
    },
    outcome,
    metrics: {
      label: `${response.teams.home.name} – ${response.teams.away.name}`,
      variant,
      lambdaTotal: round2(lambdaTotal),
      marketTotal: marketTotal === null ? null : round2(marketTotal),
      totalDelta: totalDelta(lambdaTotal, marketTotal),
      mae1x2: marketWin ? winMeanAbsoluteError(modelWin, marketWin) : null,
      favoriteDelta: favorite ? favorite.delta : null,
      favoriteMarket: favorite ? favorite.marketProbability : null,
      favoriteModel: favorite ? favorite.modelProbability : null,
      favoriteSide: favorite ? favorite.side : null,
      brier: outcome ? brierScore(modelWin, outcome) : null,
      logLoss: outcome ? logLoss(modelWin, outcome) : null,
      totalsLineGap,
      edgesComputed: analysis ? analysis.markets.filter((market) => market.edge !== null).length : 0,
      markets: analysis ? analysis.markets.length : 0,
    },
  };
}
