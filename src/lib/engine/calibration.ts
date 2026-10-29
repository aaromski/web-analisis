import type { CalibrationPoint, MarketOption, RiskLevel } from '../types/analysis';
import { fairOdds } from './markets';
import { clamp, handicapCover, poissonOver, poissonUnder, round, totalOver, totalUnder, type ScoreMatrix } from './poisson';

export const TOTAL_LINES: number[] = Array.from({ length: 7 }, (_, index) => index + 0.5);
export const CORNER_LINES: number[] = Array.from({ length: 9 }, (_, index) => index + 6.5);
export const HANDICAP_LINES: number[] = Array.from({ length: 21 }, (_, index) => (index - 12) / 4);

/**
 * Umbral de confianza que debe superar una línea para publicarse. Más datos
 * dudosos o más desacuerdo con el mercado elevan el listón.
 */
export function confidenceThreshold(
  quality: number,
  lambdaTotal: number,
  marketTotalLine: number | null,
): number {
  const disagreement = marketTotalLine !== null && Math.abs(lambdaTotal - marketTotalLine) > 0.35 ? 1 : 0;
  return round(clamp(0.74 + 0.08 * (1 - quality) + 0.02 * disagreement, 0.68, 0.86), 3);
}

export function computeConfidence(probability: number, quality: number, agreement: number): number {
  const value = 0.7 * probability + 0.18 * quality + 0.12 * agreement;
  return Math.round(clamp(value, 0, 1) * 100);
}

export function riskFromConfidence(confidence: number, quality: number): RiskLevel {
  if (confidence >= 74 && quality >= 0.6) return 'Bajo';
  if (confidence >= 62) return 'Medio';
  return 'Alto';
}

export function nearestHalfLine(value: number, min = 0.5, max = 6.5): number {
  const raw = Math.round(value - 0.5) + 0.5;
  return clamp(raw, min, max);
}

export function formatSignedLine(line: number): string {
  if (Math.abs(line) < 1e-9) return '0';
  const sign = line > 0 ? '+' : '-';
  const abs = Math.abs(line);
  return `${sign}${Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(2).replace(/0$/, '')}`;
}

export interface TotalsCalibration {
  selection: 'over' | 'under';
  line: number;
  probability: number;
  marketProbability: number | null;
  edge: number | null;
  calibrated: boolean;
  curve: CalibrationPoint[];
  alternatives: MarketOption[];
  explanation: string;
  note?: string;
  baseLine: number;
}

