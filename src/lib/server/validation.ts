import { ValidationError } from './errors';

export interface MatchInput {
  matchId?: string;
  home?: string;
  away?: string;
  date?: string;
  league?: string;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LEAGUE_SLUG = /^[a-z0-9._-]{1,50}$/;
const MATCH_ID = /^[A-Za-z0-9._:-]{1,300}$/;

function strictDate(value: string): boolean {
  const match = DATE_ONLY.exec(value);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }
  return !Number.isNaN(Date.parse(value));
}

function clean(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new ValidationError(`El campo supera ${maxLength} caracteres.`);
  }
  return trimmed;
}

/**
 * Acepta JSON de un formulario: por ID o por equipos. Devuelve solo los campos
 * relevantes y normaliza espacios. Lanza ValidationError con mensaje en español.
 */
export function parseMatchInput(body: unknown): MatchInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('El cuerpo debe ser un objeto JSON.');
  }
  const raw = body as Record<string, unknown>;
  const matchId = clean(raw.matchId ?? raw.match_id, 300);
  const home = clean(raw.home, 100);
  const away = clean(raw.away, 100);
  const date = clean(raw.date, 40);
  const league = clean(raw.league, 50);

  if (matchId) {
    if (!MATCH_ID.test(matchId)) {
      throw new ValidationError('El ID del partido contiene caracteres no permitidos.');
    }
    return { matchId };
  }

  if (!home || !away) {
    throw new ValidationError('Indica el equipo local y el visitante, o un ID de partido.');
  }
  if (home.toLowerCase() === away.toLowerCase()) {
    throw new ValidationError('El local y el visitante no pueden ser el mismo equipo.');
  }
  if (date && !strictDate(date)) {
    throw new ValidationError('La fecha no es válida. Usa el formato YYYY-MM-DD.');
  }
  if (league && !LEAGUE_SLUG.test(league)) {
    throw new ValidationError('La liga debe ser un slug en minúsculas, por ejemplo eng.1 o ita.1.');
  }

  return {
    home,
    away,
    ...(date ? { date } : {}),
    ...(league ? { league } : {}),
  };
}

export function matchInputKey(input: MatchInput): string {
  return JSON.stringify({
    matchId: input.matchId ?? null,
    home: input.home?.toLowerCase() ?? null,
    away: input.away?.toLowerCase() ?? null,
    date: input.date ?? null,
    league: input.league ?? null,
  });
}

export function describeInput(input: MatchInput): string {
  if (input.matchId) return input.matchId;
  return `${input.home} vs ${input.away}${input.date ? ` · ${input.date}` : ''}${input.league ? ` · ${input.league}` : ''}`;
}
