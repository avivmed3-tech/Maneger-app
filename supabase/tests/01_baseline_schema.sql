-- The production schema of project lwiurzkiojctwzllpnmr as it stood on
-- 2026-10-07, before the secure-auth migrations: every table open to anon.
-- Read back from information_schema / pg_policies; kept here so the migrations
-- are tested against the database they will actually meet.

create function public.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
create function public.work_logs_touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create table public.companies(
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  logo_url text,
  settings jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table public.subscriptions(
  id uuid primary key default gen_random_uuid(),
  company_id uuid unique references public.companies(id) on delete cascade,
  plan text not null default 'free' check (plan = any (array['free','pro','enterprise'])),
  status text not null default 'active' check (status = any (array['active','trial','expired','cancelled'])),
  trial_ends_at timestamptz,
  current_period_start timestamptz default now(),
  current_period_end timestamptz default (now() + '30 days'::interval),
  max_users integer default 3,
  max_orders integer default 10,
  payment_provider text,
  payment_provider_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table public.plan_features(
  plan text not null,
  feature_key text not null,
  feature_value jsonb not null default 'true'::jsonb,
  primary key (plan, feature_key)
);
create table public.app_users(
  id text primary key,
  username text not null unique,
  password_hash text not null,
  role text not null default 'worker',
  name text not null,
  project_access jsonb not null default '"all"'::jsonb,
  stage_access jsonb not null default '"all"'::jsonb,
  can_edit boolean not null default false,
  can_view boolean not null default true,
  active boolean not null default true,
  hourly_rate numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  company_id uuid default '00000000-0000-0000-0000-000000000001'::uuid references public.companies(id),
  login_attempts integer default 0,
  locked_until timestamptz,
  last_login timestamptz,
  password_changed_at timestamptz default now(),
  department_id text,
  manager_id text,
  sale_rate numeric default 0,
  password_plain text,
  branch_access jsonb default '[]'::jsonb,
  branch_none boolean default false
);
create index idx_app_users_company on public.app_users(company_id);
create table public.projects(
  id text primary key, name text not null,
  created_at timestamptz not null default now(),
  company_id uuid default '00000000-0000-0000-0000-000000000001'::uuid references public.companies(id),
  updated_at timestamptz not null default now()
);
create table public.stages(
  id text primary key, name text not null,
  stage_order integer not null default 0,
  color text not null default '#3b82f6',
  price numeric not null default 0,
  created_at timestamptz not null default now(),
  company_id uuid default '00000000-0000-0000-0000-000000000001'::uuid references public.companies(id),
  hourly_rate numeric default 0, role_id text, minutes numeric default 0,
  updated_at timestamptz not null default now()
);
create table public.stage_blocks(
  id text primary key, name text not null, stages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  company_id uuid default '00000000-0000-0000-0000-000000000001'::uuid references public.companies(id),
  updated_at timestamptz not null default now()
);
create table public.orders(
  id text primary key,
  wo_number text not null,
  pn text, description text,
  qty integer not null default 0,
  unit_price numeric not null default 0,
  project_id text, received_date date, target_date date,
  stage_ids jsonb not null default '[]'::jsonb,
  block_id text,
  serials jsonb not null default '[]'::jsonb,
  shortages jsonb not null default '[]'::jsonb,
  defects jsonb not null default '[]'::jsonb,
  delivered_serials jsonb not null default '[]'::jsonb,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  company_id uuid default '00000000-0000-0000-0000-000000000001'::uuid references public.companies(id),
  branch text, erp_status text, erp_note text
);
create index orders_company_updated_id_idx on public.orders(company_id, updated_at, id);
create table public.work_logs(
  id text primary key,
  user_id text not null, user_name text not null,
  serial_id text, serial_sn text, stage_id text, order_id text,
  start_time timestamptz, end_time timestamptz,
  completed boolean not null default false,
  duration_min numeric not null default 0,
  paused boolean not null default false,
  pause_start timestamptz,
  total_pause_min numeric not null default 0,
  pause_log jsonb not null default '[]'::jsonb,
  bulk boolean not null default false,
  bulk_group_id text, bulk_count integer,
  created_at timestamptz not null default now(),
  company_id uuid default '00000000-0000-0000-0000-000000000001'::uuid references public.companies(id),
  updated_at timestamptz not null default now(),
  hold_info jsonb
);
create index work_logs_company_updated_id_idx on public.work_logs(company_id, updated_at, id);
create table public.custom_tasks(
  id text primary key, user_id text not null, user_name text not null, name text not null,
  description text, price numeric not null default 0,
  active boolean not null default false, completed boolean not null default false, partial boolean not null default false,
  start_time timestamptz, end_time timestamptz, duration_min numeric not null default 0,
  paused boolean not null default false, pause_start timestamptz, total_pause_min numeric not null default 0,
  pause_log jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  company_id uuid default '00000000-0000-0000-0000-000000000001'::uuid references public.companies(id)
);
create table public.audit_log(
  id text primary key, user_id text, username text, name text,
  action text not null, target text, details text,
  reverted boolean not null default false, can_undo boolean not null default false,
  created_at timestamptz not null default now(),
  company_id uuid default '00000000-0000-0000-0000-000000000001'::uuid references public.companies(id),
  ref_id text
);
create table public.departments(
  id text primary key, name text not null, color text not null default '#3b82f6', manager_id text,
  created_at timestamptz not null default now(),
  company_id uuid default '00000000-0000-0000-0000-000000000001'::uuid references public.companies(id),
  branch_codes jsonb default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create table public.daily_plans(
  id text primary key, user_id text not null, user_name text, plan_date date not null,
  order_id text, stage_id text, target_qty numeric default 0, note text, done boolean default false,
  created_by text, created_by_name text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  company_id uuid default '00000000-0000-0000-0000-000000000001'::uuid references public.companies(id),
  serial_ids jsonb default '[]'::jsonb
);
create table public.pn_standards(
  id text primary key, pn text not null, stage_minutes jsonb default '{}'::jsonb, total_min numeric default 0,
  note text, updated_by text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  company_id uuid default '00000000-0000-0000-0000-000000000001'::uuid references public.companies(id)
);

create trigger work_logs_touch_updated_at before insert or update on public.work_logs for each row execute function public.work_logs_touch_updated_at();
create trigger orders_touch_updated_at before insert or update on public.orders for each row execute function public.touch_updated_at();
create trigger projects_touch_updated_at before insert or update on public.projects for each row execute function public.touch_updated_at();
create trigger stages_touch_updated_at before insert or update on public.stages for each row execute function public.touch_updated_at();
create trigger stage_blocks_touch_updated_at before insert or update on public.stage_blocks for each row execute function public.touch_updated_at();
create trigger custom_tasks_touch_updated_at before insert or update on public.custom_tasks for each row execute function public.touch_updated_at();
create trigger departments_touch_updated_at before insert or update on public.departments for each row execute function public.touch_updated_at();
create trigger daily_plans_touch_updated_at before insert or update on public.daily_plans for each row execute function public.touch_updated_at();
create trigger pn_standards_touch_updated_at before insert or update on public.pn_standards for each row execute function public.touch_updated_at();
create trigger app_users_touch_updated_at before insert or update on public.app_users for each row execute function public.touch_updated_at();

-- Every table open to every caller — the state the lockdown replaces.
do $$
declare t text;
begin
  foreach t in array array['app_users','audit_log','custom_tasks','daily_plans','departments','orders',
                           'pn_standards','projects','stage_blocks','stages','work_logs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy anon_all on public.%I for all using (true) with check (true)', t);
    execute format('create policy %I on public.%I for all using (true) with check (true)', 'anon_all_'||t, t);
  end loop;
end $$;
alter table public.companies enable row level security;
create policy anon_read_companies on public.companies for select using (true);
create policy companies_insert on public.companies for insert with check (true);
create policy companies_select on public.companies for select using (true);
alter table public.subscriptions enable row level security;
create policy anon_read_subscriptions on public.subscriptions for select using (true);
create policy subscriptions_insert on public.subscriptions for insert with check (true);
create policy subscriptions_select on public.subscriptions for select using (true);
alter table public.plan_features enable row level security;
create policy anon_read_plan_features on public.plan_features for select using (true);

alter publication supabase_realtime add table public.projects, public.stages, public.stage_blocks,
  public.orders, public.work_logs, public.custom_tasks, public.departments, public.daily_plans, public.pn_standards;

insert into public.companies(id, name, slug) values ('00000000-0000-0000-0000-000000000001', 'ברירת מחדל', 'default');
