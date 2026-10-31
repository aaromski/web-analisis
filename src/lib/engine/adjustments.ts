import type { AggregatedResponse, PreMatchTeam } from '../types/api';
import type { ModelAdjustment } from '../types/analysis';
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from './params';
import { clamp } from './poisson';
import { teamSample } from './quality';

export interface TeamAdjustment {
  /** Multiplicador sobre los goles que genera el equipo. */
  attack: number;
  /** Multiplicador sobre los goles que concede; >1 empeora la defensa. */
  defense: number;
}

export interface AdjustmentBundle {
  home: TeamAdjustment;
  away: TeamAdjustment;
  /** Multiplicador común a ambos equipos (clima, h2h). */
  total: number;
  adjustments: ModelAdjustment[];
  /** Incremento de incertidumbre si la alineación no está confirmada. */
  sigmaBoost: number;
}

export function pointsPerMatch(team: PreMatchTeam | null | undefined): number | null {
  const standings = team?.standings;
  if (!standings || standings.points === null || standings.played === null || standings.played <= 0) return null;
  const value = standings.points / standings.played;
  return Number.isFinite(value) ? value : null;
}

export function lineupAverageRating(team: PreMatchTeam | null | undefined): number | null {
  const ratings = (team?.lineup?.starters ?? [])
    .map((player) => player.season_rating)
    .filter((rating): rating is number => typeof rating === 'number' && Number.isFinite(rating));
  if (ratings.length < 8) return null;
  return ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
}

function sideFromIndex(index: number): 'home' | 'away' {
  return index === 0 ? 'home' : 'away';
}

/**
 * Ajustes contextuales acotados. No intentan reemplazar el modelo de fuerzas:
 * corrigen el ritmo esperado por disponibilidad, descanso, nivel del rival,
 * clima e historial directo. Cada factor se limita para evitar que un dato
 * aislado domine λ.
 */
