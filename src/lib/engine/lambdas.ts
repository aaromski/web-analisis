import type { AggregatedResponse, PreMatchPayload, PreMatchTeam, TeamPayload } from '../types/api';
import type { TeamModel } from '../types/analysis';
import { clamp, round } from './poisson';
import { statNumber, teamSample } from './quality';

const PRIOR_HOME = 1.45;
const PRIOR_AWAY = 1.25;
const PRIOR_ATTACK = 1.35;
const PRIOR_DEFENSE = 1.35;

interface BlendValue {
  value: number;
  usedXg: boolean;
  usedGoals: boolean;
  fallback: boolean;
}

function blendAttack(team: TeamPayload | undefined): BlendValue {
  const xg = statNumber(team, 'xg');
  const goals = statNumber(team, 'goals_scored');
  if (xg !== null && goals !== null) return { value: 0.62 * xg + 0.38 * goals, usedXg: true, usedGoals: true, fallback: false };
  if (xg !== null) return { value: xg, usedXg: true, usedGoals: false, fallback: false };
  if (goals !== null) return { value: goals, usedXg: false, usedGoals: true, fallback: false };
  return { value: PRIOR_ATTACK, usedXg: false, usedGoals: false, fallback: true };
}

function blendDefense(team: TeamPayload | undefined): BlendValue {
  const xga = statNumber(team, 'xga');
  const conceded = statNumber(team, 'goals_conceded');
  if (xga !== null && conceded !== null) return { value: 0.62 * xga + 0.38 * conceded, usedXg: true, usedGoals: true, fallback: false };
  if (xga !== null) return { value: xga, usedXg: true, usedGoals: false, fallback: false };
  if (conceded !== null) return { value: conceded, usedXg: false, usedGoals: true, fallback: false };
  return { value: PRIOR_DEFENSE, usedXg: false, usedGoals: false, fallback: true };
}

interface FormNumbers {
  goalsFor: number | null;
  goalsAgainst: number | null;
  matches: number | null;
  form: string | null;
  source: 'recent_form' | 'form' | null;
}

