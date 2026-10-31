-- Reversión del ciclo de aprendizaje. Orden: vista, tablas, funciones.
-- Ejecutar solo si se quiere eliminar todo el esquema persistente.

drop view if exists public.v_match_backtest;

drop table if exists public.predictions;
drop table if exists public.ingestion_events;
drop table if exists public.match_snapshots;
drop table if exists public.engine_params;
drop table if exists public.matches;

drop function if exists public.record_snapshot(text, text, jsonb, text, text, timestamptz);
drop function if exists public.purge_post_payloads(interval);
drop function if exists public.tg_predictions_require_pre();
drop function if exists public.tg_post_requires_pre();
drop function if exists public.tg_touch_updated_at();
