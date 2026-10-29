import type { AggregatedResponse, ApiErrorPayload } from '../types/api';
import { StatsApiError } from './errors';
import type { MatchInput } from './validation';

const DEFAULT_BASE = 'http://localhost:3000';

export function statsApiBaseUrl(): string {
  return (process.env.STATS_API_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
}

function isAggregatedResponse(payload: unknown): payload is AggregatedResponse {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Partial<AggregatedResponse>;
  return Boolean(
    candidate.match &&
      typeof candidate.match.match_id === 'string' &&
      candidate.teams &&
      candidate.teams.home &&
      candidate.teams.away &&
      candidate.teams.home.stats &&
      candidate.teams.away.stats,
  );
}

function buildUrl(input: MatchInput): string {
  const base = statsApiBaseUrl();
  if (input.matchId) {
    return `${base}/api/v1/matches/${encodeURIComponent(input.matchId)}/stats`;
  }
  const params = new URLSearchParams();
  params.set('home', input.home ?? '');
  params.set('away', input.away ?? '');
  if (input.date) params.set('date', input.date);
  if (input.league) params.set('league', input.league);
  return `${base}/api/v1/matches/stats?${params.toString()}`;
}

export interface FetchResult {
  data: AggregatedResponse;
  latencyMs: number;
}

export async function fetchMatchStats(input: MatchInput, timeoutMs = 45_000): Promise<FetchResult> {
  const url = buildUrl(input);
  const started = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new StatsApiError(
        504,
        'STATS_API_TIMEOUT',
        'La API de estadísticas tardó demasiado en responder. Vuelve a intentarlo; el contexto previo puede ser lento.',
      );
    }
    throw new StatsApiError(
      503,
      'STATS_API_DOWN',
      'No se pudo conectar con la API de estadísticas. Comprueba que el servicio de la carpeta api esté activo y vuelve a intentarlo.',
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new StatsApiError(502, 'STATS_API_INVALID_JSON', 'La API de estadísticas devolvió una respuesta que no es JSON.');
    }
  }

  if (!response.ok) {
    const apiError = (payload as ApiErrorPayload | null)?.error;
    throw new StatsApiError(
      response.status,
      apiError?.code ?? 'STATS_API_ERROR',
      apiError?.message ?? `La API de estadísticas respondió con HTTP ${response.status}.`,
      apiError?.details,
    );
  }

  if (!isAggregatedResponse(payload)) {
    throw new StatsApiError(502, 'STATS_API_INVALID_RESPONSE', 'La API devolvió un contrato inesperado: faltan partido o equipos.');
  }

  return { data: payload, latencyMs: Date.now() - started };
}

export interface HealthResult {
  reachable: boolean;
  version: string | null;
  preMatchEnabled: boolean;
  latencyMs: number;
  error: string | null;
}

export async function getStatsApiHealth(): Promise<HealthResult> {
  const started = Date.now();
  try {
    const response = await fetch(`${statsApiBaseUrl()}/health`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    });
    const payload = (await response.json()) as {
      status?: string;
      canonical_version?: string;
      pre_match_context?: { enabled?: boolean };
    };
    return {
      reachable: response.ok && payload.status === 'ok',
      version: payload.canonical_version ?? null,
      preMatchEnabled: Boolean(payload.pre_match_context?.enabled),
      latencyMs: Date.now() - started,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return {
      reachable: false,
      version: null,
      preMatchEnabled: false,
      latencyMs: Date.now() - started,
      error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'sin conexión',
    };
  }
}
