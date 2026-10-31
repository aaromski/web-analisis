-- Promoción / rollback atómico de una versión de parámetros.
-- El índice único parcial engine_params_single_promoted impide dos filas
-- promovidas: se retira la actual antes de promover la nueva en una sola
-- transacción. La versión anterior queda `retired` y sigue referenciada por
-- las predicciones históricas.
create or replace function public.set_promoted_params(p_version text)
returns table (promoted_version text, retired_version text)
language plpgsql
set search_path = ''
as $$
declare
  v_target  public.engine_params%rowtype;
  v_current text;
begin
  select * into v_target
    from public.engine_params
   where version = p_version
     for update;
  if not found then
    raise exception 'unknown params version %', p_version using errcode = 'P0002';
  end if;

  select version into v_current
    from public.engine_params
   where status = 'promoted'
     for update;

  if v_current = p_version then
    return query select p_version, null::text;
    return;
  end if;

  if v_target.status not in ('shadow', 'draft', 'retired') then
    raise exception 'params version % cannot be promoted from status %',
      p_version, v_target.status using errcode = '23514';
  end if;

  if v_current is not null then
    update public.engine_params
       set status = 'retired',
           retired_at = now()
     where version = v_current;
  end if;

  update public.engine_params
     set status = 'promoted',
         promoted_at = now(),
         retired_at = null
   where version = p_version;

  insert into public.ingestion_events (operation, status, params_version)
  values ('promote_params', 'ok', p_version);

  return query select p_version, v_current;
end;
$$;

revoke all on function public.set_promoted_params(text)
  from public, anon, authenticated;
grant execute on function public.set_promoted_params(text) to service_role;
