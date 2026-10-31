import type { MarketKey, ParlaySuggestion } from '../types/analysis';
import { fairOdds, jointMatrixProbability } from './markets';
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from './params';
import type { ScoreMatrix } from './poisson';

export interface ParlayCandidate {
  marketKey: MarketKey;
  market: string;
  selection: string;
  probability: number;
  predicate: (home: number, away: number) => boolean;
}

const NEST_EPSILON = 1e-6;

/**
 * Dos patas anidadas (p. ej. «Gana el local» y «1X») no aportan información
 * nueva: la conjunta coincide con la probabilidad de la más amplia. Se detecta
 * comparando la conjunta con cada pata, sin listar combinaciones a mano.
 */
function nestedLeg(matrix: ScoreMatrix, first: ParlayCandidate, second: ParlayCandidate): boolean {
  const joint = jointMatrixProbability(matrix, [first.predicate, second.predicate]);
  return (
    joint >= first.probability - NEST_EPSILON || joint >= second.probability - NEST_EPSILON
  );
}

/**
 * Combinada conservadora: hasta 3 selecciones de mercados distintos. La
 * probabilidad conjunta se calcula sumando las celdas compatibles de la matriz,
 * por lo que la correlación entre mercados del mismo partido queda incorporada.
 */
export function buildParlay(
  matrix: ScoreMatrix,
  candidates: ParlayCandidate[],
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): ParlaySuggestion | null {
  const { minLeg, maxLeg, minJoint, maxLegs } = params.parlay;
  const eligible = candidates
    .filter((candidate) => candidate.probability >= minLeg && candidate.probability <= maxLeg)
    .sort((a, b) => b.probability - a.probability);

  const chosen: ParlayCandidate[] = [];
  for (const candidate of eligible) {
    if (chosen.some((item) => item.marketKey === candidate.marketKey)) continue;
    if (chosen.some((item) => nestedLeg(matrix, item, candidate))) continue;
    const next = [...chosen, candidate];
    const joint = jointMatrixProbability(matrix, next.map((item) => item.predicate));
    if (joint < minJoint) continue;
    chosen.push(candidate);
    if (chosen.length === maxLegs) break;
  }

  if (chosen.length < 2) return null;
  const probability = jointMatrixProbability(matrix, chosen.map((item) => item.predicate));

  return {
    legs: chosen.map((item) => ({
      marketKey: item.marketKey,
      market: item.market,
      selection: item.selection,
      probability: item.probability,
      fairOdds: fairOdds(item.probability),
    })),
    probability,
    fairOdds: fairOdds(probability),
    correlationNote:
      'Probabilidad conjunta calculada sobre la matriz de marcadores del partido: las selecciones están correlacionadas y no se multiplican entre sí.',
  };
}
