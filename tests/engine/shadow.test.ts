import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeMatch } from '../../src/lib/engine/analyze.ts';
import {
  SHADOW_ENGINE_PARAMS,
  SHADOW_PARAMS_VERSION,
  SHADOW_SEED_OVERRIDES,
  resolveShadowParams,
} from '../../src/lib/engine/shadow.ts';
import { DEFAULT_ENGINE_PARAMS } from '../../src/lib/engine/params.ts';
import type { AggregatedResponse } from '../../src/lib/types/api.ts';

function oddsFixture(): AggregatedResponse {
  return {
    match: {
      match_id: 'test:shadow-1',
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
        moneyline: {
          home: { american: null, decimal: 1.8, implied_probability: 0.55, no_vig_probability: 0.55 },
          draw: { american: null, decimal: 3.6, implied_probability: 0.28, no_vig_probability: 0.28 },
          away: { american: null, decimal: 4.4, implied_probability: 0.17, no_vig_probability: 0.17 },
        },
        totals: {
          line: 2.5,
          over: { american: null, decimal: 1.8, implied_probability: 0.55, no_vig_probability: 0.55 },
          under: { american: null, decimal: 2.05, implied_probability: 0.45, no_vig_probability: 0.45 },
        },
      },
      teams: {
        home: { name: 'Home Test', side: 'home' },
        away: { name: 'Away Test', side: 'away' },
      },
      h2h: null,
      meta: {
        sources: [{ source: 'alpha', dataset: 'odds', status: 'ok', duration_ms: 120 }],
        deadline_ms: 4000,
        coverage: { sections: { odds: true, lineups: false }, available: 1, total: 2 },
      },
    },
    meta: {
      canonical_version: '1.2.0',
      generated_at: '2026-10-31T09:00:02Z',
      cache: { hit: false, ttl_seconds: 60 },
    },
  };
}

test('la sombra neutraliza el ancla y deja el resto de parámetros como producción', () => {
  assert.equal(SHADOW_PARAMS_VERSION, 'engine-1.3.0-shadow-noanchor');
  for (const key of ['moneylineTotals', 'moneylinePrediction', 'totals', 'prediction', 'moneyline'] as const) {
    assert.deepEqual(SHADOW_ENGINE_PARAMS.anchor.weight[key], {
      base: 0,
      quality: 0,
      agreement: 0,
      gapScale: 0,
      min: 0,
      max: 0,
    });
  }
  assert.equal(SHADOW_ENGINE_PARAMS.anchor.finalWeightMin, 0);
  assert.equal(SHADOW_ENGINE_PARAMS.anchor.finalWeightMax, 0);
  assert.deepEqual(SHADOW_ENGINE_PARAMS.lambda, DEFAULT_ENGINE_PARAMS.lambda);
  assert.deepEqual(SHADOW_ENGINE_PARAMS.calibration, DEFAULT_ENGINE_PARAMS.calibration);
  assert.deepEqual(SHADOW_ENGINE_PARAMS.uncertainty, DEFAULT_ENGINE_PARAMS.uncertainty);
});

test('la fila sembrada en la migración coincide con los overrides del código', () => {
  const migration = readFileSync(
    join(
      process.cwd(),
      'supabase',
      'migrations',
      '20261031120500_learning_loop_shadow_params.sql',
    ),
    'utf8',
  );
  const match = migration.match(/'(\{.*\})'::jsonb/s);
  assert.ok(match, 'la migración debe declarar el JSON de overrides');
  assert.deepEqual(JSON.parse(match[1]), SHADOW_SEED_OVERRIDES);
});

test('resolveShadowParams ignora valores no numéricos y claves desconocidas', () => {
  const params = resolveShadowParams({
    anchor: { finalWeightMin: 0.4, finalWeightMax: 'alto' },
    lambda: { externalBlendWeight: 0, maxLambda: 'x' },
    unknown: { value: 1 },
  });
  assert.equal(params.anchor.finalWeightMin, 0.4);
  assert.equal(params.anchor.finalWeightMax, DEFAULT_ENGINE_PARAMS.anchor.finalWeightMax);
  assert.equal(params.lambda.externalBlendWeight, 0);
  assert.equal(params.lambda.maxLambda, DEFAULT_ENGINE_PARAMS.lambda.maxLambda);
  assert.equal((params as unknown as Record<string, unknown>).unknown, undefined);
  assert.deepEqual(resolveShadowParams(null), DEFAULT_ENGINE_PARAMS);
});

test('con cuotas la producción ancla y la sombra no', () => {
  const fixture = oddsFixture();
  const production = analyzeMatch(fixture);
  const shadow = analyzeMatch(fixture, { params: SHADOW_ENGINE_PARAMS });

  assert.ok(production.model.marketAnchor.weight > 0);
  assert.equal(shadow.model.marketAnchor.weight, 0);
  assert.notEqual(shadow.lambdas.home, production.lambdas.home);
  assert.notEqual(shadow.winProbabilities.home, production.winProbabilities.home);
  assert.equal(shadow.model.version, production.model.version);
});
