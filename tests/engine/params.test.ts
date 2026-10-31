import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeMatch } from '../../src/lib/engine/analyze.ts';
import { DEFAULT_ENGINE_PARAMS } from '../../src/lib/engine/params.ts';
import type { AggregatedResponse } from '../../src/lib/types/api.ts';

function loadFixture(name: string): AggregatedResponse {
  const path = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as AggregatedResponse;
}

function withoutTimestamp(analysis: ReturnType<typeof analyzeMatch>): ReturnType<typeof analyzeMatch> {
  return { ...analysis, model: { ...analysis.model, generatedAt: '' } };
}

/**
 * Guarda contra deriva accidental: estos son los valores del motor 1.2.0.
 * Cambiar cualquier knob debe ser deliberado y acompañarse de una subida de
 * MODEL_VERSION y de una nueva corrida del arnés.
 */
test('DEFAULT_ENGINE_PARAMS fija los valores del motor 1.2.0', () => {
  assert.deepEqual(DEFAULT_ENGINE_PARAMS, {
    lambda: {
      strengthShrink: 0.15,
      strengthShrinkMax: 0.5,
      shortSampleMatches: 5,
      shortSampleExtra: 0.2,
      xgWeight: 0.62,
      goalsWeight: 0.38,
      formAttackCoef: 0.15,
      formAttackMin: 0.85,
      formAttackMax: 1.15,
      formDefenseCoef: 0.1,
      formDefenseMin: 0.9,
      formDefenseMax: 1.1,
      externalBlendWeight: 0.35,
      ppgBand: 0.15,
      minLambda: 0.15,
      maxLambda: 4.5,
      minTotal: 0.8,
      maxTotal: 7,
      htShare: 0.44,
    },
    quality: {
      statObservedConfidence: 1,
      statProjectedConfidence: 0.65,
      statDerivedFactor: 0.85,
      confidenceCoverageWeight: 0.45,
      sampleWeight: 0.25,
      predictionWeight: 0.15,
      oddsWeight: 0.1,
      formWeight: 0.05,
      sampleSaturation: 10,
      sampleMissingScore: 0.25,
    },
    adjustments: {
      lineupRatingBaseline: 6.6,
      lineupPenaltyMax: 0.06,
      lineupDefenseScale: 0.8,
      sigmaBoostNoLineup: 0.01,
      sigmaBoostUnconfirmed: 0.02,
      restShortDays: 3,
      restMediumDays: 4,
      restShortAttack: 0.97,
      restShortDefense: 1.02,
      restMediumAttack: 0.985,
      restMediumDefense: 1.01,
      leaguePpg: 1.35,
      opponentStrengthMin: -0.5,
      opponentStrengthMax: 0.5,
      opponentStrengthThreshold: 0.05,
      opponentAttackCoef: 0.06,
      opponentDefenseCoef: 0.05,
      weatherRainPct: 60,
      weatherWindKmh: 25,
      weatherRainFactor: 0.97,
      weatherTempHigh: 32,
      weatherTempLow: 0,
      weatherTempFactor: 0.98,
      h2hSampleMax: 5,
      h2hMinMatches: 3,
      h2hCoef: 0.1,
      h2hMinFactor: 0.94,
      h2hMaxFactor: 1.06,
      h2hLambdaFloor: 0.5,
      multiplierMin: 0.85,
      multiplierMax: 1.15,
      totalMin: 0.9,
      totalMax: 1.1,
      sigmaBoostMax: 0.08,
    },
    anchor: {
      gapThreshold: 0.3,
      gapRange: 0.7,
      gapWeight: 0.18,
      scaleMin: 0.6,
      scaleMax: 1.15,
      finalWeightMin: 0.25,
      finalWeightMax: 0.85,
      supremacyTotalMin: 0.4,
      supremacyTotalMax: 8,
      supremacyHomeMin: 0.01,
      supremacyHomeMax: 0.98,
      supremacyShareMin: 0.12,
      supremacyShareMax: 0.88,
      overMin: 0.001,
      overMax: 0.999,
      impliedTotalMax: 8,
      weight: {
        moneylineTotals: { base: 0.58, quality: 0.2, agreement: 0.1, gapScale: 1, min: 0.5, max: 0.85 },
        moneylinePrediction: { base: 0.42, quality: 0.15, agreement: 0.08, gapScale: 0.7, min: 0.36, max: 0.62 },
        totals: { base: 0.45, quality: 0.15, agreement: 0, gapScale: 0.6, min: 0.4, max: 0.7 },
        prediction: { base: 0.3, quality: 0.12, agreement: 0, gapScale: 0.4, min: 0.25, max: 0.5 },
        moneyline: { base: 0.48, quality: 0.2, agreement: 0, gapScale: 0.5, min: 0.45, max: 0.7 },
      },
    },
    calibration: {
      thresholdBase: 0.74,
      thresholdTotals: 0.72,
      thresholdHandicap: 0.66,
      thresholdCorners: 0.7,
      thresholdQualityCoef: 0.08,
      thresholdDisagreementCoef: 0.02,
      thresholdDisagreementGap: 0.35,
      thresholdMinOffset: -0.06,
      thresholdMaxOffset: 0.12,
      confidenceProbability: 0.7,
      confidenceQuality: 0.18,
      confidenceAgreement: 0.12,
    },
    uncertainty: {
      samples: 240,
      sampleMin: 40,
      sampleMax: 800,
      seed: 20261030,
      sigmaBase: 0.1,
      sigmaQuality: 0.2,
      sigmaMin: 0.08,
      sigmaMax: 0.4,
      lambdaMin: 0.1,
      lambdaMax: 5,
    },
    movement: {
      driftCoef: 0.12,
      driftCap: 0.1,
      providerBoost: 0.05,
      providerMin: 3,
      min: 0.95,
      max: 1.12,
    },
    parlay: {
      minLeg: 0.66,
      maxLeg: 0.93,
      minJoint: 0.45,
      maxLegs: 3,
    },
  });
});

test('analyzeMatch sin params y con DEFAULT_ENGINE_PARAMS explícito es idéntico', () => {
  const response = loadFixture('derby.json');
  const implicit = analyzeMatch(response);
  const explicit = analyzeMatch(response, { params: DEFAULT_ENGINE_PARAMS });
  assert.deepEqual(withoutTimestamp(explicit), withoutTimestamp(implicit));
});
