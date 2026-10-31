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
const CANDIDATE_B = 'auto-anchor-s100-20261020';
const REFERENCE = 'baseline-1.2.0-defaults';
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
  options: {
    variant: 'shadow' | 'production';
    version: string;
    brier: number;
    extras?: Record<string, unknown>;
  },
  startDays = 20,
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => {
    const captured = new Date(Date.parse('2026-09-01T00:00:00Z') + (startDays + index) * 86_400_000);
    return {
      match_id: `test:${options.variant}-${String(index).padStart(4, '0')}`,
      league_id: 'test.1',
      pre_snapshot_id: `snap-${options.variant}-${String(index).padStart(4, '0')}`,
      variant: options.variant,
      params_version: options.version,
      brier: options.brier,
      log_loss: 0.6,
      pre_captured_at: captured.toISOString(),
      // Totales pareados por defecto: el objetivo compuesto y su cobertura.
      home_score: 2,
      away_score: 1,
      totals_line: 2.5,
      totals_side: 'over',
      totals_probability: 0.55,
      ...options.extras,
    };
  });
}

function pairedRows(
  count: number,
  shadowVersion = CANDIDATE,
  shadowBrier = 0.4,
  productionBrier = 0.45,
  extras: { shadow?: Record<string, unknown>; production?: Record<string, unknown> } = {},
): Array<Record<string, unknown>> {
  const shadow = scoredRows(count, {
    variant: 'shadow',
    version: shadowVersion,
    brier: shadowBrier,
    extras: extras.shadow,
  });
  const production = scoredRows(count, {
    variant: 'production',
    version: PROMOTED,
    brier: productionBrier,
    extras: extras.production,
  });
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

/** Pares con diferencias heterogéneas por partido (para guardarraíles). */
function customPairs(
  rows: Array<{
    shadowBrier: number;
    productionBrier: number;
    shadowExtras?: Record<string, unknown>;
    productionExtras?: Record<string, unknown>;
  }>,
): Array<Record<string, unknown>> {
  const production: Array<Record<string, unknown>> = [];
  const shadow: Array<Record<string, unknown>> = [];
  rows.forEach((row, index) => {
    const matchId = `test:custom-${String(index).padStart(4, '0')}`;
    const snapshotId = `snap-custom-${String(index).padStart(4, '0')}`;
    production.push({
      match_id: matchId,
      league_id: 'test.1',
      pre_snapshot_id: snapshotId,
      variant: 'production',
      params_version: PROMOTED,
      brier: row.productionBrier,
      log_loss: 0.6,
      pre_captured_at: new Date(Date.parse('2026-09-01T00:00:00Z') + index * 86_400_000).toISOString(),
      home_score: 2,
      away_score: 1,
      totals_line: 2.5,
      totals_side: 'over',
      totals_probability: 0.55,
      ...row.productionExtras,
    });
    shadow.push({
      match_id: matchId,
      league_id: 'test.1',
      pre_snapshot_id: snapshotId,
      variant: 'shadow',
      params_version: CANDIDATE,
      brier: row.shadowBrier,
      log_loss: 0.6,
      pre_captured_at: new Date(Date.parse('2026-09-01T00:00:00Z') + index * 86_400_000).toISOString(),
      home_score: 2,
      away_score: 1,
      totals_line: 2.5,
      totals_side: 'over',
      totals_probability: 0.55,
      ...row.shadowExtras,
    });
  });
  return production.concat(shadow);
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

test('walkForwardWindows produce folds expansivos con validación disjunta', async () => {
  const { walkForwardWindows } = await learning();
  const windows = walkForwardWindows(100);
  assert.deepEqual(
    windows.map((window) => [window.trainMatches, window.validationStart, window.validationEnd]),
    [
      [40, 40, 60],
      [60, 60, 80],
      [80, 80, 100],
    ],
  );
  // Con 60 partidos no hay dos folds válidos: se pospone el ajuste.
  assert.deepEqual(walkForwardWindows(60), []);
  const many = walkForwardWindows(200);
  assert.equal(many.length, 3);
  assert.ok(many.every((window, index) => index === 0 || window.validationStart >= many[index - 1].validationEnd));
});

test('evaluateDrift detecta degradación sostenida frente a la referencia', async () => {
  const { evaluateDrift } = await learning();
  assert.equal(evaluateDrift(Array.from({ length: 49 }, () => 0.05)).promote, false);
  const decision = evaluateDrift(Array.from({ length: 50 }, () => 0.05));
  assert.equal(decision.promote, true);
  assert.equal(decision.matches, 50);
  assert.equal(evaluateDrift(Array.from({ length: 50 }, () => 0.001)).promote, false);
});

test('evaluateGuardrail solo bloquea con muestra y degradación material', async () => {
  const { evaluateGuardrail } = await learning();
  assert.equal(evaluateGuardrail(Array.from({ length: 9 }, () => 0.2)).ok, true);
  assert.equal(evaluateGuardrail(Array.from({ length: 10 }, () => 0.001)).ok, true);
  assert.equal(evaluateGuardrail(Array.from({ length: 10 }, () => 0.05)).ok, false);
  assert.equal(evaluateGuardrail(Array.from({ length: 10 }, () => -0.05)).ok, true);
});

test('totalsBrier puntúa la línea publicada y descarta push o datos incompletos', async () => {
  const { totalsBrier } = await learning();
  const row = (overrides: Record<string, unknown>) =>
    ({
      totalsLine: 2.5,
      totalsSide: 'over',
      totalsProbability: 0.6,
      homeScore: 2,
      awayScore: 1,
      ...overrides,
    }) as never;
  assert.ok(Math.abs((totalsBrier(row({})) ?? -1) - 0.16) < 1e-12);
  assert.ok(Math.abs((totalsBrier(row({ totalsSide: 'under' })) ?? -1) - 0.36) < 1e-12);
  assert.equal(totalsBrier(row({ totalsLine: 3 })), null);
  assert.equal(totalsBrier(row({ totalsSide: null })), null);
  assert.equal(totalsBrier(row({ homeScore: null })), null);
});

test('recencyWeight reduce el peso a la mitad por cada vida media', async () => {
  const { recencyWeight, RECENCY_HALF_LIFE_DAYS } = await learning();
  const day = 86_400_000;
  const anchor = Date.parse('2026-10-31T00:00:00Z');
  assert.equal(recencyWeight(anchor, anchor), 1);
  assert.ok(Math.abs(recencyWeight(anchor - RECENCY_HALF_LIFE_DAYS * day, anchor) - 0.5) < 1e-12);
  assert.ok(Math.abs(recencyWeight(anchor - 2 * RECENCY_HALF_LIFE_DAYS * day, anchor) - 0.25) < 1e-12);
  // Un kickoff futuro no supera el peso máximo.
  assert.equal(recencyWeight(anchor + 5 * day, anchor), 1);
});

test('totalsCoverage mide los pares con lectura de totales en ambos lados', async () => {
  const { totalsCoverage } = await learning();
  const mapped = (rows: Array<Record<string, any>>) =>
    rows.map((row) => ({
      matchId: row.match_id,
      leagueId: row.league_id,
      snapshotId: row.pre_snapshot_id,
      variant: row.variant,
      paramsVersion: row.params_version,
      brier: row.brier,
      logLoss: row.log_loss,
      preCapturedAt: row.pre_captured_at,
      probHome: null,
      probDraw: null,
      probAway: null,
      lambdaHome: null,
      lambdaAway: null,
      preAnchorLambdaHome: null,
      preAnchorLambdaAway: null,
      totalsLine: row.totals_line,
      totalsSide: row.totals_side,
      totalsProbability: row.totals_probability,
      marketTotalLine: null,
      marketWin: null,
      marketSpread: null,
      homeScore: row.home_score,
      awayScore: row.away_score,
      anchorWeight: null,
    }));
  assert.equal(totalsCoverage(mapped(pairedRows(10)), CANDIDATE, PROMOTED), 1);
  const withoutTotals = mapped(
    pairedRows(10, CANDIDATE, 0.4, 0.45, {
      shadow: { totals_line: null },
      production: { totals_line: null },
    }),
  );
  assert.equal(totalsCoverage(withoutTotals, CANDIDATE, PROMOTED), 0);
});

test('sin cobertura de totales la candidata no se promociona', async () => {
  setEnv(ENABLED_ENV);
  const rows = pairedRows(60, CANDIDATE, 0.3, 0.45, {
    shadow: { totals_line: null },
    production: { totals_line: null },
  });
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) return Response.json(rows);
    if (call.url.includes('status=eq.promoted')) {
      return Response.json([engineRow(PROMOTED, '2026-09-01T00:00:00Z')]);
    }
    if (call.url.includes('status.eq.shadow')) {
      return Response.json([engineRow(CANDIDATE, null)]);
    }
    if (call.url.includes('select=version,status')) return Response.json([]);
    if (call.method === 'POST' && call.url.includes('/rest/v1/ingestion_events')) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();
    assert.deepEqual(await runLearning(NOW), {
      state: 'skipped',
      reason: 'low-coverage',
      shadowMatches: 60,
      coverage: 0,
    });
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('evaluateLeagueGuard bloquea una liga perdedora con muestra suficiente', async () => {
  const { evaluateLeagueGuard } = await learning();
  const decision = evaluateLeagueGuard(
    new Map<string, number[]>([
      ['test.A', Array.from({ length: 12 }, () => -0.02)],
      ['test.B', Array.from({ length: 10 }, () => 0.03)],
      ['test.C', Array.from({ length: 5 }, () => 0.5)],
    ]),
  );
  assert.equal(decision.ok, false);
  assert.deepEqual(decision.segments.map((segment) => segment.leagueId), ['test.A', 'test.B', 'test.C']);
  const small = evaluateLeagueGuard(new Map([['test.A', Array.from({ length: 5 }, () => 0.5)]]));
  assert.equal(small.ok, true);
});

test('una liga perdedora bloquea la promoción aunque la media global mejore', async () => {
  setEnv(ENABLED_ENV);
  // 50 partidos de la liga A mejoran; 10 de la B empeoran lo suficiente.
  const rows = pairedRows(60, CANDIDATE, 0.25, 0.45).map((row) => {
    const index = Number(String(row.match_id).slice(-4));
    const leagueId = index < 50 ? 'test.A' : 'test.B';
    if (row.variant === 'shadow') {
      return { ...row, league_id: leagueId, brier: index < 50 ? 0.25 : 0.53 };
    }
    return { ...row, league_id: leagueId };
  });
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) return Response.json(rows);
    if (call.url.includes('status=eq.promoted')) {
      return Response.json([engineRow(PROMOTED, '2026-09-01T00:00:00Z')]);
    }
    if (call.url.includes('status.eq.shadow')) {
      return Response.json([engineRow(CANDIDATE, null)]);
    }
    if (call.url.includes('select=version,status')) return Response.json([]);
    if (call.method === 'POST' && call.url.includes('/rest/v1/ingestion_events')) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();
    assert.deepEqual(await runLearning(NOW), {
      state: 'ok',
      reason: 'candidate-kept',
      shadowMatches: 60,
      guard: 'league',
    });
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('compositeBrier mezcla 1X2 normalizado y totales al 50 %', async () => {
  const { compositeBrier } = await learning();
  const row = (overrides: Record<string, unknown>) =>
    ({
      brier: 0.4,
      totalsLine: 2.5,
      totalsSide: 'over',
      totalsProbability: 0.6,
      homeScore: 2,
      awayScore: 1,
      ...overrides,
    }) as never;
  // 0,5 × (0,4 / 2) + 0,5 × 0,16 = 0,18.
  assert.ok(Math.abs(compositeBrier(row({})) - 0.18) < 1e-12);
  // Sin totales se puntúa solo el 1X2 normalizado.
  assert.ok(Math.abs(compositeBrier(row({ totalsLine: null })) - 0.2) < 1e-12);
});

test('exactScoreBrier castiga el marcador real y usa una categoría "otro"', async () => {
  const { exactScoreBrier } = await learning();
  const scores = [
    { home: 1, away: 0, probability: 0.15 },
    { home: 1, away: 1, probability: 0.12 },
  ];
  // Acierta el marcador: (0,15−1)² + 0,12² + resto² = 1,2698.
  assert.ok(Math.abs((exactScoreBrier(scores, 1, 0) ?? -1) - 1.2698) < 1e-12);
  // El marcador real cae en "otro": 0,15² + 0,12² + (0,73−1)² = 0,1098.
  assert.ok(Math.abs((exactScoreBrier(scores, 0, 0) ?? -1) - 0.1098) < 1e-12);
  assert.equal(exactScoreBrier([], 0, 0), null);
  // Una lista con duplicados no cuenta dos veces la misma categoría.
  assert.ok(
    Math.abs(
      (exactScoreBrier([...scores, { home: 1, away: 0, probability: 0.15 }], 1, 0) ?? -1) - 1.2698,
    ) < 1e-12,
  );
});

test('evaluateSequential promueve con evidencia de signo consistente antes de 50 pares', async () => {
  const { evaluateSequential } = await learning();
  // 24 triunfos aún no alcanzan el mínimo de muestra.
  assert.equal(evaluateSequential(Array.from({ length: 24 }, () => -0.02)).promote, false);
  const strong = evaluateSequential(Array.from({ length: 25 }, () => -0.02));
  assert.equal(strong.promote, true);
  assert.equal(strong.matches, 25);
  assert.equal(strong.wins, 25);
  assert.ok(strong.logLikelihood > 0);
  // Con 2 candidatas α se divide: el mismo caso sigue pasando de sobra.
  assert.equal(
    evaluateSequential(Array.from({ length: 25 }, () => -0.02), { alpha: 0.025 }).promote,
    true,
  );
  // Sin señal clara no hay promoción.
  const noisy = [
    ...Array.from({ length: 16 }, () => -0.02),
    ...Array.from({ length: 14 }, () => 0.02),
  ];
  assert.equal(evaluateSequential(noisy).promote, false);
  // La media debe superar el margen aunque el signo sea perfecto.
  assert.equal(evaluateSequential(Array.from({ length: 30 }, () => -0.001)).promote, false);
  // Los empates no votan y tampoco sirven para alcanzar el mínimo.
  assert.equal(evaluateSequential(Array.from({ length: 40 }, () => 0)).promote, false);
});

test('lowAnchorDiffs solo mide partidos donde producción apenas se ancla', async () => {
  const { lowAnchorDiffs } = await learning();
  const row = (overrides: Record<string, unknown>) =>
    ({
      matchId: 'm1',
      snapshotId: 's1',
      variant: 'production',
      paramsVersion: PROMOTED,
      brier: 0.4,
      logLoss: 0.6,
      preCapturedAt: '2026-09-20T00:00:00Z',
      totalsLine: null,
      totalsSide: null,
      totalsProbability: null,
      homeScore: 1,
      awayScore: 0,
      anchorWeight: 0.3,
      ...overrides,
    }) as never;
  const rows = [
    row({}),
    row({ variant: 'shadow', paramsVersion: CANDIDATE, brier: 0.32 }),
    // Este par está muy anclado: queda fuera del segmento.
    row({ matchId: 'm2', snapshotId: 's2', anchorWeight: 0.7, brier: 0.4 }),
    row({ matchId: 'm2', snapshotId: 's2', variant: 'shadow', paramsVersion: CANDIDATE, brier: 0.2, anchorWeight: 0.7 }),
  ];
  const diffs = lowAnchorDiffs(rows, CANDIDATE, PROMOTED);
  assert.equal(diffs.length, 1);
  // (0,32 − 0,4) / 2 = −0,04.
  assert.ok(Math.abs(diffs[0] + 0.04) < 1e-12);
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
    assert.deepEqual(listed, { promoted: null, shadows: [] });

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

test('listScoredPredictions pagina la vista y lee el peso del ancla', async () => {
  setEnv(ENABLED_ENV);
  const makeRow = (index: number) => ({
    match_id: `test:page-${index}`,
    pre_snapshot_id: `snap-page-${index}`,
    variant: 'production',
    params_version: 'v1',
    brier: 0.4,
    log_loss: 0.6,
    anchor_weight: index === 0 ? 0.55 : null,
  });
  const firstPage = Array.from({ length: 1000 }, (_, index) => makeRow(index));
  const stub = stubFetch((call) => {
    const offset = new URL(call.url).searchParams.get('offset');
    if (offset === '0') return Response.json(firstPage);
    if (offset === '1000') return Response.json([makeRow(1000)]);
    throw new Error(`offset inesperado: ${offset}`);
  });

  try {
    const { clearParamsCache, listScoredPredictions } = await db();
    clearParamsCache();

    const rows = await listScoredPredictions(['v1']);
    assert.equal(rows?.length, 1001);
    assert.equal(rows?.[0].anchorWeight, 0.55);
    assert.equal(rows?.[1].anchorWeight, null);
    assert.equal(stub.calls.length, 2);
    assert.ok(stub.calls[1].url.includes('offset=1000'));
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
    if (call.url.includes('status.eq.shadow')) {
      return Response.json([engineRow(CANDIDATE, null), engineRow(REFERENCE, null)]);
    }
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
    if (call.url.includes('status.eq.shadow')) {
      return Response.json([engineRow(CANDIDATE, null), engineRow(REFERENCE, null)]);
    }
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

test('promueve con 30 pares si la evidencia secuencial es consistente', async () => {
  setEnv(ENABLED_ENV);
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) return Response.json(pairedRows(30));
    if (call.url.includes('status=eq.promoted')) {
      return Response.json([engineRow(PROMOTED, '2026-09-01T00:00:00Z')]);
    }
    if (call.url.includes('status.eq.shadow')) {
      return Response.json([engineRow(CANDIDATE, null), engineRow(REFERENCE, null)]);
    }
    if (call.url.includes('select=version,status')) return Response.json([]);
    if (call.url.includes('/rpc/set_promoted_params')) {
      return Response.json([{ promoted_version: CANDIDATE, retired_version: PROMOTED }]);
    }
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();

    // El bootstrap fijo exige 50 pares; el SPRT promueve a los 30 con 30/30.
    assert.deepEqual(await runLearning(NOW), {
      state: 'ok',
      reason: 'promoted',
      shadowMatches: 30,
      promotion: { version: CANDIDATE, retired: PROMOTED },
    });
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('no promueve si el 1X2 empeora aunque el compuesto mejore por totales', async () => {
  setEnv(ENABLED_ENV);
  const shared = { home_score: 2, away_score: 1, totals_line: 2.5, totals_side: 'over' };
  const extras = {
    production: { ...shared, totals_probability: 0.55 },
    shadow: { ...shared, totals_probability: 0.95 },
  };
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) {
      // La sombra gana el total (Brier 0,0025 vs 0,2025) pero pierde el 1X2.
      return Response.json(pairedRows(60, CANDIDATE, 0.5, 0.45, extras));
    }
    if (call.url.includes('status=eq.promoted')) {
      return Response.json([engineRow(PROMOTED, '2026-09-01T00:00:00Z')]);
    }
    if (call.url.includes('status.eq.shadow')) {
      return Response.json([engineRow(CANDIDATE, null), engineRow(REFERENCE, null)]);
    }
    if (call.url.includes('select=version,status')) return Response.json([]);
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();

    assert.deepEqual(await runLearning(NOW), {
      state: 'ok',
      reason: 'candidate-kept',
      shadowMatches: 60,
      guard: 'result',
    });
    assert.equal(stub.calls.filter((call) => call.url.includes('/rpc/')).length, 0);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('no promueve si el segmento de ancla baja se degrada', async () => {
  setEnv(ENABLED_ENV);
  const rows = [
    ...Array.from({ length: 20 }, () => ({
      shadowBrier: 0.5,
      productionBrier: 0.4,
      productionExtras: { anchor_weight: 0.3 },
      shadowExtras: { anchor_weight: 0.3 },
    })),
    ...Array.from({ length: 40 }, () => ({
      shadowBrier: 0.3,
      productionBrier: 0.5,
      productionExtras: { anchor_weight: 0.7 },
      shadowExtras: { anchor_weight: 0.7 },
    })),
  ];
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) return Response.json(customPairs(rows));
    if (call.url.includes('status=eq.promoted')) {
      return Response.json([engineRow(PROMOTED, '2026-09-01T00:00:00Z')]);
    }
    if (call.url.includes('status.eq.shadow')) {
      return Response.json([engineRow(CANDIDATE, null), engineRow(REFERENCE, null)]);
    }
    if (call.url.includes('select=version,status')) return Response.json([]);
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();

    // En conjunto gana (−0,05), pero en el 33 % menos anclado pierde (+0,05).
    assert.deepEqual(await runLearning(NOW), {
      state: 'ok',
      reason: 'candidate-kept',
      shadowMatches: 60,
      guard: 'model-led',
    });
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('un control heredado bajo la compuerta no bloquea el ajuste', async () => {
  setEnv(ENABLED_ENV);
  const control = 'engine-1.3.0-shadow-noanchor';
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) {
      return Response.json(scoredRows(60, { variant: 'shadow', version: control, brier: 0.5 }));
    }
    if (call.url.includes('status=eq.promoted')) return Response.json([engineRow(PROMOTED, null)]);
    if (call.url.includes('status.eq.shadow')) {
      return Response.json([engineRow(control, null), engineRow(REFERENCE, null)]);
    }
    if (call.method === 'POST' && call.url.includes('/rest/v1/ingestion_events')) {
      return new Response(null, { status: 204 });
    }
    if (call.method === 'PATCH' && call.url.includes('/rest/v1/engine_params')) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();

    // El control sigue sumando, pero el ciclo avanza hasta la compuerta real.
    assert.deepEqual(await runLearning(NOW), {
      state: 'skipped',
      reason: 'insufficient-data',
      datasetMatches: 0,
    });
    // Sin promoción ni retiro: la única escritura es el diario del ciclo.
    const writes = stub.calls.filter((call) => call.method !== 'GET');
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.includes('/rest/v1/ingestion_events'));
    const body = JSON.parse(String(writes[0].body ?? '{}')) as Record<string, unknown>;
    assert.equal(body.operation, 'backtest');
    assert.equal(body.request_id, 'learning');
    assert.equal(body.error_code, 'insufficient-data');
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('una candidata sin created_at caduca por su primera captura sombra', async () => {
  setEnv(ENABLED_ENV);
  // Capturas de hace 40 días: superan los 21 de retención aunque la fila no
  // tenga created_at (versiones antiguas creadas antes de guardar la fecha).
  const rows = scoredRows(10, { variant: 'shadow', version: CANDIDATE, brier: 0.45 });
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) return Response.json(rows);
    if (call.url.includes('status=eq.promoted')) return Response.json([engineRow(PROMOTED, null)]);
    if (call.url.includes('status.eq.shadow')) {
      return Response.json([
        { ...engineRow(CANDIDATE, null), created_at: null },
        engineRow(REFERENCE, null),
      ]);
    }
    if (call.method === 'PATCH' && call.url.includes('/rest/v1/engine_params')) {
      return new Response(null, { status: 204 });
    }
    if (call.method === 'POST' && call.url.includes('/rest/v1/ingestion_events')) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();

    assert.deepEqual(await runLearning(NOW), {
      state: 'skipped',
      reason: 'insufficient-data',
      datasetMatches: 0,
    });

    const patches = stub.calls.filter((call) => call.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.ok(patches[0].url.includes(`version=eq.${CANDIDATE}`));
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('una candidata reciente sin created_at sigue acumulando muestra', async () => {
  setEnv(ENABLED_ENV);
  // Primera captura hace 2 días (2026-09-01 + 58 días): aún no caduca.
  const rows = scoredRows(10, { variant: 'shadow', version: CANDIDATE, brier: 0.45 }, 58);
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) return Response.json(rows);
    if (call.url.includes('status=eq.promoted')) return Response.json([engineRow(PROMOTED, null)]);
    if (call.url.includes('status.eq.shadow')) {
      return Response.json([
        { ...engineRow(CANDIDATE, null), created_at: null },
        engineRow(REFERENCE, null),
      ]);
    }
    if (call.method === 'POST' && call.url.includes('/rest/v1/ingestion_events')) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();

    assert.deepEqual(await runLearning(NOW), {
      state: 'skipped',
      reason: 'candidate-accumulating',
      shadowMatches: 10,
    });
    assert.equal(stub.calls.filter((call) => call.method === 'PATCH').length, 0);
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
    if (call.url.includes('status.eq.shadow')) return Response.json([]);
    if (call.method === 'POST' && call.url.includes('on_conflict=version')) {
      return new Response(null, { status: 204 });
    }
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
    // La primera pasada siembra el control fijo con los defaults.
    const insert = stub.calls.find((call) => call.method === 'POST');
    assert.ok(insert);
    const body = JSON.parse(insert.body ?? '{}') as { version?: string; status?: string; params?: unknown };
    assert.equal(body.version, REFERENCE);
    assert.equal(body.status, 'shadow');
    assert.deepEqual(body.params, {});
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
    if (call.url.includes('status.eq.shadow')) return Response.json([]);
    if (call.method === 'POST' && call.url.includes('on_conflict=version')) {
      return new Response(null, { status: 204 });
    }
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
    assert.equal(
      stub.calls.filter((call) => call.method === 'POST' && (call.body ?? '').includes('auto-anchor-')).length,
      0,
    );
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('con dos candidatas promueve la mejor y retira la que pierde', async () => {
  setEnv(ENABLED_ENV);
  const rows = pairedRows(50, CANDIDATE, 0.4).concat(pairedRows(50, CANDIDATE_B, 0.44));
  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) return Response.json(rows);
    if (call.url.includes('status=eq.promoted')) {
      return Response.json([engineRow(PROMOTED, '2026-09-01T00:00:00Z')]);
    }
    if (call.url.includes('status.eq.shadow')) {
      return Response.json([
        engineRow(CANDIDATE, null),
        engineRow(CANDIDATE_B, null),
        engineRow(REFERENCE, null),
      ]);
    }
    if (call.url.includes('select=version,status')) return Response.json([]);
    if (call.url.includes('/rpc/set_promoted_params')) {
      return Response.json([{ promoted_version: CANDIDATE, retired_version: PROMOTED }]);
    }
    if (call.method === 'PATCH') return new Response(null, { status: 204 });
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();

    assert.deepEqual(await runLearning(NOW), {
      state: 'ok',
      reason: 'promoted',
      shadowMatches: 50,
      promotion: { version: CANDIDATE, retired: PROMOTED },
    });

    const patches = stub.calls.filter((call) => call.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.ok(patches[0].url.includes(`version=eq.${CANDIDATE_B}`));
  } finally {
    stub.restore();
    clearEnv();
  }
});

test('vuelve a los defaults cuando la producción deriva de la referencia', async () => {
  setEnv(ENABLED_ENV);
  const promoted = 'auto-anchor-s090-20261020';
  const production = scoredRows(50, { variant: 'production', version: promoted, brier: 0.5 });
  const reference = scoredRows(50, { variant: 'shadow', version: REFERENCE, brier: 0.42 });
  const pairs = reference.map((row, index) => ({
    ...row,
    pre_snapshot_id: production[index].pre_snapshot_id,
    match_id: production[index].match_id,
  }));

  const stub = stubFetch((call) => {
    if (call.url.includes('/rest/v1/v_match_backtest')) {
      return Response.json(production.concat(pairs));
    }
    if (call.url.includes('status=eq.promoted')) {
      return Response.json([engineRow(promoted, '2026-09-01T00:00:00Z')]);
    }
    if (call.url.includes('status.eq.shadow')) return Response.json([engineRow(REFERENCE, null)]);
    if (call.url.includes('select=version,status')) return Response.json([]);
    if (call.url.includes('/rpc/set_promoted_params')) {
      return Response.json([{ promoted_version: 'auto-rollback-20261031', retired_version: promoted }]);
    }
    if (call.method === 'POST' && call.url.includes('on_conflict=version')) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`llamada inesperada: ${call.method} ${call.url}`);
  });

  try {
    const { clearParamsCache } = await db();
    clearParamsCache();

    const summary = await runLearning(NOW);
    assert.equal(summary.state, 'ok');
    assert.equal(summary.reason, 'drifted');
    assert.equal(summary.shadowMatches, 50);
    assert.deepEqual(summary.rollback, {
      version: 'auto-rollback-20261031',
      retired: promoted,
    });
    assert.ok(summary.drift);
    assert.equal(summary.drift?.matches, 50);
    // Compuesto: medio peso del Brier 1X2, sin aporte de totales (iguales).
    assert.ok((summary.drift?.mean ?? 0) > 0.015);
    assert.equal(summary.drift?.probability, 1);
  } finally {
    stub.restore();
    clearEnv();
  }
});
