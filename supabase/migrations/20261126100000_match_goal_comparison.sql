-- Parley Lab · comparativo de gol entre los dos equipos de cada partido.
-- Solo cuenta partidos anteriores al kickoff (sin fuga de información), así que
-- sirve tanto para partidos programados como cerrados. Los goles salen de
-- match_goal_events en snapshots post vigentes y excluyen la prórroga.
-- v_match_team_prior_form calcula cada perfil una vez (global y en su localía);
-- v_match_goal_comparison lo expone con columnas home_/away_ lado a lado.

create or replace view public.v_match_team_prior_form
with (security_invoker = true) as
with base as (
  select
    m.match_id,
    m.kickoff_at,
    t.home_team_id,
    t.home_team_name,
    t.away_team_id,
    t.away_team_name
  from public.matches m
  join public.v_match_teams t on t.match_id = m.match_id
  where t.home_team_id is not null
    and t.away_team_id is not null
),
current_goals as (
  select g.*
  from public.match_goal_events g
  join public.match_snapshots s
    on s.id = g.snapshot_id
   and s.is_current
),
prior_participation as (
  select
    t.match_id,
    t.home_team_id as team_id,
    t.home_team_name as team_name,
    'home'::text as venue
  from public.v_match_teams t
  join public.matches m on m.match_id = t.match_id
  where m.home_score is not null
    and m.away_score is not null
    and t.home_team_id is not null
  union all
  select
    t.match_id,
    t.away_team_id,
    t.away_team_name,
    'away'::text
  from public.v_match_teams t
  join public.matches m on m.match_id = t.match_id
  where m.home_score is not null
    and m.away_score is not null
    and t.away_team_id is not null
),
prior_for_match as (
  select
    b.match_id as target_match_id,
    'home'::text as side,
    p.match_id as prior_match_id,
    p.team_id,
    p.team_name,
    p.venue
  from base b
  join prior_participation p
    on p.team_id = b.home_team_id
  join public.matches pm on pm.match_id = p.match_id
  where pm.kickoff_at < b.kickoff_at
  union all
  select
    b.match_id,
    'away'::text,
    p.match_id,
    p.team_id,
    p.team_name,
    p.venue
  from base b
  join prior_participation p
    on p.team_id = b.away_team_id
  join public.matches pm on pm.match_id = p.match_id
  where pm.kickoff_at < b.kickoff_at
),
prior_rows as (
  select
    pf.target_match_id,
    pf.side,
    pf.team_id,
    pf.team_name,
    pf.prior_match_id,
    pf.venue,
    count(g.id) filter (where g.team_id = pf.team_id)::int as goals_for,
    count(g.id) filter (where g.team_id is not null and g.team_id <> pf.team_id)::int as goals_against,
    count(g.id) filter (where g.team_id = pf.team_id and g.period = 'first_half')::int as h1_for,
    count(g.id) filter (where g.team_id = pf.team_id and g.period = 'second_half')::int as h2_for,
    count(g.id) filter (where g.team_id is not null and g.team_id <> pf.team_id and g.period = 'first_half')::int as h1_against,
    count(g.id) filter (where g.team_id is not null and g.team_id <> pf.team_id and g.period = 'second_half')::int as h2_against,
    count(g.id) filter (where g.team_id = pf.team_id and g.minute <= 15)::int as b1_15_for,
    count(g.id) filter (where g.team_id = pf.team_id and g.minute between 16 and 30)::int as b16_30_for,
    count(g.id) filter (where g.team_id = pf.team_id and g.minute between 31 and 45)::int as b31_45_for,
    count(g.id) filter (where g.team_id = pf.team_id and g.minute between 46 and 60)::int as b46_60_for,
    count(g.id) filter (where g.team_id = pf.team_id and g.minute between 61 and 75)::int as b61_75_for,
    count(g.id) filter (where g.team_id = pf.team_id and g.minute > 75)::int as b76_90_for,
    count(g.id) filter (where g.team_id is not null and g.team_id <> pf.team_id and g.minute <= 15)::int as b1_15_against,
    count(g.id) filter (where g.team_id is not null and g.team_id <> pf.team_id and g.minute between 16 and 30)::int as b16_30_against,
    count(g.id) filter (where g.team_id is not null and g.team_id <> pf.team_id and g.minute between 31 and 45)::int as b31_45_against,
    count(g.id) filter (where g.team_id is not null and g.team_id <> pf.team_id and g.minute between 46 and 60)::int as b46_60_against,
    count(g.id) filter (where g.team_id is not null and g.team_id <> pf.team_id and g.minute between 61 and 75)::int as b61_75_against,
    count(g.id) filter (where g.team_id is not null and g.team_id <> pf.team_id and g.minute > 75)::int as b76_90_against,
    fg.minute as first_minute,
    (fg.first_team_id = pf.team_id) as first_for,
    (fg.first_team_id is not null and fg.first_team_id <> pf.team_id) as first_against
  from prior_for_match pf
  left join current_goals g
    on g.match_id = pf.prior_match_id
   and g.period <> 'extra_time'
   and g.credited_side is not null
  left join public.v_match_first_goal fg
    on fg.match_id = pf.prior_match_id
  group by
    pf.target_match_id,
    pf.side,
    pf.team_id,
    pf.team_name,
    pf.prior_match_id,
    pf.venue,
    fg.minute,
    fg.first_team_id
),
agg as (
  select
    target_match_id,
    side,
    venue,
    grouping(venue) = 1 as is_all,
    count(*)::int as matches,
    sum(goals_for)::int as goals_for,
    sum(goals_against)::int as goals_against,
    sum(h1_for)::int as h1_for,
    sum(h2_for)::int as h2_for,
    sum(h1_against)::int as h1_against,
    sum(h2_against)::int as h2_against,
    sum(b1_15_for)::int as b1_15_for,
    sum(b16_30_for)::int as b16_30_for,
    sum(b31_45_for)::int as b31_45_for,
    sum(b46_60_for)::int as b46_60_for,
    sum(b61_75_for)::int as b61_75_for,
    sum(b76_90_for)::int as b76_90_for,
    sum(b1_15_against)::int as b1_15_against,
    sum(b16_30_against)::int as b16_30_against,
    sum(b31_45_against)::int as b31_45_against,
    sum(b46_60_against)::int as b46_60_against,
    sum(b61_75_against)::int as b61_75_against,
    sum(b76_90_against)::int as b76_90_against,
    count(*) filter (where goals_against = 0)::int as clean_sheets,
    count(*) filter (where goals_for = 0)::int as failed_to_score,
    count(*) filter (where goals_for > 0 and goals_against > 0)::int as btts,
    count(*) filter (where goals_for + goals_against >= 3)::int as over_2_5,
    count(*) filter (where first_for is true)::int as first_goals,
    count(*) filter (where first_against is true)::int as first_goals_conceded,
    avg(first_minute) as first_goal_minute_avg,
    percentile_cont(0.5) within group (order by first_minute) as first_goal_minute_median
  from prior_rows
  group by grouping sets (
    (target_match_id, side, venue),
    (target_match_id, side)
  )
)
select
  a.target_match_id as match_id,
  a.side,
  case when a.is_all then 'all' else a.venue end as condition,
  case when a.side = 'home' then b.home_team_id else b.away_team_id end as team_id,
  case when a.side = 'home' then b.home_team_name else b.away_team_name end as team_name,
  a.matches,
  a.goals_for,
  a.goals_against,
  case when a.matches > 0 then round(a.goals_for::numeric / a.matches, 2) end as goals_for_avg,
  case when a.matches > 0 then round(a.goals_against::numeric / a.matches, 2) end as goals_against_avg,
  case when a.goals_for > 0 then round(90.0 * a.matches / a.goals_for, 1) end as minutes_per_goal_for,
  case when a.goals_against > 0 then round(90.0 * a.matches / a.goals_against, 1) end as minutes_per_goal_against,
  a.h1_for as first_half_goals_for,
  a.h2_for as second_half_goals_for,
  case when a.goals_for > 0 then round(100.0 * a.h1_for / a.goals_for, 1) end as first_half_pct_for,
  case when a.goals_for > 0 then round(100.0 * a.h2_for / a.goals_for, 1) end as second_half_pct_for,
  a.h1_against as first_half_goals_against,
  a.h2_against as second_half_goals_against,
  case when a.goals_against > 0 then round(100.0 * a.h1_against / a.goals_against, 1) end as first_half_pct_against,
  case when a.goals_against > 0 then round(100.0 * a.h2_against / a.goals_against, 1) end as second_half_pct_against,
  a.first_goals,
  a.first_goals_conceded,
  case when a.matches > 0 then round(100.0 * a.first_goals / a.matches, 1) end as first_goal_pct,
  round(a.first_goal_minute_avg, 1) as first_goal_minute_avg,
  round(a.first_goal_minute_median::numeric, 1) as first_goal_minute_median,
  a.clean_sheets,
  a.failed_to_score,
  case when a.matches > 0 then round(100.0 * a.btts / a.matches, 1) end as btts_pct,
  case when a.matches > 0 then round(100.0 * a.over_2_5 / a.matches, 1) end as over_2_5_pct,
  jsonb_build_object(
    '1_15', a.b1_15_for,
    '16_30', a.b16_30_for,
    '31_45', a.b31_45_for,
    '46_60', a.b46_60_for,
    '61_75', a.b61_75_for,
    '76_90', a.b76_90_for
  ) as bands_for,
  jsonb_build_object(
    '1_15', a.b1_15_against,
    '16_30', a.b16_30_against,
    '31_45', a.b31_45_against,
    '46_60', a.b46_60_against,
    '61_75', a.b61_75_against,
    '76_90', a.b76_90_against
  ) as bands_against
