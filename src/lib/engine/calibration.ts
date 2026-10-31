import type { CalibrationPoint, MarketOption, RiskLevel } from '../types/analysis';
import { fairOdds } from './markets';
import { clamp, handicapCover, poissonOver, poissonUnder, round, totalOver, totalUnder, type ScoreMatrix } from './poisson';

export const TOTAL_LINES: number[] = Array.from({ length: 7 }, (_, index) => index + 0.5);
export const CORNER_LINES: number[] = Array.from({ length: 9 }, (_, index) => index + 6.5);
/**
 * Líneas que puede tomar el favorito. En el mercado real el favorito siempre
 * entrega goles (signo negativo); el no favorito recibe el espejo positivo.
 */
export const FAVORITE_HANDICAP_LINES: number[] = Array.from({ length: 12 }, (_, index) => (index - 12) / 4);

/**
 * Umbral de confianza que debe superar una línea para publicarse. Más datos
 * dudosos o más desacuerdo con el mercado elevan el listón. `base` permite que
 * cada mercado tenga su propio punto de partida (el favorito de un runline
 * necesita menos cobertura que un Over/Under).
 */
export function confidenceThreshold(
  quality: number,
  lambdaTotal: number,
  marketTotalLine: number | null,
  base = 0.74,
): number {
  const disagreement = marketTotalLine !== null && Math.abs(lambdaTotal - marketTotalLine) > 0.35 ? 1 : 0;
  return round(clamp(base + 0.08 * (1 - quality) + 0.02 * disagreement, base - 0.06, base + 0.12), 3);
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

function valueNote(
  edge: number | null,
  modelProbability: number | null,
  marketProbability: number | null,
  label: string,
): string | null {
  if (edge === null || modelProbability === null || marketProbability === null || label.length === 0) return null;
  const modelPct = (modelProbability * 100).toFixed(1);
  const marketPct = (marketProbability * 100).toFixed(1);
  const points = Math.abs(edge * 100).toFixed(1);
  if (edge >= 0.03) {
    return `Valor en ${label}: el modelo da ${modelPct} % frente al ${marketPct} % del mercado (+${points} pts).`;
  }
  if (edge <= -0.03) {
    return `Sin valor en ${label}: el modelo da ${modelPct} % frente al ${marketPct} % del mercado (−${points} pts).`;
  }
  return `Modelo y mercado alineados en ${label}: ${modelPct} % frente a ${marketPct} %.`;
}

export interface TotalsCalibration {
  selection: 'over' | 'under';
  line: number;
  probability: number;
  marketProbability: number | null;
  marketModelProbability: number | null;
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
  // El valor se mide siempre en la línea del mercado, aunque la recomendada
  // esté en otra línea: así se compara el mismo producto que ofrece la casa.
  const marketModelProbability =
    marketLine === null ? null : selection === 'over' ? totalOver(matrix, marketLine) : totalUnder(matrix, marketLine);
  const marketProbability = marketLine === null ? null : selection === 'over' ? marketOver : marketUnder;
  const edge =
    marketProbability !== null && marketProbability > 0 && marketModelProbability !== null
      ? marketModelProbability - marketProbability
      : null;

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
    : `Ninguna línea alcanza el umbral del ${(threshold * 100).toFixed(0)} %. Se publica ${sideLabel} ${picked.line.toFixed(1)} (${(probability * 100).toFixed(0)} %) como la mejor disponible.`;

  const notes: string[] = [];
  if (marketLine !== null && Math.abs(marketLine - picked.line) > 0.5) {
    notes.push(
      `La línea de mercado (${marketLine.toFixed(1)}) está a ${Math.abs(marketLine - picked.line).toFixed(1)} de la recomendada.`,
    );
  }
  const value = valueNote(
    edge,
    marketModelProbability,
    marketProbability,
    marketLine === null ? '' : `la línea de mercado ${marketLine.toFixed(1)}`,
  );
  if (value) notes.push(value);
  const note = notes.length > 0 ? notes.join(' ') : undefined;

  return {
    selection,
    line: picked.line,
    probability,
    marketProbability,
    marketModelProbability,
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
  marketModelProbability: number | null;
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
  const points = FAVORITE_HANDICAP_LINES.map((line) => ({
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
    // El favorito nunca recibe hándicap positivo: se publica la menos exigente.
    picked = points[points.length - 1];
  }

  const marketSideLine =
    marketLine === null ? null : selection === 'home' ? marketLine : -marketLine;
  const marketSideProbability = selection === 'home' ? marketHome : marketAway;
  const marketModelProbability =
    marketSideLine === null ? null : handicapCover(matrix, selection, marketSideLine);
  const marketProbability =
    marketSideProbability !== null && marketSideProbability > 0 ? marketSideProbability : null;
  const edge =
    marketProbability !== null && marketModelProbability !== null
      ? marketModelProbability - marketProbability
      : null;

  const curve: CalibrationPoint[] = points.map((point) => ({
    line: point.line,
    probability: point.probability,
    meetsThreshold: point.probability >= threshold,
    selected: Math.abs(point.line - picked.line) < 1e-9,
  }));

  const alternatives: MarketOption[] = [];
  for (const line of [picked.line - 0.25, picked.line, picked.line + 0.25]) {
    if (line > -0.25 + 1e-9) continue;
    if (line < FAVORITE_HANDICAP_LINES[0] - 1e-9) continue;
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
  const favoriteWinPct = ((selection === 'home' ? winProbabilities.home : winProbabilities.away) * 100).toFixed(0);
  const explanation = calibrated
    ? `${favoriteName} es el favorito (${favoriteWinPct} % de victoria). La línea más exigente que mantiene el umbral del ${(threshold * 100).toFixed(0)} % es ${lineText} (${(picked.probability * 100).toFixed(0)} % de cobertura).`
    : `${favoriteName} es el favorito (${favoriteWinPct} % de victoria), pero ninguna línea negativa alcanza el umbral del ${(threshold * 100).toFixed(0)} %. Se publica la menos exigente, ${lineText} (${(picked.probability * 100).toFixed(0)} % de cobertura).`;

  const notes: string[] = [];
  if (marketLine !== null && Math.abs(marketLine - (selection === 'home' ? picked.line : -picked.line)) > 0.5) {
    notes.push('La línea de mercado se aleja de la recomendada.');
  }
  const value = valueNote(
    edge,
    marketModelProbability,
    marketProbability,
    marketSideLine === null ? '' : `la línea de mercado ${formatSignedLine(marketSideLine)}`,
  );
  if (value) notes.push(value);
  const note = notes.length > 0 ? notes.join(' ') : undefined;

  return {
    selection,
    favoriteName,
    line: picked.line,
    probability: picked.probability,
    marketProbability,
    marketModelProbability,
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
  marketProbability: number | null;
  marketModelProbability: number | null;
  edge: number | null;
  calibrated: boolean;
  curve: CalibrationPoint[];
  alternatives: MarketOption[];
  explanation: string;
  note?: string;
  baseLine: number;
}

export function calibrateCorners(
  lambdaCorners: number,
  threshold: number,
  marketLine: number | null = null,
  marketOver: number | null = null,
  marketUnder: number | null = null,
  comparisonSource: 'odds' | 'prediction' | null = null,
): CornersCalibration {
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
  const marketModelProbability =
    marketLine === null ? null : selection === 'over' ? poissonOver(lambdaCorners, marketLine) : poissonUnder(lambdaCorners, marketLine);
  const marketProbability = marketLine === null ? null : selection === 'over' ? marketOver : marketUnder;
  const edge =
    marketProbability !== null && marketProbability > 0 && marketModelProbability !== null
      ? marketModelProbability - marketProbability
      : null;
  const notes: string[] = [];
  if (comparisonSource === 'prediction') {
    notes.push('La referencia de córners es una predicción externa, no una cuota: el valor es orientativo.');
  }
  const value = valueNote(
    edge,
    marketModelProbability,
    marketProbability,
    marketLine === null ? '' : `la línea ${marketLine.toFixed(1)}`,
  );
  if (value) notes.push(value);
  const explanation = `Proyección de ${lambdaCorners.toFixed(1)} córners. Con umbral del ${(threshold * 100).toFixed(0)} %, la línea calibrada es ${sideLabel} ${picked.line.toFixed(1)} (${(probability * 100).toFixed(0)} %).`;

  return {
    selection,
    line: picked.line,
    probability,
    marketProbability,
    marketModelProbability,
    edge,
    calibrated,
    curve,
    alternatives,
    explanation,
    note: notes.length > 0 ? notes.join(' ') : undefined,
    baseLine,
  };
}
