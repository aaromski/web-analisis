import { createHash } from 'node:crypto';
import type { AggregatedResponse, TeamPayload } from '../types/api';

/**
 * Proyección determinista de una respuesta de la Aggregator API para el
 * snapshot pre-partido.
 *
 * Dos análisis del mismo partido con el mismo contenido observable deben
 * producir el mismo digest, aunque cambien las marcas de tiempo, el estado de
 * la caché, las latencias o el orden en que respondieron los proveedores.
 * El digest es la identidad de contenido que usa la capa de persistencia; la
 * deduplicación autoritativa sigue ocurriendo en `public.record_snapshot`,
 * que hashea el payload que recibe.
 */

/** Claves que describen cómo o cuándo se produjo el payload, no qué dice. */
const VOLATILE_KEYS = new Set([
  'generated_at',
  'captured_at',
  'deadline_ms',
  'duration_ms',
  'latency_ms',
  'ttl_seconds',
  'cache',
]);

function encode(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map((item) => encode(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`).join(',')}}`;
  }
  return 'null';
}

/** JSON con claves ordenadas recursivamente: misma entrada, misma cadena. */
export function stableStringify(value: unknown): string {
  return encode(value);
}

/** SHA-256 hex (64 caracteres) de la serialización estable. */
export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

/** Las listas de fuentes no tienen orden semántico: se ordenan por contenido. */
function sortProviders(items: unknown[]): unknown[] {
  return items
    .map((item) => ({ item, key: stableStringify(item) }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((entry) => entry.item);
}

/** Elimina campos volátiles en cualquier profundidad y ordena listas de fuentes. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (VOLATILE_KEYS.has(key)) continue;
    if (key === 'sources' && Array.isArray(item)) {
      output[key] = sortProviders(item.map((entry) => scrub(entry)));
      continue;
    }
    output[key] = scrub(item);
  }
  return output;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function teamDigest(team: TeamPayload | null | undefined): Record<string, unknown> | null {
  if (!team || typeof team !== 'object') return null;
  return {
    team_id: text(team.team_id),
    name: text(team.name),
    side: team.side === 'away' ? 'away' : 'home',
    sample: typeof team.sample === 'number' && Number.isFinite(team.sample) ? team.sample : null,
    stats: scrub(team.stats ?? {}),
  };
}

/**
 * Identidad de contenido del bloque pre-partido: partido, equipos y `pre_match`
 * sin campos volátiles. La fecha se conserva (kickoff) y el bloque `post_match`
 * nunca entra en el hash.
 */
export function canonicalPreSnapshot(response: AggregatedResponse): Record<string, unknown> {
  const match = response?.match;
  return {
    match_id: text(match?.match_id),
    league: {
      id: text(match?.league?.id),
      name: text(match?.league?.name),
    },
    season: text(match?.season),
    kickoff_at: text(match?.date),
    status: text(match?.status) ?? 'unknown',
    venue: text(match?.venue),
    teams: {
      home: teamDigest(response?.teams?.home),
      away: teamDigest(response?.teams?.away),
    },
    pre_match: response?.pre_match == null ? null : scrub(response.pre_match),
  };
}
