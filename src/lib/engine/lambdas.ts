import type { AggregatedResponse, PreMatchPayload, PreMatchTeam, TeamPayload } from '../types/api';
import type { TeamModel } from '../types/analysis';
import { leagueBaseline, type LeagueBaseline } from './league';
import { clamp, round } from './poisson';
import { statNumber, teamSample } from './quality';

/**
 * Peso con el que cada fuerza se acerca a 1 (media de liga). Se aplica en
 * espacio multiplicativo para no comprimir la supremacía entre equipos.
 */
const STRENGTH_SHRINK = 0.15;

interface BlendValue {
  value: number;
  usedXg: boolean;
  usedGoals: boolean;
  fallback: boolean;
}

function blendAttack(team: TeamPayload | undefined, fallback: number): BlendValue {
  const xg = statNumber(team, 'xg');
  const goals = statNumber(team, 'goals_scored');
  if (xg !== null && goals !== null) return { value: 0.62 * xg + 0.38 * goals, usedXg: true, usedGoals: true, fallback: false };
  if (xg !== null) return { value: xg, usedXg: true, usedGoals: false, fallback: false };
  if (goals !== null) return { value: goals, usedXg: false, usedGoals: true, fallback: false };
  return { value: fallback, usedXg: false, usedGoals: false, fallback: true };
}

function blendDefense(team: TeamPayload | undefined, fallback: number): BlendValue {
  const xga = statNumber(team, 'xga');
  const conceded = statNumber(team, 'goals_conceded');
  if (xga !== null && conceded !== null) return { value: 0.62 * xga + 0.38 * conceded, usedXg: true, usedGoals: true, fallback: false };
  if (xga !== null) return { value: xga, usedXg: true, usedGoals: false, fallback: false };
  if (conceded !== null) return { value: conceded, usedXg: false, usedGoals: true, fallback: false };
  return { value: fallback, usedXg: false, usedGoals: false, fallback: true };
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

function shrinkStrength(value: number, weight: number): number {
  const w = clamp(weight, 0, 0.5);
  return (1 - w) * value + w;
}

function scaleToTotal(lambdaHome: number, lambdaAway: number, caveats: string[]): { home: number; away: number } {
  let home = lambdaHome;
  let away = lambdaAway;
  const total = home + away;
  if (total > 7) {
    const factor = 7 / total;
    home *= factor;
    away *= factor;
    caveats.push('El total proyectado se limitó a 7 goles.');
  } else if (total < 0.8) {
    const factor = 0.8 / total;
    home *= factor;
    away *= factor;
    caveats.push('El total proyectado se elevó al mínimo de 0.8 goles.');
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
}

export function buildLambdas(response: AggregatedResponse): LambdaModel {
  const homeTeam = response.teams.home;
  const awayTeam = response.teams.away;
  const pre: PreMatchPayload | null | undefined = response.pre_match;
  const league: LeagueBaseline = leagueBaseline(response.match?.league?.id);
  const perTeam = Math.max(0.2, league.perTeam);

  const attackHome = blendAttack(homeTeam, perTeam);
  const defenseHome = blendDefense(homeTeam, perTeam);
  const attackAway = blendAttack(awayTeam, perTeam);
  const defenseAway = blendDefense(awayTeam, perTeam);

  const homeSample = teamSample(homeTeam);
  const awaySample = teamSample(awayTeam);
  const extraHome = homeSample !== null && homeSample < 5 ? 0.2 * (1 - clamp(homeSample / 5, 0, 1)) : 0;
  const extraAway = awaySample !== null && awaySample < 5 ? 0.2 * (1 - clamp(awaySample / 5, 0, 1)) : 0;

  // Fuerzas relativas a la media de la liga. Multiplicar evita que un ataque
  // fuerte contra una defensa débil se diluya en un promedio aritmético.
  const attackStrengthHome = shrinkStrength(attackHome.value / perTeam, STRENGTH_SHRINK + extraHome);
  const defenseStrengthHome = shrinkStrength(defenseHome.value / perTeam, STRENGTH_SHRINK + extraHome);
  const attackStrengthAway = shrinkStrength(attackAway.value / perTeam, STRENGTH_SHRINK + extraAway);
  const defenseStrengthAway = shrinkStrength(defenseAway.value / perTeam, STRENGTH_SHRINK + extraAway);

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
      const weight = Math.round((STRENGTH_SHRINK + extra) * 100);
      caveats.push(`${name}: muestra corta (${sample ?? 0} partidos); las fuerzas se acercan un ${weight} % a la media de liga.`);
    }
  }

  // Forma reciente: ataque propio y defensa propia (que afecta al rival).
  const homeForm = fromRecent(pre?.teams?.home, 'home');
  const awayForm = fromRecent(pre?.teams?.away, 'away');
  let formApplied = false;

  if (homeForm.goalsFor !== null) {
    const ratio = homeForm.goalsFor / perTeam;
    lambdaHome *= clamp(1 + 0.15 * (ratio - 1), 0.85, 1.15);
    formApplied = true;
  }
  if (awayForm.goalsFor !== null) {
    const ratio = awayForm.goalsFor / perTeam;
    lambdaAway *= clamp(1 + 0.15 * (ratio - 1), 0.85, 1.15);
    formApplied = true;
  }
  if (homeForm.goalsAgainst !== null) {
    lambdaAway *= clamp(1 + 0.1 * (homeForm.goalsAgainst / perTeam - 1), 0.9, 1.1);
    formApplied = true;
  }
  if (awayForm.goalsAgainst !== null) {
    lambdaHome *= clamp(1 + 0.1 * (awayForm.goalsAgainst / perTeam - 1), 0.9, 1.1);
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

  const scaled = scaleToTotal(lambdaHome, lambdaAway, caveats);
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
    leagueId: league.id,
    leagueTotal: league.total,
    sources,
    caveats,
    predictionBlended,
    formApplied,
  };
}
