/**
 * Parámetros aprendibles del motor. Los valores de `DEFAULT_ENGINE_PARAMS` son
 * los del modelo 1.2.0: cambiarlos a mano mueve la salida de producción, así que
 * cualquier variante debe construirse con un objeto propio (motor sombra).
 *
 * Las funciones del motor aceptan `params` como último argumento opcional y
 * usan este objeto por defecto; así los llamadores existentes no cambian.
 */

/** Correlación Dixon-Coles. Estructural: no forma parte del ajuste. */
export const RHO = -0.1;
/** Truncado de la matriz de marcadores. Estructural: no forma parte del ajuste. */
export const MAX_GOALS = 12;

export interface AnchorWeightParams {
  /** Peso base del ancla para esta fuente. */
  base: number;
  /** Refuerzo cuando los datos propios son débiles (1 − calidad). */
  quality: number;
  /** Refuerzo cuando el modelo se aleja del mercado (1 − acuerdo). */
  agreement: number;
  /** Fracción del gapBoost que aplica esta fuente. */
  gapScale: number;
  min: number;
  max: number;
}

export type AnchorWeightKey =
  | 'moneylineTotals'
  | 'moneylinePrediction'
  | 'totals'
  | 'prediction'
  | 'moneyline';

export interface EngineParams {
  /** Construcción de λ: fuerzas, forma, mezcla externa y límites. */
  lambda: {
    /** Peso con el que cada fuerza se acerca a 1 (media de liga). */
    strengthShrink: number;
    /** Tope del shrink acumulado (fuerza + muestra corta). */
    strengthShrinkMax: number;
    /** Muestra por debajo de la cual se añade shrink extra. */
    shortSampleMatches: number;
    /** Shrink extra máximo por muestra corta. */
    shortSampleExtra: number;
    /** Peso de xG/xGA en la mezcla con goles. */
    xgWeight: number;
    /** Peso de goles en la mezcla con xG/xGA. */
    goalsWeight: number;
    /** Coeficiente y clamps del ajuste por forma (ataque propio). */
    formAttackCoef: number;
    formAttackMin: number;
    formAttackMax: number;
    /** Coeficiente y clamps del ajuste por forma (goles concedidos). */
    formDefenseCoef: number;
    formDefenseMin: number;
    formDefenseMax: number;
    /** Peso de la predicción externa en la mezcla de λ (el resto es el modelo). */
    externalBlendWeight: number;
    /** Banda de puntos por partido para elegir split vs. rivales fuertes/débiles. */
    ppgBand: number;
    minLambda: number;
    maxLambda: number;
    /** Límites del total proyectado antes de redondear. */
    minTotal: number;
    maxTotal: number;
    /** Fracción de goles que se modela en la primera parte (HT/FT). */
    htShare: number;
  };
  /** Calidad de datos y confianza de cada estadística. */
  quality: {
    statObservedConfidence: number;
    statProjectedConfidence: number;
    /** Factor aplicado a estadísticas derivadas. */
    statDerivedFactor: number;
    /** Pesos del score de calidad (suman 1). */
    confidenceCoverageWeight: number;
    sampleWeight: number;
    predictionWeight: number;
    oddsWeight: number;
    formWeight: number;
    /** Partidos a los que satura la muestra; score si no se declara. */
    sampleSaturation: number;
    sampleMissingScore: number;
  };
  /** Ajustes contextuales acotados sobre λ. */
  adjustments: {
    lineupRatingBaseline: number;
    lineupPenaltyMax: number;
    /** Cuánto del castigo ofensivo se traslada a la defensa. */
    lineupDefenseScale: number;
    sigmaBoostNoLineup: number;
    sigmaBoostUnconfirmed: number;
    restShortDays: number;
    restMediumDays: number;
    restShortAttack: number;
    restShortDefense: number;
    restMediumAttack: number;
    restMediumDefense: number;
    leaguePpg: number;
    opponentStrengthMin: number;
    opponentStrengthMax: number;
    opponentStrengthThreshold: number;
    opponentAttackCoef: number;
    opponentDefenseCoef: number;
    weatherRainPct: number;
    weatherWindKmh: number;
    weatherRainFactor: number;
    weatherTempHigh: number;
    weatherTempLow: number;
    weatherTempFactor: number;
    h2hSampleMax: number;
    h2hMinMatches: number;
    h2hCoef: number;
    h2hMinFactor: number;
    h2hMaxFactor: number;
    h2hLambdaFloor: number;
    multiplierMin: number;
    multiplierMax: number;
    totalMin: number;
    totalMax: number;
    sigmaBoostMax: number;
  };
  /** Ancla de mercado: fórmulas de peso, gap y clamps del ajuste. */
  anchor: {
    /** Discrepancia de total a partir de la cual se refuerza el ancla. */
    gapThreshold: number;
    /** Rango de discrepancia que satura el refuerzo. */
    gapRange: number;
    /** Refuerzo máximo del peso por discrepancia de total. */
    gapWeight: number;
    /** Escala de `movementWeightScale` sobre el peso. */
    scaleMin: number;
    scaleMax: number;
    /** Clamps finales del peso del ancla. */
    finalWeightMin: number;
    finalWeightMax: number;
    /** Reparto de un total de mercado entre local y visitante. */
    supremacyTotalMin: number;
    supremacyTotalMax: number;
    supremacyHomeMin: number;
    supremacyHomeMax: number;
    supremacyShareMin: number;
    supremacyShareMax: number;
    /** Inversión del total implícito en la línea de totales. */
    overMin: number;
    overMax: number;
    impliedTotalMax: number;
    weight: Record<AnchorWeightKey, AnchorWeightParams>;
  };
  /** Umbrales de publicación y confianza por mercado. */
  calibration: {
    thresholdBase: number;
    thresholdTotals: number;
    thresholdHandicap: number;
    thresholdCorners: number;
    thresholdQualityCoef: number;
    thresholdDisagreementCoef: number;
    /** Desacuerdo mínimo con la línea de totales para sumar al umbral. */
    thresholdDisagreementGap: number;
    /** Offsets relativos al base: suelo y techo del umbral. */
    thresholdMinOffset: number;
    thresholdMaxOffset: number;
    confidenceProbability: number;
    confidenceQuality: number;
    confidenceAgreement: number;
  };
  /** Monte Carlo de incertidumbre. */
  uncertainty: {
    samples: number;
    sampleMin: number;
    sampleMax: number;
    seed: number;
    sigmaBase: number;
    /** Incremento de σ por pérdida de calidad (1 − q). */
    sigmaQuality: number;
    sigmaMin: number;
    sigmaMax: number;
    /** Clamps de λ en cada muestra perturbada. */
    lambdaMin: number;
    lambdaMax: number;
  };
  /** Escala del peso del ancla según movimiento y proveedores. */
  movement: {
    driftCoef: number;
    driftCap: number;
    providerBoost: number;
    providerMin: number;
    min: number;
    max: number;
  };
  /** Filtros de la combinada. */
  parlay: {
    minLeg: number;
    maxLeg: number;
    minJoint: number;
    maxLegs: number;
  };
}

/** Valores de producción del motor 1.2.0. No editar sin subir MODEL_VERSION. */
export const DEFAULT_ENGINE_PARAMS: EngineParams = {
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
};
