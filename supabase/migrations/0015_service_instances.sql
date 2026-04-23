-- Service instances — persistent record of running OS processes so a server
-- restart can reconcile and reattach (or mark stopped) instead of losing
-- track of the running app. See docs/MULTI-SERVICE.md § Phase 9.9.
--
-- Why: the registry is in-memory. A dev-server hot-reload or a prod deploy
-- would drop every service from the panel even though the OS processes are
-- still alive. With this table, on boot we reconcile via `kill(pid, 0)` and
-- either re-register the instance (external runner, same pid/port) or GC
-- the row.

create table public.service_instances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- (project_id, service_name, worktree_path) is the scope tuple; multiple
  -- historical rows may share it (restart history) but typically only one
  -- row is "live" (status in running|starting|stopping) at any time.
  service_name text not null,
  worktree_path text,
  runner_id text not null,
  pid int,
  port int not null,
  status text not null
    check (status in ('starting', 'running', 'stopping', 'stopped', 'crashed')),
  exit_code int,
  error text,
  label text,
  host text,
  started_at timestamptz not null default now(),
  stopped_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.service_instances is
  'Persistent record of spawned service processes. Reconciled on boot via kill(pid, 0).';

-- Single lookup we care about: "live instances for this (user, project)"
-- when rebuilding the in-memory registry on boot. Covering index on status
-- keeps the scan cheap even when the table grows (stopped rows accumulate).
create index service_instances_user_project_live_idx
  on public.service_instances (user_id, project_id, status);

-- Secondary for per-scope live lookups (panel filtering by worktree).
create index service_instances_scope_live_idx
  on public.service_instances (project_id, service_name, worktree_path, status);

alter table public.service_instances enable row level security;

create policy "service_instances_select_own" on public.service_instances
  for select using (auth.uid() = user_id);
create policy "service_instances_insert_own" on public.service_instances
  for insert with check (auth.uid() = user_id);
create policy "service_instances_update_own" on public.service_instances
  for update using (auth.uid() = user_id);
create policy "service_instances_delete_own" on public.service_instances
  for delete using (auth.uid() = user_id);
