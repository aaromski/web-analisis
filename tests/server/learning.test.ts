import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * `db.ts` (importado por `learning.ts`) declara `import 'server-only'`, que no
 * existe fuera del bundle de Next. Mismo stub que el resto de pruebas de servidor.
 */
const stubDir = mkdtempSync(join(tmpdir(), 'parley-lab-learning-server-only-'));
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
type Learning = typeof import('../../src/lib/server/learning.ts');

let loaded: Promise<Db> | null = null;
let learningLoaded: Promise<Learning> | null = null;

function db(): Promise<Db> {
  loaded ??= import('../../src/lib/server/db.ts');
  return loaded;
}

/** Import dinámico: el stub de `server-only` debe existir antes de resolverlo. */
function learning(): Promise<Learning> {
  learningLoaded ??= import('../../src/lib/server/learning.ts');
  return learningLoaded;
}

async function runLearning(nowMs: number) {
  return (await learning()).runLearning(nowMs);
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

const PROMOTED = 'engine-1.2.0-defaults';
const CANDIDATE = 'auto-anchor-s110-20261020';
const NOW = Date.parse('2026-10-31T06:00:00Z');

function engineRow(
  version: string,
  promotedAt: string | null,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version,
    params,
    created_at: '2026-10-01T00:00:00Z',
    promoted_at: promotedAt,
  };
}

/** Filas de la vista de backtest: un par sombra/producción por partido. */
function scoredRows(
  count: number,
  options: { variant: 'shadow' | 'production'; version: string; brier: number },
  startDays = 20,
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => {
    const captured = new Date(Date.parse('2026-09-01T00:00:00Z') + (startDays + index) * 86_400_000);
    return {
      match_id: `test:${options.variant}-${String(index).padStart(4, '0')}`,
      pre_snapshot_id: `snap-${options.variant}-${String(index).padStart(4, '0')}`,
      variant: options.variant,
      params_version: options.version,
      brier: options.brier,
      log_loss: 0.6,
      pre_captured_at: captured.toISOString(),
    };
  });
}

function pairedRows(count: number): Array<Record<string, unknown>> {
  const shadow = scoredRows(count, { variant: 'shadow', version: CANDIDATE, brier: 0.40 });
  const production = scoredRows(count, { variant: 'production', version: PROMOTED, brier: 0.45 });
  const pairs: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index += 1) {
    pairs.push({
      ...shadow[index],
      pre_snapshot_id: production[index].pre_snapshot_id,
      match_id: production[index].match_id,
    });
  }
  return production.concat(pairs);
}

/** Payload canónico mínimo, sin cuotas: el ancla no aplica y todas las escalas empatan. */
function canonicalPayload(index: number): Record<string, unknown> {
  return {
    match_id: `test:tune-${String(index).padStart(4, '0')}`,
    league: { id: 'test.1', name: 'Test League' },
    season: '2026',
    kickoff_at: new Date(Date.parse('2026-08-01T18:00:00Z') + index * 86_400_000).toISOString(),
    status: 'scheduled',
    venue: null,
    teams: {
      home: {
        team_id: 'test-home',
        name: 'Home Test',
        side: 'home',
        sample: 10,
        stats: { goals: { value: 1.4, unit: 'goals', status: 'observed', source: 'test' } },
      },
      away: {
        team_id: 'test-away',
        name: 'Away Test',
        side: 'away',
        sample: 10,
        stats: { goals: { value: 1.1, unit: 'goals', status: 'observed', source: 'test' } },
      },
    },
    pre_match: null,
  };
}

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

test('resultOf clasifica el marcador', async () => {
  const { resultOf } = await learning();
  assert.equal(resultOf(2, 1), 'home');
  assert.equal(resultOf(1, 1), 'draw');
  assert.equal(resultOf(0, 3), 'away');
});

test('brierOf y logLossOf puntúan la probabilidad del resultado', async () => {
  const { brierOf, logLossOf } = await learning();
  const probabilities = { home: 0.5, draw: 0.3, away: 0.2 };
  assert.ok(Math.abs((brierOf(probabilities, 'home') ?? -1) - 0.38) < 1e-12);
  assert.ok(Math.abs((brierOf(probabilities, 'draw') ?? -1) - 0.78) < 1e-12);
  assert.ok(Math.abs((brierOf(probabilities, 'away') ?? -1) - 0.98) < 1e-12);
  assert.equal(brierOf({ home: Number.NaN, draw: 0.5, away: 0.5 }, 'home'), null);

  assert.ok(Math.abs((logLossOf(probabilities, 'draw') ?? -1) + Math.log(0.3)) < 1e-12);
  assert.equal(logLossOf({ home: 1, draw: 0, away: 0 }, 'draw'), null);
  // La probabilidad se acota a 1e-15 para que el logaritmo quede finito.
  assert.ok(
    Math.abs((logLossOf({ home: 1e-300, draw: 0.5, away: 0.5 }, 'home') ?? 0) + Math.log(1e-15)) < 1e-12,
  );
});

