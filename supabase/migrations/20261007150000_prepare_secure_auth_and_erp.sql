-- ════════════════════════════════════════════════════════════════════════════
-- Phase 1 of 2 — prepare. Safe to run while today's app is live.
-- ════════════════════════════════════════════════════════════════════════════
-- Until now every table was open to the public anon key that ships inside
-- index.html: anyone who opened the site could read every company's data,
-- every user's password (in plain text and as an unsalted SHA-256), and could
-- write anything, including "admin" on themselves.
--
-- This migration adds everything the secure model needs WITHOUT taking anything
-- away yet, so the app in the field keeps working until the new client is out:
--
--   • a private schema the API cannot reach, holding each user's password
--     encrypted with a key that lives in Supabase Vault (admins can still view
--     a password — the business asked to keep that — but it is never stored or
--     served in clear), and the random secret behind each user's Supabase Auth
--     account;
--   • svc_* functions for the `auth` Edge Function: login with lockout,
--     company registration — callable only with the service role key;
--   • the helpers the row-level policies of phase 2 are written with: which
--     app user, company and role a request's JWT belongs to;
--   • set_user_password / reveal_user_passwords for the admin screens;
--   • the Priority ⇄ Engini integration: a per-company API key, the inbound
--     batch log, the Priority operation behind every stage of every work order,
--     and the outbox of stage sign-offs waiting to be reported back.
--
-- Phase 2 (supabase/pending/lockdown.sql) swaps the open policies for
-- per-company ones and removes the password columns. It is run only after the
-- new client is deployed — see docs/ENGINI-PRIORITY.md, "סדר ההפעלה".
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ── Who is asking ─────────────────────────────────────────────────────────
-- The auth Edge Function stamps app_user_id into app_metadata, which only the
-- service role can write — a user cannot edit it into their own token.
-- Company and role are read from app_users on every request rather than from
-- the token, so deactivating a user or changing their role takes effect at
-- once, not when their token expires.
create or replace function private.app_user_id() returns text
language sql stable set search_path = '' as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'app_user_id', '')
$$;

create or replace function private.company_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select u.company_id from public.app_users u
   where u.id = private.app_user_id() and u.active
$$;

create or replace function private.app_role() returns text
language sql stable security definer set search_path = '' as $$
  select u.role from public.app_users u
   where u.id = private.app_user_id() and u.active
$$;

-- Read-only users (צופה) see everything in their company and change nothing.
create or replace function private.can_write() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select u.role <> 'viewer' from public.app_users u
                    where u.id = private.app_user_id() and u.active), false)
$$;

-- The departments a department manager runs: the one on their own card, and
-- any department that names them its manager — managerDept() in the app.
create or replace function private.managed_dept_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct x), '{}'::text[]) from (
    select u.department_id as x from public.app_users u
     where u.id = private.app_user_id() and u.active and u.department_id is not null
    union
    select d.id from public.departments d
      join public.app_users u on u.id = private.app_user_id() and u.active
     where d.manager_id = u.id and d.company_id = u.company_id
  ) s
$$;

-- May the caller create / change / delete a user that looks like this?
-- manageableUsers() in the app, enforced: an admin manages everyone in their
-- company; a department manager manages their own department and themselves,
-- and can never create, edit or become an admin.
create or replace function private.may_administer(p_company uuid, p_role text, p_department_id text, p_id text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.app_users me
     where me.id = private.app_user_id() and me.active and me.company_id = p_company
       and ( me.role = 'admin'
          or ( me.role = 'dept_manager' and coalesce(p_role, '') <> 'admin'
               and (p_id = me.id or p_department_id = any(private.managed_dept_ids())) ) )
  )
$$;

create or replace function private.can_manage_user(p_user_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select private.may_administer(t.company_id, t.role, t.department_id, t.id)
                     from public.app_users t where t.id = p_user_id), false)
$$;

grant execute on function private.app_user_id(), private.company_id(), private.app_role(),
  private.can_write(), private.managed_dept_ids(), private.may_administer(uuid, text, text, text),
  private.can_manage_user(text) to authenticated, service_role;

-- ── Passwords ─────────────────────────────────────────────────────────────
create table if not exists private.user_secrets(
  app_user_id   text primary key,
  company_id    uuid,
  -- The password, encrypted with the Vault key: what an admin sees in the
  -- users screen and on the printed credentials sheet.
  pw_enc        bytea,
  -- The old unsalted SHA-256, only for accounts whose password was never kept
  -- in readable form. Cleared on that user's first login under the new scheme.
  legacy_sha256 text,
  -- The user's Supabase Auth account. Its password is a random secret, not the
  -- user's password, so the Auth API cannot be used to go around the lockout.
  auth_user_id  uuid unique,
  auth_secret_enc bytea,
  updated_at    timestamptz not null default now()
);
alter table private.user_secrets enable row level security;
revoke all on private.user_secrets from public, authenticated;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'omniview_pw_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'omniview_pw_key',
      'OmniView: encrypts app users'' passwords (viewable by admins). Never leaves the database.');
  end if;
end $$;

create or replace function private.pw_key() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'omniview_pw_key' limit 1
$$;
create or replace function private.pw_encrypt(p text) returns bytea
language sql volatile security definer set search_path = '' as $$
  select case when coalesce(p, '') = '' then null
              else extensions.pgp_sym_encrypt(p, private.pw_key()) end
$$;
create or replace function private.pw_decrypt(b bytea) returns text
language sql stable security definer set search_path = '' as $$
  select case when b is null then null else extensions.pgp_sym_decrypt(b, private.pw_key()) end