export function calibrateTotals(
  matrix: ScoreMatrix,
  lambdaTotal: number,
  threshold: number,
  marketLine: number | null,
  marketOver: number | null,
  marketUnder: number | null,
): TotalsCalibration {
  const baseLine = nearestHalfLine(lambdaTotal);
  const points = TOTAL_LINES.map((line) => ({
    line,
    over: totalOver(matrix, line),
    under: totalUnder(matrix, line),
  }));

  const overCandidates = points.filter((point) => (point.over ?? 0) >= threshold);
  const underCandidates = points.filter((point) => (point.under ?? 0) >= threshold);

  // Over: la línea más alta que mantiene el umbral. Under: la más baja.
  const overPick = overCandidates.length > 0 ? overCandidates[overCandidates.length - 1] : null;
  const underPick = underCandidates.length > 0 ? underCandidates[0] : null;

  let selection: 'over' | 'under';
  let picked: { line: number; over: number; under: number };
  let calibrated = true;

  if (overPick && underPick) {
    const overMargin = (overPick.over ?? 0) - threshold;
    const underMargin = (underPick.under ?? 0) - threshold;
    selection = overMargin >= underMargin ? 'over' : 'under';
    picked = selection === 'over' ? overPick : underPick;
  } else if (overPick || underPick) {
    selection = overPick ? 'over' : 'under';
    picked = (overPick ?? underPick)!;
  } else {
    calibrated = false;
    const bestOver = [...points].sort((a, b) => (b.over ?? 0) - (a.over ?? 0))[0];
    const bestUnder = [...points].sort((a, b) => (b.under ?? 0) - (a.under ?? 0))[0];
    if ((bestOver.over ?? 0) >= (bestUnder.under ?? 0)) {
      selection = 'over';
      picked = bestOver;
    } else {
      selection = 'under';
      picked = bestUnder;
    }
  }

  const probability = selection === 'over' ? (picked.over ?? 0) : (picked.under ?? 0);
  const marketProbability =
    marketLine !== null && Math.abs(marketLine - picked.line) < 1e-9
      ? selection === 'over'
        ? marketOver
        : marketUnder
      : null;
  const edge = marketProbability !== null ? probability - marketProbability : null;

  const curve: CalibrationPoint[] = points.map((point) => ({
    line: point.line,
    probability: selection === 'over' ? point.over ?? 0 : point.under ?? 0,
    over: point.over,
    under: point.under,
    meetsThreshold: (selection === 'over' ? point.over ?? 0 : point.under ?? 0) >= threshold,
    selected: Math.abs(point.line - picked.line) < 1e-9,
  }));

  const alternatives: MarketOption[] = [];
  const neighborLines =
    selection === 'over'
      ? [picked.line - 0.5, picked.line, picked.line + 0.5]
      : [picked.line - 0.5, picked.line, picked.line + 0.5];
  for (const line of neighborLines) {
    if (line < TOTAL_LINES[0] || line > TOTAL_LINES[TOTAL_LINES.length - 1]) continue;
    const point = points.find((candidate) => Math.abs(candidate.line - line) < 1e-9);
    if (!point) continue;
    const p = selection === 'over' ? point.over ?? 0 : point.under ?? 0;
    alternatives.push({
      label: `${selection === 'over' ? 'Over' : 'Under'} ${line.toFixed(1)}`,
      code: selection,
      probability: p,
      fairOdds: fairOdds(p),
      selected: Math.abs(line - picked.line) < 1e-9,
    });
  }

  const sideLabel = selection === 'over' ? 'Over' : 'Under';
  const basePoint = points.find((point) => Math.abs(point.line - baseLine) < 1e-9);
  const baseProbability = basePoint ? (selection === 'over' ? basePoint.over ?? 0 : basePoint.under ?? 0) : null;
  const baseText =
    baseProbability !== null
      ? `La línea base ${sideLabel} ${baseLine.toFixed(1)} daba ${(baseProbability * 100).toFixed(0)} %. `
      : '';
  const explanation = calibrated
    ? `${baseText}Con umbral del ${(threshold * 100).toFixed(0)} %, la línea más ${selection === 'over' ? 'alta' : 'baja'} que sostiene la confianza es ${sideLabel} ${picked.line.toFixed(1)} (${(probability * 100).toFixed(0)} %).`
    : `Ninguna línea alcanza el umbral del ${(threshold * 100).toFixed(0)} %. Se publica ${sideLabel} ${picked.line.toFixed(1)} (${(probability * 100).toFixed(0)} %) como la mejor disponible, con riesgo alto.`;

  const note =
    marketLine !== null && Math.abs(marketLine - picked.line) > 0.5
      ? `La línea de mercado (${marketLine.toFixed(1)}) se aleja ${Math.abs(marketLine - picked.line).toFixed(1)} de la recomendada.`
      : undefined;

  return {
    selection,
    line: picked.line,
    probability,
    marketProbability,
    edge,
    calibrated,
    curve,
    alternatives,
    explanation,
    note,
    baseLine,
  };
}

export interface HandicapCalibration {
  selection: 'home' | 'away';
  favoriteName: string;
  line: number;
  probability: number;
  marketProbability: number | null;
  edge: number | null;
  calibrated: boolean;
  curve: CalibrationPoint[];
  alternatives: MarketOption[];
  explanation: string;
  note?: string;
}

export function calibrateHandicap(
  matrix: ScoreMatrix,
  winProbabilities: { home: number; draw: number; away: number },
  threshold: number,
  homeName: string,
  awayName: string,
  marketLine: number | null,
  marketHome: number | null,
  marketAway: number | null,
): HandicapCalibration {
  const selection: 'home' | 'away' = winProbabilities.home >= winProbabilities.away ? 'home' : 'away';
  const favoriteName = selection === 'home' ? homeName : awayName;
  const points = HANDICAP_LINES.map((line) => ({
    line,
    probability: handicapCover(matrix, selection, line),
  }));

  const passing = points.filter((point) => point.probability >= threshold);
  let calibrated = true;
  let picked: { line: number; probability: number };

  if (passing.length > 0) {
    // Primera línea (la más negativa) que aún cumple el umbral.
    picked = passing[0];
  } else {
    calibrated = false;
    picked = [...points].sort((a, b) => b.probability - a.probability)[0];
  }

  const marketSideLine =
    marketLine === null ? null : selection === 'home' ? marketLine : -marketLine;
  const marketSideProbability = selection === 'home' ? marketHome : marketAway;
  const marketProbability =
    marketSideLine !== null && Math.abs(marketSideLine - picked.line) < 1e-9 ? marketSideProbability : null;
  const edge = marketProbability !== null ? picked.probability - marketProbability : null;

  const curve: CalibrationPoint[] = points.map((point) => ({
    line: point.line,
    probability: point.probability,
    meetsThreshold: point.probability >= threshold,
    selected: Math.abs(point.line - picked.line) < 1e-9,
  }));

  const alternatives: MarketOption[] = [];
  for (const line of [picked.line - 0.25, picked.line, picked.line + 0.25]) {
    if (line < HANDICAP_LINES[0] - 1e-9 || line > HANDICAP_LINES[HANDICAP_LINES.length - 1] + 1e-9) continue;
    const p = handicapCover(matrix, selection, line);
    alternatives.push({
      label: `${favoriteName} ${formatSignedLine(line)}`,
      code: selection,
      probability: p,
      fairOdds: fairOdds(p),
      selected: Math.abs(line - picked.line) < 1e-9,
    });
  }

  const lineText = formatSignedLine(picked.line);
  const explanation = calibrated
    ? `${favoriteName} es el favorito (${((selection === 'home' ? winProbabilities.home : winProbabilities.away) * 100).toFixed(0)} % de victoria). La línea más exigente que mantiene el umbral del ${(threshold * 100).toFixed(0)} % es ${lineText} (${(picked.probability * 100).toFixed(0)} % de cobertura).`
    : `${favoriteName} no alcanza el umbral ni con la línea más favorable. Se publica ${lineText} (${(picked.probability * 100).toFixed(0)} %) con riesgo alto.`;

  const note =
    picked.line > 0
      ? `El favorito necesita hándicap positivo (${lineText}): su ventaja no es suficiente para exigir una línea negativa.`
      : marketLine !== null && Math.abs(marketLine - (selection === 'home' ? picked.line : -picked.line)) > 0.5
        ? `La línea de mercado se aleja de la recomendada.`
        : undefined;

  return {
    selection,
    favoriteName,
    line: picked.line,
    probability: picked.probability,
    marketProbability,
    edge,
    calibrated,
    curve,
    alternatives,
    explanation,
    note,
  };
}

