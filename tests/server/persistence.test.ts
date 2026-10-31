import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalPreSnapshot, hashCanonical, stableStringify } from '../../src/lib/server/canonical.ts';
import type { AggregatedResponse, OddsPrice } from '../../src/lib/types/api.ts';
import type { AnalysisResult } from '../../src/lib/types/analysis.ts';

/**
 * `db.ts` declara `import 'server-only'`, un marcador que Next resuelve en su
 * bundle pero que no existe como paquete en node_modules. Para poder probarlo
 * fuera de Next lo resolvemos a un módulo vacío.
 */
const stubDir = mkdtempSync(join(tmpdir(), 'parley-lab-server-only-'));
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

type Db = typeof import('../../src/lib/server/db.ts');

let loaded: Promise<Db> | null = null;

/** Import dinámico: los hooks deben estar registrados antes de resolver db.ts. */
function db(): Promise<Db> {
  loaded ??= import('../../src/lib/server/db.ts');
  return loaded;
}

const ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_PERSISTENCE_ENABLED',
  'SUPABASE_TIMEOUT_MS',
] as const;

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

const ENABLED_ENV = {
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SUPABASE_PERSISTENCE_ENABLED: 'true',
};

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

/** Sustituye `globalThis.fetch`; ninguna prueba usa red real. */
function stubFetch(handler: FetchHandler): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders && !Array.isArray(rawHeaders) && !(rawHeaders instanceof Headers)) {
      for (const [key, value] of Object.entries(rawHeaders)) {
        headers[key.toLowerCase()] = String(value);
      }
    }
    const call: FetchCall = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
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

function price(probability: number): OddsPrice {
  return {
    american: null,
    decimal: probability > 0 ? Math.round((1 / probability) * 100) / 100 : null,
    implied_probability: probability,
    no_vig_probability: probability,
  };
}

/** Fixture sintético: ningún dato real de usuarios ni de partidos. */
function scheduledFixture(): AggregatedResponse {
  return {
    match: {
      match_id: 'test:900001',
      league: { id: 'test.1', name: 'Test League' },
      season: '2026',
      date: '2026-11-02T18:00:00Z',
      status: 'scheduled',
      venue: 'Test Arena',
      score: { home: null, away: null },
    },
    teams: {
      home: {
        team_id: 'test-home',
        name: 'Home Test',
        side: 'home',
        sample: 12,
        stats: {
          goals: { value: 1.6, unit: 'goals', status: 'observed', source: 'test' },
          shots_on_target: { value: 4.8, unit: 'count', status: 'projected', source: 'test' },
        },
      },
      away: {
        team_id: 'test-away',
        name: 'Away Test',
        side: 'away',
        sample: 11,
        stats: {
          goals: { value: 1.1, unit: 'goals', status: 'observed', source: 'test' },
          shots_on_target: { value: 3.9, unit: 'count', status: 'projected', source: 'test' },
        },
      },
    },
    pre_match: {
      version: '1.2.0',
      status: 'partial',
      generated_at: '2026-10-31T09:00:00Z',
      odds: {
        provider: 'test-book',
        captured_at: '2026-10-31T08:55:00Z',
        provider_count: 3,
        totals: { line: 2.5, over: price(0.55), under: price(0.45) },
      },
      teams: {
        home: { name: 'Home Test', side: 'home' },
        away: { name: 'Away Test', side: 'away' },
      },
      h2h: null,
      meta: {
        sources: [
          { source: 'alpha', dataset: 'odds', status: 'ok', duration_ms: 120 },
          { source: 'beta', dataset: 'lineups', status: 'ok', duration_ms: 340 },
        ],
        deadline_ms: 4000,
        coverage: { sections: { odds: true, lineups: true }, available: 2, total: 2 },
      },
    },
    meta: {
      canonical_version: '1.2.0',
      generated_at: '2026-10-31T09:00:02Z',
      cache: { hit: false, ttl_seconds: 60 },
    },
  };
}

/** La persistencia sin configuración sale antes de leer el análisis. */
const UNUSED_ANALYSIS = {} as AnalysisResult;

