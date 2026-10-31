-- Variante sombra v1: motor sin ancla de mercado (brazo de control).
-- El JSON debe coincidir con `SHADOW_SEED_OVERRIDES` de src/lib/engine/shadow.ts.
insert into public.engine_params (version, status, params, notes)
values (
  'engine-1.3.0-shadow-noanchor',
  'shadow',
  '{"anchor":{"finalWeightMin":0,"finalWeightMax":0,"weight":{"moneylineTotals":{"base":0,"quality":0,"agreement":0,"gapScale":0,"min":0,"max":0},"moneylinePrediction":{"base":0,"quality":0,"agreement":0,"gapScale":0,"min":0,"max":0},"totals":{"base":0,"quality":0,"agreement":0,"gapScale":0,"min":0,"max":0},"prediction":{"base":0,"quality":0,"agreement":0,"gapScale":0,"min":0,"max":0},"moneyline":{"base":0,"quality":0,"agreement":0,"gapScale":0,"min":0,"max":0}}}}'::jsonb,
  'Brazo de control: motor sin ancla de mercado. No promocionable sin muestra.'
)
on conflict (version) do nothing;
