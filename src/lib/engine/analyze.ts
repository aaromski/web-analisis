import type { AggregatedResponse } from '../types/api';
import type {
  AnalysisResult,
  MarketKey,
  MarketOption,
  MarketResult,
} from '../types/analysis';
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
  extractCornersLine,
  extractSpreadMarket,
  extractTotalsMarket,
  extractWinMarket,
  modelAgreement,
} from './odds';
import { buildParlay, type ParlayCandidate } from './parlay';
import {
  buildScoreMatrix,
  clamp,
  exactScores,
  oddTotal,
  round,
} from './poisson';
import { assessQuality, statNumber } from './quality';

export const MODEL_VERSION = '1.0.0';
export const RHO = -0.1;
export const MAX_GOALS = 12;

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
  edge?: number | null;
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
): MarketResult {
  const probability = round(clamp(draft.probability, 0, 1), 4);
  const confidence = computeConfidence(probability, qualityScore, agreement);
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

export function analyzeMatch(response: AggregatedResponse): AnalysisResult {
  if (!response?.match || !response?.teams?.home || !response?.teams?.away) {
    throw new AnalysisError('INVALID_RESPONSE', 'La API devolvió una respuesta sin partido o sin equipos.');
  }
  if (!response.teams.home.name || !response.teams.away.name) {
    throw new AnalysisError('MISSING_TEAMS', 'La API no devolvió los nombres de ambos equipos.');
  }

  if (response.match.status === 'finished' || response.match.status === 'live') {
    const finished = response.match.status === 'finished';
    throw new AnalysisError(
      'MATCH_NOT_PROJECTABLE',
      finished
        ? 'El partido ya finalizó. El motor calibra líneas antes del inicio; elige un partido programado.'
        : 'El partido está en juego. El motor calibra líneas antes del inicio; elige un partido programado.',
      {
        status: response.match.status,
        score: response.match.score,
        home: response.teams.home.name,
        away: response.teams.away.name,
        date: response.match.date,
      },
    );
  }

  const pre = response.pre_match ?? null;
  const homeName = response.teams.home.name;
  const awayName = response.teams.away.name;

  const lambdas = buildLambdas(response);
  const quality = assessQuality(response);
  const matrix = buildScoreMatrix(lambdas.lambdaHome, lambdas.lambdaAway, {
    rho: RHO,
    maxGoals: MAX_GOALS,
  });

  const win = resultOutcomes(matrix);
  const winMarket = extractWinMarket(pre);
  const oddsWin = winMarket?.source === 'odds' ? winMarket : null;
  const agreement = modelAgreement(win, winMarket);
  const totalsMarket = extractTotalsMarket(pre);
  const spreadMarket = extractSpreadMarket(pre);
  const threshold = confidenceThreshold(quality.score, lambdas.lambdaTotal, totalsMarket.line);

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
    (winMarket
      ? ` La referencia ${winMarket.source === 'odds' ? 'de cuotas sin vig' : 'externa'} le da ${pct(
          winMarket[resultPick.code as 'home' | 'draw' | 'away'],
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
        alternatives: resultOptions.map((option) => ({ ...option, selected: option.code === resultPick.code })),
        explanation: resultExplanation,
        note: resultPick.probability < 0.5 ? 'Ningún resultado supera el 50 %: mercado de alta incertidumbre.' : undefined,
      },
      markets.length + 1,
      quality.score,
      agreement,
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
  const dcOptions: MarketOption[] = [
    {
      label: '1X · Local o empate',
      code: 'homeDraw',
      probability: dc.homeDraw,
      fairOdds: fairOdds(dc.homeDraw),
      marketProbability: oddsWin ? oddsWin.home + oddsWin.draw : null,
      edge: oddsWin ? dc.homeDraw - (oddsWin.home + oddsWin.draw) : null,
    },
    {
      label: 'X2 · Empate o visitante',
      code: 'drawAway',
      probability: dc.drawAway,
      fairOdds: fairOdds(dc.drawAway),
      marketProbability: oddsWin ? oddsWin.draw + oddsWin.away : null,
      edge: oddsWin ? dc.drawAway - (oddsWin.draw + oddsWin.away) : null,
    },
    {
      label: '12 · Local o visitante',
      code: 'homeAway',
      probability: dc.homeAway,
      fairOdds: fairOdds(dc.homeAway),
      marketProbability: oddsWin ? oddsWin.home + oddsWin.away : null,
      edge: oddsWin ? dc.homeAway - (oddsWin.home + oddsWin.away) : null,
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
        alternatives: dcOptions.map((option) => ({ ...option, selected: option.code === dcPick.code })),
        explanation: `La cobertura ${dcPick.label} acumula ${pct(dcPick.probability)} de los escenarios de la matriz. ${dcPick.edge !== null && dcPick.edge !== undefined ? (dcPick.edge >= 0 ? `Frente al mercado hay ${(dcPick.edge * 100).toFixed(1)} pts de valor.` : `El mercado la valora ${Math.abs(dcPick.edge * 100).toFixed(1)} pts por encima del modelo.`) : 'Sin cuota comparable no se calcula valor.'}`,
      },
      markets.length + 1,
      quality.score,
      agreement,
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
    threshold,
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
        threshold,
        marketProbability: totalsCalibration.marketProbability,
        edge: totalsCalibration.edge,
        curve: totalsCalibration.curve,
        alternatives: totalsCalibration.alternatives,
        calibrated: totalsCalibration.calibrated,
        explanation: totalsCalibration.explanation,
        note: totalsCalibration.note,
      },
      markets.length + 1,
      quality.score,
      agreement,
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
    threshold,
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
        threshold,
        marketProbability: handicapCalibration.marketProbability,
        edge: handicapCalibration.edge,
        curve: handicapCalibration.curve,
        alternatives: handicapCalibration.alternatives,
        calibrated: handicapCalibration.calibrated,
        explanation: handicapCalibration.explanation,
        note: handicapCalibration.note,
      },
      markets.length + 1,
      quality.score,
      agreement,
    ),
  );

  // 5. Anota primero
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
    ),
  );

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
    ),
  );
  parlayCandidates.push({
    marketKey: 'odd_even',
    market: 'Impar o par',
    selection: parityPick.label,
    probability: parityPick.probability,
    predicate: (i, j) => (parityPick.code === 'odd' ? (i + j) % 2 === 1 : (i + j) % 2 === 0),
  });

  // 7. HT/FT
  const htft = htFtProbabilities(lambdas.lambdaHome, lambdas.lambdaAway, RHO);
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
        explanation: `El escenario HT/FT más probable es ${topCombo.label} (${pct(topCombo.probability)}). Se modela el 44 % de los goles en la primera parte y se convoluciona la segunda.`,
        note: 'Mercado de alta varianza: incluso el escenario más probable rara vez supera el 30 %.',
      },
      markets.length + 1,
      quality.score,
      agreement,
    ),
  );

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
    ),
  );

  // 9. BTTS
  const btts = bttsProbabilities(matrix);
  const bttsOptions: MarketOption[] = [
    { label: 'Sí · ambos anotan', code: 'yes', probability: btts.yes, fairOdds: fairOdds(btts.yes) },
    { label: 'No · al menos uno no anota', code: 'no', probability: btts.no, fairOdds: fairOdds(btts.no) },
  ];
  const bttsPick = maxBy(bttsOptions, (option) => option.probability);
  const externalBtts = response.pre_match?.prediction?.btts?.yes;
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
        alternatives: bttsOptions.map((option) => ({ ...option, selected: option.code === bttsPick.code })),
        explanation: `La probabilidad de que ambos equipos marquen es ${pct(btts.yes)}; el No acumula ${pct(btts.no)}.${externalBtts !== null && externalBtts !== undefined ? ` La predicción externa da ${pct(externalBtts)} al Sí.` : ''}`,
      },
      markets.length + 1,
      quality.score,
      agreement,
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
  if (cornersAvailable) {
    const lambdaCorners = (cornersHome as number) + (cornersAway as number);
    const cornersCalibration = calibrateCorners(lambdaCorners, threshold);
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
          marketLine: extractCornersLine(pre),
          probability: cornersCalibration.probability,
          threshold,
          curve: cornersCalibration.curve,
          alternatives: cornersCalibration.alternatives,
          calibrated: cornersCalibration.calibrated,
          explanation: cornersCalibration.explanation,
          note: 'Mercado extendido (fuera de los nueve objetivo): usa una Poisson 1D sobre córners proyectados.',
        },
        markets.length + 1,
        quality.score,
        agreement,
      ),
    );
  } else {
    quality.caveats.push('Sin córners proyectados para ambos equipos: se omite el mercado extendido de córners.');
  }

  const dataCaveats = [...quality.caveats, ...lambdas.caveats].filter(
    (item, index, array) => array.indexOf(item) === index,
  );
  if (lambdas.predictionBlended) {
    dataCaveats.unshift('λ combina el modelo propio con la predicción externa (65/35).');
  }

  const parlay = buildParlay(matrix, parlayCandidates);
  const matchStatus = normalizeStatus(response.match.status);

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
      baseTotalLine: nearestHalfLine(lambdas.lambdaTotal),
      marketAgreement: round(agreement, 3),
      lambdaSources: lambdas.sources,
    },
  };
}
