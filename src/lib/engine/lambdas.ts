import type {
  AggregatedResponse,
  PreMatchPayload,
  PreMatchTeam,
  RecentFormSplit,
  TeamPayload,
} from '../types/api';
import type { ModelAdjustment, TeamModel } from '../types/analysis';
import { buildAdjustments, lineupAverageRating, pointsPerMatch } from './adjustments';
import { leagueBaseline, type LeagueBaseline } from './league';
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from './params';
import { clamp, round } from './poisson';
import { statDetail, statNumber, teamConfidence, teamSample } from './quality';

interface BlendValue {
  value: number;
  usedXg: boolean;
  usedGoals: boolean;
  fallback: boolean;
  /** 0–1: observed pesa 1, projected 0.65, derivada 0.85. */
  confidence: number;
}

function blendAttack(
  team: TeamPayload | undefined,
  fallback: number,
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): BlendValue {
  const { xgWeight, goalsWeight } = params.lambda;
  const xg = statDetail(team, 'xg', params);
  const goals = statDetail(team, 'goals_scored', params);
  const wx = xg.value === null ? 0 : xgWeight * xg.confidence;
  const wg = goals.value === null ? 0 : goalsWeight * goals.confidence;
  if (wx + wg > 0) {
    return {
      value: (wx * (xg.value ?? 0) + wg * (goals.value ?? 0)) / (wx + wg),
      usedXg: xg.value !== null,
      usedGoals: goals.value !== null,
      fallback: false,
      confidence: clamp(
        (xgWeight > 0 ? wx / xgWeight : 0) + (goalsWeight > 0 ? wg / goalsWeight : 0),
        0,
        1,
      ),
    };
  }
  return { value: fallback, usedXg: false, usedGoals: false, fallback: true, confidence: 0 };
}

function blendDefense(
  team: TeamPayload | undefined,
  fallback: number,
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): BlendValue {
  const { xgWeight, goalsWeight } = params.lambda;
  const xga = statDetail(team, 'xga', params);
  const conceded = statDetail(team, 'goals_conceded', params);
  const wx = xga.value === null ? 0 : xgWeight * xga.confidence;
  const wg = conceded.value === null ? 0 : goalsWeight * conceded.confidence;
  if (wx + wg > 0) {
    return {
      value: (wx * (xga.value ?? 0) + wg * (conceded.value ?? 0)) / (wx + wg),
      usedXg: xga.value !== null,
      usedGoals: conceded.value !== null,
      fallback: false,
      confidence: clamp(
        (xgWeight > 0 ? wx / xgWeight : 0) + (goalsWeight > 0 ? wg / goalsWeight : 0),
        0,
        1,
      ),
    };
  }
  return { value: fallback, usedXg: false, usedGoals: false, fallback: true, confidence: 0 };
}

interface FormNumbers {
  goalsFor: number | null;
  goalsAgainst: number | null;
  matches: number | null;
  form: string | null;
  source: 'recent_form' | 'form' | null;
  window: string | null;
}

function splitNumbers(
  split: RecentFormSplit | null | undefined,
  label: string,
  fallbackForm: string | null,
): FormNumbers | null {
  if (!split || (split.matches ?? 0) < 3 || split.goals_for === null || split.goals_against === null) return null;
  const matches = split.matches as number;
  return {
    goalsFor: split.goals_for / matches,
    goalsAgainst: split.goals_against / matches,
    matches,
    form: split.form ?? fallbackForm,
    source: 'recent_form',
    window: label,
  };
}

