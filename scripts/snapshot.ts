import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BASE = 'http://localhost:3000';

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return null;
  const value = process.argv[index + 1].trim();
  return value.length > 0 ? value : null;
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function main(): Promise<void> {
  const home = argument('home');
  const away = argument('away');
  const date = argument('date');
  const league = argument('league');

  if (!home || !away || !date) {
    console.error('Uso: npm run snapshot -- --home "Local" --away "Visitante" --date YYYY-MM-DD [--league id]');
    process.exitCode = 1;
    return;
  }

  const base = (process.env.STATS_API_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
  const params = new URLSearchParams({ home, away, date });
  if (league) params.set('league', league);
  const url = `${base}/api/v1/matches/stats?${params.toString()}`;

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`La API respondió ${response.status} al capturar el partido.`);
    console.error(text.slice(0, 400));
    process.exitCode = 1;
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    console.error('La respuesta no es JSON válido.');
    process.exitCode = 1;
    return;
  }

  const directory = join(process.cwd(), 'data', 'snapshots');
  mkdirSync(directory, { recursive: true });
  const filename = `${slugify(date)}-${slugify(league ?? 'liga')}-${slugify(home)}-${slugify(away)}.json`;
  const path = join(directory, filename);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const match = (payload as { match?: { match_id?: string; status?: string } }).match;
  console.log(`Snapshot guardado: ${path}`);
  console.log(`Partido: ${match?.match_id ?? 'desconocido'} · estado ${match?.status ?? 'desconocido'}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
