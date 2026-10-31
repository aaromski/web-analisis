-- Un post sin pre sería un partido huérfano: no hay predicción que comparar.
-- La ruta ya lo comprueba antes de escribir; este trigger protege la base
-- frente a llamadas directas a `record_snapshot`.

create or replace function public.tg_post_requires_pre()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.phase = 'post' and not exists (
    select 1
      from public.match_snapshots s
     where s.match_id = new.match_id
       and s.phase = 'pre'
  ) then
    raise exception 'match % has no pre snapshot', new.match_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists match_snapshots_post_requires_pre on public.match_snapshots;
create trigger match_snapshots_post_requires_pre
  before insert on public.match_snapshots
  for each row execute function public.tg_post_requires_pre();

revoke all on function public.tg_post_requires_pre() from public, anon, authenticated;