$$;
create or replace function private.sha256_hex(p text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex')
$$;
revoke execute on function private.pw_key(), private.pw_encrypt(text), private.pw_decrypt(bytea)
  from public, authenticated;

-- While the old client is still in the field it hashes passwords itself and
-- writes them to app_users.password_hash / password_plain. Until phase 2 drops
-- those columns, every such write is copied here, so nothing an admin changes
-- in the meantime is lost.
create or replace function private.legacy_pw_columns() returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'app_users' and column_name = 'password_hash')
$$;

create or replace function private.capture_legacy_password() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n jsonb := to_jsonb(new);
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  plain text := nullif(n ->> 'password_plain', '');
  hash  text := nullif(n ->> 'password_hash', '');
  cur   private.user_secrets;
begin
  if tg_op = 'UPDATE'
     and (n ->> 'password_plain') is not distinct from (o ->> 'password_plain')
     and (n ->> 'password_hash')  is not distinct from (o ->> 'password_hash') then
    return new;
  end if;
  select * into cur from private.user_secrets where app_user_id = new.id;
  insert into private.user_secrets as s (app_user_id, company_id, pw_enc, legacy_sha256)
  values (new.id, new.company_id,
          case
            when plain is not null and (o ->> 'password_plain') is distinct from plain then private.pw_encrypt(plain)
            -- A new hash with no readable password next to it: keep the stored
            -- copy only if it is still the same password.
            when cur.pw_enc is not null and hash is not null
                 and private.sha256_hex(private.pw_decrypt(cur.pw_enc)) <> hash then null
            else cur.pw_enc
          end,
          hash)
  on conflict (app_user_id) do update
     set company_id = excluded.company_id, pw_enc = excluded.pw_enc,
         legacy_sha256 = excluded.legacy_sha256, updated_at = now();
  return new;
exception when others then
  -- Never block a save over this; the next write or the next login catches up.
  raise warning 'capture_legacy_password(%): %', new.id, sqlerrm;
  return new;
end $$;

drop trigger if exists app_users_capture_legacy_password on public.app_users;
create trigger app_users_capture_legacy_password
  after insert or update on public.app_users
  for each row execute function private.capture_legacy_password();

-- Everything as it stands now.
insert into private.user_secrets as s (app_user_id, company_id, pw_enc, legacy_sha256)
select u.id, u.company_id, private.pw_encrypt(nullif(u.password_plain, '')), nullif(u.password_hash, '')
  from public.app_users u
on conflict (app_user_id) do update
   set company_id = excluded.company_id,
       pw_enc = coalesce(excluded.pw_enc, s.pw_enc),
       legacy_sha256 = excluded.legacy_sha256,
       updated_at = now();

-- A user created by the new client carries no hash at all.
alter table public.app_users alter column password_hash set default '';

