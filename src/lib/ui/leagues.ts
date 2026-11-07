/** Ligas que ya aparecen en los análisis guardados, con el slug que usa la API de ESPN. */

export interface LeagueOption {
  slug: string;
  name: string;
  country: string;
}

export const KNOWN_LEAGUES: LeagueOption[] = [
  { slug: 'eng.1', name: 'Premier League', country: 'Inglaterra' },
  { slug: 'esp.1', name: 'LaLiga', country: 'España' },
  { slug: 'ita.1', name: 'Serie A', country: 'Italia' },
  { slug: 'ger.1', name: 'Bundesliga', country: 'Alemania' },
  { slug: 'fra.1', name: 'Ligue 1', country: 'Francia' },
  { slug: 'uefa.champions', name: 'Champions League', country: 'Europa' },
  { slug: 'uefa.europa', name: 'Europa League', country: 'Europa' },
  { slug: 'uefa.europa.conf', name: 'Conference League', country: 'Europa' },
  { slug: 'por.1', name: 'Primeira Liga', country: 'Portugal' },
  { slug: 'bel.1', name: 'Pro League', country: 'Bélgica' },
];

const LEAGUE_SLUG = /^[a-z0-9._-]{1,50}$/;

export function isLeagueSlug(value: string): boolean {
  return LEAGUE_SLUG.test(value);
}

export function leagueLabel(slug: string): string {
  return KNOWN_LEAGUES.find((league) => league.slug === slug)?.name ?? slug;
}

/** Une el catálogo con los slugs añadidos por el usuario, sin duplicados. */
export function mergeLeagues(custom: readonly string[]): LeagueOption[] {
  const known = new Set(KNOWN_LEAGUES.map((league) => league.slug));
  const extra = custom
    .filter((slug) => !known.has(slug))
    .map<LeagueOption>((slug) => ({ slug, name: slug, country: 'Añadida' }));
  return [...KNOWN_LEAGUES, ...extra];
}

export const CUSTOM_LEAGUES_KEY = 'parley-lab.custom-leagues.v1';
export const LAST_LEAGUE_KEY = 'parley-lab.last-league.v1';
