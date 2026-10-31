-- Parley Lab · ciclo de aprendizaje continuo (motor 1.2.0)
-- Escrituras solo desde el servidor Next con service_role.
-- RLS activo y sin políticas: anon y authenticated no leen ni escriben.

create table if not exists public.matches (
  match_id    text primary key check (match_id ~ '^[^[:space:]]{3,80}$'),
  league_id   text not null,
  league_name text,
  season      text,
  kickoff_at  timestamptz not null,
  status      text not null default 'scheduled'
              check (status in ('scheduled', 'live', 'finished', 'unknown')),
  home_name   text not null,
  away_name   text not null,
  home_score  integer check (home_score >= 0),
  away_score  integer check (away_score >= 0),
  venue       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint matches_finished_score check (
    status <> 'finished' or (home_score is not null and away_score is not null)
  )
);

-- pre: versionado por contenido (cuotas y alineaciones cambian).
-- post: uno vigente por partido; las correcciones quedan como historial.
create table if not exists public.match_snapshots (
  id                uuid primary key default gen_random_uuid(),
  match_id          text not null references public.matches(match_id),
  phase             text not null check (phase in ('pre', 'post')),
  payload_hash      text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  payload           jsonb,
  completeness      text not null default 'complete'
                    check (completeness in ('partial', 'complete')),
  source            text,
  canonical_version text,
  captured_at       timestamptz not null default now(),
  is_current        boolean not null default false,
  payload_purged_at timestamptz,
  created_at        timestamptz not null default now(),
  constraint match_snapshots_identity_uk unique (match_id, phase, payload_hash),
  constraint match_snapshots_current_is_post check (not is_current or phase = 'post'),
  constraint match_snapshots_payload_or_purged
    check (payload is not null or payload_purged_at is not null)
);

create unique index if not exists match_snapshots_one_current_post
  on public.match_snapshots (match_id)
  where phase = 'post' and is_current;

create table if not exists public.engine_params (
  version     text primary key check (version ~ '^[A-Za-z0-9._-]{1,40}$'),
  status      text not null default 'draft'
              check (status in ('draft', 'shadow', 'promoted', 'retired')),
  params      jsonb not null,
  metrics     jsonb,
  notes       text,
  promoted_at timestamptz,
  retired_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint engine_params_promoted_at
    check (status <> 'promoted' or promoted_at is not null),
  constraint engine_params_retired_at
    check (status <> 'retired' or retired_at is not null)
);

create unique index if not exists engine_params_single_promoted
  on public.engine_params ((true))
  where status = 'promoted';

create table if not exists public.predictions (
  id                 uuid primary key default gen_random_uuid(),
  snapshot_id        uuid not null references public.match_snapshots(id),
  variant            text not null check (variant in ('production', 'shadow')),
  engine_version     text not null,
  params_version     text not null references public.engine_params(version),
  generated_at       timestamptz not null,
  lambda_home        numeric(5,3) not null check (lambda_home between 0 and 10),
  lambda_away        numeric(5,3) not null check (lambda_away between 0 and 10),
  lambda_total       numeric(5,3) not null check (lambda_total between 0 and 10),
  prob_home          numeric(6,5) not null check (prob_home between 0 and 1),
  prob_draw          numeric(6,5) not null check (prob_draw between 0 and 1),
  prob_away          numeric(6,5) not null check (prob_away between 0 and 1),
  totals_line        numeric(4,2),
  totals_side        text check (totals_side in ('over', 'under')),
  totals_probability numeric(6,5) check (totals_probability between 0 and 1),
  market_total_line  numeric(4,2),
  anchor_weight      numeric(4,3) check (anchor_weight between 0 and 1),
  data_quality       numeric(4,3) check (data_quality between 0 and 1),
  payload            jsonb not null,
  created_at         timestamptz not null default now(),
  constraint predictions_identity_uk unique (snapshot_id, variant, params_version),
  constraint predictions_win_sum check (abs(prob_home + prob_draw + prob_away - 1) <= 0.01),
  constraint predictions_lambda_consistent
    check (abs(lambda_home + lambda_away - lambda_total) <= 0.02)
);

create or replace function public.tg_predictions_require_pre()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from public.match_snapshots s
     where s.id = new.snapshot_id
       and s.phase = 'pre'
  ) then
    raise exception 'snapshot % is not a pre snapshot', new.snapshot_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists predictions_require_pre on public.predictions;
create trigger predictions_require_pre
  before insert or update of snapshot_id on public.predictions
  for each row execute function public.tg_predictions_require_pre();

-- Auditoría de escrituras: sin payload, sin cabeceras, sin claves.
create table if not exists public.ingestion_events (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),
  match_id       text,
  snapshot_id    uuid references public.match_snapshots(id) on delete set null,
  operation      text not null check (operation in
                   ('capture_pre', 'capture_post', 'generate_predictions',
                    'promote_params', 'purge_payloads', 'backtest')),
  status         text not null check (status in ('ok', 'duplicate', 'skipped', 'error')),
  error_code     text,
  http_status    integer,
  latency_ms     integer check (latency_ms >= 0),
  engine_version text,
  params_version text,
  request_id     text
);

create index if not exists matches_league_kickoff_idx
  on public.matches (league_id, kickoff_at desc);
create index if not exists matches_kickoff_idx
  on public.matches (kickoff_at desc);
create index if not exists match_snapshots_retention_idx
  on public.match_snapshots (captured_at)
  where phase = 'post' and payload is not null;
create index if not exists predictions_params_idx
  on public.predictions (params_version, variant, created_at desc);
create index if not exists ingestion_events_recent_idx
  on public.ingestion_events (occurred_at desc);
create index if not exists ingestion_events_match_idx
  on public.ingestion_events (match_id, occurred_at desc);
create index if not exists ingestion_events_snapshot_idx
  on public.ingestion_events (snapshot_id);

create or replace function public.tg_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists matches_touch_updated_at on public.matches;
create trigger matches_touch_updated_at
  before update on public.matches
  for each row execute function public.tg_touch_updated_at();

alter table public.matches          enable row level security;
alter table public.match_snapshots  enable row level security;
alter table public.predictions      enable row level security;
alter table public.engine_params    enable row level security;
alter table public.ingestion_events enable row level security;

revoke all on table public.matches, public.match_snapshots, public.predictions,
                      public.engine_params, public.ingestion_events
  from anon, authenticated;

grant select, insert, update, delete on table public.matches,
      public.match_snapshots, public.predictions, public.engine_params
  to service_role;
grant select, insert on table public.ingestion_events to service_role;
revoke all on sequence public.ingestion_events_id_seq from anon, authenticated;
grant usage, select on sequence public.ingestion_events_id_seq to service_role;
