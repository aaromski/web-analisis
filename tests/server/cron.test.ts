import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * La ruta del cron importa `db.ts`, que declara `import 'server-only'`. El
 * marcador no existe fuera del bundle de Next, así que se resuelve a vacío
 * (mismo patrón que `persistence.test.ts`).
 */
const stubDir = mkdtempSync(join(tmpdir(), 'parley-lab-cron-server-only-'));
const stubFile = join(stubDir, 'server-only.cjs');
writeFileSync(stubFile, 'module.exports = {};\n');
const stubUrl = pathToFileURL(stubFile).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: stubUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

test.after(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

const ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_PERSISTENCE_ENABLED',
  'SUPABASE_TIMEOUT_MS',
  'CRON_SECRET',
  'STATS_API_BASE_URL',
  'NODE_ENV',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

const ORIGINAL_ENV = new Map<EnvKey, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function setEnv(values: Partial<Record<EnvKey, string>>): void {
  const env = process.env as Record<string, string | undefined>;
  for (const key of ENV_KEYS) delete env[key];
  for (const [key, value] of Object.entries(values)) env[key] = value;
}

function restoreEnv(): void {
  const env = process.env as Record<string, string | undefined>;
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

const ENABLED_ENV = {
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SUPABASE_PERSISTENCE_ENABLED: 'true',
  STATS_API_BASE_URL: 'https://stats.test',
} as const;

interface FetchCall {
  url: string;
  method: string;
  body: string | null;
}

type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

function stubFetch(handler: FetchHandler): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Fixture sintético de un partido finalizado con bloque post_match completo. */
function statsWithPost(postAvailable = true): unknown {
  return {
    match: {
      match_id: 'test:900001',
      league: { id: 'test.1', name: 'Test League' },
      season: '2026',
      date: '2026-10-30T18:00:00Z',
      status: 'finished',
      venue: null,
      score: { home: 2, away: 1 },
    },
    teams: {
      home: { team_id: 'test-home', name: 'Home Test', side: 'home', stats: {} },
      away: { team_id: 'test-away', name: 'Away Test', side: 'away', stats: {} },
    },
    ...(postAvailable
      ? {
          post_match: {
            version: '1.0.0',
            status: 'complete',
            score: { ht: { home: 1, away: 0 }, ft: { home: 2, away: 1 } },
            timeline: [],
            meta: {
              coverage: {
                sections: {
                  score: true,
                  halves: true,
                  timeline: true,
                  lineups: false,
                  players: false,
                  xg: false,
                },
                available: 3,
                total: 6,
              },
              warnings: [],
              conflicts: [],
              sources: [],
            },
          },
        }
      : {}),
    meta: { canonical_version: '1.2.0', generated_at: '2026-10-31T00:00:00Z' },
  };
}

function dbHandler(postAvailable = true): FetchHandler {
  return (call) => {
    if (call.method === 'GET' && call.url.includes('phase=eq.post')) {
      return Response.json([]);
    }
    if (call.method === 'GET' && call.url.includes('phase=eq.pre')) {
      return Response.json([
        {
          match_id: 'test:900001',
          captured_at: '2026-10-31T09:00:00Z',
          matches: { kickoff_at: '2026-10-30T18:00:00Z' },
        },
      ]);
    }
    if (call.url.includes('/api/v1/matches/')) {
      return Response.json(statsWithPost(postAvailable));
    }
    if (call.url.includes('/rpc/record_snapshot')) {
      return Response.json([
        { snapshot_id: '33333333-3333-4333-8333-333333333333', inserted: true },
      ]);
    }
    // Sin filas en `engine_params`: el aprendizaje no tiene versión promovida.
    if (call.method === 'GET' && call.url.includes('/rest/v1/engine_params')) {
      return Response.json([]);
    }
    return new Response(null, { status: 201 });
  };
}

interface CronSummary {
  state: string;
  pending: number;
  processed: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  errors: number;
  remaining: number;
  stopReason: string;
  results: Array<{ matchId: string; outcome: string; code?: string }>;
  learning: { state: string; reason?: string };
}

async function cronRoute(): Promise<typeof import('../../src/app/api/cron/ingest/route.ts')> {
  return import('../../src/app/api/cron/ingest/route.ts');
}

test('sin CRON_SECRET en producción el cron queda cerrado', async () => {
  setEnv({ ...ENABLED_ENV, NODE_ENV: 'production' });
  const stub = stubFetch(() => {
    throw new Error('no debe usarse la red');
  });

  try {
    const { GET } = await cronRoute();
    const response = await GET(new Request('https://web.test/api/cron/ingest'));
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'CRON_DISABLED');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test('un secreto ausente o incorrecto devuelve 401', async () => {
  setEnv({ ...ENABLED_ENV, CRON_SECRET: 'test-cron-secret' });
  const stub = stubFetch(() => {
    throw new Error('no debe usarse la red');
  });

  try {
    const { GET } = await cronRoute();

    const missing = await GET(new Request('https://web.test/api/cron/ingest'));
    assert.equal(missing.status, 401);

    const wrong = await GET(
      new Request('https://web.test/api/cron/ingest', {
        headers: { authorization: 'Bearer otro-secreto' },
      }),
    );
    assert.equal(wrong.status, 401);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test('con secreto cierra los pendientes e inserta el resultado', async () => {
  setEnv({ ...ENABLED_ENV, CRON_SECRET: 'test-cron-secret' });
  const stub = stubFetch(dbHandler());

  try {
    const { GET } = await cronRoute();
    const response = await GET(
      new Request('https://web.test/api/cron/ingest', {
        headers: { authorization: 'Bearer test-cron-secret' },
      }),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as CronSummary;
    assert.equal(body.state, 'ok');
    assert.equal(body.pending, 1);
    assert.equal(body.processed, 1);
    assert.equal(body.inserted, 1);
    assert.equal(body.errors, 0);
    assert.deepEqual(body.results, [{ matchId: 'test:900001', outcome: 'inserted' }]);
    // Sin versión promovida en `engine_params` el aprendizaje no toca nada.
    assert.deepEqual(body.learning, { state: 'skipped', reason: 'no-promoted' });

    const statsCall = stub.calls.find((call) => call.url.includes('/api/v1/matches/'));
    assert.ok(statsCall);
    assert.ok(statsCall.url.includes('include=post_match'));
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test('un partido sin marcador disponible se omite sin abortar la pasada', async () => {
  setEnv({ ...ENABLED_ENV, CRON_SECRET: 'test-cron-secret' });
  const stub = stubFetch(dbHandler(false));

  try {
    const { GET } = await cronRoute();
    const response = await GET(
      new Request('https://web.test/api/cron/ingest', {
        headers: { authorization: 'Bearer test-cron-secret' },
      }),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as CronSummary;
    assert.equal(body.state, 'ok');
    assert.equal(body.skipped, 1);
    assert.deepEqual(body.results, [
      { matchId: 'test:900001', outcome: 'skipped', code: 'POST_MATCH_UNAVAILABLE' },
    ]);
  } finally {
    stub.restore();
    restoreEnv();
  }
});
