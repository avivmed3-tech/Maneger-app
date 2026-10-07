-- The parts of a Supabase project the migrations lean on, rebuilt on a bare
-- Postgres so tools/db-test.js can run the real SQL without a Supabase stack.
--
-- auth.jwt() reads the same GUC PostgREST sets for every request, so a test
-- "logs in" with: set local request.jwt.claims = '{"app_metadata":{...}}'.
-- Vault is a plain table here — the real one encrypts at rest, which the code
-- under test never sees either way.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create schema extensions;
create schema vault;
create extension pgcrypto with schema extensions;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', current_user)
$$;

create table vault.secrets(
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text,
  secret text not null
);
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null,
  new_description text default '', new_key_id uuid default null) returns uuid
language sql as $$
  insert into vault.secrets(name, description, secret) values (new_name, new_description, new_secret) returning id
$$;

create publication supabase_realtime;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
