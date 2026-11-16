-- Local Postgres compatibility layer for ai-coder.
--
-- Supabase provides `auth.users` and `auth.uid()` out of the box. The app's
-- migrations and RLS policies depend on both. This file recreates just enough
-- of that surface for a local Postgres + PostgREST stack.
--
-- Run once after `createdb ai_coder`, before applying supabase/migrations.
-- Roles are cluster-wide, so this is idempotent.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  -- Not unique: AnyOAuth identities are never merged by email. The stable
  -- account key is `anyoauth_subject`.
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz,
  -- AnyOAuth identity. `subject` is stable per provider; email alone is not
  -- used to merge identities.
  anyoauth_subject text unique,
  anyoauth_provider text,
  anyoauth_username text,
  avatar_url text,
  email_verified boolean not null default false
);

create index if not exists users_anyoauth_subject_idx on auth.users (anyoauth_subject);

-- PostgREST exposes the verified JWT claims via `request.jwt.claims`.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif((current_setting('request.jwt.claims', true)::jsonb) ->> 'sub', '')::uuid
$$;

-- Realtime publication. The app's migrations add tables to it; local Postgres
-- does not have Supabase's publication pre-created.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'create publication supabase_realtime';
  end if;
end $$;
