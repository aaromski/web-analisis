import {
  DEFAULT_ENGINE_PARAMS,
  type AnchorWeightKey,
  type EngineParams,
} from './params';

/**
 * Variante sombra v1: el motor sin ancla de mercado.
 *
 * Es el brazo de control del ciclo de aprendizaje: la producción ancla λ al
 * total y la supremacía implícitos en las cuotas, y la sombra deja que el
 * modelo puro compita contra ella con resultados reales. No es una candidata a
 * promoción; cuando la muestra exista, una versión ajustada puede sustituirla
 * en `engine_params` (status `shadow`) sin cambiar código.
 */
export const SHADOW_PARAMS_VERSION = 'engine-1.3.0-shadow-noanchor';

const ZERO_WEIGHT = {
  base: 0,
  quality: 0,
  agreement: 0,
  gapScale: 0,
  min: 0,
  max: 0,
} as const;

const WEIGHT_KEYS: AnchorWeightKey[] = [
  'moneylineTotals',
  'moneylinePrediction',
  'totals',
  'prediction',
  'moneyline',
];

function zeroAnchorWeights(): Record<AnchorWeightKey, typeof ZERO_WEIGHT> {
  const weights = {} as Record<AnchorWeightKey, typeof ZERO_WEIGHT>;
  for (const key of WEIGHT_KEYS) weights[key] = { ...ZERO_WEIGHT };
  return weights;
}

/**
 * Overrides tal como se guardan en `engine_params.params`. La migración
 * `20261031120500_learning_loop_shadow_params.sql` debe contener este mismo
 * JSON; `tests/engine/shadow.test.ts` lo comprueba.
 */
export const SHADOW_SEED_OVERRIDES = {
  anchor: {
    // Sin esto, `weightScale` devuelve el peso al mínimo de 0,25.
    finalWeightMin: 0,
    finalWeightMax: 0,
    weight: zeroAnchorWeights(),
  },
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Mezcla solo números finitos sobre los defaults, recursivamente. Claves
 * desconocidas o valores no numéricos se ignoran: un `params` corrupto en la
 * base nunca puede introducir strings ni `NaN` en el motor.
 */
export function resolveShadowParams(overrides: unknown): EngineParams {
  return mergeNumbers(DEFAULT_ENGINE_PARAMS, overrides);
}

function mergeNumbers<T>(base: T, overrides: unknown): T {
  if (!isPlainObject(overrides)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides)) {
    const current = out[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = mergeNumbers(current, value);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out as T;
}

/** Defaults de 1.2.0 con el ancla neutralizada (peso exactamente 0). */
export const SHADOW_ENGINE_PARAMS: EngineParams = resolveShadowParams(SHADOW_SEED_OVERRIDES);