from agg a
join base b on b.match_id = a.target_match_id;

revoke all on table public.v_match_team_prior_form from anon, authenticated;
grant select on table public.v_match_team_prior_form to service_role;

-- Una fila por partido con el perfil previo de cada equipo. `home_venue` y
-- `away_venue` repiten el perfil en su localía (local en casa, visitante fuera)
-- con la misma forma que las columnas globales.
create or replace view public.v_match_goal_comparison
with (security_invoker = true) as
with base as (
  select
    m.match_id,
    m.league_id,
    m.league_name,
    m.season,
    m.kickoff_at,
    m.status,
    m.home_score,
    m.away_score,
    t.home_team_id,
    t.home_team_name,
    t.away_team_id,
    t.away_team_name
  from public.matches m
  join public.v_match_teams t on t.match_id = m.match_id
  where t.home_team_id is not null
    and t.away_team_id is not null
),
form as materialized (
  select * from public.v_match_team_prior_form
)
select
  b.match_id,
  b.league_id,
  b.league_name,
  b.season,
  b.kickoff_at,
  b.status,
  b.home_team_id,
  b.home_team_name,
  b.away_team_id,
  b.away_team_name,
  b.home_score,
  b.away_score,
  coalesce(h.matches, 0) as home_prior_matches,
  coalesce(h.goals_for, 0) as home_goals_for,
  coalesce(h.goals_against, 0) as home_goals_against,
  h.goals_for_avg as home_goals_for_avg,
  h.goals_against_avg as home_goals_against_avg,
  h.minutes_per_goal_for as home_minutes_per_goal_for,
  h.minutes_per_goal_against as home_minutes_per_goal_against,
  coalesce(h.first_half_goals_for, 0) as home_first_half_goals_for,
  coalesce(h.second_half_goals_for, 0) as home_second_half_goals_for,
  h.first_half_pct_for as home_first_half_pct_for,
  h.second_half_pct_for as home_second_half_pct_for,
  coalesce(h.first_half_goals_against, 0) as home_first_half_goals_against,
  coalesce(h.second_half_goals_against, 0) as home_second_half_goals_against,
  h.first_half_pct_against as home_first_half_pct_against,
  h.second_half_pct_against as home_second_half_pct_against,
  coalesce(h.first_goals, 0) as home_first_goals,
  coalesce(h.first_goals_conceded, 0) as home_first_goals_conceded,
  h.first_goal_pct as home_first_goal_pct,
  h.first_goal_minute_avg as home_first_goal_minute_avg,
  h.first_goal_minute_median as home_first_goal_minute_median,
  coalesce(h.clean_sheets, 0) as home_clean_sheets,
  coalesce(h.failed_to_score, 0) as home_failed_to_score,
  h.btts_pct as home_btts_pct,
  h.over_2_5_pct as home_over_2_5_pct,
  h.bands_for as home_bands_for,
  h.bands_against as home_bands_against,
  coalesce((hv.profile ->> 'matches')::int, 0) as home_venue_matches,
  hv.profile as home_venue,
  coalesce(a.matches, 0) as away_prior_matches,
  coalesce(a.goals_for, 0) as away_goals_for,
  coalesce(a.goals_against, 0) as away_goals_against,
  a.goals_for_avg as away_goals_for_avg,
  a.goals_against_avg as away_goals_against_avg,
  a.minutes_per_goal_for as away_minutes_per_goal_for,
  a.minutes_per_goal_against as away_minutes_per_goal_against,
  coalesce(a.first_half_goals_for, 0) as away_first_half_goals_for,
  coalesce(a.second_half_goals_for, 0) as away_second_half_goals_for,
  a.first_half_pct_for as away_first_half_pct_for,
  a.second_half_pct_for as away_second_half_pct_for,
  coalesce(a.first_half_goals_against, 0) as away_first_half_goals_against,
  coalesce(a.second_half_goals_against, 0) as away_second_half_goals_against,
  a.first_half_pct_against as away_first_half_pct_against,
  a.second_half_pct_against as away_second_half_pct_against,
  coalesce(a.first_goals, 0) as away_first_goals,
  coalesce(a.first_goals_conceded, 0) as away_first_goals_conceded,
  a.first_goal_pct as away_first_goal_pct,
  a.first_goal_minute_avg as away_first_goal_minute_avg,
  a.first_goal_minute_median as away_first_goal_minute_median,
  coalesce(a.clean_sheets, 0) as away_clean_sheets,
  coalesce(a.failed_to_score, 0) as away_failed_to_score,
  a.btts_pct as away_btts_pct,
  a.over_2_5_pct as away_over_2_5_pct,
  a.bands_for as away_bands_for,
  a.bands_against as away_bands_against,
  coalesce((av.profile ->> 'matches')::int, 0) as away_venue_matches,
  av.profile as away_venue
