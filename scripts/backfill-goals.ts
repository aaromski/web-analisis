/**
 * Rellena `match_goal_events` desde los snapshots post ya guardados.
 *
 * Idempotente: envía con `on_conflict=(snapshot_id, seq)` y resuelve duplicados
 * fusionando, así que repetirlo tras un cambio del extractor corrige las filas
 * existentes sin duplicarlas. Solo lee snapshots post vigentes; las
 * correcciones antiguas no duplican goles en las vistas.
 *
 * Uso: npm run backfill:goals -- [--dry-run]
 */
import type { PostMatchEvent } from '../src/lib/types/api.ts';
import { goalEventRows } from '../src/lib/server/goal-events.ts';

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const INSERT_CHUNK = 200;

interface SnapshotRow {
  id?: unknown;
  match_id?: unknown;
  timeline?: unknown;
}

interface TeamRow {
  match_id?: unknown;
  home_team_id?: unknown;
  home_team_name?: unknown;
  away_team_id?: unknown;
  away_team_name?: unknown;
}

interface TeamInfo {
  homeTeamId: string | null;
  homeName: string | null;
  awayTeamId: string | null;
  awayName: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function config(): { baseUrl: string; serviceKey: string } {
  const baseUrl = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!baseUrl || !serviceKey) {
    console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY (usa .env.local).');
    process.exit(1);
  }
  return { baseUrl, serviceKey };
}

function headers(serviceKey: string): Record<string, string> {
  return {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    accept: 'application/json',
  };
}

async function getAll<T>(baseUrl: string, serviceKey: string, path: string, label: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const join = path.includes('?') ? '&' : '?';
    const url = `${baseUrl}${path}${join}limit=${PAGE_SIZE}&offset=${offset}`;
    const response = await fetch(url, {
      headers: headers(serviceKey),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`No se pudo leer ${label} (${response.status}): ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) throw new Error(`Respuesta inesperada al leer ${label}.`);
    rows.push(...(payload as T[]));
    if (payload.length < PAGE_SIZE) return rows;
  }
  throw new Error(`La lectura de ${label} superó ${MAX_PAGES * PAGE_SIZE} filas.`);
}

async function insertChunk(
  baseUrl: string,
  serviceKey: string,
  chunk: ReturnType<typeof goalEventRows>,
): Promise<number> {
  const response = await fetch(`${baseUrl}/rest/v1/match_goal_events?on_conflict=snapshot_id,seq`, {
    method: 'POST',
    headers: {
      ...headers(serviceKey),
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(chunk),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`La inserción falló (${response.status}): ${body.slice(0, 300)}`);
  }
  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? payload.length : 0;
}

async function tableCount(baseUrl: string, serviceKey: string): Promise<number | null> {
  const response = await fetch(`${baseUrl}/rest/v1/match_goal_events?select=id`, {
    headers: { ...headers(serviceKey), prefer: 'count=exact', range: '0-0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const range = response.headers.get('content-range') ?? '';
  const total = Number(range.split('/')[1]);
  return Number.isFinite(total) ? total : null;
}

async function main(): Promise<void> {
  const { baseUrl, serviceKey } = config();
  const dryRun = process.argv.includes('--dry-run');
  const started = Date.now();

  const [snapshots, teams] = await Promise.all([
    getAll<SnapshotRow>(
      baseUrl,
      serviceKey,
      '/rest/v1/match_snapshots?select=id,match_id,timeline:payload->timeline&phase=eq.post&is_current=is.true&payload=not.is.null&order=captured_at.asc',
      'snapshots post',
    ),
    getAll<TeamRow>(
      baseUrl,
      serviceKey,
      '/rest/v1/v_match_teams?select=match_id,home_team_id,home_team_name,away_team_id,away_team_name',
      'equipos por partido',
    ),
  ]);

  const teamByMatch = new Map<string, TeamInfo>();
  for (const row of teams) {
    const matchId = text(row.match_id);
    if (!matchId) continue;
    teamByMatch.set(matchId, {
      homeTeamId: text(row.home_team_id),
      homeName: text(row.home_team_name),
      awayTeamId: text(row.away_team_id),
      awayName: text(row.away_team_name),
    });
  }

  const rows: ReturnType<typeof goalEventRows> = [];
  let withoutTeams = 0;
  let withoutTimeline = 0;

  for (const snapshot of snapshots) {
    const snapshotId = text(snapshot.id);
    const matchId = text(snapshot.match_id);
    if (!snapshotId || !matchId) continue;
    if (!Array.isArray(snapshot.timeline)) {
      withoutTimeline += 1;
      continue;
    }
    const info = teamByMatch.get(matchId);
    if (!info) withoutTeams += 1;
    rows.push(
      ...goalEventRows({
        snapshotId,
        matchId,
        timeline: snapshot.timeline as PostMatchEvent[],
        ...(info ?? {}),
      }),
    );
  }

  if (dryRun) {
    console.log(
      `Simulación: ${rows.length} goles extraídos de ${snapshots.length} snapshots post ` +
        `(${withoutTimeline} sin timeline, ${withoutTeams} sin equipos). No se insertó nada.`,
    );
    return;
  }

  let written = 0;
  for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
    written += await insertChunk(baseUrl, serviceKey, rows.slice(index, index + INSERT_CHUNK));
  }

  const total = await tableCount(baseUrl, serviceKey);
  const latency = Date.now() - started;
  console.log(
    `Snapshots post: ${snapshots.length} · sin timeline: ${withoutTimeline} · sin equipos: ${withoutTeams}\n` +
      `Goles extraídos: ${rows.length} · escritos: ${written} · filas en la tabla: ${total ?? '?'} (${latency} ms)`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
