create table if not exists public.travel_user_memory (
  user_id text primary key,
  profile jsonb not null default '{}'::jsonb,
  memory jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.travel_plans (
  id bigint generated always as identity primary key,
  user_id text not null,
  plan_id text not null,
  location text,
  price numeric,
  quality_score numeric,
  plan jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists travel_plans_user_created_idx
  on public.travel_plans (user_id, created_at desc);

create unique index if not exists travel_plans_user_plan_id_idx
  on public.travel_plans (user_id, plan_id);