function fromRecent(
  team: PreMatchTeam | undefined,
  side: 'home' | 'away',
  ownPpg: number | null,
  opponentPpg: number | null,
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): FormNumbers {
  const empty: FormNumbers = { goalsFor: null, goalsAgainst: null, matches: null, form: null, source: null, window: null };
  const recent = team?.recent_form;
  if (recent) {
    const band = params.lambda.ppgBand;
    const stronger = ownPpg !== null && opponentPpg !== null && opponentPpg > ownPpg + band;
    const weaker = ownPpg !== null && opponentPpg !== null && opponentPpg < ownPpg - band;
    const preferred = stronger
      ? splitNumbers(recent.splits?.vs_stronger, 'vs_stronger', recent.results.form)
      : weaker
        ? splitNumbers(recent.splits?.vs_weaker, 'vs_weaker', recent.results.form)
        : null;
    if (preferred) return preferred;
    const role = splitNumbers(side === 'home' ? recent.splits?.home : recent.splits?.away, side, recent.results.form);
    if (role) return role;
    const matches = recent.results.matches ?? recent.matches;
    if (matches && matches >= 5 && recent.results.goals_for !== null && recent.results.goals_against !== null) {
      return {
        goalsFor: recent.results.goals_for / matches,
        goalsAgainst: recent.results.goals_against / matches,
        matches,
        form: recent.results.form ?? null,
        source: 'recent_form',
        window: 'overall',
      };
    }
  }

  const entries = (team?.form ?? []).slice(0, 5);
  const parsed = entries
    .map((entry) => {
      const match = entry.score?.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
      if (!match) return null;
      const first = Number(match[1]);
      const second = Number(match[2]);
      if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
      if (entry.home_away !== 'home' && entry.home_away !== 'away') return null;
      const isHome = entry.home_away === 'home';
      return {
        goalsFor: isHome ? first : second,
        goalsAgainst: isHome ? second : first,
        result: entry.result,
      };
    })
    .filter((item): item is { goalsFor: number; goalsAgainst: number; result: 'W' | 'D' | 'L' | null } => item !== null);

  if (parsed.length >= 3) {
    const goalsFor = parsed.reduce((sum, item) => sum + item.goalsFor, 0) / parsed.length;
    const goalsAgainst = parsed.reduce((sum, item) => sum + item.goalsAgainst, 0) / parsed.length;
    return {
      goalsFor,
      goalsAgainst,
      matches: parsed.length,
      form: parsed.map((item) => item.result ?? '?').join(''),
      source: 'form',
      window: 'form',
    };
  }
  return empty;
}

function shrinkStrength(value: number, weight: number, params: EngineParams = DEFAULT_ENGINE_PARAMS): number {
  const w = clamp(weight, 0, params.lambda.strengthShrinkMax);
  return (1 - w) * value + w;
}

function scaleToTotal(
  lambdaHome: number,
  lambdaAway: number,
  caveats: string[],
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): { home: number; away: number } {
  const { minTotal, maxTotal } = params.lambda;
  let home = lambdaHome;
  let away = lambdaAway;
  const total = home + away;
  if (total > maxTotal) {
    const factor = maxTotal / total;
    home *= factor;
    away *= factor;
    caveats.push(`El total proyectado se limitó a ${maxTotal} goles.`);
  } else if (total < minTotal) {
    const factor = minTotal / total;
    home *= factor;
    away *= factor;
    caveats.push(`El total proyectado se elevó al mínimo de ${minTotal} goles.`);
  }
  return { home, away };
}

export interface LambdaModel {
  home: TeamModel;
  away: TeamModel;
  lambdaHome: number;
  lambdaAway: number;
  lambdaTotal: number;
  leagueId: string | null;
  leagueTotal: number;
  sources: string[];
  caveats: string[];
  predictionBlended: boolean;
  formApplied: boolean;
  adjustments: ModelAdjustment[];
  /** Extra de incertidumbre cuando la alineación no está confirmada. */
  sigmaBoost: number;
}

