/**
 * Referencias de liga para λ. Los valores son medias de goles por partido en
 * temporadas recientes; solo fijan la escala del modelo, no el nivel de cada
 * equipo. Una liga desconocida usa la media general.
 */

export const DEFAULT_LEAGUE_TOTAL = 2.7;
/** Proporción del total de goles que corresponde al local (ventaja de localía). */
export const HOME_SHARE = 0.545;

export const LEAGUE_TOTALS: Record<string, number> = {
  'eng.1': 2.86,
  'esp.1': 2.62,
  'ita.1': 2.68,
  'ger.1': 3.12,
  'fra.1': 2.82,
  'por.1': 2.55,
  'ned.1': 3.05,
  'bel.1': 2.9,
  'tur.1': 2.75,
  'usa.1': 2.95,
  'mex.1': 2.7,
  'arg.1': 2.45,
  'bra.1': 2.4,
  'eng.2': 2.65,
  'esp.2': 2.4,
};

export interface LeagueBaseline {
  id: string | null;
  total: number;
  home: number;
  away: number;
  perTeam: number;
}

export function leagueBaseline(leagueId: string | null | undefined): LeagueBaseline {
  const id = typeof leagueId === 'string' && leagueId.length > 0 ? leagueId : null;
  const total = id !== null && Number.isFinite(LEAGUE_TOTALS[id]) ? LEAGUE_TOTALS[id] : DEFAULT_LEAGUE_TOTAL;
  return {
    id,
    total,
    home: total * HOME_SHARE,
    away: total * (1 - HOME_SHARE),
    perTeam: total / 2,
  };
}
