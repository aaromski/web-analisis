import type { AggregatedResponse } from '../types/api';
import type {
  AnalysisResult,
  ComparisonSource,
  MarketKey,
  MarketOption,
  MarketResult,
} from '../types/analysis';
import { anchorLambdas, impliedTotalFromOver } from './anchor';
import {
  confidenceThreshold,
  computeConfidence,
  calibrateCorners,
  calibrateHandicap,
  calibrateTotals,
  formatSignedLine,
  nearestHalfLine,
  riskFromConfidence,
} from './calibration';
import { buildContext } from './context';
import { buildLambdas } from './lambdas';
import {
  bttsProbabilities,
  doubleChanceOutcomes,
  fairOdds,
  firstGoalProbabilities,
  htFtProbabilities,
  resultOutcomes,
} from './markets';
import {
  EMPTY_MARKET_SIGNAL,
  buildMarketSignal,
  extraCornersMarket,
  extraMarketProbability,
  extractExtraMarkets,
  extractSpreadMarket,
  extractTotalsMarket,
  extractWinMarket,
  modelAgreement,
  movementWeightScale,
  pickBalancedLine,
} from './odds';
import { buildParlay, type ParlayCandidate } from './parlay';
import { DEFAULT_ENGINE_PARAMS, MAX_GOALS, RHO, type EngineParams } from './params';
import {
  buildScoreMatrix,
  clamp,
  exactScores,
  oddTotal,
  round,
  shiftMatrix,
} from './poisson';
import { assessQuality, statNumber } from './quality';
import { buildLiveMeta } from './live';
import { buildUncertainty } from './uncertainty';

export const MODEL_VERSION = '1.2.0';
export { MAX_GOALS, RHO } from './params';

/** Opciones de `analyzeMatch`; `params` permite inyectar una variante sombra. */
export interface AnalyzeOptions {
  params?: EngineParams;
}

export class AnalysisError extends Error {
  constructor(
    public readonly code: 'INVALID_RESPONSE' | 'MISSING_TEAMS' | 'MATCH_NOT_PROJECTABLE',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AnalysisError';
  }
}

interface MarketCore {
  key: MarketKey;
  name: string;
  tagline: string;
  selection: string;
  selectionCode: string;
  probability: number;
  threshold: number;
  explanation: string;
  line?: number | null;
  baseLine?: number | null;
  marketLine?: number | null;
  marketProbability?: number | null;
  marketModelProbability?: number | null;
  edge?: number | null;
  comparisonSource?: ComparisonSource | null;
  curve?: MarketResult['curve'];
  alternatives?: MarketOption[];
  scores?: MarketResult['scores'];
  combos?: MarketResult['combos'];
  calibrated?: boolean;
  available?: boolean;
  note?: string;
}

function finalizeMarket(
  draft: MarketCore,
  index: number,
  qualityScore: number,
  agreement: number,
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): MarketResult {
  const probability = round(clamp(draft.probability, 0, 1), 4);
  const confidence = computeConfidence(probability, qualityScore, agreement, params);
  const curve = (draft.curve ?? []).map((point) => ({
    ...point,
    probability: round(point.probability, 4),
    over: point.over === undefined ? undefined : round(point.over, 4),
    under: point.under === undefined ? undefined : round(point.under, 4),
  }));
  const alternatives = (draft.alternatives ?? []).map((option) => ({
    ...option,
    probability: round(option.probability, 4),
    fairOdds: round(fairOdds(option.probability), 2),
    marketProbability:
      option.marketProbability === undefined ? undefined : option.marketProbability === null ? null : round(option.marketProbability, 4),
    edge: option.edge === undefined ? undefined : option.edge === null ? null : round(option.edge, 4),
  }));

  return {
    ...draft,
    index,
    probability,
    fairOdds: round(fairOdds(probability), 2),
    confidence,
    risk: riskFromConfidence(confidence, qualityScore),
    line: draft.line ?? null,
    baseLine: draft.baseLine ?? null,
    marketLine: draft.marketLine ?? null,
    marketProbability:
      draft.marketProbability === undefined
        ? null
        : draft.marketProbability === null
          ? null
          : round(draft.marketProbability, 4),
    marketModelProbability:
      draft.marketModelProbability === undefined
        ? null
        : draft.marketModelProbability === null
          ? null
          : round(draft.marketModelProbability, 4),
    edge: draft.edge === undefined ? null : draft.edge === null ? null : round(draft.edge, 4),
    curve,
    alternatives,
    calibrated: draft.calibrated ?? false,
    available: draft.available ?? true,
  };
}