export interface CornersCalibration {
  selection: 'over' | 'under';
  line: number;
  probability: number;
  calibrated: boolean;
  curve: CalibrationPoint[];
  alternatives: MarketOption[];
  explanation: string;
  baseLine: number;
}

export function calibrateCorners(lambdaCorners: number, threshold: number): CornersCalibration {
  const baseLine = nearestHalfLine(lambdaCorners, CORNER_LINES[0], CORNER_LINES[CORNER_LINES.length - 1]);
  const points = CORNER_LINES.map((line) => ({
    line,
    over: poissonOver(lambdaCorners, line),
    under: poissonUnder(lambdaCorners, line),
  }));
  const overCandidates = points.filter((point) => point.over >= threshold);
  const underCandidates = points.filter((point) => point.under >= threshold);
  const overPick = overCandidates.length > 0 ? overCandidates[overCandidates.length - 1] : null;
  const underPick = underCandidates.length > 0 ? underCandidates[0] : null;

  let selection: 'over' | 'under';
  let picked: { line: number; over: number; under: number };
  let calibrated = true;
  if (overPick && underPick) {
    const overMargin = overPick.over - threshold;
    const underMargin = underPick.under - threshold;
    selection = overMargin >= underMargin ? 'over' : 'under';
    picked = selection === 'over' ? overPick : underPick;
  } else if (overPick || underPick) {
    selection = overPick ? 'over' : 'under';
    picked = (overPick ?? underPick)!;
  } else {
    calibrated = false;
    const bestOver = [...points].sort((a, b) => b.over - a.over)[0];
    const bestUnder = [...points].sort((a, b) => b.under - a.under)[0];
    if (bestOver.over >= bestUnder.under) {
      selection = 'over';
      picked = bestOver;
    } else {
      selection = 'under';
      picked = bestUnder;
    }
  }

  const probability = selection === 'over' ? picked.over : picked.under;
  const curve: CalibrationPoint[] = points.map((point) => ({
    line: point.line,
    probability: selection === 'over' ? point.over : point.under,
    over: point.over,
    under: point.under,
    meetsThreshold: (selection === 'over' ? point.over : point.under) >= threshold,
    selected: Math.abs(point.line - picked.line) < 1e-9,
  }));

  const alternatives: MarketOption[] = [];
  for (const line of [picked.line - 0.5, picked.line, picked.line + 0.5]) {
    if (line < CORNER_LINES[0] || line > CORNER_LINES[CORNER_LINES.length - 1]) continue;
    const point = points.find((candidate) => Math.abs(candidate.line - line) < 1e-9);
    if (!point) continue;
    const p = selection === 'over' ? point.over : point.under;
    alternatives.push({
      label: `${selection === 'over' ? 'Over' : 'Under'} ${line.toFixed(1)} córners`,
      code: selection,
      probability: p,
      fairOdds: fairOdds(p),
      selected: Math.abs(line - picked.line) < 1e-9,
    });
  }

  const sideLabel = selection === 'over' ? 'Over' : 'Under';
  const explanation = `Proyección de ${lambdaCorners.toFixed(1)} córners. Con umbral del ${(threshold * 100).toFixed(0)} %, la línea calibrada es ${sideLabel} ${picked.line.toFixed(1)} (${(probability * 100).toFixed(0)} %).`;

  return {
    selection,
    line: picked.line,
    probability,
    calibrated,
    curve,
    alternatives,
    explanation,
    baseLine,
  };
}
