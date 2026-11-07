import type { FixtureMatch, FixtureState } from '../types/fixtures';
import { StatsApiError } from './errors';

const DEFAULT_BASE = 'https://site.api.espn.com/apis/site/v2';
const TIMEZONE = 'Europe/Madrid';
const TIMEOUT_MS = 8_000;

function espnBaseUrl(): string {
  return (process.env.ESPN_API_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
}

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Fecha de calendario en Madrid (YYYY-MM-DD) para un instante dado. */
export function madridDayKey(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = dayFormat.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

export function madridToday(now = new Date()): string {
  return madridDayKey(now) ?? now.toISOString().slice(0, 10);
}

export function isFixtureDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const probe = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(probe.getTime()) && probe.toISOString().slice(0, 10) === value;
}

function shiftDay(date: string, offset: number): string {
  const probe = new Date(`${date}T00:00:00Z`);
  probe.setUTCDate(probe.getUTCDate() + offset);
  return probe.toISOString().slice(0, 10);
}

interface EspnTeam {
  displayName?: string;
  name?: string;
  shortDisplayName?: string;
}

interface EspnCompetitor {
  homeAway?: string;
  score?: string | number;
  name?: string;
  team?: EspnTeam;
}

interface EspnEvent {
  id?: string;
  date?: string;
  competitions?: Array<{
    date?: string;
    startDate?: string;
    status?: {
      displayClock?: string;
      type?: {
        name?: string;
        state?: string;
        shortDetail?: string;
        detail?: string;
      };
    };
    venue?: { fullName?: string };
    competitors?: EspnCompetitor[];
  }>;
}

function statusOf(state: string | undefined, name: string | undefined): FixtureState {
  const upper = (name ?? '').toUpperCase();
  if (
    upper.includes('CANCEL') ||
    upper.includes('POSTPON') ||
    upper.includes('SUSPEND') ||
    upper.includes('ABANDON')
  ) {
    return 'other';
  }
  if (state === 'in') return 'live';
  if (state === 'post') return 'finished';
  if (state === 'pre') return 'scheduled';
  return 'other';
}

function statusLabelOf(status: FixtureState, shortDetail: string | undefined): string {
  if (status === 'scheduled') return 'Programado';
  if (status === 'live') return 'En juego';
  if (status === 'finished') return 'Finalizado';
  return shortDetail?.trim() || 'Sin jugar';
}

function scoreOf(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function teamName(competitor: EspnCompetitor | undefined): string | null {
  return (
    competitor?.team?.displayName?.trim() ||
    competitor?.team?.name?.trim() ||
    competitor?.team?.shortDisplayName?.trim() ||
    competitor?.name?.trim() ||
    null
  );
}

/**
 * Convierte un scoreboard de ESPN en partidos del día indicado. Descarta eventos
 * de otras fechas porque cada petición cubre una jornada en la zona de Madrid.
 */
export function mapScoreboard(payload: unknown, date: string): FixtureMatch[] {
  if (!payload || typeof payload !== 'object') return [];
  const events = (payload as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];

  const matches: FixtureMatch[] = [];
  for (const raw of events) {
    const event = raw as EspnEvent;
    const competition = event.competitions?.[0];
    const id = typeof event.id === 'string' ? event.id.trim() : '';
    const kickoff = event.date ?? competition?.date ?? competition?.startDate;
    if (!id || typeof kickoff !== 'string') continue;
    if (madridDayKey(kickoff) !== date) continue;

    const competitors = competition?.competitors ?? [];
    const home = competitors.find((competitor) => competitor.homeAway === 'home');
    const away = competitors.find((competitor) => competitor.homeAway === 'away');
    const homeName = teamName(home);
    const awayName = teamName(away);
    if (!homeName || !awayName) continue;

    const statusType = competition?.status?.type;
    const status = statusOf(statusType?.state, statusType?.name);

    matches.push({
      id: `espn:${id}`,
      home: homeName,
      away: awayName,
      kickoff: new Date(kickoff).toISOString(),
      status,
      statusLabel: statusLabelOf(status, statusType?.shortDetail),
      homeScore: scoreOf(home?.score),
      awayScore: scoreOf(away?.score),
      venue: competition?.venue?.fullName?.trim() || null,
    });
  }

  return matches;
}

async function fetchScoreboard(league: string, day: string): Promise<unknown> {
  const url = `${espnBaseUrl()}/sports/soccer/${encodeURIComponent(league)}/scoreboard?dates=${day.replace(/-/g, '')}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new StatsApiError(
        504,
        'FIXTURES_TIMEOUT',
        'La fuente del calendario tardó demasiado en responder. Vuelve a intentarlo.',
      );
    }
    throw new StatsApiError(
      503,
      'FIXTURES_UNAVAILABLE',
      'No se pudo conectar con la fuente del calendario. Comprueba la conexión y vuelve a intentarlo.',
    );
  }

  if (response.status === 400 || response.status === 404) {
    throw new StatsApiError(
      422,
      'LEAGUE_NOT_FOUND',
      `La fuente no reconoce la liga «${league}». Revisa el slug o elige otra liga.`,
    );
  }
  if (!response.ok) {
    throw new StatsApiError(
      502,
      'FIXTURES_API_ERROR',
      `La fuente del calendario respondió con HTTP ${response.status}.`,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new StatsApiError(
      502,
      'FIXTURES_INVALID_JSON',
      'La fuente del calendario devolvió una respuesta que no es JSON.',
    );
  }
}

/**
 * Partidos del día en la zona de Madrid. Se consultan el día anterior y el
 * siguiente porque ESPN agrupa los eventos por fecha estadounidense y un partido
 * nocturno puede caer en otra jornada; el mapeo filtra por fecha de Madrid.
 */
export async function fetchLeagueFixtures(league: string, date: string): Promise<FixtureMatch[]> {
  const days = [-1, 0, 1].map((offset) => shiftDay(date, offset));
  const payloads = await Promise.all(days.map((day) => fetchScoreboard(league, day)));

  const byId = new Map<string, FixtureMatch>();
  for (const payload of payloads) {
    for (const match of mapScoreboard(payload, date)) byId.set(match.id, match);
  }

  return [...byId.values()].sort(
    (left, right) => left.kickoff.localeCompare(right.kickoff) || left.home.localeCompare(right.home),
  );
}
