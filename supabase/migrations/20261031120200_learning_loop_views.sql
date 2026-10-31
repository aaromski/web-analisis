-- Join pre → post por (match_id, phase), nunca por FK entre snapshots:
-- el post puede no existir y las correcciones cambian cuál es el vigente.
create or replace view public.v_match_backtest
with (security_invoker = true) as
with base as (
  select
    m.match_id,
    m.league_id,
    m.kickoff_at,
    m.status,
    s.id              as pre_snapshot_id,
    s.captured_at     as pre_captured_at,
    p.id              as prediction_id,
    p.variant,
    p.engine_version,
    p.params_version,
    p.lambda_home,
    p.lambda_away,
    p.lambda_total,
    p.prob_home,
    p.prob_draw,
    p.prob_away,
    p.totals_line,
    p.totals_side,
    p.totals_probability,
    p.market_total_line,
    p.anchor_weight,
    p.data_quality,
    post.id           as post_snapshot_id,
    post.completeness as post_completeness,
    m.home_score,
    m.away_score,
    case
      when m.home_score is null or m.away_score is null then null
      when m.home_score > m.away_score then 'home'
      when m.home_score = m.away_score then 'draw'
      else 'away'
    end as actual_result
  from public.predictions p
  join public.match_snapshots s
    on s.id = p.snapshot_id and s.phase = 'pre'
  join public.matches m
    on m.match_id = s.match_id
  left join public.match_snapshots post
    on post.match_id = m.match_id and post.phase = 'post' and post.is_current
)
select
  b.*,
  case
    when b.actual_result is null then null
    else
      power(b.prob_home - (b.actual_result = 'home')::int, 2) +
      power(b.prob_draw - (b.actual_result = 'draw')::int, 2) +
      power(b.prob_away - (b.actual_result = 'away')::int, 2)
  end as brier,
  case b.actual_result
    when 'home' then -ln(nullif(b.prob_home, 0))
    when 'draw' then -ln(nullif(b.prob_draw, 0))
    when 'away' then -ln(nullif(b.prob_away, 0))
  end as log_loss
from base b;

revoke all on table public.v_match_backtest from anon, authenticated;
grant select on table public.v_match_backtest to service_role;