function fromRecent(team: PreMatchTeam | undefined, side: 'home' | 'away'): FormNumbers {
  const empty: FormNumbers = { goalsFor: null, goalsAgainst: null, matches: null, form: null, source: null };
  const recent = team?.recent_form;
  if (recent) {
    const split = side === 'home' ? recent.splits?.home : recent.splits?.away;
    if (split && (split.matches ?? 0) >= 3 && split.goals_for !== null && split.goals_against !== null) {
      return {
        goalsFor: split.goals_for / (split.matches as number),
        goalsAgainst: split.goals_against / (split.matches as number),
        matches: split.matches,
        form: split.form ?? recent.results.form ?? null,
        source: 'recent_form',
      };
    }
    const matches = recent.results.matches ?? recent.matches;
    if (matches && matches >= 5 && recent.results.goals_for !== null && recent.results.goals_against !== null) {
      return {
        goalsFor: recent.results.goals_for / matches,
        goalsAgainst: recent.results.goals_against / matches,
        matches,
        form: recent.results.form ?? null,
        source: 'recent_form',
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
    };
  }
  return empty;
}

export interface LambdaModel {
  home: TeamModel;
  away: TeamModel;
  lambdaHome: number;
  lambdaAway: number;
  lambdaTotal: number;
  sources: string[];
  caveats: string[];
  predictionBlended: boolean;
  formApplied: boolean;
}

export function buildLambdas(response: AggregatedResponse): LambdaModel {
  const homeTeam = response.teams.home;
  const awayTeam = response.teams.away;
  const pre: PreMatchPayload | null | undefined = response.pre_match;

  const attackHome = blendAttack(homeTeam);
  const defenseHome = blendDefense(homeTeam);
  const attackAway = blendAttack(awayTeam);
  const defenseAway = blendDefense(awayTeam);

  let lambdaHome = (attackHome.value + defenseAway.value) / 2;
  let lambdaAway = (attackAway.value + defenseHome.value) / 2;

  // Mezcla con la media de liga para estabilizar muestras cortas.
  lambdaHome = 0.82 * lambdaHome + 0.18 * PRIOR_HOME;
  lambdaAway = 0.82 * lambdaAway + 0.18 * PRIOR_AWAY;

  // Localía.
  lambdaHome *= 1.06;
  lambdaAway *= 0.96;

  const caveats: string[] = [];
  const sources: string[] = [];

  if (attackHome.usedXg || attackAway.usedXg || defenseHome.usedXg || defenseAway.usedXg) {
    sources.push('xG/xGA de temporada');
  }
  if (attackHome.usedGoals || attackAway.usedGoals || defenseHome.usedGoals || defenseAway.usedGoals) {
    sources.push('Goles de temporada');
  }
  if (attackHome.fallback || attackAway.fallback || defenseHome.fallback || defenseAway.fallback) {
    sources.push('Media de liga');
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

  // Ajuste por muestra corta.
  const homeSample = teamSample(homeTeam);
  const awaySample = teamSample(awayTeam);
  if (homeSample !== null && homeSample < 5) {
    const weight = 0.2 * (1 - clamp(homeSample / 5, 0, 1));
    lambdaHome = lambdaHome * (1 - weight) + PRIOR_HOME * weight;
  }
  if (awaySample !== null && awaySample < 5) {
    const weight = 0.2 * (1 - clamp(awaySample / 5, 0, 1));
    lambdaAway = lambdaAway * (1 - weight) + PRIOR_AWAY * weight;
  }

  // Forma reciente: ataque propio y defensa propia (que afecta al rival).
  const homeForm = fromRecent(pre?.teams?.home, 'home');
  const awayForm = fromRecent(pre?.teams?.away, 'away');
  let formApplied = false;

  if (homeForm.goalsFor !== null) {
    const ratio = homeForm.goalsFor / Math.max(lambdaHome, 0.2);
    lambdaHome *= clamp(1 + 0.15 * (ratio - 1), 0.85, 1.15);
    formApplied = true;
  }
  if (awayForm.goalsFor !== null) {
    const ratio = awayForm.goalsFor / Math.max(lambdaAway, 0.2);
    lambdaAway *= clamp(1 + 0.15 * (ratio - 1), 0.85, 1.15);
    formApplied = true;
  }
  if (homeForm.goalsAgainst !== null) {
    lambdaAway *= clamp(1 + 0.1 * (homeForm.goalsAgainst / PRIOR_DEFENSE - 1), 0.9, 1.1);
    formApplied = true;
  }
  if (awayForm.goalsAgainst !== null) {
    lambdaHome *= clamp(1 + 0.1 * (awayForm.goalsAgainst / PRIOR_DEFENSE - 1), 0.9, 1.1);
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
    lambdaHome = 0.65 * lambdaHome + 0.35 * predictedHome;
    lambdaAway = 0.65 * lambdaAway + 0.35 * predictedAway;
    predictionBlended = true;
    sources.push('Predicción externa');
  }

  const beforeClampHome = lambdaHome;
  const beforeClampAway = lambdaAway;
  lambdaHome = clamp(lambdaHome, 0.15, 4.5);
  lambdaAway = clamp(lambdaAway, 0.15, 4.5);
  if (beforeClampHome !== lambdaHome || beforeClampAway !== lambdaAway) {
    caveats.push('λ ajustada al límite operativo del motor.');
  }

  const totalBefore = lambdaHome + lambdaAway;
  if (totalBefore > 7) {
    const factor = 7 / totalBefore;
    lambdaHome *= factor;
    lambdaAway *= factor;
    caveats.push('El total proyectado se limitó a 7 goles.');
  } else if (totalBefore < 0.8) {
    const factor = 0.8 / totalBefore;
    lambdaHome *= factor;
    lambdaAway *= factor;
    caveats.push('El total proyectado se elevó al mínimo de 0.8 goles.');
  }

  lambdaHome = round(lambdaHome, 2);
  lambdaAway = round(lambdaAway, 2);

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
  };

  return {
    home: homeModel,
    away: awayModel,
    lambdaHome,
    lambdaAway,
    lambdaTotal: round(lambdaHome + lambdaAway, 2),
    sources,
    caveats,
    predictionBlended,
    formApplied,
  };
}
