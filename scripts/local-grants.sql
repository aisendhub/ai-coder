-- Grants for the local PostgREST roles. RLS still applies to `authenticated`;
-- `service_role` has BYPASSRLS. Run after supabase/migrations.
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to authenticated, service_role;

grant all on all tables in schema public to authenticated, service_role;
grant all on all sequences in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;

grant select on auth.users to authenticated, service_role;

alter default privileges in schema public
  grant all on tables to authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to authenticated, service_role;