test('el bootstrap es determinista y respeta la dirección', async () => {
  const { bootstrapProbability } = await learning();
  const negative = Array.from({ length: 40 }, () => -0.01);
  const positive = Array.from({ length: 40 }, () => 0.01);

  assert.equal(bootstrapProbability(negative, 'below'), 1);
  assert.equal(bootstrapProbability(negative, 'above'), 0);
  assert.equal(bootstrapProbability(positive, 'above'), 1);
  assert.equal(bootstrapProbability(negative, 'below'), bootstrapProbability(negative, 'below'));
  assert.equal(bootstrapProbability([], 'below'), 0);
});

test('evaluatePromotion exige muestra, margen y confianza', async () => {
  const { evaluatePromotion } = await learning();
  assert.equal(evaluatePromotion(Array.from({ length: 49 }, () => -0.05)).promote, false);
  assert.equal(evaluatePromotion(Array.from({ length: 50 }, () => -0.05)).promote, true);
  // La mejora media no alcanza el margen de 0,004 aunque la confianza sea total.
  assert.equal(evaluatePromotion(Array.from({ length: 50 }, () => -0.001)).promote, false);
  const decision = evaluatePromotion(Array.from({ length: 80 }, () => -0.02));
  assert.equal(decision.matches, 80);
  assert.ok(Math.abs(decision.mean + 0.02) < 1e-12);
  assert.ok(decision.probability >= 0.95);
});

test('evaluateRollback exige degradación sostenida', async () => {
  const { evaluateRollback } = await learning();
  assert.equal(evaluateRollback(Array.from({ length: 29 }, () => 0.05)).promote, false);
  assert.equal(evaluateRollback(Array.from({ length: 30 }, () => 0.05)).promote, true);
  assert.equal(evaluateRollback(Array.from({ length: 30 }, () => 0.005)).promote, false);
  // Una sola observación pésima entre treinta neutras no dispara el rollback.
  const noisy = [...Array.from({ length: 29 }, () => 0), 0.2];
  assert.equal(evaluateRollback(noisy).promote, false);
});

test('pickBestScale elige el mejor Brier y desempata hacia 1', async () => {
  const { ANCHOR_SCALES, pickBestScale } = await learning();
  assert.equal(pickBestScale([]), null);
  assert.equal(
    pickBestScale([
      { scale: 0.9, brier: 0.5 },
      { scale: 1.0, brier: 0.4 },
    ]),
    1.0,
  );
  assert.equal(
    pickBestScale([
      { scale: 0.7, brier: 0.5 },
      { scale: 1.1, brier: 0.5 },
    ]),
    1.1,
  );
  assert.equal(pickBestScale([{ scale: 0.8, brier: Number.NaN }]), null);
  assert.deepEqual(ANCHOR_SCALES, [0.7, 0.8, 0.9, 1.0, 1.1]);
});

// ---------------------------------------------------------------------------
// Lectura de parámetros promovidos
// ---------------------------------------------------------------------------

test('getPromotedConfig lee la fila promovida y la cachea', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() =>
    Response.json([engineRow(PROMOTED, '2026-09-01T00:00:00Z', { anchor: { scaleMin: 0.9, scaleMax: 0.9 } })]),
  );

  try {
    const { getPromotedConfig, clearParamsCache } = await db();
    clearParamsCache();

    const config = await getPromotedConfig();
    assert.equal(config?.version, PROMOTED);
    assert.equal(config?.params.anchor.scaleMin, 0.9);
    assert.equal(config?.params.anchor.scaleMax, 0.9);
    assert.equal(config?.promotedAt, '2026-09-01T00:00:00.000Z');
    assert.ok(!JSON.stringify(config).includes('test-service-role-key'));

    await getPromotedConfig();
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0].url.includes('status=eq.promoted'));
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('un fallo de lectura devuelve null y no propaga la excepción', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() => {
    throw new TypeError('fetch failed');
  });

  try {
    const { getPromotedConfig, clearParamsCache } = await db();
    clearParamsCache();

    assert.equal(await getPromotedConfig(), null);
    // El fallo se cachea un tiempo corto: el análisis no espera dos veces.
    assert.equal(await getPromotedConfig(), null);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
    clearEnv();
  }
});