function pct(probability: number): string {
  return `${(probability * 100).toFixed(1)} %`;
}

function maxBy<T>(items: T[], value: (item: T) => number): T {
  return items.reduce((best, item) => (value(item) > value(best) ? item : best), items[0]);
}

function normalizeStatus(value: string | undefined | null): AnalysisResult['match']['status'] {
  if (value === 'scheduled' || value === 'live' || value === 'finished') {
    return value;
  }
  return 'unknown';
}

export function analyzeMatch(
  response: AggregatedResponse,
  options: AnalyzeOptions = {},
): AnalysisResult {
  const params = options.params ?? DEFAULT_ENGINE_PARAMS;
  if (!response?.match || !response?.teams?.home || !response?.teams?.away) {
    throw new AnalysisError('INVALID_RESPONSE', 'La API devolvió una respuesta sin partido o sin equipos.');
  }
  if (!response.teams.home.name || !response.teams.away.name) {
    throw new AnalysisError('MISSING_TEAMS', 'La API no devolvió los nombres de ambos equipos.');
  }

  if (response.match.status === 'finished') {
    throw new AnalysisError(
      'MATCH_NOT_PROJECTABLE',
      'El partido ya finalizó. El motor calibra líneas antes del inicio; elige un partido programado o en juego.',
      {
        status: response.match.status,
        score: response.match.score,
        home: response.teams.home.name,
        away: response.teams.away.name,
        date: response.match.date,
      },
    );
  }

  const matchStatus = normalizeStatus(response.match.status);
  const isLive = matchStatus === 'live';

  const pre = response.pre_match ?? null;
  const homeName = response.teams.home.name;
  const awayName = response.teams.away.name;

  const lambdas = buildLambdas(response, params);
  const quality = assessQuality(response, params);
  const winMarket = extractWinMarket(pre);
  // En vivo las cuotas son previas al partido y no condicionan al marcador
  // actual: no sirven como referencia de valor.
  const oddsWin = !isLive && winMarket?.source === 'odds' ? winMarket : null;
  const predictionWin = !isLive && winMarket?.source === 'prediction' ? winMarket : null;
  const totalsMarket = isLive ? { line: null, over: null, under: null } : extractTotalsMarket(pre);
  const spreadMarket = isLive ? { line: null, home: null, away: null } : extractSpreadMarket(pre);
  const extraMarkets = isLive ? [] : extractExtraMarkets(pre);
  const signal = isLive ? null : buildMarketSignal(pre);

  // Sin cuotas de totales, la predicción externa aporta la escala de goles.
  const predictionLines = pickBalancedLine(pre?.prediction?.over_under);
  const predictionTotal =
    predictionLines && predictionLines.probability !== null
      ? impliedTotalFromOver(predictionLines.line, predictionLines.probability)
      : null;

  let matrix = buildScoreMatrix(lambdas.lambdaHome, lambdas.lambdaAway, {
    rho: RHO,
    maxGoals: MAX_GOALS,
  });
  let win = resultOutcomes(matrix);

  // Ancla al mercado: corrige la compresión de la supremacía y fija la escala
  // de goles con la expectativa agregada de las cuotas. En vivo se omite: las
  // cuotas de un partido en juego no describen el partido completo.
  const agreement = isLive ? 0.5 : modelAgreement(win, winMarket);
  const comparisonWin = isLive ? null : winMarket;
  const anchor = isLive
    ? {
        lambdaHome: lambdas.lambdaHome,
        lambdaAway: lambdas.lambdaAway,
        applied: false,
        weight: 0,
        source: 'none' as const,
        marketTotal: null,
        marketHome: null,
        marketAway: null,
        totalSource: 'none' as const,
        note: null,
      }
    : anchorLambdas({
        lambdaHome: lambdas.lambdaHome,
        lambdaAway: lambdas.lambdaAway,
        winMarket: oddsWin,
        totalsMarket,
        predictionTotal,
        predictionWin,
        quality: quality.score,
        agreement,
        weightScale: movementWeightScale(signal, params),
      }, params);
  if (anchor.applied) {
    lambdas.lambdaHome = anchor.lambdaHome;
    lambdas.lambdaAway = anchor.lambdaAway;
    lambdas.lambdaTotal = round(anchor.lambdaHome + anchor.lambdaAway, 2);
    lambdas.home.lambda = anchor.lambdaHome;
    lambdas.away.lambda = anchor.lambdaAway;
    lambdas.sources.push('Ancla de mercado');
    if (anchor.note) lambdas.caveats.push(anchor.note);
    if (anchor.totalSource === 'prediction' || anchor.source === 'prediction' || anchor.source === 'moneyline+prediction') {
      lambdas.caveats.push(
        'La referencia del ancla es la predicción externa, no cuotas: λ hereda su incertidumbre.',
      );
    }
    matrix = buildScoreMatrix(lambdas.lambdaHome, lambdas.lambdaAway, {
      rho: RHO,
      maxGoals: MAX_GOALS,
    });
    win = resultOutcomes(matrix);
  }

  // Modo en vivo: se proyecta solo el tiempo restante sobre el marcador actual.
  const live = isLive ? buildLiveMeta(response, lambdas.lambdaHome, lambdas.lambdaAway) : null;
  if (live) {
    matrix = shiftMatrix(
      buildScoreMatrix(live.remainingLambdaHome, live.remainingLambdaAway, {
        rho: RHO,
        maxGoals: MAX_GOALS,
      }),
      live.currentScore.home,
      live.currentScore.away,
    );
    win = resultOutcomes(matrix);
    lambdas.sources.push('Modo en vivo');
    lambdas.caveats.push(
      `Partido en juego (~${live.elapsedMinutes} min): se proyecta el ${Math.round(live.remainingShare * 100)} % restante con marcador ${live.currentScore.home}-${live.currentScore.away}.`,
    );
    lambdas.caveats.push('En vivo no se compara el modelo con cuotas previas al partido.');
  }

  const threshold = confidenceThreshold(
    quality.score,
    lambdas.lambdaTotal,
    totalsMarket.line,
    params.calibration.thresholdBase,
    params,
  );
  const totalsThreshold = confidenceThreshold(
    quality.score,
    lambdas.lambdaTotal,
    totalsMarket.line,
    params.calibration.thresholdTotals,
    params,
  );
  const handicapThreshold = confidenceThreshold(
    quality.score,
    lambdas.lambdaTotal,
    totalsMarket.line,
    params.calibration.thresholdHandicap,
    params,
  );
  const cornersThreshold = confidenceThreshold(
    quality.score,
    lambdas.lambdaTotal,
    totalsMarket.line,
    params.calibration.thresholdCorners,
    params,
  );

  const markets: MarketResult[] = [];
  const parlayCandidates: ParlayCandidate[] = [];

  // 1. Resultado final (1X2)
  const resultOptions: MarketOption[] = [
    {
      label: homeName,
      code: 'home',
      probability: win.home,
      fairOdds: fairOdds(win.home),
      marketProbability: oddsWin?.home ?? null,
      edge: oddsWin ? win.home - oddsWin.home : null,
    },
    {
      label: 'Empate',
      code: 'draw',
      probability: win.draw,
      fairOdds: fairOdds(win.draw),
      marketProbability: oddsWin?.draw ?? null,
      edge: oddsWin ? win.draw - oddsWin.draw : null,
    },
    {
      label: awayName,
      code: 'away',
      probability: win.away,
      fairOdds: fairOdds(win.away),
      marketProbability: oddsWin?.away ?? null,
      edge: oddsWin ? win.away - oddsWin.away : null,
    },
  ];
  const resultPick = maxBy(resultOptions, (option) => option.probability);
  const resultExplanation =
    `${homeName} gana en ${pct(win.home)} de los escenarios, el empate en ${pct(win.draw)} y ${awayName} en ${pct(win.away)}.` +
    (comparisonWin
      ? ` La referencia ${comparisonWin.source === 'odds' ? 'de cuotas sin vig' : 'externa'} le da ${pct(
          comparisonWin[resultPick.code as 'home' | 'draw' | 'away'],
        )} a la misma selección.`
      : ' Sin cuotas disponibles no se calcula valor.');
  markets.push(
    finalizeMarket(
      {
        key: 'result',
        name: 'Resultado final',
        tagline: '1X2 · tres caminos',
        selection: resultPick.label,
        selectionCode: resultPick.code ?? 'home',
        probability: resultPick.probability,
        threshold: 0.5,
        marketProbability: resultPick.marketProbability ?? null,
        edge: resultPick.edge ?? null,
        comparisonSource: comparisonWin ? comparisonWin.source : null,
        alternatives: resultOptions.map((option) => ({ ...option, selected: option.code === resultPick.code })),
        explanation: resultExplanation,
        note: resultPick.probability < 0.5 ? 'Ningún resultado supera el 50 %: mercado de alta incertidumbre.' : undefined,
      },
      markets.length + 1,
      quality.score,
      agreement,
      params,
    ),
  );
  parlayCandidates.push({
    marketKey: 'result',
    market: 'Resultado final',
    selection: resultPick.label,
    probability: resultPick.probability,
    predicate: (i, j) =>
      resultPick.code === 'home' ? i > j : resultPick.code === 'away' ? j > i : i === j,
  });

  // 2. Doble oportunidad
  const dc = doubleChanceOutcomes(matrix);
  const dcMarket = {
    homeDraw:
      oddsWin !== null
        ? oddsWin.home + oddsWin.draw
        : extraMarketProbability(extraMarkets, ['double chance', 'doble oportunidad'], ['1x', 'home or draw']),
    drawAway:
      oddsWin !== null
        ? oddsWin.draw + oddsWin.away
        : extraMarketProbability(extraMarkets, ['double chance', 'doble oportunidad'], ['x2', 'draw or away']),
    homeAway:
      oddsWin !== null
        ? oddsWin.home + oddsWin.away
        : extraMarketProbability(extraMarkets, ['double chance', 'doble oportunidad'], ['12', 'home or away']),
  };
  const dcSource: ComparisonSource | null = oddsWin
    ? 'odds'
    : dcMarket.homeDraw !== null || dcMarket.drawAway !== null || dcMarket.homeAway !== null
      ? 'extra_market'
      : null;
  const dcOptions: MarketOption[] = [
    {
      label: '1X · Local o empate',
      code: 'homeDraw',
      probability: dc.homeDraw,
      fairOdds: fairOdds(dc.homeDraw),
      marketProbability: dcMarket.homeDraw,
      edge: dcMarket.homeDraw !== null ? dc.homeDraw - dcMarket.homeDraw : null,
    },
    {
      label: 'X2 · Empate o visitante',
      code: 'drawAway',
      probability: dc.drawAway,
      fairOdds: fairOdds(dc.drawAway),
      marketProbability: dcMarket.drawAway,
      edge: dcMarket.drawAway !== null ? dc.drawAway - dcMarket.drawAway : null,
    },
    {
      label: '12 · Local o visitante',
      code: 'homeAway',
      probability: dc.homeAway,
      fairOdds: fairOdds(dc.homeAway),
      marketProbability: dcMarket.homeAway,
      edge: dcMarket.homeAway !== null ? dc.homeAway - dcMarket.homeAway : null,
    },
  ];
  const dcPick = maxBy(dcOptions, (option) => option.probability);
  markets.push(
    finalizeMarket(
      {
        key: 'double_chance',
        name: 'Doble oportunidad',
        tagline: 'Cobertura de dos signos',
        selection: dcPick.label,
        selectionCode: dcPick.code ?? 'homeDraw',
        probability: dcPick.probability,
        threshold: 0.5,
        marketProbability: dcPick.marketProbability ?? null,
        edge: dcPick.edge ?? null,
        comparisonSource: dcSource,
        alternatives: dcOptions.map((option) => ({ ...option, selected: option.code === dcPick.code })),
        explanation: `La cobertura ${dcPick.label} acumula ${pct(dcPick.probability)} de los escenarios de la matriz. ${dcPick.edge !== null && dcPick.edge !== undefined ? (dcPick.edge >= 0 ? `Frente al mercado hay ${(dcPick.edge * 100).toFixed(1)} pts de valor.` : `El mercado la valora ${Math.abs(dcPick.edge * 100).toFixed(1)} pts por encima del modelo.`) : 'Sin cuota comparable no se calcula valor.'}`,
      },
      markets.length + 1,
      quality.score,
      agreement,
      params,
    ),
  );
  parlayCandidates.push({
    marketKey: 'double_chance',
    market: 'Doble oportunidad',
    selection: dcPick.label,
    probability: dcPick.probability,
    predicate: (i, j) =>
      dcPick.code === 'homeDraw' ? i >= j : dcPick.code === 'drawAway' ? j >= i : i !== j,
  });

  // 3. Altas / Bajas con línea calibrada
  const totalsCalibration = calibrateTotals(
    matrix,
    lambdas.lambdaTotal,
    totalsThreshold,
    totalsMarket.line,
    totalsMarket.over,
    totalsMarket.under,
  );
  const totalsSideLabel = totalsCalibration.selection === 'over' ? 'Over' : 'Under';
  const totalsSelection = `${totalsSideLabel} ${totalsCalibration.line.toFixed(1)}`;
  markets.push(
    finalizeMarket(
      {
        key: 'totals',
        name: 'Altas / Bajas',
        tagline: 'Línea dinámica de goles',
        selection: totalsSelection,
        selectionCode: totalsCalibration.selection,
        line: totalsCalibration.line,
        baseLine: totalsCalibration.baseLine,
        marketLine: totalsMarket.line,
        probability: totalsCalibration.probability,
        threshold: totalsThreshold,
        marketProbability: totalsCalibration.marketProbability,
        marketModelProbability: totalsCalibration.marketModelProbability,
        edge: totalsCalibration.edge,
        comparisonSource: totalsMarket.line !== null ? 'odds' : null,
        curve: totalsCalibration.curve,
        alternatives: totalsCalibration.alternatives,
        calibrated: totalsCalibration.calibrated,
        explanation: totalsCalibration.explanation,
        note: totalsCalibration.note,
      },
      markets.length + 1,
      quality.score,
      agreement,
      params,
    ),
  );
  parlayCandidates.push({
    marketKey: 'totals',
    market: 'Altas / Bajas',
    selection: totalsSelection,
    probability: totalsCalibration.probability,
    predicate: (i, j) =>
      totalsCalibration.selection === 'over'
        ? i + j > totalsCalibration.line
        : i + j < totalsCalibration.line,
  });

  // 4. Runline / hándicap con línea calibrada
  const handicapCalibration = calibrateHandicap(
    matrix,
    win,
    handicapThreshold,
    homeName,
    awayName,
    spreadMarket.line,
    spreadMarket.home,
    spreadMarket.away,
  );
  const handicapSelection = `${handicapCalibration.favoriteName} ${formatSignedLine(handicapCalibration.line)}`;
  markets.push(
    finalizeMarket(
      {
        key: 'handicap',
        name: 'Runline / Hándicap',
        tagline: 'Favorito vs. no favorito',
        selection: handicapSelection,
        selectionCode: handicapCalibration.selection,
        line: handicapCalibration.line,
        marketLine: spreadMarket.line,
        probability: handicapCalibration.probability,
        threshold: handicapThreshold,
        marketProbability: handicapCalibration.marketProbability,
        marketModelProbability: handicapCalibration.marketModelProbability,
        edge: handicapCalibration.edge,
        comparisonSource: spreadMarket.line !== null ? 'odds' : null,
        curve: handicapCalibration.curve,
        alternatives: handicapCalibration.alternatives,
        calibrated: handicapCalibration.calibrated,
        explanation: handicapCalibration.explanation,
        note: handicapCalibration.note,
      },
      markets.length + 1,
      quality.score,
      agreement,
      params,
    ),
  );

  // 5. Anota primero (solo pre-partido: en vivo el primer gol ya puede haber caído)
  if (!live) {
    const first = firstGoalProbabilities(
      lambdas.lambdaHome,
      lambdas.lambdaAway,
      matrix.cells[0]?.[0],
    );
    const firstOptions: MarketOption[] = [
      { label: `${homeName} anota primero`, code: 'home', probability: first.home, fairOdds: fairOdds(first.home) },
      { label: `${awayName} anota primero`, code: 'away', probability: first.away, fairOdds: fairOdds(first.away) },
      { label: 'Sin goles', code: 'none', probability: first.none, fairOdds: fairOdds(first.none) },
    ];
    const firstPick = maxBy(firstOptions, (option) => option.probability);
    markets.push(
      finalizeMarket(
        {
          key: 'first_goal',
          name: 'Anota primero',
          tagline: 'Primer gol del partido',
          selection: firstPick.label,
          selectionCode: firstPick.code ?? 'home',
          probability: firstPick.probability,
          threshold: 0.5,
          alternatives: firstOptions.map((option) => ({ ...option, selected: option.code === firstPick.code })),
          explanation: `Con tasas de ${lambdas.lambdaHome.toFixed(2)} y ${lambdas.lambdaAway.toFixed(2)} goles, el primer gol se reparte: ${homeName} ${pct(first.home)}, ${awayName} ${pct(first.away)} y sin goles ${pct(first.none)}.`,
          note: 'Modelo de procesos de Poisson: no distingue el minuto ni el ritmo inicial.',
        },
        markets.length + 1,
        quality.score,
        agreement,
        params,
      ),
    );
  }

  // 6. Par o impar
  const odd = oddTotal(matrix);
  const parityOptions: MarketOption[] = [
    { label: 'Total impar', code: 'odd', probability: odd, fairOdds: fairOdds(odd) },
    { label: 'Total par', code: 'even', probability: 1 - odd, fairOdds: fairOdds(1 - odd) },
  ];
  const parityPick = maxBy(parityOptions, (option) => option.probability);
  markets.push(
    finalizeMarket(
      {
        key: 'odd_even',
        name: 'Impar o par',
        tagline: 'Paridad del total de goles',
        selection: parityPick.label,
        selectionCode: parityPick.code ?? 'odd',
        probability: parityPick.probability,
        threshold: 0.5,
        alternatives: parityOptions.map((option) => ({ ...option, selected: option.code === parityPick.code })),
        explanation: `La matriz reparte ${pct(odd)} al total impar y ${pct(1 - odd)} al par. La ventaja es mínima por construcción.`,
        note: 'Mercado casi simétrico: úsalo solo como complemento, no como base de la combinada.',
      },
      markets.length + 1,
      quality.score,
      agreement,
      params,
    ),
  );
  parlayCandidates.push({
    marketKey: 'odd_even',
    market: 'Impar o par',
    selection: parityPick.label,
    probability: parityPick.probability,
    predicate: (i, j) => (parityPick.code === 'odd' ? (i + j) % 2 === 1 : (i + j) % 2 === 0),
  });

  // 7. HT/FT (solo pre-partido: el descanso ya ocurrió o no es reconstruible)
  if (!live) {
    const htft = htFtProbabilities(lambdas.lambdaHome, lambdas.lambdaAway, RHO, params);
    const combos = htft.combos.slice(0, 6);
    const topCombo = combos[0];
    markets.push(
      finalizeMarket(
        {
          key: 'ht_ft',
          name: 'Descanso / Final',
          tagline: 'HT/FT · nueve combinaciones',
          selection: topCombo.label,
          selectionCode: `${topCombo.ht}/${topCombo.ft}`,
          probability: topCombo.probability,
          threshold: 0.5,
          combos,
          explanation: `El escenario HT/FT más probable es ${topCombo.label} (${pct(topCombo.probability)}). Se modela el ${Math.round(params.lambda.htShare * 100)} % de los goles en la primera parte y se convoluciona la segunda.`,
          note: 'Mercado de alta varianza: incluso el escenario más probable rara vez supera el 30 %.',
        },
        markets.length + 1,
        quality.score,
        agreement,
        params,
      ),
    );
  }

  // 8. Marcador exacto
  const scoreList = exactScores(matrix, 6);
  const topScore = scoreList[0];
  markets.push(
    finalizeMarket(
      {
        key: 'exact_score',
        name: 'Marcador exacto',
        tagline: 'Top 6 de la matriz',
        selection: `${topScore.home}-${topScore.away}`,
        selectionCode: `${topScore.home}-${topScore.away}`,
        probability: topScore.probability,
        threshold: 0.5,
        scores: scoreList.map((score) => ({
          score: `${score.home}-${score.away}`,
          home: score.home,
          away: score.away,
          probability: round(score.probability, 4),
        })),
        explanation: `El marcador más probable es ${topScore.home}-${topScore.away} con ${pct(topScore.probability)}. La matriz concentra la mayor parte de la masa entre 0 y 3 goles por equipo.`,
        note: 'Resultado exacto: mercado de alta varianza; úsalo como lectura, no como recomendación fuerte.',
      },
      markets.length + 1,
      quality.score,
      agreement,
      params,
    ),
  );

  // 9. BTTS
  const btts = bttsProbabilities(matrix);
  const externalBtts = isLive ? undefined : response.pre_match?.prediction?.btts?.yes;
  const bttsExtraYes = extraMarketProbability(
    extraMarkets,
    ['both teams to score', 'btts', 'ambos anotan'],
    ['yes', 'si'],
  );
  const bttsExtraNo = extraMarketProbability(
    extraMarkets,
    ['both teams to score', 'btts', 'ambos anotan'],
    ['no'],
  );
  const bttsReferenceYes = bttsExtraYes ?? (typeof externalBtts === 'number' ? externalBtts : null);
  const bttsReferenceNo =
    bttsExtraNo ?? (typeof externalBtts === 'number' ? 1 - externalBtts : null);
  const bttsSource: ComparisonSource | null =
    bttsExtraYes !== null || bttsExtraNo !== null
      ? 'extra_market'
      : typeof externalBtts === 'number'
        ? 'prediction'
        : null;
  const bttsOptions: MarketOption[] = [
    {
      label: 'Sí · ambos anotan',
      code: 'yes',
      probability: btts.yes,
      fairOdds: fairOdds(btts.yes),
      marketProbability: bttsReferenceYes,
      edge: bttsReferenceYes !== null ? btts.yes - bttsReferenceYes : null,
    },
    {
      label: 'No · al menos uno no anota',
      code: 'no',
      probability: btts.no,
      fairOdds: fairOdds(btts.no),
      marketProbability: bttsReferenceNo,
      edge: bttsReferenceNo !== null ? btts.no - bttsReferenceNo : null,
    },
  ];
  const bttsPick = maxBy(bttsOptions, (option) => option.probability);
  markets.push(
    finalizeMarket(
      {
        key: 'btts',
        name: 'Ambos anotan',
        tagline: 'BTTS · Sí / No',
        selection: bttsPick.label,
        selectionCode: bttsPick.code ?? 'yes',
        probability: bttsPick.probability,
        threshold: 0.5,
        marketProbability: bttsPick.marketProbability ?? null,
        edge: bttsPick.edge ?? null,
        comparisonSource: bttsSource,
        alternatives: bttsOptions.map((option) => ({ ...option, selected: option.code === bttsPick.code })),
        explanation: `La probabilidad de que ambos equipos marquen es ${pct(btts.yes)}; el No acumula ${pct(btts.no)}.${bttsReferenceYes !== null ? ` La referencia ${bttsSource === 'extra_market' ? 'de cuotas' : 'externa'} da ${pct(bttsReferenceYes)} al Sí.` : ''}`,
      },
      markets.length + 1,
      quality.score,
      agreement,
      params,
    ),
  );
  parlayCandidates.push({
    marketKey: 'btts',
    market: 'Ambos anotan',
    selection: bttsPick.label,
    probability: bttsPick.probability,
    predicate: (i, j) => (bttsPick.code === 'yes' ? i > 0 && j > 0 : i === 0 || j === 0),
  });

  // 10. Córners (extendido)
  const cornersHome = statNumber(response.teams.home, 'corners');
  const cornersAway = statNumber(response.teams.away, 'corners');
  const cornersAvailable = cornersHome !== null && cornersAway !== null && cornersHome + cornersAway > 0;
  if (cornersAvailable && !live) {
    const lambdaCorners = (cornersHome as number) + (cornersAway as number);
    const predictionCorners = pickBalancedLine(pre?.prediction?.corners);
    const cornersExtra = extraCornersMarket(pre);
    // Solo se usa la línea del proveedor si trae probabilidades: mezclar su
    // línea con la probabilidad de la predicción mediría otro producto.
    const cornersHasOdds =
      cornersExtra.line !== null && (cornersExtra.over !== null || cornersExtra.under !== null);
    const cornersMarketLine = cornersHasOdds ? cornersExtra.line : predictionCorners?.line ?? null;
    const cornersMarketOver = cornersHasOdds
      ? cornersExtra.over
      : predictionCorners && predictionCorners.probability !== null
        ? predictionCorners.probability
        : null;
    const cornersMarketUnder = cornersHasOdds
      ? cornersExtra.under
      : predictionCorners && predictionCorners.probability !== null
        ? 1 - predictionCorners.probability
        : null;
    const cornersComparison: 'odds' | 'prediction' | null = cornersHasOdds
      ? 'odds'
      : predictionCorners
        ? 'prediction'
        : null;
    const cornersCalibration = calibrateCorners(
      lambdaCorners,
      cornersThreshold,
      cornersMarketLine,
      cornersMarketOver,
      cornersMarketUnder,
      cornersComparison,
    );
    const cornersSideLabel = cornersCalibration.selection === 'over' ? 'Over' : 'Under';
    markets.push(
      finalizeMarket(
        {
          key: 'corners',
          name: 'Córners',
          tagline: 'Mercado extendido · línea dinámica',
          selection: `${cornersSideLabel} ${cornersCalibration.line.toFixed(1)}`,
          selectionCode: cornersCalibration.selection,
          line: cornersCalibration.line,
          baseLine: cornersCalibration.baseLine,
          marketLine: cornersMarketLine,
          probability: cornersCalibration.probability,
          threshold: cornersThreshold,
          marketProbability: cornersCalibration.marketProbability,
          marketModelProbability: cornersCalibration.marketModelProbability,
          edge: cornersCalibration.edge,
          comparisonSource: cornersComparison,
          curve: cornersCalibration.curve,
          alternatives: cornersCalibration.alternatives,
          calibrated: cornersCalibration.calibrated,
          explanation: cornersCalibration.explanation,
          note: `Mercado extendido (fuera de los nueve objetivo): usa una Poisson 1D sobre córners proyectados.${cornersCalibration.note ? ` ${cornersCalibration.note}` : ''}`,
        },
        markets.length + 1,
        quality.score,
        agreement,
        params,
      ),
    );
  } else if (live) {
    quality.caveats.push('En vivo se omiten los córners: la proyección de temporada describe el partido completo.');
  } else {
    quality.caveats.push('Sin córners proyectados para ambos equipos: se omite el mercado extendido de córners.');
  }

  const dataCaveats = [...quality.caveats, ...lambdas.caveats].filter(
    (item, index, array) => array.indexOf(item) === index,
  );
  if (lambdas.predictionBlended) {
    const externalPct = Math.round(params.lambda.externalBlendWeight * 100);
    dataCaveats.unshift(`λ combina el modelo propio con la predicción externa (${100 - externalPct}/${externalPct}).`);
  }

  const parlay = live ? null : buildParlay(matrix, parlayCandidates, params);
  if (live) {
    dataCaveats.push('Sin combinada en vivo: las selecciones no describen el partido completo.');
  }

  const baseTotalLine = nearestHalfLine(lambdas.lambdaTotal);
  const uncertainty = buildUncertainty(
    {
      lambdaHome: lambdas.lambdaHome,
      lambdaAway: lambdas.lambdaAway,
      quality: quality.score,
      sigmaBoost: lambdas.sigmaBoost,
      totalLine: baseTotalLine,
    },
    params,
  );

  // Solo se publican intervalos donde el Monte Carlo midió el mismo producto.
  for (const market of markets) {
    if (market.key === 'result') {
      const code = market.selectionCode as 'home' | 'draw' | 'away';
      market.interval = uncertainty.win[code] ?? null;
    } else if (
      market.key === 'totals' &&
      market.line !== null &&
      uncertainty.totalLine !== null &&
      Math.abs(market.line - uncertainty.totalLine) < 1e-9
    ) {
      market.interval = uncertainty.total;
    }
  }

  return {
    match: {
      id: response.match.match_id,
      leagueId: response.match.league?.id ?? '',
      leagueName: response.match.league?.name ?? 'Liga desconocida',
      season: response.match.season ?? null,
      date: response.match.date,
      status: matchStatus,
      venue: response.match.venue ?? null,
      homeName,
      awayName,
      score: {
        home: response.match.score?.home ?? null,
        away: response.match.score?.away ?? null,
      },
      isRetrospective: matchStatus === 'finished',
    },
    teams: { home: lambdas.home, away: lambdas.away },
    lambdas: {
      home: lambdas.lambdaHome,
      away: lambdas.lambdaAway,
      total: lambdas.lambdaTotal,
    },
    winProbabilities: {
      home: round(win.home, 4),
      draw: round(win.draw, 4),
      away: round(win.away, 4),
    },
    dataQuality: {
      ...quality,
      caveats: dataCaveats,
    },
    markets,
    parlay,
    context: buildContext(response),
    model: {
      version: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      rho: RHO,
      maxGoals: MAX_GOALS,
      threshold,
      thresholds: {
        default: threshold,
        totals: totalsThreshold,
        handicap: handicapThreshold,
        corners: cornersThreshold,
      },
      baseTotalLine,
      leagueBaseline: round(lambdas.leagueTotal, 2),
      marketAgreement: round(agreement, 3),
      marketAnchor: {
        applied: anchor.applied,
        weight: anchor.weight,
        source: anchor.source,
        marketTotal: anchor.marketTotal,
        marketHome: anchor.marketHome,
        marketAway: anchor.marketAway,
        totalSource: anchor.totalSource,
      },
      marketSignal: signal ?? EMPTY_MARKET_SIGNAL,
      adjustments: lambdas.adjustments,
      uncertainty,
      live,
      lambdaSources: lambdas.sources,
    },
  };
}