test('la identidad canónica ignora timestamps, caché, latencias y orden de fuentes', () => {
  const base = scheduledFixture();
  const baseHash = hashCanonical(canonicalPreSnapshot(base));
  assert.match(baseHash, /^[0-9a-f]{64}$/);

  const volatile = structuredClone(base);
  volatile.meta.generated_at = '2026-10-31T11:11:11Z';
  volatile.meta.cache = { hit: true, ttl_seconds: 900 };
  volatile.pre_match!.generated_at = '2026-10-31T11:11:12Z';
  volatile.pre_match!.odds!.captured_at = '2026-10-31T11:10:00Z';
  volatile.pre_match!.meta!.deadline_ms = 9500;
  volatile.pre_match!.meta!.sources = [
    { source: 'beta', dataset: 'lineups', status: 'ok', duration_ms: 900 },
    { source: 'alpha', dataset: 'odds', status: 'ok', duration_ms: 40 },
  ];

  assert.equal(hashCanonical(canonicalPreSnapshot(volatile)), baseHash);

  const repriced = structuredClone(base);
  repriced.pre_match!.odds!.totals!.line = 3.5;
  assert.notEqual(hashCanonical(canonicalPreSnapshot(repriced)), baseHash);

  // El orden de claves tampoco altera la serialización.
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

test('sin configuración la persistencia queda desactivada y no usa la red', async () => {
  clearEnv();
  const stub = stubFetch(() => {
    throw new Error('fetch no debe llamarse');
  });

  try {
    const { getLabSummary, persistPreAnalysis } = await db();

    assert.deepEqual(await getLabSummary(), {
      state: 'disabled',
      matchesWithResult: 0,
      required: 100,
      markets: [],
      backtest: null,
      engine: { promoted: null, candidate: null },
    });

    const result = await persistPreAnalysis({ response: scheduledFixture(), analysis: UNUSED_ANALYSIS });
    assert.deepEqual(result, { status: 'skipped' });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('SUPABASE_PERSISTENCE_ENABLED=false desactiva aunque haya credenciales', async () => {
  setEnv({ ...ENABLED_ENV, SUPABASE_PERSISTENCE_ENABLED: 'false' });
  const stub = stubFetch(() => {
    throw new Error('fetch no debe llamarse');
  });

  try {
    const { getLabSummary, persistPreAnalysis } = await db();
    assert.equal((await getLabSummary()).state, 'disabled');
    assert.equal((await persistPreAnalysis({ response: scheduledFixture(), analysis: UNUSED_ANALYSIS })).status, 'skipped');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('un partido no programado se omite sin capturar snapshot', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() => Response.json([]));

  try {
    const { persistPreAnalysis } = await db();
    const fixture = scheduledFixture();
    fixture.match.status = 'finished';

    const result = await persistPreAnalysis({ response: fixture, analysis: UNUSED_ANALYSIS });
    assert.deepEqual(result, { status: 'skipped' });
    // Solo el evento de auditoría del omitido, ninguna escritura de captura.
    const writes = stub.calls.filter((call) => !call.url.includes('/rest/v1/ingestion_events'));
    assert.equal(writes.length, 0);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('un fallo de red no se propaga y se publica como error', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() => {
    throw new TypeError('fetch failed');
  });

  try {
    const { getLabSummary, persistPreAnalysis } = await db();

    assert.equal((await getLabSummary()).state, 'error');

    const result = await persistPreAnalysis({ response: scheduledFixture(), analysis: UNUSED_ANALYSIS });
    assert.equal(result.status, 'error');
    assert.equal(result.errorCode, 'supabase_unreachable');
    // Ni claves ni credenciales en el estado devuelto.
    assert.ok(!JSON.stringify(result).includes('test-service-role-key'));
  } finally {
    stub.restore();
    clearEnv();
  }
});

function labRow(
  snapshotId: string,
  variant: 'production' | 'shadow',
  matchId: string,
  createdAt: string,
  probs: { home: number; draw: number; away: number },
  totals: { line: number; side: 'over' | 'under'; probability: number },
) {
  return {
    snapshot_id: snapshotId,
    variant,
    prob_home: probs.home,
    prob_draw: probs.draw,
    prob_away: probs.away,
    totals_line: totals.line,
    totals_side: totals.side,
    totals_probability: totals.probability,
    match_snapshots: { match_id: matchId, created_at: createdAt },
  };
}

test('getLabSummary compara producción y sombra con el último snapshot', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/predictions')) {
      return Response.json([
        // Snapshot antiguo del mismo partido: debe quedar fuera.
        labRow('old-1', 'production', 'test:1', '2026-10-01T10:00:00Z', { home: 0.1, draw: 0.1, away: 0.8 }, { line: 2.5, side: 'over', probability: 0.2 }),
        labRow('old-1', 'shadow', 'test:1', '2026-10-01T10:00:00Z', { home: 0.1, draw: 0.1, away: 0.8 }, { line: 2.5, side: 'over', probability: 0.2 }),
        labRow('snap-1', 'production', 'test:1', '2026-10-02T10:00:00Z', { home: 0.5, draw: 0.3, away: 0.2 }, { line: 2.5, side: 'over', probability: 0.55 }),
        labRow('snap-1', 'shadow', 'test:1', '2026-10-02T10:00:00Z', { home: 0.6, draw: 0.25, away: 0.15 }, { line: 2.5, side: 'over', probability: 0.5 }),
        labRow('snap-2', 'production', 'test:2', '2026-10-02T11:00:00Z', { home: 0.4, draw: 0.35, away: 0.25 }, { line: 2.5, side: 'over', probability: 0.6 }),
        labRow('snap-2', 'shadow', 'test:2', '2026-10-02T11:00:00Z', { home: 0.35, draw: 0.35, away: 0.3 }, { line: 2.5, side: 'over', probability: 0.62 }),
        // Sin resultado: no entra en la comparación.
        labRow('snap-3', 'production', 'test:3', '2026-10-02T12:00:00Z', { home: 0.3, draw: 0.3, away: 0.4 }, { line: 2.5, side: 'over', probability: 0.5 }),
        labRow('snap-3', 'shadow', 'test:3', '2026-10-02T12:00:00Z', { home: 0.3, draw: 0.3, away: 0.4 }, { line: 2.5, side: 'over', probability: 0.5 }),
      ]);
    }
    return Response.json([
      { match_id: 'test:1', home_score: 2, away_score: 1 },
      { match_id: 'test:2', home_score: 1, away_score: 1 },
    ]);
  });

  try {
    const { getLabSummary } = await db();
    const summary = await getLabSummary();
    assert.equal(summary.state, 'insufficient');
    assert.equal(summary.matchesWithResult, 2);
    assert.equal(summary.required, 100);

    const byMarket = new Map(summary.markets.map((row) => [row.market, row]));
    assert.deepEqual([...byMarket.keys()], ['1x2_home', '1x2_draw', '1x2_away', 'totals']);

    const home = byMarket.get('1x2_home')!;
    assert.equal(home.label, 'Local');
    assert.ok(Math.abs(home.production! - 0.45) < 1e-9);
    assert.ok(Math.abs(home.shadow! - 0.475) < 1e-9);
    assert.equal(home.deltaPp, 2.5);
    assert.equal(home.n, 2);
    assert.equal(home.promotion, 'observing');
    assert.ok(home.interval && home.interval[0] < 0.025 && home.interval[1] > 0.025);

    const totals = byMarket.get('totals')!;
    assert.ok(Math.abs(totals.production! - 0.575) < 1e-9);
    assert.ok(Math.abs(totals.shadow! - 0.56) < 1e-9);
    assert.equal(totals.n, 2);

    assert.ok(summary.backtest);
    assert.equal(summary.backtest.matches, 2);
    // test:1 → home (2-1); test:2 → draw (1-1).
    assert.equal(summary.backtest.production.brier, 0.5125);
    assert.equal(summary.backtest.shadow.brier, 0.44);
    assert.ok(Math.abs(summary.backtest.production.logLoss - 0.8715) < 1e-4);
    assert.ok(Math.abs(summary.backtest.shadow.logLoss - 0.7803) < 1e-4);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('sin pares producción/sombra la compuerta queda en cero', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/predictions')) {
      return Response.json([
        labRow('snap-1', 'production', 'test:1', '2026-10-02T10:00:00Z', { home: 0.5, draw: 0.3, away: 0.2 }, { line: 2.5, side: 'over', probability: 0.55 }),
      ]);
    }
    return Response.json([{ match_id: 'test:1', home_score: 2, away_score: 1 }]);
  });

  try {
    const { getLabSummary } = await db();
    assert.deepEqual(await getLabSummary(), {
      state: 'insufficient',
      matchesWithResult: 0,
      required: 100,
      markets: [],
      backtest: null,
      engine: { promoted: null, candidate: null },
    });
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('un HTTP de error en la lectura del laboratorio se publica como error', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() => new Response(JSON.stringify({ code: '42501' }), { status: 401 }));

  try {
    const { getLabSummary } = await db();
    assert.deepEqual(await getLabSummary(), {
      state: 'error',
      matchesWithResult: 0,
      required: 100,
      markets: [],
      backtest: null,
      engine: { promoted: null, candidate: null },
    });
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('la captura usa el payload canónico y devuelve duplicate sin lanzar', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/matches')) return new Response(null, { status: 201 });
    if (call.url.includes('/rest/v1/rpc/record_snapshot')) {
      return Response.json([{ snapshot_id: '11111111-1111-4111-8111-111111111111', inserted: false }]);
    }
    return new Response(null, { status: 201 });
  });

  try {
    const { persistPreAnalysis } = await db();
    const result = await persistPreAnalysis({
      response: scheduledFixture(),
      // Sin motor real: la captura se completa y la predicción se descarta.
      analysis: UNUSED_ANALYSIS,
    });

    assert.deepEqual(result, {
      status: 'duplicate',
      snapshotId: '11111111-1111-4111-8111-111111111111',
    });

    const rpc = stub.calls.find((call) => call.url.includes('/rpc/record_snapshot'));
    assert.ok(rpc?.body);
    const body = JSON.parse(rpc.body) as { p_payload: Record<string, unknown>; p_phase: string };
    assert.equal(body.p_phase, 'pre');
    assert.match(String(body.p_payload.content_hash), /^[0-9a-f]{64}$/);
    assert.equal(body.p_payload.match_id, 'test:900001');
    // El payload canónico no arrastra campos volátiles.
    assert.equal(body.p_payload.generated_at, undefined);
  } finally {
    stub.restore();
    clearEnv();
  }
});

function postInput() {
  return {
    matchId: 'test:900001',
    kickoffAt: '2026-11-02T18:00:00Z',
    leagueId: 'test.1',
    leagueName: 'Test League',
    homeName: 'Home Test',
    awayName: 'Away Test',
    homeScore: 2,
    awayScore: 1,
    phasePayload: { version: '1.0.0', score: { ft: { home: 2, away: 1 } } },
    completeness: 'complete' as const,
  };
}

test('un post sin captura pre no crea un partido huérfano', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/match_snapshots')) return Response.json([]);
    return new Response(null, { status: 201 });
  });

  try {
    const { recordPostMatch } = await db();
    assert.deepEqual(await recordPostMatch(postInput()), { status: 'missing_pre' });

    // Solo se consultó si existe el pre: ni partido ni snapshot post.
    const writes = stub.calls.filter((call) => !call.url.includes('/ingestion_events'));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, 'GET');
    assert.ok(writes[0].url.includes('/rest/v1/match_snapshots'));
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('con captura pre el post se registra una sola vez', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch((call) => {
    if (call.method === 'GET' && call.url.includes('/rest/v1/match_snapshots')) {
      return Response.json([{ id: '22222222-2222-4222-8222-222222222222' }]);
    }
    if (call.url.includes('/rpc/record_snapshot')) {
      return Response.json([
        { snapshot_id: '33333333-3333-4333-8333-333333333333', inserted: true },
      ]);
    }
    return new Response(null, { status: 201 });
  });

  try {
    const { recordPostMatch } = await db();
    assert.deepEqual(await recordPostMatch(postInput()), {
      status: 'ok',
      snapshotId: '33333333-3333-4333-8333-333333333333',
      inserted: true,
    });
    const urls = stub.calls.map((call) => call.url);
    assert.ok(urls.some((url) => url.includes('/rest/v1/matches')));
    assert.ok(urls.some((url) => url.includes('/rpc/record_snapshot')));
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('sin configuración no hay partidos pendientes y no se usa la red', async () => {
  clearEnv();
  const stub = stubFetch(() => {
    throw new Error('no debe usarse la red');
  });

  try {
    const { listPendingPostMatches } = await db();
    assert.deepEqual(await listPendingPostMatches(), { status: 'disabled' });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('los pendientes deduplican capturas pre, excluyen cerrados y respetan el tope', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch((call) => {
    if (call.url.includes('phase=eq.post')) {
      return Response.json([{ match_id: 'test:1' }]);
    }
    return Response.json([
      { match_id: 'test:1', captured_at: '2026-10-31T09:00:00Z', matches: { kickoff_at: '2026-10-30T18:00:00Z' } },
      { match_id: 'test:1', captured_at: '2026-10-30T09:00:00Z', matches: { kickoff_at: '2026-10-30T18:00:00Z' } },
      { match_id: 'test:2', captured_at: '2026-10-31T08:00:00Z', matches: { kickoff_at: '2026-10-29T18:00:00Z' } },
      { match_id: 'test:3', captured_at: '2026-10-31T07:00:00Z', matches: { kickoff_at: '2026-10-28T18:00:00Z' } },
    ]);
  });

  try {
    const { listPendingPostMatches } = await db();
    const result = await listPendingPostMatches({ limit: 1, minAgeHours: 2 });
    assert.deepEqual(result, {
      status: 'ok',
      matches: [{ matchId: 'test:2', kickoffAt: '2026-10-29T18:00:00.000Z' }],
    });

    assert.equal(stub.calls.length, 2);
    const [preCall, closedCall] = stub.calls;
    assert.ok(preCall.url.includes('/rest/v1/match_snapshots'));
    assert.ok(preCall.url.includes('phase=eq.pre'));
    assert.ok(preCall.url.includes('matches!inner(kickoff_at)'));
    assert.ok(preCall.url.includes('matches.kickoff_at=lt.'));
    assert.ok(preCall.url.includes('order=captured_at.desc'));
    assert.ok(closedCall.url.includes('phase=eq.post'));
    assert.ok(closedCall.url.includes('match_id=in.(test:1,test:2,test:3)'));
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('un error al leer los pendientes se publica como estado', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() => new Response(null, { status: 503 }));

  try {
    const { listPendingPostMatches } = await db();
    const result = await listPendingPostMatches();
    assert.equal(result.status, 'error');
  } finally {
    stub.restore();
    clearEnv();
  }
});
