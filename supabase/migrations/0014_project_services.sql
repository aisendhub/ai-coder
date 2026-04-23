-- Multi-service per project. See docs/MULTI-SERVICE.md.
--
-- Today: one manifest per project (projects.run_manifest jsonb).
-- After: one row per service (web, api, worker, …) in project_services,
-- so monorepos and multi-process apps can configure each independently.
--
-- Phase 9.1 scope: schema + backfill. No endpoints yet reach this table;
-- reads continue to work via the existing projects.run_manifest column
-- until the read-path abstraction ships in server/services-store.ts.
-- Legacy columns kept for one release in case we need to roll back.

create table public.project_services (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Stable short identifier within a project ('web', 'api', 'worker').
  -- Lowercase-ish convention by UI; DB stores whatever the user saved.
  name text not null,
  description text,
  -- Mirror of RunManifest (server/runtime/manifest.ts). cwd is NOT stored —
  -- derived from projects.cwd / conversations.worktree_path at run time.
  stack text not null,
  start text not null,
  build text,
  env jsonb not null default '{}'::jsonb,
  port int,
  dockerfile text,
  healthcheck jsonb,
  -- Included in "Run all". Toggle without deleting the row.
  enabled boolean not null default true,
  -- Display order in the panel; also the "Run all" start order.
  order_index int not null default 0,
  -- PM2-style supervisor settings, honored by registry (Phase 9.8).
  restart_policy text not null default 'on-failure'
    check (restart_policy in ('always', 'on-failure', 'never')),
  max_restarts int not null default 5 check (max_restarts >= 0),
  -- Stable localhost port across restarts. Registry tries this first via
  -- allocatePort(preferred); falls back to the 4100-4999 sandbox if taken.
  assigned_port int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One service name per project — user-visible uniqueness.
  unique (project_id, name)
);

comment on table public.project_services is
  'One row per service configuration within a project. Replaces the single projects.run_manifest.';
comment on column public.project_services.assigned_port is
  'Stable port across restarts. Tried first on spawn; falls back to sandbox range if unavailable.';

-- Keep sub-selects snappy when the panel loads the list for a project.
create index project_services_project_order_idx
  on public.project_services (project_id, order_index);

alter table public.project_services enable row level security;

-- Ownership derives via projects.user_id (standard pattern in this repo).
create policy "project_services_select_own" on public.project_services
  for select using (
    exists (
      select 1 from public.projects p
      where p.id = project_services.project_id and p.user_id = auth.uid()
    )
  );
create policy "project_services_insert_own" on public.project_services
  for insert with check (
    exists (
      select 1 from public.projects p
      where p.id = project_services.project_id and p.user_id = auth.uid()
    )
  );
create policy "project_services_update_own" on public.project_services
  for update using (
    exists (
      select 1 from public.projects p
      where p.id = project_services.project_id and p.user_id = auth.uid()
    )
  );
create policy "project_services_delete_own" on public.project_services
  for delete using (
    exists (
      select 1 from public.projects p
      where p.id = project_services.project_id and p.user_id = auth.uid()
    )
  );

-- Auto-touch updated_at on any row change.
create or replace function public.project_services_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;
create trigger project_services_touch
  before update on public.project_services
  for each row execute function public.project_services_touch_updated_at();

-- Per-conversation, per-service env/start overrides. Sparse: most tasks
-- won't set this. Shape: { "<serviceName>": { ...ManifestOverride }, ... }.
-- Supersedes conversations.run_manifest_override (kept for now).
alter table public.conversations
  add column service_overrides jsonb;
comment on column public.conversations.service_overrides is
  'Per-service ManifestOverride map keyed by service name. Replaces run_manifest_override.';

-- ─── Backfill ───────────────────────────────────────────────────────────────
-- Existing projects with a run_manifest get a single 'default' service row
-- with equivalent fields. No-op when a project already has a default row
-- (idempotent, in case this migration runs twice somehow).
insert into public.project_services (
  project_id, name, stack, start, build, env, port, dockerfile, healthcheck,
  enabled, order_index, restart_policy, max_restarts, assigned_port
)
select
  p.id,
  'default',
  coalesce(p.run_manifest->>'stack', 'custom'),
  coalesce(p.run_manifest->>'start', ''),
  p.run_manifest->>'build',
  coalesce(p.run_manifest->'env', '{}'::jsonb),
  nullif((p.run_manifest->>'port'), '')::int,
  p.run_manifest->>'dockerfile',
  p.run_manifest->'healthcheck',
  true,
  0,
  'on-failure',
  5,
  -- First assigned_port we find across the project's conversations. Good
  -- enough — if multiple worktrees picked different ports, first-writer wins
  -- and the registry re-probes on start anyway.
  (
    select c.assigned_port
    from public.conversations c
    where c.project_id = p.id
      and c.assigned_port is not null
    order by c.updated_at desc
    limit 1
  )
from public.projects p
where p.run_manifest is not null
  and (p.run_manifest->>'start') is not null
  and (p.run_manifest->>'start') <> ''
  and not exists (
    select 1 from public.project_services ps
    where ps.project_id = p.id and ps.name = 'default'
  );

-- Existing conversation overrides → service_overrides = {"default": override}.
update public.conversations
set service_overrides = jsonb_build_object('default', run_manifest_override)
where run_manifest_override is not null
  and service_overrides is null;
