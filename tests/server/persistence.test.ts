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
      scoring: null,
      calibration: null,
      baseline: null,
      dataHealth: {
        pairedMatches: 0,
        marketWin: 0,
        recaptured: 0,
        traceMissing: 0,
        totalsAtLine: 0,
        handicapAtLine: 0,
        lastCaptureAt: null,
      },
      trackRecord: [],
      engine: { promoted: null, candidates: [], reference: null },
      learning: { runs: [], versions: [] },
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
    assert.deepEqual(summary.learning, { runs: [], versions: [] });

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

test('el laboratorio mide mercado, calibración, línea exacta y CLV', async () => {
  setEnv(ENABLED_ENV);
  type Probs = {
    home: number;
    draw: number;
    away: number;
    totalOver: number;
    handicap: number;
    market: { home: number; draw: number; away: number; source: string } | null;
  };
  const row = (
    snapshotId: string,
    variant: 'production' | 'shadow',
    matchId: string,
    createdAt: string,
    probs: Probs,
  ) => ({
    snapshot_id: snapshotId,
    variant,
    prob_home: probs.home,
    prob_draw: probs.draw,
    prob_away: probs.away,
    totals_line: 2.5,
    totals_side: 'over',
    totals_probability: probs.totalOver,
    model_totals: { line: 2.5, over: probs.totalOver, under: 1 - probs.totalOver, push: 0 },
    model_handicap: { line: -0.5, home: probs.handicap, away: 1 - probs.handicap },
    market_win: probs.market,
    market_totals: { line: 2.5, over: 0.55, under: 0.45 },
    market_spread: { line: -0.5, home: 0.52, away: 0.48 },
    match_snapshots: {
      match_id: matchId,
      created_at: createdAt,
      matches: { league_id: 'test.A' },
    },
  });
  const productionProbs: Probs = {
    home: 0.5,
    draw: 0.3,
    away: 0.2,
    totalOver: 0.6,
    handicap: 0.55,
    market: { home: 0.45, draw: 0.3, away: 0.25, source: 'odds' },
  };
  const openProbs: Probs = {
    ...productionProbs,
    market: { home: 0.4, draw: 0.32, away: 0.28, source: 'odds' },
  };
  const shadowProbs: Probs = {
    home: 0.6,
    draw: 0.25,
    away: 0.15,
    totalOver: 0.5,
    handicap: 0.6,
    market: null,
  };

  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/predictions')) {
      return Response.json([
        row('snap-0', 'production', 'test:1', '2026-10-01T10:00:00Z', openProbs),
        row('snap-1', 'production', 'test:1', '2026-10-02T10:00:00Z', productionProbs),
        row('snap-1', 'shadow', 'test:1', '2026-10-02T10:00:00Z', shadowProbs),
        row('snap-2', 'production', 'test:2', '2026-10-02T11:00:00Z', {
          ...productionProbs,
          home: 0.4,
          draw: 0.35,
          away: 0.25,
        }),
        row('snap-2', 'shadow', 'test:2', '2026-10-02T11:00:00Z', {
          ...shadowProbs,
          home: 0.35,
          draw: 0.35,
          away: 0.3,
          totalOver: 0.62,
        }),
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

    const near = (actual: number | null, expected: number, tolerance = 1e-3) => {
      assert.ok(actual !== null && Math.abs(actual - expected) < tolerance, `${actual} ≉ ${expected}`);
    };

    assert.ok(summary.baseline);
    assert.equal(summary.baseline.matches, 2);
    near(summary.baseline.productionBrier, 0.5125);
    near(summary.baseline.shadowBrier, 0.44);
    near(summary.baseline.marketBrier, 0.605);
    near(summary.baseline.naiveBrier, 0.5);
    near(summary.baseline.productionSkillVsMarket, 1 - 0.5125 / 0.605);
    assert.equal(summary.baseline.clv.matches, 1);
    near(summary.baseline.clv.mean, 0.05);
    near(summary.baseline.clv.positiveShare, 1);

    assert.ok(summary.scoring);
    near(summary.scoring.totals!.production, 0.26);
    near(summary.scoring.totals!.shadow, 0.3172);
    near(summary.scoring.totals!.market, 0.2525);
    near(summary.scoring.handicap!.production, 0.2525);
    near(summary.scoring.handicap!.shadow, 0.26);
    near(summary.scoring.handicap!.market, 0.2504);

    assert.ok(summary.calibration);
    near(summary.calibration.productionEce, 0.2833);
    near(summary.calibration.shadowEce, 0.1333);
    assert.equal(summary.calibration.guard.ok, true);
    assert.equal(summary.calibration.isotonic, null);

    assert.equal(summary.dataHealth.pairedMatches, 2);
    assert.equal(summary.dataHealth.marketWin, 2);
    assert.equal(summary.dataHealth.recaptured, 1);
    assert.equal(summary.dataHealth.traceMissing, 0);
    assert.equal(summary.dataHealth.totalsAtLine, 2);
    assert.equal(summary.dataHealth.handicapAtLine, 2);
    assert.ok(summary.dataHealth.lastCaptureAt?.startsWith('2026-10-02'));

    const league = summary.trackRecord.find(
      (entry) => entry.kind === 'league' && entry.key === 'test.A',
    );
    assert.ok(league);
    assert.equal(league.matches, 2);
    near(league.productionBrier, 0.5125);
    near(league.shadowBrier, 0.44);
    near(league.marketBrier, 0.605);
    near(league.delta, 0.44 - 0.5125);
    assert.equal(summary.trackRecord.filter((entry) => entry.kind === 'market').length, 3);
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
      scoring: null,
      calibration: null,
      baseline: null,
      dataHealth: {
        pairedMatches: 0,
        marketWin: 0,
        recaptured: 0,
        traceMissing: 0,
        totalsAtLine: 0,
        handicapAtLine: 0,
        lastCaptureAt: null,
      },
      trackRecord: [],
      engine: { promoted: null, candidates: [], reference: null },
      learning: { runs: [], versions: [] },
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
      scoring: null,
      calibration: null,
      baseline: null,
      dataHealth: {
        pairedMatches: 0,
        marketWin: 0,
        recaptured: 0,
        traceMissing: 0,
        totalsAtLine: 0,
        handicapAtLine: 0,
        lastCaptureAt: null,
      },
      trackRecord: [],
      engine: { promoted: null, candidates: [], reference: null },
      learning: { runs: [], versions: [] },
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

test('las recapturas piden el recurso embebido que filtran', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/matches')) {
      return Response.json([
        { match_id: 'test:5', kickoff_at: '2026-11-07T20:00:00Z' },
        { match_id: null, kickoff_at: '2026-11-07T20:00:00Z' },
      ]);
    }
    return new Response(null, { status: 201 });
  });

  try {
    const { listRecaptureCandidates } = await db();
    const result = await listRecaptureCandidates({
      nowMs: Date.parse('2026-11-07T18:00:00Z'),
      limit: 2,
    });
    assert.deepEqual(result, {
      status: 'ok',
      matches: [{ matchId: 'test:5', kickoffAt: '2026-11-07T20:00:00.000Z' }],
    });

    assert.equal(stub.calls.length, 1);
    const url = stub.calls[0].url;
    // PostgREST rechaza (PGRST108) filtrar por un recurso embebido si el
    // `select` no lo incluye.
    assert.ok(url.includes('select=match_id,kickoff_at,match_snapshots!inner(id)'));
    assert.ok(url.includes('match_snapshots!inner(id)'));
    assert.ok(url.includes('match_snapshots.phase=eq.pre'));
    assert.ok(url.includes('status=eq.scheduled'));
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('sin configuración no hay recapturas y no se usa la red', async () => {
  clearEnv();
  const stub = stubFetch(() => {
    throw new Error('no debe usarse la red');
  });

  try {
    const { listRecaptureCandidates } = await db();
    assert.deepEqual(await listRecaptureCandidates(), { status: 'disabled', matches: [] });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('el diario del ciclo lee solo backtest/learning y mapea el motivo', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() =>
    Response.json([
      {
        occurred_at: '2026-10-31T06:05:00Z',
        status: 'skipped',
        error_code: 'candidate-accumulating',
        params_version: null,
      },
      {
        occurred_at: '2026-10-30T06:05:00Z',
        status: 'ok',
        error_code: 'promoted',
        params_version: 'auto-anchor-s110-20261030',
      },
      { occurred_at: 'nope', status: 'ok', error_code: null, params_version: null },
      { occurred_at: '2026-10-29T06:05:00Z', status: 'weird', error_code: null, params_version: null },
    ]),
  );

  try {
    const { listLearningRuns } = await db();
    const runs = await listLearningRuns(8);
    assert.deepEqual(runs, [
      {
        occurredAt: '2026-10-31T06:05:00.000Z',
        status: 'skipped',
        reason: 'candidate-accumulating',
        paramsVersion: null,
      },
      {
        occurredAt: '2026-10-30T06:05:00.000Z',
        status: 'ok',
        reason: 'promoted',
        paramsVersion: 'auto-anchor-s110-20261030',
      },
    ]);
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0].url.includes('/rest/v1/ingestion_events'));
    assert.ok(stub.calls[0].url.includes('operation=eq.backtest'));
    assert.ok(stub.calls[0].url.includes('request_id=eq.learning'));
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('el historial de versiones incluye notas y fechas', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() =>
    Response.json([
      {
        version: 'engine-1.2.0-defaults',
        status: 'promoted',
        created_at: '2026-10-01T00:00:00Z',
        promoted_at: '2026-10-01T00:00:00Z',
        retired_at: null,
        notes: 'Base de producción',
      },
      { version: null, status: 'shadow' },
    ]),
  );

  try {
    const { listEngineHistory } = await db();
    const history = await listEngineHistory(6);
    assert.deepEqual(history, [
      {
        version: 'engine-1.2.0-defaults',
        status: 'promoted',
        createdAt: '2026-10-01T00:00:00.000Z',
        promotedAt: '2026-10-01T00:00:00.000Z',
        retiredAt: null,
        notes: 'Base de producción',
      },
    ]);
  } finally {
    stub.restore();
    clearEnv();
  }
});

function goalRow(): import('../../src/lib/server/goal-events.ts').GoalEventRow {
  return {
    snapshot_id: '33333333-3333-4333-8333-333333333333',
    match_id: 'test:900001',
    seq: 0,
    minute: 23,
    added_time: null,
    period: 'first_half',
    event_type: 'goal',
    side: 'home',
    credited_side: 'home',
    team_id: 'team-home',
    opponent_team_id: 'team-away',
    team_name: 'Home Test',
    player_id: null,
    player_name: 'Ana',
    assist_name: null,
    score_home_after: 1,
    score_away_after: 0,
  };
}

test('los goles se insertan de forma idempotente en match_goal_events', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() => Response.json([goalRow()], { status: 201 }));

  try {
    const { recordGoalEvents } = await db();
    assert.deepEqual(await recordGoalEvents([goalRow()]), { status: 'ok', inserted: 1 });
    assert.equal(stub.calls.length, 1);

    const [call] = stub.calls;
    assert.equal(call.method, 'POST');
    assert.ok(call.url.includes('/rest/v1/match_goal_events'));
    assert.ok(call.url.includes('on_conflict=snapshot_id,seq'));
    assert.match(call.headers.prefer ?? '', /resolution=ignore-duplicates/);
    assert.ok(call.body);
    assert.equal((JSON.parse(call.body) as unknown[]).length, 1);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('sin goles o sin configuración no se usa la red', async () => {
  setEnv(ENABLED_ENV);
  const withGoles = stubFetch(() => {
    throw new Error('no debe usarse la red');
  });
  try {
    const { recordGoalEvents } = await db();
    assert.deepEqual(await recordGoalEvents([]), { status: 'skipped', inserted: 0 });
    assert.equal(withGoles.calls.length, 0);
  } finally {
    withGoles.restore();
    clearEnv();
  }

  const offline = stubFetch(() => {
    throw new Error('no debe usarse la red');
  });
  try {
    const { recordGoalEvents } = await db();
    assert.deepEqual(await recordGoalEvents([goalRow()]), { status: 'skipped', inserted: 0 });
    assert.equal(offline.calls.length, 0);
  } finally {
    offline.restore();
  }
});

test('un fallo al insertar goles se devuelve como estado y no lanza', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() => new Response('{"message":"boom"}', { status: 503 }));

  try {
    const { recordGoalEvents } = await db();
    assert.deepEqual(await recordGoalEvents([goalRow()]), {
      status: 'error',
      inserted: 0,
      errorCode: 'http_503',
    });
  } finally {
    stub.restore();
    clearEnv();
  }
});

function goalComparisonRow(): Record<string, unknown> {
  return {
    match_id: 'espn:401874795',
    kickoff_at: '2026-11-26T20:00:00Z',
    home_team_id: 'team-home',
    home_team_name: 'Home Test',
    away_team_id: 'team-away',
    away_team_name: 'Away Test',
    home_prior_matches: 4,
    home_goals_for: 7,
    home_goals_against: 4,
    home_goals_for_avg: 1.75,
    home_goals_against_avg: 1,
    home_minutes_per_goal_for: 51.4,
    home_minutes_per_goal_against: 90,
    home_first_half_goals_for: 4,
    home_second_half_goals_for: 3,
    home_first_half_pct_for: 57.1,
    home_second_half_pct_for: 42.9,
    home_first_half_goals_against: 2,
    home_second_half_goals_against: 2,
    home_first_half_pct_against: 50,
    home_second_half_pct_against: 50,
    home_first_goals: 3,
    home_first_goals_conceded: 1,
    home_first_goal_pct: 75,
    home_first_goal_minute_avg: 26.3,
    home_first_goal_minute_median: 24.5,
    home_clean_sheets: 1,
    home_failed_to_score: 1,
    home_btts_pct: 50,
    home_over_2_5_pct: 75,
    home_bands_for: { '1_15': 2, '16_30': 1, '31_45': 1, '46_60': 0, '61_75': 2, '76_90': 1 },
    home_bands_against: { '1_15': 0, '16_30': 1, '31_45': 1, '46_60': 1, '61_75': 0, '76_90': 1 },
    home_venue_matches: 2,
    home_venue: {
      matches: 2,
      goals_for: 3,
      goals_against: 0,
      goals_for_avg: 1.5,
      goals_against_avg: 0,
      minutes_per_goal_for: 60,
      minutes_per_goal_against: null,
      first_half_goals_for: 1,
      second_half_goals_for: 2,
      first_half_pct_for: 33.3,
      second_half_pct_for: 66.7,
      first_half_goals_against: 0,
      second_half_goals_against: 0,
      first_half_pct_against: null,
      second_half_pct_against: null,
      first_goals: 2,
      first_goals_conceded: 0,
      first_goal_pct: 100,
      first_goal_minute_avg: 30,
      first_goal_minute_median: 30,
      clean_sheets: 2,
      failed_to_score: 0,
      btts_pct: 0,
      over_2_5_pct: 50,
      bands_for: { '1_15': 1, '16_30': 0, '31_45': 0, '46_60': 0, '61_75': 1, '76_90': 1 },
      bands_against: { '1_15': 0, '16_30': 0, '31_45': 0, '46_60': 0, '61_75': 0, '76_90': 0 },
    },
    away_prior_matches: 3,
    away_goals_for: 2,
    away_goals_against: 5,
    away_goals_for_avg: 0.67,
    away_goals_against_avg: 1.67,
    away_minutes_per_goal_for: 135,
    away_minutes_per_goal_against: 54,
    away_first_half_goals_for: 1,
    away_second_half_goals_for: 1,
    away_first_half_pct_for: 50,
    away_second_half_pct_for: 50,
    away_first_half_goals_against: 3,
    away_second_half_goals_against: 2,
    away_first_half_pct_against: 60,
    away_second_half_pct_against: 40,
    away_first_goals: 0,
    away_first_goals_conceded: 3,
    away_first_goal_pct: 0,
    away_first_goal_minute_avg: null,
    away_first_goal_minute_median: null,
    away_clean_sheets: 0,
    away_failed_to_score: 1,
    away_btts_pct: 33.3,
    away_over_2_5_pct: 66.7,
    away_bands_for: { '1_15': 0, '16_30': 0, '31_45': 1, '46_60': 0, '61_75': 0, '76_90': 1 },
    away_bands_against: { '1_15': 1, '16_30': 1, '31_45': 1, '46_60': 1, '61_75': 1, '76_90': 0 },
    away_venue_matches: 2,
    away_venue: null,
  };
}

test('el comparativo mapea el perfil de ambos equipos y codifica el ID', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() => Response.json([goalComparisonRow()]));

  try {
    const { getGoalComparison } = await db();
    const result = await getGoalComparison('espn:401874795');
    assert.equal(result.state, 'ok');
    if (result.state !== 'ok') return;

    const { comparison } = result;
    assert.equal(comparison.matchId, 'espn:401874795');
    assert.equal(comparison.homeTeamName, 'Home Test');
    assert.equal(comparison.awayTeamName, 'Away Test');
    assert.equal(comparison.home.matches, 4);
    assert.equal(comparison.home.goalsFor, 7);
    assert.equal(comparison.home.minutesPerGoalFor, 51.4);
    assert.equal(comparison.home.firstHalfPctFor, 57.1);
    assert.equal(comparison.home.firstGoalMinuteMedian, 24.5);
    assert.equal(comparison.home.bandsFor['1_15'], 2);
    assert.equal(comparison.home.bandsAgainst['76_90'], 1);
    assert.equal(comparison.home.venueMatches, 2);
    assert.equal(comparison.home.venue?.matches, 2);
    assert.equal(comparison.home.venue?.bttsPct, 0);
    assert.equal(comparison.home.venue?.bandsFor['76_90'], 1);
    assert.equal(comparison.away.matches, 3);
    assert.equal(comparison.away.firstGoalMinuteMedian, null);
    assert.equal(comparison.away.bandsFor['76_90'], 1);
    assert.equal(comparison.away.venue, null);

    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.method, 'GET');
    assert.ok(call.url.includes('/rest/v1/v_match_goal_comparison'));
    assert.ok(call.url.includes('match_id=eq.espn%3A401874795'));
    assert.ok(call.url.includes('limit=1'));
    assert.equal(call.headers.apikey, 'test-service-role-key');
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('sin fila el comparativo devuelve not_found', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() => Response.json([]));

  try {
    const { getGoalComparison } = await db();
    assert.deepEqual(await getGoalComparison('test:900001'), { state: 'not_found' });
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('sin configuración el comparativo queda desactivado y no usa la red', async () => {
  clearEnv();
  const stub = stubFetch(() => {
    throw new Error('fetch no debe llamarse');
  });

  try {
    const { getGoalComparison } = await db();
    assert.deepEqual(await getGoalComparison('test:900001'), { state: 'disabled' });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('un fallo de Supabase se publica como estado de error con código', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() => new Response('{"message":"sin privilegios"}', { status: 403 }));

  try {
    const { getGoalComparison } = await db();
    assert.deepEqual(await getGoalComparison('test:900001'), {
      state: 'error',
      errorCode: 'http_403',
    });
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('una fila sin match_id se rechaza como error de formato', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() => Response.json([{ home_team_name: 'Home Test' }]));

  try {
    const { getGoalComparison } = await db();
    assert.deepEqual(await getGoalComparison('test:900001'), {
      state: 'error',
      errorCode: 'invalid_row',
    });
  } finally {
    stub.restore();
    clearEnv();
  }
});