-- Stores a password the new way, and — until phase 2 — the old way too, so a
-- device still on the old client can log the user in with it.
create or replace function private.store_password(p_user_id text, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.user_secrets as s (app_user_id, company_id, pw_enc, legacy_sha256)
  select u.id, u.company_id, private.pw_encrypt(p_password), null from public.app_users u where u.id = p_user_id
  on conflict (app_user_id) do update
     set pw_enc = excluded.pw_enc, legacy_sha256 = null, company_id = excluded.company_id, updated_at = now();
  if private.legacy_pw_columns() then
    -- the capture trigger sees the same password it was just given and keeps it
    execute 'update public.app_users set password_hash = $1, password_plain = $2 where id = $3'
      using private.sha256_hex(p_password), p_password, p_user_id;
  end if;
  update public.app_users
     set password_changed_at = now(), login_attempts = 0, locked_until = null
   where id = p_user_id;
end $$;
revoke execute on function private.store_password(text, text) from public, authenticated;

-- ── Admin screens ─────────────────────────────────────────────────────────
-- Set someone's password: an admin for anyone in the company, a department
-- manager for their own people, anybody for themselves.
create or replace function public.set_user_password(p_user_id text, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if private.app_user_id() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_user_id is distinct from private.app_user_id() and not private.can_manage_user(p_user_id) then
    raise exception 'not allowed to set this user''s password' using errcode = '42501';
  end if;
  if coalesce(p_password, '') = '' then
    raise exception 'empty password' using errcode = '22023';
  end if;
  perform private.store_password(p_user_id, p_password);
end $$;

-- The passwords the caller is allowed to see — the users they may administer.
-- Nobody sees their own through this (they typed it), and nothing is returned
-- for an account whose password was never kept in readable form.
create or replace function public.reveal_user_passwords(p_ids text[] default null)
returns table(id text, password text)
language sql stable security definer set search_path = '' as $$
  select u.id, private.pw_decrypt(s.pw_enc)
    from public.app_users u
    join private.user_secrets s on s.app_user_id = u.id
   where u.company_id = private.company_id()
     and (p_ids is null or u.id = any(p_ids))
     and s.pw_enc is not null
     and private.can_manage_user(u.id)
$$;

revoke execute on function public.set_user_password(text, text), public.reveal_user_passwords(text[]) from public, anon;
grant execute on function public.set_user_password(text, text), public.reveal_user_passwords(text[]) to authenticated;

-- ── For the auth Edge Function only (service role) ────────────────────────
create or replace function private.user_profile(u public.app_users) returns jsonb
language sql stable set search_path = '' as $$
  select to_jsonb(u) - 'password_hash' - 'password_plain'
$$;

-- The Supabase Auth account behind an app user, and the random password only
-- the auth function knows. Created on first use. (The function derives the
-- account's address from the app user id.)
create or replace function private.auth_identity(p_user_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s private.user_secrets; secret text;
begin
  select * into s from private.user_secrets where app_user_id = p_user_id;
  if s.auth_secret_enc is null then
    secret := encode(extensions.gen_random_bytes(24), 'hex');
    insert into private.user_secrets as x (app_user_id, company_id, auth_secret_enc)
    select u.id, u.company_id, private.pw_encrypt(secret) from public.app_users u where u.id = p_user_id
    on conflict (app_user_id) do update set auth_secret_enc = excluded.auth_secret_enc, updated_at = now();
  else
    secret := private.pw_decrypt(s.auth_secret_enc);
  end if;
  return jsonb_build_object('auth_user_id', s.auth_user_id, 'secret', secret);
end $$;
revoke execute on function private.auth_identity(text) from public, authenticated;

create or replace function public.svc_login(p_username text, p_password text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u public.app_users;
  s private.user_secrets;
  ok boolean := false;
  hash text := private.sha256_hex(p_password);
  tries int;
  max_tries constant int := 5;
begin
  select * into u from public.app_users where username = btrim(coalesce(p_username, ''));
  if not found or not u.active or coalesce(p_password, '') = '' then
    return jsonb_build_object('ok', false, 'error', 'bad_credentials');
  end if;
  if u.locked_until is not null and u.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked', 'locked_until', u.locked_until);
  end if;
  select * into s from private.user_secrets where app_user_id = u.id;
  if s.pw_enc is not null and private.pw_decrypt(s.pw_enc) = p_password then ok := true;
  elsif s.legacy_sha256 is not null and s.legacy_sha256 = hash then ok := true;
  -- Until phase 2, an old client may have changed the hash a moment ago.
  elsif (to_jsonb(u) ->> 'password_hash') = hash then ok := true;
  end if;

  if not ok then
    tries := coalesce(u.login_attempts, 0) + 1;
    update public.app_users
       set login_attempts = tries,
           locked_until = case when tries >= max_tries then now() + interval '15 minutes' else locked_until end
     where id = u.id;
    return jsonb_build_object('ok', false,
      'error', case when tries >= max_tries then 'locked' else 'bad_credentials' end,
      'attempts', tries, 'max_attempts', max_tries);
  end if;

  -- The password is known now, so the account no longer depends on the old
  -- hash: keep the readable copy (encrypted) and drop the hash.
  if s.pw_enc is null or private.pw_decrypt(s.pw_enc) <> p_password then
    insert into private.user_secrets as x (app_user_id, company_id, pw_enc)
    values (u.id, u.company_id, private.pw_encrypt(p_password))
    on conflict (app_user_id) do update set pw_enc = excluded.pw_enc, updated_at = now();
  end if;
  update private.user_secrets set legacy_sha256 = null where app_user_id = u.id and legacy_sha256 is not null;
  update public.app_users set login_attempts = 0, locked_until = null, last_login = now() where id = u.id
  returning * into u;
  -- Journaled here rather than by the app: the page reloads the moment the
  -- login succeeds, before a write from the browser could leave.
  insert into public.audit_log(id, user_id, username, name, action, target, details, company_id)
  values ('al' || encode(extensions.gen_random_bytes(6), 'hex'), u.id, u.username, u.name, 'התחברות', '', '', u.company_id);

  return jsonb_build_object('ok', true, 'user', private.user_profile(u), 'auth', private.auth_identity(u.id));
end $$;

create or replace function public.svc_link_auth_user(p_user_id text, p_auth_user_id uuid) returns void
language sql security definer set search_path = '' as $$
  update private.user_secrets set auth_user_id = p_auth_user_id, updated_at = now() where app_user_id = p_user_id
$$;

-- A new company and its first admin — what the sign-up form used to write
-- straight into four tables with the public key.
create or replace function public.svc_register(p_company_name text, p_admin_name text, p_username text, p_password text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cname text := btrim(coalesce(p_company_name, ''));
  aname text := btrim(coalesce(p_admin_name, ''));
  uname text := btrim(coalesce(p_username, ''));
  cid uuid := gen_random_uuid();
  v_slug text;
  uid text := 'u' || substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 10);
  u public.app_users;
begin
  if cname = '' or aname = '' or uname = '' or coalesce(p_password, '') = '' then
    return jsonb_build_object('ok', false, 'error', 'missing_fields');
  end if;
  if length(cname) > 120 or length(aname) > 120 or length(uname) > 60 then
    return jsonb_build_object('ok', false, 'error', 'too_long');
  end if;
  if exists (select 1 from public.app_users where username = uname) then
    return jsonb_build_object('ok', false, 'error', 'username_taken');
  end if;
  v_slug := nullif(regexp_replace(regexp_replace(lower(cname), '\s+', '-', 'g'), '[^a-z0-9א-ת-]', '', 'g'), '');
  if v_slug is null or exists (select 1 from public.companies c where c.slug = v_slug) then
    v_slug := coalesce(v_slug, 'company') || '-' || substr(cid::text, 1, 6);
  end if;
  insert into public.companies(id, name, slug) values (cid, cname, v_slug);
  insert into public.subscriptions(company_id, plan, status, trial_ends_at, max_users, max_orders)
  values (cid, 'free', 'trial', now() + interval '14 days', 3, 10);
  insert into public.app_users(id, username, role, name, project_access, stage_access, can_edit, can_view,
                               active, hourly_rate, company_id)
  values (uid, uname, 'admin', aname, '"all"', '"all"', true, true, true, 0, cid)
  returning * into u;
  perform private.store_password(uid, p_password);
  update public.app_users set last_login = now() where id = uid returning * into u;
  insert into public.audit_log(id, user_id, username, name, action, target, details, company_id)
  values ('al' || encode(extensions.gen_random_bytes(6), 'hex'), u.id, u.username, u.name, 'הרשמת חברה', cname, '', cid);
  return jsonb_build_object('ok', true, 'user', private.user_profile(u), 'auth', private.auth_identity(uid));
end $$;

revoke execute on function public.svc_login(text, text), public.svc_link_auth_user(text, uuid),
  public.svc_register(text, text, text, text) from public, anon, authenticated;
grant execute on function public.svc_login(text, text), public.svc_link_auth_user(text, uuid),
  public.svc_register(text, text, text, text) to service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- Priority ⇄ Engini
-- ════════════════════════════════════════════════════════════════════════════
-- Engini talks to the `erp` Edge Function with a per-company API key. Inbound,
-- it sends Priority's work-order operations and the function runs them through
-- the very same code as the Excel import (priScan → priBuild → priMergePlan),
-- then writes the result here in one transaction. Outbound, every stage
-- sign-off in the app becomes an event in erp_outbox, which Engini collects,
-- reports on the matching operation in Priority, and acknowledges.

create table if not exists public.erp_connections(
  company_id      uuid primary key references public.companies(id) on delete cascade,
  key_hash        text,
  key_hint        text,
  key_created_at  timestamptz,
  -- Off until Engini is ready to collect sign-offs: while off, nothing is
  -- queued at all.
  two_way         boolean not null default false,
  -- priBuild options; anything left out takes the import screen's default.
  options         jsonb not null default '{}'::jsonb,
  -- Priority operation (normalised תאור פעולה) → stage id, or "__skip".
  stage_map       jsonb not null default '{}'::jsonb,
  lock_holder     text,
  lock_until      timestamptz,
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  updated_at      timestamptz not null default now()
);
create unique index if not exists erp_connections_key_hash_idx on public.erp_connections(key_hash) where key_hash is not null;

create table if not exists public.erp_inbox(
  id          bigint generated always as identity primary key,
  company_id  uuid not null references public.companies(id) on delete cascade,
  batch_ref   text,
  received_at timestamptz not null default now(),
  rows_count  integer,
  wos_count   integer,
  result      jsonb
);
create index if not exists erp_inbox_company_idx on public.erp_inbox(company_id, id desc);

-- The Priority operation behind each stage of each work order — what a sign-off
-- in the app has to be reported against.
create table if not exists public.erp_order_ops(
  company_id  uuid not null references public.companies(id) on delete cascade,
  order_id    text not null,
  stage_id    text not null,
  wo_number   text not null,
  op_code     text,
  op_seq      numeric,
  op_name     text,
  work_center text,
  updated_at  timestamptz not null default now(),
  primary key (company_id, order_id, stage_id)
);

create table if not exists public.erp_outbox(
  id           bigint generated always as identity primary key,
  company_id   uuid not null references public.companies(id) on delete cascade,
  event_type   text not null check (event_type in ('sign', 'unsign')),
  work_log_id  text not null,
  order_id     text,
  stage_id     text,
  -- for an unsign: the sign it takes back
  reverses_id  bigint references public.erp_outbox(id) on delete set null,
  payload      jsonb not null,
  -- pending → sent → acked | failed.  unmapped: no Priority operation is known
  -- for this stage of this work order yet (it is re-queued when one arrives).
  -- cancelled: taken back before it was ever delivered.
  status       text not null default 'pending'
               check (status in ('pending', 'sent', 'acked', 'failed', 'unmapped', 'cancelled')),
  attempts     integer not null default 0,
  error        text,
  priority_ref text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  acked_at     timestamptz
);
create index if not exists erp_outbox_queue_idx on public.erp_outbox(company_id, status, id);
create index if not exists erp_outbox_log_idx on public.erp_outbox(company_id, work_log_id, id desc);
create index if not exists erp_outbox_order_idx on public.erp_outbox(company_id, order_id, stage_id);
create index if not exists work_logs_bulk_group_idx on public.work_logs(bulk_group_id) where bulk_group_id is not null;

-- Nobody reads these tables directly: the app goes through erp_* functions
-- (admins only) and Engini through the Edge Function.
alter table public.erp_connections enable row level security;
alter table public.erp_inbox       enable row level security;
alter table public.erp_order_ops   enable row level security;
alter table public.erp_outbox      enable row level security;
revoke all on public.erp_connections, public.erp_inbox, public.erp_order_ops, public.erp_outbox from anon, authenticated;

-- ── Outbox: every stage sign-off goes back to Priority ────────────────────
create or replace function private.erp_sign_payload(w public.work_logs) returns jsonb
language sql stable security definer set search_path = '' as $$
  with g as (
    select case when w.bulk_group_id is null then 1
                else greatest(1, (select count(*) from public.work_logs x
                                   where x.bulk_group_id = w.bulk_group_id and x.company_id = w.company_id))
           end as size
  ), q as (
    select case when w.serial_id is null and coalesce(w.bulk_count, 0) > 0 then w.bulk_count else 1 end as units
  )
  select jsonb_build_object(
    'type', 'sign',
    'work_log_id', w.id,
    'wo_number', o.wo_number,
    'pn', o.pn,
    'operation', case when op.stage_id is null then null else jsonb_build_object(
        'code', op.op_code, 'seq', op.op_seq, 'name', op.op_name, 'work_center', op.work_center) end,
    'stage_id', w.stage_id,
    'stage_name', st.name,
    'serial_number', nullif(w.serial_sn, ''),
    'quantity', q.units,
    'worker_id', w.user_id,
    'worker_name', w.user_name,
    'start_time', w.start_time,
    'end_time', w.end_time,
    -- net working minutes: pauses (הפסקה / HOLD) are already taken out
    'duration_min', w.duration_min,
    'pause_min', w.total_pause_min,
    -- a group of units started together carries the group's time on every unit
    'group_id', w.bulk_group_id,
    'group_size', g.size,
    'minutes_per_unit', round(w.duration_min / (g.size * q.units)::numeric, 2))
  from g, q
  left join public.orders o on o.id = w.order_id and o.company_id = w.company_id
  left join public.stages st on st.id = w.stage_id
  left join public.erp_order_ops op
         on op.company_id = w.company_id and op.order_id = w.order_id and op.stage_id = w.stage_id
$$;

create or replace function private.erp_capture_sign_off() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  cid uuid := coalesce(case when tg_op <> 'DELETE' then new.company_id end, old.company_id);
  was_signed boolean := false;
  is_signed  boolean := false;
  prev public.erp_outbox;
  p jsonb;
begin
  if not exists (select 1 from public.erp_connections c where c.company_id = cid and c.two_way) then
    return null;
  end if;
  -- Priority's own progress (the import's stand-in worker) never goes back to it.
  if tg_op <> 'INSERT' then
    was_signed := old.completed and old.user_id <> 'priority_import'
                  and old.order_id is not null and old.stage_id is not null;
  end if;
  if tg_op <> 'DELETE' then
    is_signed := new.completed and new.user_id <> 'priority_import'
                 and new.order_id is not null and new.stage_id is not null;
  end if;
  if tg_op = 'UPDATE' and was_signed and is_signed
     and (new.order_id, new.stage_id, new.serial_id, new.serial_sn, new.bulk_count, new.duration_min,
          new.user_id, new.start_time, new.end_time, new.total_pause_min)
         is not distinct from
         (old.order_id, old.stage_id, old.serial_id, old.serial_sn, old.bulk_count, old.duration_min,
          old.user_id, old.start_time, old.end_time, old.total_pause_min) then
    return null;
  end if;

  if was_signed then
    select * into prev from public.erp_outbox
     where company_id = cid and work_log_id = old.id order by id desc limit 1;
    if prev.id is not null and prev.event_type = 'sign' then
      if prev.status in ('pending', 'unmapped', 'failed') then
        -- never reached Priority: nothing to take back there
        update public.erp_outbox set status = 'cancelled' where id = prev.id;
      elsif prev.status in ('sent', 'acked') then
        insert into public.erp_outbox(company_id, event_type, work_log_id, order_id, stage_id, reverses_id, payload, status)
        values (cid, 'unsign', old.id, prev.order_id, prev.stage_id, prev.id,
                (prev.payload - 'type') || jsonb_build_object('type', 'unsign', 'reverses_event_id', prev.id,
                                                              'priority_ref', prev.priority_ref),
                'pending');
      end if;
    end if;
  end if;

  if is_signed then
    p := private.erp_sign_payload(new);
    insert into public.erp_outbox(company_id, event_type, work_log_id, order_id, stage_id, payload, status)
    values (cid, 'sign', new.id, new.order_id, new.stage_id, p,
            case when p -> 'operation' is null or jsonb_typeof(p -> 'operation') = 'null' then 'unmapped' else 'pending' end);
  end if;
  return null;
end $$;

drop trigger if exists work_logs_erp_outbox on public.work_logs;
create trigger work_logs_erp_outbox
  after insert or update or delete on public.work_logs
  for each row execute function private.erp_capture_sign_off();

-- ── Admin side (the 🔌 Priority card in the app) ──────────────────────────
create or replace function private.require_admin() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare cid uuid := private.company_id();
begin
  if cid is null or private.app_role() is distinct from 'admin' then
    raise exception 'admins only' using errcode = '42501';
  end if;
  return cid;
end $$;

-- A fresh API key for Engini. Shown once; only its hash is kept. Creating a
-- new one retires the old one immediately.
create or replace function public.erp_create_key() returns text
language plpgsql security definer set search_path = '' as $$
declare cid uuid := private.require_admin(); k text;
begin
  k := 'ov_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.erp_connections(company_id, key_hash, key_hint, key_created_at)
  values (cid, private.sha256_hex(k), right(k, 4), now())
  on conflict (company_id) do update
     set key_hash = excluded.key_hash, key_hint = excluded.key_hint,
         key_created_at = excluded.key_created_at, updated_at = now();
  return k;
end $$;

create or replace function public.erp_revoke_key() returns void
language sql security definer set search_path = '' as $$
  update public.erp_connections set key_hash = null, key_hint = null, updated_at = now()
   where company_id = private.require_admin()
$$;

-- Any argument left null is left as it is. stage_map is merged, not replaced.
create or replace function public.erp_update_settings(p_two_way boolean default null,
  p_options jsonb default null, p_stage_map jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
declare cid uuid := private.require_admin();
begin
  insert into public.erp_connections(company_id) values (cid) on conflict (company_id) do nothing;
  update public.erp_connections
     set two_way   = coalesce(p_two_way, two_way),
         options   = coalesce(p_options, options),
         stage_map = stage_map || coalesce(p_stage_map, '{}'::jsonb),
         updated_at = now()
   where company_id = cid;
end $$;

create or replace function public.erp_retry_failed() returns integer
language plpgsql security definer set search_path = '' as $$
declare cid uuid := private.require_admin(); n integer;
begin
  update public.erp_outbox set status = 'pending', error = null
   where company_id = cid and status = 'failed';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.erp_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  with me as (select private.require_admin() as cid)
  select jsonb_build_object(
    'connection', (select to_jsonb(c) - 'key_hash' - 'lock_holder' - 'stage_map'
                          || jsonb_build_object('has_key', c.key_hash is not null,
                                                'mapped_ops', (select count(*) from jsonb_object_keys(c.stage_map)))
                     from public.erp_connections c, me where c.company_id = me.cid),
    'outbox', (select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
                 from (select e.status, count(*) n from public.erp_outbox e, me
                        where e.company_id = me.cid group by e.status) s),
    'inbox', (select coalesce(jsonb_agg(to_jsonb(i) - 'company_id' order by i.id desc), '[]'::jsonb)
                from (select x.* from public.erp_inbox x, me where x.company_id = me.cid order by x.id desc limit 10) i),
    'problems', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'status', e.status, 'error', e.error,
                          'wo_number', e.payload ->> 'wo_number', 'stage_name', e.payload ->> 'stage_name',
                          'created_at', e.created_at) order by e.id desc), '[]'::jsonb)
                   from (select x.* from public.erp_outbox x, me where x.company_id = me.cid
                           and x.status in ('failed', 'unmapped') order by x.id desc limit 20) e))
$$;

revoke execute on function public.erp_create_key(), public.erp_revoke_key(),
  public.erp_update_settings(boolean, jsonb, jsonb), public.erp_retry_failed(), public.erp_status()
  from public, anon;
grant execute on function public.erp_create_key(), public.erp_revoke_key(),
  public.erp_update_settings(boolean, jsonb, jsonb), public.erp_retry_failed(), public.erp_status()
  to authenticated;

-- ── Engini side (the erp Edge Function, service role) ─────────────────────
create or replace function public.svc_erp_auth(p_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('company_id', c.company_id, 'two_way', c.two_way,
                            'options', c.options, 'stage_map', c.stage_map)
    from public.erp_connections c
   where c.key_hash = private.sha256_hex(p_key) and coalesce(p_key, '') <> ''
$$;

-- One batch at a time per company: two at once could both decide an
-- operation needs a new stage, and create it twice.
create or replace function public.svc_erp_lock(p_company uuid, p_holder text, p_seconds integer default 120)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.erp_connections
     set lock_holder = p_holder, lock_until = now() + make_interval(secs => p_seconds)
   where company_id = p_company and (lock_until is null or lock_until < now() or lock_holder = p_holder);
  get diagnostics n = row_count;
  return n > 0;
end $$;

create or replace function public.svc_erp_unlock(p_company uuid, p_holder text) returns void
language sql security definer set search_path = '' as $$
  update public.erp_connections set lock_holder = null, lock_until = null
   where company_id = p_company and lock_holder = p_holder
$$;

-- Everything priBuild / priMergePlan need for one batch, in one round trip.
create or replace function public.svc_erp_load(p_company uuid, p_wo_keys text[], p_pns text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  with ord as (
    select o.* from public.orders o
     where o.company_id = p_company and lower(btrim(o.wo_number)) = any(p_wo_keys)
  ), ids as (select array_agg(id) as a from ord)
  select jsonb_build_object(
    'stages',   (select coalesce(jsonb_agg(to_jsonb(s) order by s.stage_order, s.id), '[]'::jsonb)
                   from public.stages s where s.company_id = p_company),
    'projects', (select coalesce(jsonb_agg(to_jsonb(p) order by p.name, p.id), '[]'::jsonb)
                   from public.projects p where p.company_id = p_company),
    'pn_standards', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                   from public.pn_standards x where x.company_id = p_company and btrim(x.pn) = any(p_pns)),
    'orders',   (select coalesce(jsonb_agg(to_jsonb(o) order by o.created_at, o.id), '[]'::jsonb) from ord o),
    -- the last import's progress records — the only ones a re-import replaces
    'erp_logs', (select coalesce(jsonb_agg(to_jsonb(w)), '[]'::jsonb)
                   from public.work_logs w, ids
                  where w.company_id = p_company and w.order_id = any(ids.a) and w.user_id = 'priority_import'),
    -- what people signed in the app, per stage: the units Priority must not be
    -- credited with twice
    'app_done', (select coalesce(jsonb_agg(jsonb_build_object('order_id', order_id, 'stage_id', stage_id,
                          'serial_ids', serial_ids, 'qty', qty)), '[]'::jsonb)
                   from (select w.order_id, w.stage_id,
                                coalesce(jsonb_agg(distinct w.serial_id) filter (where w.serial_id is not null), '[]'::jsonb) serial_ids,
                                coalesce(sum(w.bulk_count) filter (where w.serial_id is null), 0) qty
                           from public.work_logs w, ids
                          where w.company_id = p_company and w.order_id = any(ids.a) and w.completed
                            and w.user_id <> 'priority_import' and w.stage_id is not null
                          group by w.order_id, w.stage_id) d),
    -- units the app has already reported to Priority (acknowledged and not
    -- taken back), per stage — Priority's own count includes them
    'acked', (select coalesce(jsonb_agg(jsonb_build_object('order_id', order_id, 'stage_id', stage_id, 'units', units)), '[]'::jsonb)
                from (select order_id, stage_id, sum(units) units from (
                        select distinct on (e.work_log_id) e.work_log_id, e.order_id, e.stage_id, e.event_type,
                               coalesce((e.payload ->> 'quantity')::numeric, 1) units
                          from public.erp_outbox e, ids
                         where e.company_id = p_company and e.order_id = any(ids.a) and e.status = 'acked'
                         order by e.work_log_id, e.id desc) last_state
                       where event_type = 'sign' group by order_id, stage_id) a))
$$;

-- Writes one batch, all or nothing. Every row is forced into p_company,
-- whatever the payload says.
create or replace function public.svc_erp_apply(p_company uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n_added int := 0; n_updated int := 0; n_logs int := 0; n_dropped int := 0; n_requeued int := 0;
  inbox_id bigint;
begin
  insert into public.stages(id, name, stage_order, color, price, hourly_rate, role_id, minutes, company_id)
  select r.id, r.name, coalesce(r.stage_order, 0), coalesce(r.color, '#3b82f6'), coalesce(r.price, 0),
         coalesce(r.hourly_rate, 0), r.role_id, coalesce(r.minutes, 0), p_company
    from jsonb_populate_recordset(null::public.stages, coalesce(p -> 'new_stages', '[]')) r
  on conflict (id) do nothing;

  insert into public.projects(id, name, company_id)
  select r.id, r.name, p_company
    from jsonb_populate_recordset(null::public.projects, coalesce(p -> 'new_projects', '[]')) r
  on conflict (id) do nothing;

  -- New work orders. The unique index on (company, מספר פק"ע) makes a second
  -- copy impossible: if one slipped in from elsewhere this fails, the whole
  -- batch rolls back, and Engini's retry finds the order and updates it.
  insert into public.orders(id, wo_number, pn, description, qty, unit_price, project_id, branch,
                            received_date, target_date, stage_ids, block_id, serials, shortages, defects,
                            delivered_serials, status, erp_status, erp_note, company_id)
  select r.id, r.wo_number, r.pn, r.description, coalesce(r.qty, 0), coalesce(r.unit_price, 0), r.project_id, r.branch,
         r.received_date, r.target_date, coalesce(r.stage_ids, '[]'), r.block_id, coalesce(r.serials, '[]'),
         coalesce(r.shortages, '[]'), coalesce(r.defects, '[]'), coalesce(r.delivered_serials, '[]'),
         coalesce(r.status, 'open'), r.erp_status, r.erp_note, p_company
    from jsonb_populate_recordset(null::public.orders, coalesce(p -> 'added_orders', '[]')) r;
  get diagnostics n_added = row_count;

  -- Existing work orders: only the fields the ERP owns. Defects, shortages,
  -- deliveries and the floor's own changes are left exactly as they are; the
  -- serial list is only ever extended (by the merge plan), never shortened.
  update public.orders o
     set pn = coalesce(r.pn, o.pn), description = coalesce(r.description, o.description),
         qty = coalesce(r.qty, o.qty), unit_price = coalesce(r.unit_price, o.unit_price),
         project_id = coalesce(r.project_id, o.project_id), branch = coalesce(r.branch, o.branch),
         received_date = coalesce(r.received_date, o.received_date), target_date = coalesce(r.target_date, o.target_date),
         stage_ids = coalesce(r.stage_ids, o.stage_ids),
         serials = case when (u.j -> 'serials') is null or jsonb_typeof(u.j -> 'serials') = 'null' then o.serials else r.serials end,
         status = coalesce(r.status, o.status), erp_status = coalesce(r.erp_status, o.erp_status),
         erp_note = case when u.j ? 'erp_note' then r.erp_note else o.erp_note end
    from jsonb_array_elements(coalesce(p -> 'updated_orders', '[]')) u(j),
         lateral jsonb_populate_record(null::public.orders, u.j) r
   where o.id = r.id and o.company_id = p_company;
  get diagnostics n_updated = row_count;

  -- Only the import's own stand-in records are ever removed or rewritten here;
  -- a person's work is never touched by the ERP.
  delete from public.work_logs w
   where w.company_id = p_company and w.user_id = 'priority_import'
     and w.id in (select jsonb_array_elements_text(coalesce(p -> 'drop_log_ids', '[]')));
  get diagnostics n_dropped = row_count;

  insert into public.work_logs(id, user_id, user_name, serial_id, serial_sn, stage_id, order_id, start_time, end_time,
                               completed, duration_min, paused, pause_start, total_pause_min, pause_log, bulk,
                               bulk_group_id, bulk_count, hold_info, company_id)
  select r.id, 'priority_import', coalesce(r.user_name, 'ייבוא Priority'), r.serial_id, r.serial_sn, r.stage_id, r.order_id,
         r.start_time, r.end_time, coalesce(r.completed, true), coalesce(r.duration_min, 0), false, null, 0,
         '[]'::jsonb, coalesce(r.bulk, false), null, r.bulk_count, null, p_company
    from jsonb_populate_recordset(null::public.work_logs, coalesce(p -> 'logs', '[]')) r
  on conflict (id) do update
     set serial_id = excluded.serial_id, serial_sn = excluded.serial_sn, stage_id = excluded.stage_id,
         order_id = excluded.order_id, start_time = excluded.start_time, end_time = excluded.end_time,
         completed = excluded.completed, bulk = excluded.bulk, bulk_count = excluded.bulk_count
   where public.work_logs.company_id = p_company and public.work_logs.user_id = 'priority_import';
  get diagnostics n_logs = row_count;

  insert into public.pn_standards(id, pn, stage_minutes, total_min, note, updated_by, company_id)
  select r.id, r.pn, coalesce(r.stage_minutes, '{}'), coalesce(r.total_min, 0), r.note, r.updated_by, p_company
    from jsonb_populate_recordset(null::public.pn_standards, coalesce(p -> 'stds', '[]')) r
  on conflict (id) do update
     set stage_minutes = excluded.stage_minutes, updated_by = excluded.updated_by
   where public.pn_standards.company_id = p_company;

  insert into public.erp_order_ops(company_id, order_id, stage_id, wo_number, op_code, op_seq, op_name, work_center)
  select p_company, r.order_id, r.stage_id, r.wo_number, r.op_code, r.op_seq, r.op_name, r.work_center
    from jsonb_to_recordset(coalesce(p -> 'order_ops', '[]'))
         as r(order_id text, stage_id text, wo_number text, op_code text, op_seq numeric, op_name text, work_center text)
   where r.order_id is not null and r.stage_id is not null
  on conflict (company_id, order_id, stage_id) do update
     set wo_number = excluded.wo_number, op_code = excluded.op_code, op_seq = excluded.op_seq,
         op_name = excluded.op_name, work_center = excluded.work_center, updated_at = now();

  -- Sign-offs that were waiting for this operation to be known go out now.
  update public.erp_outbox e
     set payload = e.payload || jsonb_build_object('operation', jsonb_build_object(
                     'code', op.op_code, 'seq', op.op_seq, 'name', op.op_name, 'work_center', op.work_center),
                     'wo_number', op.wo_number),
         status = 'pending'
    from public.erp_order_ops op
   where e.company_id = p_company and e.status = 'unmapped'
     and op.company_id = p_company and op.order_id = e.order_id and op.stage_id = e.stage_id;
  get diagnostics n_requeued = row_count;

  update public.erp_connections
     set stage_map = stage_map || coalesce(p -> 'stage_map', '{}'::jsonb), last_inbound_at = now()
   where company_id = p_company;

  insert into public.erp_inbox(company_id, batch_ref, rows_count, wos_count, result)
  values (p_company, p ->> 'batch_ref', (p ->> 'rows_count')::int, (p ->> 'wos_count')::int,
          coalesce(p -> 'summary', '{}'::jsonb) || jsonb_build_object('added', n_added, 'updated', n_updated,
            'logs_written', n_logs, 'logs_dropped', n_dropped, 'requeued', n_requeued))
  returning id into inbox_id;

  return jsonb_build_object('inbox_id', inbox_id, 'added', n_added, 'updated', n_updated,
                            'logs_written', n_logs, 'logs_dropped', n_dropped, 'requeued_sign_offs', n_requeued);
end $$;

-- Hands Engini the next sign-offs to report, oldest first. An event handed
-- out and not acknowledged within the lease comes back: delivery is
-- at-least-once, so Engini must treat event_id as an idempotency key.
create or replace function public.svc_erp_outbox_take(p_company uuid, p_limit integer default 100,
  p_lease_seconds integer default 600) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare out jsonb;
begin
  with picked as (
    select e.id from public.erp_outbox e
     where e.company_id = p_company
       and (e.status = 'pending' or (e.status = 'sent' and e.sent_at < now() - make_interval(secs => p_lease_seconds)))
     order by e.id
     limit greatest(1, least(coalesce(p_limit, 100), 500))
     for update skip locked
  ), upd as (
    update public.erp_outbox e set status = 'sent', sent_at = now(), attempts = e.attempts + 1
      from picked where e.id = picked.id
    returning e.*
  )
  select coalesce(jsonb_agg(u.payload || jsonb_build_object('event_id', u.id, 'type', u.event_type,
                                                            'created_at', u.created_at, 'attempt', u.attempts)
                            order by u.id), '[]'::jsonb)
    into out from upd u;
  update public.erp_connections set last_outbound_at = now() where company_id = p_company;
  return out;
end $$;

-- [{event_id, ok, error?, priority_ref?, retry?}] — ok:false with retry:true
-- puts the event back in the queue; without it the event stays failed until an
-- admin presses "נסה שוב".
create or replace function public.svc_erp_outbox_ack(p_company uuid, p_acks jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n_ok int := 0; n_bad int := 0;
begin
  update public.erp_outbox e
     set status = 'acked', acked_at = now(), error = null,
         priority_ref = coalesce(a.priority_ref, e.priority_ref)
    from jsonb_to_recordset(coalesce(p_acks, '[]')) as a(event_id bigint, ok boolean, error text, priority_ref text, retry boolean)
   where e.company_id = p_company and e.id = a.event_id and a.ok and e.status in ('sent', 'pending', 'failed');
  get diagnostics n_ok = row_count;
  update public.erp_outbox e
     set status = case when coalesce(a.retry, false) then 'pending' else 'failed' end,
         error = left(coalesce(a.error, 'נכשל ב-Engini'), 2000)
    from jsonb_to_recordset(coalesce(p_acks, '[]')) as a(event_id bigint, ok boolean, error text, priority_ref text, retry boolean)
   where e.company_id = p_company and e.id = a.event_id and not coalesce(a.ok, false) and e.status in ('sent', 'pending');
  get diagnostics n_bad = row_count;
  return jsonb_build_object('acked', n_ok, 'failed', n_bad);
end $$;

revoke execute on function public.svc_erp_auth(text), public.svc_erp_lock(uuid, text, integer),
  public.svc_erp_unlock(uuid, text), public.svc_erp_load(uuid, text[], text[]), public.svc_erp_apply(uuid, jsonb),
  public.svc_erp_outbox_take(uuid, integer, integer), public.svc_erp_outbox_ack(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.svc_erp_auth(text), public.svc_erp_lock(uuid, text, integer),
  public.svc_erp_unlock(uuid, text), public.svc_erp_load(uuid, text[], text[]), public.svc_erp_apply(uuid, jsonb),
  public.svc_erp_outbox_take(uuid, integer, integer), public.svc_erp_outbox_ack(uuid, jsonb)
  to service_role;

-- Nothing in the private schema is callable from the API except the helpers
-- the row-level policies are written with.
revoke execute on all functions in schema private from public, authenticated;
grant execute on function private.app_user_id(), private.company_id(), private.app_role(),
  private.can_write(), private.managed_dept_ids(), private.may_administer(uuid, text, text, text),
  private.can_manage_user(text) to authenticated, service_role;

-- The two pre-existing trigger functions the security advisor flagged.
alter function public.touch_updated_at() set search_path = '';
alter function public.work_logs_touch_updated_at() set search_path = '';
