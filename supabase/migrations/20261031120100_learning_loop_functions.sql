-- Captura idempotente. Devuelve (snapshot_id, inserted):
--   inserted = true  → payload distinto, captura nueva
--   inserted = false → payload idéntico ya guardado
create or replace function public.record_snapshot(
  p_match_id     text,
  p_phase        text,
  p_payload      jsonb,
  p_completeness text default 'complete',
  p_source       text default null,
  p_captured_at  timestamptz default now()
) returns table (snapshot_id uuid, inserted boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_hash     text;
  v_existing uuid;
  v_id       uuid;
begin
  if p_phase not in ('pre', 'post') then
    raise exception 'invalid phase %', p_phase using errcode = '22023';
  end if;

  -- Serializa escrituras concurrentes del mismo partido (API + botón).
  perform 1
     from public.matches m
    where m.match_id = p_match_id
      for update;
  if not found then
    raise exception 'unknown match_id %', p_match_id using errcode = '23503';
  end if;

  -- jsonb normaliza orden de claves y espacios; el digest no depende de Node.
  v_hash := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');

  select s.id into v_existing
    from public.match_snapshots s
   where s.match_id = p_match_id
     and s.phase = p_phase
     and s.payload_hash = v_hash;

  if v_existing is not null then
    if p_phase = 'post' then
      -- Una corrección que vuelve a un payload anterior lo restaura como vigente.
      update public.match_snapshots s
         set is_current = false
       where s.match_id = p_match_id
         and s.phase = 'post'
         and s.is_current
         and s.id <> v_existing;
      update public.match_snapshots s
         set is_current = true,
             completeness = case
               when s.completeness = 'partial' and p_completeness = 'complete' then 'complete'
               else s.completeness
             end
       where s.id = v_existing;
    elsif p_completeness = 'complete' then
      update public.match_snapshots s
         set completeness = 'complete'
       where s.id = v_existing
         and s.completeness = 'partial';
    end if;
    return query select v_existing, false;
    return;
  end if;

  if p_phase = 'post' then
    update public.match_snapshots s
       set is_current = false
     where s.match_id = p_match_id
       and s.phase = 'post'
       and s.is_current;
  end if;

  insert into public.match_snapshots
    (match_id, phase, payload_hash, payload, completeness, source, captured_at, is_current)
  values
    (p_match_id, p_phase, v_hash, p_payload, p_completeness, p_source, p_captured_at,
     p_phase = 'post')
  on conflict (match_id, phase, payload_hash) do nothing
  returning id into v_id;

  if v_id is null then
    select s.id into v_id
      from public.match_snapshots s
     where s.match_id = p_match_id
       and s.phase = p_phase
       and s.payload_hash = v_hash;
    return query select v_id, false;
    return;
  end if;

  return query select v_id, true;
end;
$$;

-- Retención: conserva la fila y su identidad, borra solo el crudo del post.
create or replace function public.purge_post_payloads(
  p_keep interval default '90 days'
) returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.match_snapshots s
     set payload = null,
         payload_purged_at = now()
   where s.phase = 'post'
     and s.payload is not null
     and s.captured_at < now() - p_keep;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Supabase concede EXECUTE a anon/authenticated por defecto en el esquema public:
-- revocar solo de PUBLIC no basta.
revoke all on function public.record_snapshot(text, text, jsonb, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.purge_post_payloads(interval)
  from public, anon, authenticated;
revoke all on function public.tg_predictions_require_pre()
  from public, anon, authenticated;
revoke all on function public.tg_touch_updated_at()
  from public, anon, authenticated;

grant execute on function public.record_snapshot(text, text, jsonb, text, text, timestamptz) to service_role;
grant execute on function public.purge_post_payloads(interval) to service_role;
