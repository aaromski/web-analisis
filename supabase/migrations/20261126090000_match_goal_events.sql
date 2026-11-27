-- Parley Lab · eventos de gol del timeline post-partido.
-- Extraídos de `match_snapshots.payload->timeline` al registrar el post y
-- rellenados por `scripts/backfill-goals.ts`. Solo service_role lee y escribe.
-- `credited_side` sale de `side`, que coincide con el marcador final en los 188
-- partidos cerrados. En 8 goles en propia servidos por ESPN el `score_after`
-- viene invertido (el post lo advierte en meta.warnings) y no se usa.

create table if not exists public.match_goal_events (
  id                bigint generated always as identity primary key,
  snapshot_id       uuid not null references public.match_snapshots(id) on delete cascade,
  match_id          text not null references public.matches(match_id) on delete cascade,
  -- Posición en el timeline canónico: hace idempotente el backfill.
  seq               integer not null check (seq >= 0),
  minute            integer not null check (minute between 1 and 130),
  added_time        integer check (added_time is null or added_time >= 0),
  period            text not null check (period in ('first_half', 'second_half', 'extra_time')),
  event_type        text not null check (event_type in ('goal', 'own_goal', 'penalty_goal')),
  side              text not null check (side in ('home', 'away')),
  credited_side     text check (credited_side in ('home', 'away')),
  team_id           text,
  opponent_team_id  text,
  team_name         text,
  player_id         text,
  player_name       text,
  assist_name       text,
  score_home_after  integer check (score_home_after is null or score_home_after >= 0),
  score_away_after  integer check (score_away_after is null or score_away_after >= 0),
  created_at        timestamptz not null default now(),
  constraint match_goal_events_snapshot_seq_uk unique (snapshot_id, seq)
);

comment on table public.match_goal_events is
  'Goles del timeline post (goal, own_goal, penalty_goal) con minuto, periodo y equipo acreditado según el lado del evento.';
comment on column public.match_goal_events.credited_side is
  'Equipo al que se acredita el gol: el lado del evento, verificado contra el marcador final; null si el evento no trae lado ni delta resoluble.';
comment on column public.match_goal_events.score_home_after is
  'Marcador acumulado recalculado desde los créditos del timeline; el score_after crudo queda en el snapshot post.';

create index if not exists match_goal_events_match_idx
  on public.match_goal_events (match_id, minute);
create index if not exists match_goal_events_team_idx
  on public.match_goal_events (team_id, minute);

alter table public.match_goal_events enable row level security;
revoke all on table public.match_goal_events from anon, authenticated;
grant select, insert on table public.match_goal_events to service_role;
revoke all on sequence public.match_goal_events_id_seq from anon, authenticated;
grant usage, select on sequence public.match_goal_events_id_seq to service_role;

-- Nombres y team_id de cada partido según su captura pre más reciente.
create or replace view public.v_match_teams
with (security_invoker = true) as
select distinct on (s.match_id)
  s.match_id,
  nullif(btrim(s.payload -> 'teams' -> 'home' ->> 'team_id'), '') as home_team_id,
  nullif(btrim(s.payload -> 'teams' -> 'home' ->> 'name'), '')    as home_team_name,
  nullif(btrim(s.payload -> 'teams' -> 'away' ->> 'team_id'), '') as away_team_id,
  nullif(btrim(s.payload -> 'teams' -> 'away' ->> 'name'), '')    as away_team_name
from public.match_snapshots s
where s.phase = 'pre'
  and s.payload is not null
order by s.match_id, s.captured_at desc;

revoke all on table public.v_match_teams from anon, authenticated;
grant select on table public.v_match_teams to service_role;

-- Primer gol dentro de los 90 minutos reglamentarios de cada partido cerrado.
-- Si no hubo goles (0-0 o solo prórroga) la fila existe con `no_goal = true`.
-- Las correcciones conservan snapshots antiguos: solo cuenta el vigente.
create or replace view public.v_match_first_goal
with (security_invoker = true) as
with current_goals as (
  select g.*
  from public.match_goal_events g
  join public.match_snapshots s
    on s.id = g.snapshot_id
   and s.is_current
)
select
  m.match_id,
  m.league_id,
  m.home_name,
  m.away_name,
  m.home_score,
  m.away_score,
  fg.minute,
  fg.added_time,
  fg.period,
  fg.event_type,
  fg.credited_side,
  fg.team_id   as first_team_id,
  fg.team_name as first_team_name,
  fg.score_home_after,
  fg.score_away_after,
  (fg.match_id is null) as no_goal
from public.matches m
left join lateral (
  select g.match_id, g.minute, g.added_time, g.period, g.event_type, g.credited_side,
         g.team_id, g.team_name, g.score_home_after, g.score_away_after
  from current_goals g
  where g.match_id = m.match_id
    and g.period <> 'extra_time'
    and g.credited_side is not null
  order by g.minute, coalesce(g.added_time, 0), g.seq
  limit 1
) fg on true
where m.home_score is not null
  and m.away_score is not null;

