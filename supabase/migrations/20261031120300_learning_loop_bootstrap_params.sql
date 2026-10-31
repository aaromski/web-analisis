-- Fila base que satisface la FK predictions.params_version antes de que exista
-- el refactor de EngineParams. Nunca se edita: cada ajuste crea una versión.
insert into public.engine_params (version, status, params, notes, promoted_at)
values (
  'engine-1.2.0-defaults',
  'promoted',
  jsonb_build_object(
    'engine_version', '1.2.0',
    'source', 'baseline',
    'knobs', '{}'::jsonb
  ),
  'Parámetros por defecto del motor 1.2.0 sin aprendizaje.',
  now()
)
on conflict (version) do nothing;
