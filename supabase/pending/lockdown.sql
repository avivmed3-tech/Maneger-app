-- ════════════════════════════════════════════════════════════════════════════
-- Phase 2 of 2 — lockdown. RUN ONLY AFTER the new client is deployed.
-- ════════════════════════════════════════════════════════════════════════════
-- From this moment the public anon key opens nothing: every row is reachable
-- only with a signed-in user's token, and only inside that user's company.
-- A device still running the old client (it logs in by comparing hashes it
-- reads from app_users) is locked out until it reloads into the new one.
--
-- Run it when no shift is open — see docs/ENGINI-PRIORITY.md, "סדר ההפעלה".
-- Once applied, move this file into supabase/migrations/ under the timestamp
-- it was applied with.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. The passwords leave the public table ───────────────────────────────
-- One last copy of whatever the old client wrote since phase 1, then the
-- columns go. From here a password exists only encrypted, in private.
insert into private.user_secrets as s (app_user_id, company_id, pw_enc, legacy_sha256)
select u.id, u.company_id, private.pw_encrypt(nullif(u.password_plain, '')), nullif(u.password_hash, '')
  from public.app_users u
on conflict (app_user_id) do update
   set company_id = excluded.company_id,
       pw_enc = case
                  when excluded.pw_enc is not null then excluded.pw_enc
                  when s.pw_enc is not null and excluded.legacy_sha256 is not null
                       and private.sha256_hex(private.pw_decrypt(s.pw_enc)) <> excluded.legacy_sha256 then null
                  else s.pw_enc
                end,
       legacy_sha256 = case
                         when s.pw_enc is not null and excluded.legacy_sha256 is not null
                              and private.sha256_hex(private.pw_decrypt(s.pw_enc)) = excluded.legacy_sha256 then null
                         else coalesce(excluded.legacy_sha256, s.legacy_sha256)
                       end,
       updated_at = now();

drop trigger if exists app_users_capture_legacy_password on public.app_users;
alter table public.app_users drop column if exists password_plain;
alter table public.app_users drop column if exists password_hash;

-- ── 2. No more open policies ──────────────────────────────────────────────
do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies
            where schemaname = 'public'
              and tablename in ('app_users','audit_log','companies','custom_tasks','daily_plans','departments',
                                'orders','plan_features','pn_standards','projects','stage_blocks','stages',
                                'subscriptions','work_logs') loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

revoke all on all tables in schema public from anon;
grant select on public.plan_features to anon;

-- ── 3. Per-company access for signed-in users ─────────────────────────────
-- The company and role come from app_users (private.company_id / can_write),
-- so a deactivated user loses access on their very next request.
do $$
declare t text;
begin
  foreach t in array array['orders','work_logs','custom_tasks','daily_plans','projects','stages',
                           'stage_blocks','departments','pn_standards'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy company_read on public.%I for select to authenticated
                     using (company_id = (select private.company_id()))$p$, t);
    execute format($p$create policy company_insert on public.%I for insert to authenticated
                     with check (company_id = (select private.company_id()) and (select private.can_write()))$p$, t);
    execute format($p$create policy company_update on public.%I for update to authenticated
                     using (company_id = (select private.company_id()) and (select private.can_write()))
                     with check (company_id = (select private.company_id()))$p$, t);
    execute format($p$create policy company_delete on public.%I for delete to authenticated
                     using (company_id = (select private.company_id()) and (select private.can_write()))$p$, t);
  end loop;
end $$;

-- The activity journal: everyone in the company writes their own login and
-- logout to it (a viewer included); changing it is for those who can write.
create policy company_read on public.audit_log for select to authenticated
  using (company_id = (select private.company_id()));
create policy company_insert on public.audit_log for insert to authenticated
  with check (company_id = (select private.company_id()));
create policy company_update on public.audit_log for update to authenticated
  using (company_id = (select private.company_id()) and (select private.can_write()))
  with check (company_id = (select private.company_id()));
create policy company_delete on public.audit_log for delete to authenticated
  using (company_id = (select private.company_id()) and (select private.can_write()));

-- Users: everyone in the company sees the list (names on the floor); only
-- an admin, or a department manager for their own people, changes it — and
-- only an admin can make anyone an admin.
create policy company_read on public.app_users for select to authenticated
  using (company_id = (select private.company_id()));
create policy admin_insert on public.app_users for insert to authenticated
  with check (private.may_administer(company_id, role, department_id, id));
create policy admin_update on public.app_users for update to authenticated
  using (private.may_administer(company_id, role, department_id, id))
  with check (private.may_administer(company_id, role, department_id, id));
create policy admin_delete on public.app_users for delete to authenticated
  using (private.may_administer(company_id, role, department_id, id) and id <> (select private.app_user_id()));

-- Login bookkeeping belongs to the server. A user record saved by the app
-- carries whatever the app last read, which must not reset a lockout.
-- Deliberately not security definer: current_user is then the caller — the
-- signed-in user for a write from the app, the function owner for the svc_*
-- functions that keep this bookkeeping.
create or replace function private.app_users_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.login_attempts := 0; new.locked_until := null; new.last_login := null;
    else
      new.login_attempts := old.login_attempts; new.locked_until := old.locked_until;
      new.last_login := old.last_login; new.password_changed_at := old.password_changed_at;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists app_users_guard on public.app_users;
create trigger app_users_guard before insert or update on public.app_users
  for each row execute function private.app_users_guard();

-- Companies and plans: your own, read-only — except an admin renaming theirs.
-- New companies come only through the sign-up function, plans only from billing.
create policy own_company_read on public.companies for select to authenticated
  using (id = (select private.company_id()));
create policy own_company_admin_update on public.companies for update to authenticated
  using (id = (select private.company_id()) and (select private.app_role()) = 'admin')
  with check (id = (select private.company_id()));
create policy own_subscription_read on public.subscriptions for select to authenticated
  using (company_id = (select private.company_id()));
create policy plan_catalogue_read on public.plan_features for select to anon, authenticated using (true);

-- ── 4. One row per מספר פק"ע ──────────────────────────────────────────────
-- The guarantee everything else leans on: whatever writes an order — the
-- Excel import, Engini, a manager typing one in — a second row with the same
-- work-order number in the same company is refused by the database itself.
create unique index if not exists orders_company_wo_unique
  on public.orders (company_id, lower(btrim(wo_number)))
  where btrim(wo_number) <> '';