from base b
left join form h
  on h.match_id = b.match_id
 and h.side = 'home'
 and h.condition = 'all'
left join lateral (
  select to_jsonb(f) - 'match_id' - 'side' - 'condition' - 'team_id' - 'team_name' as profile
  from form f
  where f.match_id = b.match_id
    and f.side = 'home'
    and f.condition = 'home'
) hv on true
left join form a
  on a.match_id = b.match_id
 and a.side = 'away'
 and a.condition = 'all'
left join lateral (
  select to_jsonb(f) - 'match_id' - 'side' - 'condition' - 'team_id' - 'team_name' as profile
  from form f
  where f.match_id = b.match_id
    and f.side = 'away'
    and f.condition = 'away'
) av on true;

revoke all on table public.v_match_goal_comparison from anon, authenticated;
grant select on table public.v_match_goal_comparison to service_role;

comment on view public.v_match_team_prior_form is
  'Perfil de gol previo por partido, equipo y condición (all, home o away). Solo partidos anteriores al kickoff y goles reglamentarios.';
comment on view public.v_match_goal_comparison is
  'Comparativo por partido: perfil previo del local y del visitante, con mitades, franjas de 15 minutos, frecuencia goleadora, primer gol y contexto de resultados.';
comment on column public.v_match_team_prior_form.minutes_per_goal_for is
  'Minutos de juego por gol marcado (90 * partidos / goles); null si no marcó.';
comment on column public.v_match_team_prior_form.first_goal_pct is
  'Porcentaje de partidos previos en los que el equipo marcó primero.';
comment on column public.v_match_goal_comparison.home_venue is
  'Perfil del local en sus partidos previos como local; misma forma que las columnas globales, null si no tiene muestra.';
comment on column public.v_match_goal_comparison.away_venue is
  'Perfil del visitante en sus partidos previos como visitante; misma forma que las columnas globales, null si no tiene muestra.';