revoke all on table public.v_match_first_goal from anon, authenticated;
grant select on table public.v_match_first_goal to service_role;

-- Perfil por equipo y condición: partidos, goles a favor/en contra y quién
-- marcó primero. `condition = 'all'` agrega local y visitante.
create or replace view public.v_team_goal_profile
with (security_invoker = true) as
with finished as (
  select m.match_id
  from public.matches m
  where m.home_score is not null
    and m.away_score is not null
),
current_goals as (
  select g.*
  from public.match_goal_events g
  join public.match_snapshots s
    on s.id = g.snapshot_id
   and s.is_current
),
participation as (
  select t.match_id, t.home_team_id as team_id, t.home_team_name as team_name, 'home'::text as condition
  from public.v_match_teams t
  join finished f on f.match_id = t.match_id
  where t.home_team_id is not null
  union all
  select t.match_id, t.away_team_id, t.away_team_name, 'away'::text
  from public.v_match_teams t
  join finished f on f.match_id = t.match_id
  where t.away_team_id is not null
),
per_match as (
  select
    p.match_id,
    p.team_id,
    p.team_name,
    p.condition,
    count(g.id) filter (where g.team_id = p.team_id) as goals_for,
    count(g.id) filter (where g.team_id is not null and g.team_id <> p.team_id) as goals_against
  from participation p
  left join current_goals g
    on g.match_id = p.match_id
   and g.period <> 'extra_time'
   and g.credited_side is not null
  group by p.match_id, p.team_id, p.team_name, p.condition
),
totals as (
  select
    team_id,
    team_name,
    condition,
    count(*)::int as matches,
    coalesce(sum(goals_for), 0)::int as goals_for,
    coalesce(sum(goals_against), 0)::int as goals_against
  from per_match
  group by team_id, team_name, condition
),
firsts as (
  select
    p.team_id,
    p.condition,
    count(*) filter (where fg.first_team_id = p.team_id)::int as first_goals,
    count(*) filter (where fg.first_team_id is not null
                       and fg.first_team_id <> p.team_id)::int as first_goals_conceded
  from participation p
  join public.v_match_first_goal fg on fg.match_id = p.match_id
  group by p.team_id, p.condition
),
combined as (
  select
    t.team_id,
    t.team_name,
    t.condition,
    t.matches,
    t.goals_for,
    t.goals_against,
    coalesce(f.first_goals, 0) as first_goals,
    coalesce(f.first_goals_conceded, 0) as first_goals_conceded
  from totals t
  left join firsts f
    on f.team_id = t.team_id
   and f.condition = t.condition
)
select team_id, team_name, condition, matches, goals_for, goals_against,
       first_goals, first_goals_conceded
from combined
union all
select
  team_id,
  min(team_name),
  'all'::text,
  sum(matches)::int,
  sum(goals_for)::int,
  sum(goals_against)::int,
  sum(first_goals)::int,
  sum(first_goals_conceded)::int
from combined
group by team_id;

revoke all on table public.v_team_goal_profile from anon, authenticated;
grant select on table public.v_team_goal_profile to service_role;

-- Goles a favor y en contra por franja de 15 minutos (90' reglamentarios).
create or replace view public.v_team_goal_buckets
with (security_invoker = true) as
with current_goals as (
  select g.*
  from public.match_goal_events g
  join public.match_snapshots s
    on s.id = g.snapshot_id
   and s.is_current
),
participation as (
  select t.match_id, t.home_team_id as team_id, t.home_team_name as team_name, 'home'::text as condition
  from public.v_match_teams t
  join public.matches m
    on m.match_id = t.match_id
   and m.home_score is not null
   and m.away_score is not null
  where t.home_team_id is not null
  union all
  select t.match_id, t.away_team_id, t.away_team_name, 'away'::text
  from public.v_match_teams t
  join public.matches m
    on m.match_id = t.match_id
   and m.home_score is not null
   and m.away_score is not null
  where t.away_team_id is not null
),
events as (
  select
    p.team_id,
    p.team_name,
    p.condition,
    case
      when g.minute <= 15 then '1_15'
      when g.minute <= 30 then '16_30'
      when g.minute <= 45 then '31_45'
      when g.minute <= 60 then '46_60'
      when g.minute <= 75 then '61_75'
      else '76_90'
    end as bucket,
    case when g.team_id = p.team_id then 'for' else 'against' end as direction
  from participation p
  join current_goals g on g.match_id = p.match_id
  where g.period <> 'extra_time'
    and g.credited_side is not null
    and g.team_id is not null
),
grouped as (
  select team_id, team_name, condition, direction, bucket, count(*)::int as goals
  from events
  group by team_id, team_name, condition, direction, bucket
)
select team_id, team_name, condition, direction, bucket, goals
from grouped
union all
select team_id, min(team_name), 'all'::text, direction, bucket, sum(goals)::int
from grouped
group by team_id, direction, bucket;

revoke all on table public.v_team_goal_buckets from anon, authenticated;
grant select on table public.v_team_goal_buckets to service_role;
