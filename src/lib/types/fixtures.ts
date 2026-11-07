export type FixtureState = 'scheduled' | 'live' | 'finished' | 'other';

export interface FixtureMatch {
  /** ID listo para la búsqueda por ID, con prefijo de fuente (`espn:`). */
  id: string;
  home: string;
  away: string;
  kickoff: string;
  status: FixtureState;
  statusLabel: string;
  homeScore: number | null;
  awayScore: number | null;
  venue: string | null;
}

export interface FixturesResponse {
  league: string;
  date: string;
  timezone: string;
  matches: FixtureMatch[];
}