// ---------------------------------------------------------------------------
// Forma de las escrituras
// ---------------------------------------------------------------------------

test('retirar y promover validan la versión y usan la ruta correcta', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch((call) => {
    if (call.method === 'GET') return Response.json([]);
    if (call.url.includes('/rpc/set_promoted_params')) {
      return Response.json([{ promoted_version: CANDIDATE, retired_version: PROMOTED }]);
    }
    return new Response(null, { status: 204 });
  });

  try {
    const { clearParamsCache, getEngineConfigs, promoteParamsVersion, retireEngineVersion } = await db();
    clearParamsCache();

    assert.deepEqual(await retireEngineVersion('*bad*'), { ok: false, errorCode: 'invalid_version' });
    assert.deepEqual(await promoteParamsVersion('bad version'), { ok: false, errorCode: 'invalid_version' });
    assert.equal(stub.calls.length, 0);

    const listed = await getEngineConfigs();
    assert.deepEqual(listed, { promoted: null, shadow: null });

    assert.deepEqual(await retireEngineVersion(CANDIDATE), { ok: true });
    const patch = stub.calls.find((call) => call.method === 'PATCH');
    assert.ok(patch);
    assert.ok(patch.url.includes(`/rest/v1/engine_params?version=eq.${CANDIDATE}&status=eq.shadow`));
    const retired = JSON.parse(patch.body ?? '{}') as { status?: string; retired_at?: string };
    assert.equal(retired.status, 'retired');
    assert.ok(Number.isFinite(Date.parse(retired.retired_at ?? '')));

    const promoted = await promoteParamsVersion(CANDIDATE);
    assert.deepEqual(promoted, { ok: true, promoted: CANDIDATE, retired: PROMOTED });
    const rpc = stub.calls.find((call) => call.url.includes('/rpc/set_promoted_params'));
    assert.ok(rpc);
    assert.equal(rpc.method, 'POST');
    assert.deepEqual(JSON.parse(rpc.body ?? '{}'), { p_version: CANDIDATE });
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('las lecturas del backtest filtran las versiones pedidas', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch(() => Response.json([]));

  try {
    const { clearParamsCache, listScoredPredictions } = await db();
    clearParamsCache();

    assert.deepEqual(await listScoredPredictions(['v1', 'bad version']), []);
    const call = stub.calls[0];
    assert.ok(call.url.includes('/rest/v1/v_match_backtest'));
    assert.ok(call.url.includes('params_version=in.(v1)'));
    assert.ok(!call.url.includes('bad version'));
  } finally {
    stub.restore();
    clearEnv();
  }
});

// ---------------------------------------------------------------------------
// Ciclo completo
// ---------------------------------------------------------------------------

test('runLearning queda desactivado sin persistencia y no usa la red', async () => {
  clearEnv();
  const stub = stubFetch(() => {
    throw new Error('fetch no debe llamarse');
  });

  try {
    assert.deepEqual(await runLearning(NOW), { state: 'disabled' });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('promueve la candidata cuando gana en sombra y venció el enfriamiento', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) return Response.json(pairedRows(50));
    if (call.url.includes('status=eq.promoted')) {
      return Response.json([engineRow(PROMOTED, '2026-09-01T00:00:00Z')]);
    }
    if (call.url.includes('status=eq.shadow')) return Response.json([engineRow(CANDIDATE, null)]);
    if (call.url.includes('select=version,status')) {
      return Response.json([
        { version: PROMOTED, status: 'promoted', created_at: '2026-01-01T00:00:00Z', promoted_at: '2026-09-01T00:00:00Z', retired_at: null },
      ]);
    }
    if (call.url.includes('/rpc/set_promoted_params')) {
      return Response.json([{ promoted_version: CANDIDATE, retired_version: PROMOTED }]);
    }
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();

    const summary = await runLearning(NOW);
    assert.deepEqual(summary, {
      state: 'ok',
      reason: 'promoted',
      shadowMatches: 50,
      promotion: { version: CANDIDATE, retired: PROMOTED },
    });

    const rpc = stub.calls.filter((call) => call.url.includes('/rpc/set_promoted_params'));
    assert.equal(rpc.length, 1);
    assert.deepEqual(JSON.parse(rpc[0].body ?? '{}'), { p_version: CANDIDATE });
    assert.equal(stub.calls.filter((call) => call.method === 'PATCH').length, 0);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('respeta el enfriamiento de 30 días sin promover', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) return Response.json(pairedRows(60));
    if (call.url.includes('status=eq.promoted')) {
      return Response.json([engineRow(PROMOTED, '2026-10-28T00:00:00Z')]);
    }
    if (call.url.includes('status=eq.shadow')) return Response.json([engineRow(CANDIDATE, null)]);
    if (call.url.includes('select=version,status')) {
      return Response.json([
        { version: PROMOTED, status: 'promoted', created_at: '2026-01-01T00:00:00Z', promoted_at: '2026-10-28T00:00:00Z', retired_at: null },
      ]);
    }
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();

    assert.deepEqual(await runLearning(NOW), {
      state: 'ok',
      reason: 'promotion-cooldown',
      shadowMatches: 60,
    });
    assert.equal(stub.calls.filter((call) => call.url.includes('/rpc/')).length, 0);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('el brazo de control acumula hasta la compuerta y no se promociona', async () => {
  setEnv(ENABLED_ENV);
  const control = 'engine-1.3.0-shadow-noanchor';
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) {
      return Response.json(scoredRows(60, { variant: 'shadow', version: control, brier: 0.5 }));
    }
    if (call.url.includes('status=eq.promoted')) return Response.json([engineRow(PROMOTED, null)]);
    if (call.url.includes('status=eq.shadow')) return Response.json([engineRow(control, null)]);
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();

    assert.deepEqual(await runLearning(NOW), {
      state: 'skipped',
      reason: 'control-accumulating',
      shadowMatches: 60,
    });
    assert.equal(stub.calls.filter((call) => call.method !== 'GET').length, 0);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('sin la compuerta de 100 partidos no ajusta nada', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) {
      return Response.json(scoredRows(3, { variant: 'production', version: PROMOTED, brier: 0.5 }));
    }
    if (call.url.includes('status=eq.promoted')) return Response.json([engineRow(PROMOTED, null)]);
    if (call.url.includes('status=eq.shadow')) return Response.json([]);
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();

    assert.deepEqual(await runLearning(NOW), {
      state: 'skipped',
      reason: 'insufficient-data',
      datasetMatches: 3,
    });
    assert.ok(!stub.calls.some((call) => call.url.includes('/rest/v1/matches')));
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('con 100 partidos recorre el ajuste walk-forward sin crear candidata si no mejora', async () => {
  setEnv(ENABLED_ENV);
  const matchIds = Array.from({ length: 100 }, (_, index) => `test:tune-${String(index).padStart(4, '0')}`);
  const matches = matchIds.map((matchId, index) => ({
    match_id: matchId,
    kickoff_at: canonicalPayload(index).kickoff_at,
    home_score: index % 3,
    away_score: index % 2,
  }));
  const snapshots = matchIds.map((matchId, index) => ({
    match_id: matchId,
    captured_at: new Date(Date.parse('2026-07-31T12:00:00Z') + index * 86_400_000).toISOString(),
    payload: canonicalPayload(index),
  }));
  const productionRows = matchIds.map((matchId, index) => ({
    match_id: matchId,
    pre_snapshot_id: `snap-${index}`,
    variant: 'production',
    params_version: PROMOTED,
    brier: 0.5,
    log_loss: 0.7,
    pre_captured_at: snapshots[index].captured_at,
  }));

  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) return Response.json(productionRows);
    if (call.url.includes('/rest/v1/match_snapshots')) return Response.json(snapshots);
    if (call.url.includes('/rest/v1/matches')) return Response.json(matches);
    if (call.url.includes('status=eq.promoted')) return Response.json([engineRow(PROMOTED, null)]);
    if (call.url.includes('status=eq.shadow')) return Response.json([]);
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();

    // Sin cuotas el ancla no aplica: las cinco escalas empatan y el desempate
    // elige 1,0, que no supera el margen exigido frente a la línea base.
    assert.deepEqual(await runLearning(NOW), {
      state: 'ok',
      reason: 'candidate-not-better',
      datasetMatches: 100,
      candidate: null,
    });
    assert.equal(stub.calls.filter((call) => call.method === 'POST').length, 0);
  } finally {
    stub.restore();
    clearEnv();
  }
});