export function buildLambdas(
  response: AggregatedResponse,
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): LambdaModel {
  const knobs = params.lambda;
  const homeTeam = response.teams.home;
  const awayTeam = response.teams.away;
  const pre: PreMatchPayload | null | undefined = response.pre_match;
  const league: LeagueBaseline = leagueBaseline(response.match?.league?.id);
  const perTeam = Math.max(0.2, league.perTeam);

  const attackHome = blendAttack(homeTeam, perTeam, params);
  const defenseHome = blendDefense(homeTeam, perTeam, params);
  const attackAway = blendAttack(awayTeam, perTeam, params);
  const defenseAway = blendDefense(awayTeam, perTeam, params);

  const homeSample = teamSample(homeTeam);
  const awaySample = teamSample(awayTeam);
  const extraHome =
    homeSample !== null && homeSample < knobs.shortSampleMatches
      ? knobs.shortSampleExtra * (1 - clamp(homeSample / knobs.shortSampleMatches, 0, 1))
      : 0;
  const extraAway =
    awaySample !== null && awaySample < knobs.shortSampleMatches
      ? knobs.shortSampleExtra * (1 - clamp(awaySample / knobs.shortSampleMatches, 0, 1))
      : 0;

  // Fuerzas relativas a la media de la liga. Multiplicar evita que un ataque
  // fuerte contra una defensa débil se diluya en un promedio aritmético.
  const attackStrengthHome = shrinkStrength(attackHome.value / perTeam, knobs.strengthShrink + extraHome, params);
  const defenseStrengthHome = shrinkStrength(defenseHome.value / perTeam, knobs.strengthShrink + extraHome, params);
  const attackStrengthAway = shrinkStrength(attackAway.value / perTeam, knobs.strengthShrink + extraAway, params);
  const defenseStrengthAway = shrinkStrength(defenseAway.value / perTeam, knobs.strengthShrink + extraAway, params);

  let lambdaHome = attackStrengthHome * defenseStrengthAway * league.home;
  let lambdaAway = attackStrengthAway * defenseStrengthHome * league.away;

  const caveats: string[] = [];
  const sources: string[] = [`Media de liga ${league.total.toFixed(2)} goles/partido`];

  if (attackHome.usedXg || attackAway.usedXg || defenseHome.usedXg || defenseAway.usedXg) {
    sources.push('xG/xGA de temporada');
  }
  if (attackHome.usedGoals || attackAway.usedGoals || defenseHome.usedGoals || defenseAway.usedGoals) {
    sources.push('Goles de temporada');
  }
  if (attackHome.fallback || attackAway.fallback || defenseHome.fallback || defenseAway.fallback) {
    sources.push('Media de liga como relleno');
  }

  for (const [team, attack, defense] of [
    [homeTeam, attackHome, defenseHome],
    [awayTeam, attackAway, defenseAway],
  ] as const) {
    const name = team?.name ?? 'Equipo';
    if (attack.fallback) caveats.push(`${name}: sin xG ni goles; se usa la media de liga.`);
    else if (!attack.usedXg) caveats.push(`${name}: sin xG; el ataque se estima con goles.`);
    if (defense.fallback) caveats.push(`${name}: sin xGA ni goles concedidos; se usa la media de liga.`);
    else if (!defense.usedXg) caveats.push(`${name}: sin xGA; la defensa se estima con goles concedidos.`);
  }

  for (const [name, sample, extra] of [
    [homeTeam.name, homeSample, extraHome],
    [awayTeam.name, awaySample, extraAway],
  ] as const) {
    if (extra > 0) {
      const weight = Math.round((knobs.strengthShrink + extra) * 100);
      caveats.push(`${name}: muestra corta (${sample ?? 0} partidos); las fuerzas se acercan un ${weight} % a la media de liga.`);
    }
  }

  // Ajustes contextuales (alineación, descanso, nivel del rival, clima, h2h).
  const homePpg = pointsPerMatch(pre?.teams?.home);
  const awayPpg = pointsPerMatch(pre?.teams?.away);
  const contextual = buildAdjustments(response, lambdaHome + lambdaAway, params);
  lambdaHome *= contextual.home.attack * contextual.away.defense * contextual.total;
  lambdaAway *= contextual.away.attack * contextual.home.defense * contextual.total;
  if (contextual.adjustments.length > 0) sources.push('Ajustes contextuales');

  // Forma reciente: ataque propio y defensa propia (que afecta al rival).
  const homeForm = fromRecent(pre?.teams?.home, 'home', homePpg, awayPpg, params);
  const awayForm = fromRecent(pre?.teams?.away, 'away', awayPpg, homePpg, params);
  let formApplied = false;

  if (homeForm.goalsFor !== null) {
    const ratio = homeForm.goalsFor / perTeam;
    lambdaHome *= clamp(
      1 + knobs.formAttackCoef * (ratio - 1),
      knobs.formAttackMin,
      knobs.formAttackMax,
    );
    formApplied = true;
  }
  if (awayForm.goalsFor !== null) {
    const ratio = awayForm.goalsFor / perTeam;
    lambdaAway *= clamp(
      1 + knobs.formAttackCoef * (ratio - 1),
      knobs.formAttackMin,
      knobs.formAttackMax,
    );
    formApplied = true;
  }
  if (homeForm.goalsAgainst !== null) {
    lambdaAway *= clamp(
      1 + knobs.formDefenseCoef * (homeForm.goalsAgainst / perTeam - 1),
      knobs.formDefenseMin,
      knobs.formDefenseMax,
    );
    formApplied = true;
  }
  if (awayForm.goalsAgainst !== null) {
    lambdaHome *= clamp(
      1 + knobs.formDefenseCoef * (awayForm.goalsAgainst / perTeam - 1),
      knobs.formDefenseMin,
      knobs.formDefenseMax,
    );
    formApplied = true;
  }
  if (formApplied) sources.push('Forma reciente');

  // Mezcla con la predicción externa, si existe.
  const predictedHome = pre?.prediction?.expected_goals?.home;
  const predictedAway = pre?.prediction?.expected_goals?.away;
  let predictionBlended = false;
  if (
    typeof predictedHome === 'number' &&
    Number.isFinite(predictedHome) &&
    predictedHome > 0 &&
    typeof predictedAway === 'number' &&
    Number.isFinite(predictedAway) &&
    predictedAway > 0
  ) {
    const external = knobs.externalBlendWeight;
    lambdaHome = (1 - external) * lambdaHome + external * predictedHome;
    lambdaAway = (1 - external) * lambdaAway + external * predictedAway;
    predictionBlended = true;
    sources.push('Predicción externa');
  }

  const beforeClampHome = lambdaHome;
  const beforeClampAway = lambdaAway;
  lambdaHome = clamp(lambdaHome, knobs.minLambda, knobs.maxLambda);
  lambdaAway = clamp(lambdaAway, knobs.minLambda, knobs.maxLambda);
  if (beforeClampHome !== lambdaHome || beforeClampAway !== lambdaAway) {
    caveats.push('λ ajustada al límite operativo del motor.');
  }

  const scaled = scaleToTotal(lambdaHome, lambdaAway, caveats, params);
  lambdaHome = round(scaled.home, 2);
  lambdaAway = round(scaled.away, 2);

  const homeModel: TeamModel = {
    name: homeTeam.name,
    side: 'home',
    lambda: lambdaHome,
    attack: round(attackHome.value, 2),
    defense: round(defenseHome.value, 2),
    sample: homeSample,
    stats: {
      xg: statNumber(homeTeam, 'xg'),
      xga: statNumber(homeTeam, 'xga'),
      goals: statNumber(homeTeam, 'goals_scored'),
      conceded: statNumber(homeTeam, 'goals_conceded'),
      shotsOnTarget: statNumber(homeTeam, 'shots_on_target'),
      corners: statNumber(homeTeam, 'corners'),
      form: homeForm.form,
    },
    sources: [
      attackHome.usedXg ? 'xG' : attackHome.usedGoals ? 'goles' : 'media de liga',
      formApplied ? 'forma' : null,
      predictionBlended ? 'predicción externa' : null,
    ].filter((item): item is string => Boolean(item)),
    lineupStatus: pre?.teams?.home?.lineup?.status ?? null,
    unavailable: pre?.teams?.home?.lineup?.unavailable?.length ?? null,
    restDays: pre?.teams?.home?.rest_days ?? null,
    strengthPpg: homePpg,
  };

  const awayModel: TeamModel = {
    name: awayTeam.name,
    side: 'away',
    lambda: lambdaAway,
    attack: round(attackAway.value, 2),
    defense: round(defenseAway.value, 2),
    sample: awaySample,
    stats: {
      xg: statNumber(awayTeam, 'xg'),
      xga: statNumber(awayTeam, 'xga'),
      goals: statNumber(awayTeam, 'goals_scored'),
      conceded: statNumber(awayTeam, 'goals_conceded'),
      shotsOnTarget: statNumber(awayTeam, 'shots_on_target'),
      corners: statNumber(awayTeam, 'corners'),
      form: awayForm.form,
    },
    sources: [
      attackAway.usedXg ? 'xG' : attackAway.usedGoals ? 'goles' : 'media de liga',
      formApplied ? 'forma' : null,
      predictionBlended ? 'predicción externa' : null,
    ].filter((item): item is string => Boolean(item)),
    lineupStatus: pre?.teams?.away?.lineup?.status ?? null,
    unavailable: pre?.teams?.away?.lineup?.unavailable?.length ?? null,
    restDays: pre?.teams?.away?.rest_days ?? null,
    strengthPpg: awayPpg,
  };

  return {
    home: homeModel,
    away: awayModel,
    lambdaHome,
    lambdaAway,
    lambdaTotal: round(lambdaHome + lambdaAway, 2),
    leagueId: league.id,
    leagueTotal: league.total,
    sources,
    caveats,
    predictionBlended,
    formApplied,
    adjustments: contextual.adjustments,
    sigmaBoost: contextual.sigmaBoost,
  };
}