export function buildAdjustments(
  response: AggregatedResponse,
  lambdaTotal: number,
  params: EngineParams = DEFAULT_ENGINE_PARAMS,
): AdjustmentBundle {
  const knobs = params.adjustments;
  const pre = response.pre_match ?? null;
  const preTeams = [pre?.teams?.home, pre?.teams?.away] as const;
  const adjustments: ModelAdjustment[] = [];
  const result: AdjustmentBundle = {
    home: { attack: 1, defense: 1 },
    away: { attack: 1, defense: 1 },
    total: 1,
    adjustments,
    sigmaBoost: 0,
  };

  const ppg = preTeams.map((team) => pointsPerMatch(team));

  for (let index = 0; index < 2; index += 1) {
    const side = sideFromIndex(index);
    const target = result[side];
    const team = preTeams[index];
    const opponentPpg = ppg[1 - index];
    const ownPpg = ppg[index];

    // Alineación: solo se ajusta λ si está confirmada y hay ratings suficientes.
    const lineup = team?.lineup;
    if (!lineup) {
      result.sigmaBoost += knobs.sigmaBoostNoLineup;
    } else {
      const rating = lineupAverageRating(team);
      const unavailable = lineup.unavailable?.length ?? 0;
      if (lineup.status === 'confirmed' && rating !== null) {
        const penalty = clamp(
          (knobs.lineupRatingBaseline - rating) / knobs.lineupRatingBaseline,
          0,
          knobs.lineupPenaltyMax,
        );
        if (penalty > 0.001) {
          target.attack *= 1 - penalty;
          target.defense *= 1 + penalty * knobs.lineupDefenseScale;
          adjustments.push({
            key: 'lineup',
            label: 'Alineación confirmada',
            side,
            deltaPct: -penalty * 100,
            detail: `Rating medio del once ${rating.toFixed(2)}; se descuenta producción ofensiva.`,
          });
        }
      } else {
        result.sigmaBoost += knobs.sigmaBoostUnconfirmed;
        adjustments.push({
          key: 'lineup',
          label: 'Alineación proyectada',
          side,
          deltaPct: 0,
          detail: `Once ${lineup.status ?? 'sin confirmar'}${unavailable > 0 ? ` con ${unavailable} baja${unavailable === 1 ? '' : 's'}` : ''}; no se ajusta λ, se amplía la incertidumbre.`,
        });
      }
    }

    // Descanso: menos de 4 días reduce ritmo ofensivo y empeora la defensa.
    const rest = team?.rest_days;
    if (typeof rest === 'number' && Number.isFinite(rest)) {
      let attack = 1;
      let defense = 1;
      if (rest < knobs.restShortDays) {
        attack = knobs.restShortAttack;
        defense = knobs.restShortDefense;
      } else if (rest < knobs.restMediumDays) {
        attack = knobs.restMediumAttack;
        defense = knobs.restMediumDefense;
      }
      if (attack !== 1) {
        target.attack *= attack;
        target.defense *= defense;
        adjustments.push({
          key: 'rest',
          label: 'Descanso corto',
          side,
          deltaPct: (attack - 1) * 100,
          detail: `${rest} día${rest === 1 ? '' : 's'} desde el partido anterior.`,
        });
      }
    }

    // Nivel del rival: un rival fuerte baja el ataque propio y exige más defensa.
    if (ownPpg !== null && opponentPpg !== null) {
      const strength = clamp(
        (opponentPpg - knobs.leaguePpg) / knobs.leaguePpg,
        knobs.opponentStrengthMin,
        knobs.opponentStrengthMax,
      );
      if (Math.abs(strength) > knobs.opponentStrengthThreshold) {
        const attack = 1 - knobs.opponentAttackCoef * strength;
        const defense = 1 + knobs.opponentDefenseCoef * strength;
        target.attack *= attack;
        target.defense *= defense;
        adjustments.push({
          key: 'opponent',
          label: 'Nivel del rival',
          side,
          deltaPct: (attack - 1) * 100,
          detail: `Rival con ${opponentPpg.toFixed(2)} puntos por partido frente a la media ${knobs.leaguePpg.toFixed(2)}.`,
        });
      }
    }
  }

  // Clima: lluvia fuerte o viento reducen el ritmo; frío/calor extremo también.
  const weather = pre?.weather;
  if (weather) {
    const precipitation = weather.precipitation_chance_pct ?? 0;
    const wind = weather.wind_speed ?? 0;
    const temperature = weather.temperature_c;
    let factor = 1;
    let reason: string | null = null;
    if (precipitation >= knobs.weatherRainPct || wind >= knobs.weatherWindKmh) {
      factor = knobs.weatherRainFactor;
      reason = `${precipitation} % de lluvia y viento ${wind} km/h.`;
    } else if (
      temperature !== null &&
      (temperature >= knobs.weatherTempHigh || temperature <= knobs.weatherTempLow)
    ) {
      factor = knobs.weatherTempFactor;
      reason = `Temperatura extrema (${temperature} °C).`;
    }
    if (reason) {
      result.total *= factor;
      adjustments.push({
        key: 'weather',
        label: 'Clima',
        side: 'both',
        deltaPct: (factor - 1) * 100,
        detail: reason,
      });
    }
  }

  // H2H como prior solo con muestra corta: evita doble contar un historial amplio.
  const sample = teamSample(response.teams.home);
  const sampleAway = teamSample(response.teams.away);
  const minSample = sample === null || sampleAway === null ? sample ?? sampleAway : Math.min(sample, sampleAway);
  const aggregate = pre?.h2h?.aggregate;
  if (
    (minSample === null || minSample < knobs.h2hSampleMax) &&
    aggregate &&
    (aggregate.total_matches ?? 0) >= knobs.h2hMinMatches &&
    aggregate.home_goals !== null &&
    aggregate.away_goals !== null
  ) {
    const matches = aggregate.total_matches as number;
    const h2hTotal = (aggregate.home_goals + aggregate.away_goals) / matches;
    const factor = clamp(
      1 + knobs.h2hCoef * (h2hTotal / Math.max(knobs.h2hLambdaFloor, lambdaTotal) - 1),
      knobs.h2hMinFactor,
      knobs.h2hMaxFactor,
    );
    result.total *= factor;
    adjustments.push({
      key: 'h2h',
      label: 'Historial directo',
      side: 'both',
      deltaPct: (factor - 1) * 100,
      detail: `${matches} partidos con ${h2hTotal.toFixed(2)} goles de media; se usa como prior por muestra corta.`,
    });
  }

  result.home.attack = clamp(result.home.attack, knobs.multiplierMin, knobs.multiplierMax);
  result.home.defense = clamp(result.home.defense, knobs.multiplierMin, knobs.multiplierMax);
  result.away.attack = clamp(result.away.attack, knobs.multiplierMin, knobs.multiplierMax);
  result.away.defense = clamp(result.away.defense, knobs.multiplierMin, knobs.multiplierMax);
  result.total = clamp(result.total, knobs.totalMin, knobs.totalMax);
  result.sigmaBoost = clamp(result.sigmaBoost, 0, knobs.sigmaBoostMax);

  return result;
}
