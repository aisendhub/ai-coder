-- Env vars for services. See docs/ENV-AND-SERVICES.md.
--
-- Three persisted layers (later overrides earlier):
--   1. Project default — committed in repo as .ai-coder/env.example. Not a DB
--      concern; loaded from disk by the agent on demand.
--   2. project_env_vars  — gitignored project-shared layer. This table.
--   3. conversation_env_vars — worktree-scoped layer. Cleaned via FK CASCADE.
-- Plus existing project_services.env (per-service) at the bottom.
--
-- Plus runtime layers (not persisted): auto-injected service-discovery vars
-- (WORKTREES_SVC_<NAME>_URL/HOST/PORT) and system metadata (WORKTREES_PROJECT_ID
-- etc), populated at process spawn from the live registry.

-- Project-shared layer.
create table public.project_env_vars (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  key text not null check (key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  -- Plaintext for non-secrets. AES-encrypted blob (server/integrations/crypto.ts)
  -- for secrets. Server-side decrypt only; never returned in clear from the
  -- API once is_secret = true.
  value text not null,
  is_secret boolean not null default false,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, key)
);

comment on table public.project_env_vars is
  'Project-shared env vars. Layer 2 in the resolution chain (overrides committed defaults, overridden by conversation/service layers).';

create index project_env_vars_project_idx on public.project_env_vars (project_id);

-- Per-conversation (worktree) overrides. Cleaned up automatically when the
-- conversation is hard-deleted (reaper or manual prune).
create table public.conversation_env_vars (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  key text not null check (key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  value text not null,
  is_secret boolean not null default false,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, key)
);

comment on table public.conversation_env_vars is
  'Per-conversation (worktree) env overrides. Layer 3 in the resolution chain.';

create index conversation_env_vars_conv_idx on public.conversation_env_vars (conversation_id);

-- updated_at maintenance (mirrors the trigger style used for project_services).
create or replace function public.touch_env_vars_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger project_env_vars_touch_updated_at
  before update on public.project_env_vars
  for each row execute function public.touch_env_vars_updated_at();

create trigger conversation_env_vars_touch_updated_at
  before update on public.conversation_env_vars
  for each row execute function public.touch_env_vars_updated_at();

-- RLS: ownership flows through projects.user_id (project_env_vars) or via the
-- conversation → project chain (conversation_env_vars).

alter table public.project_env_vars enable row level security;

create policy "project_env_vars_select_own" on public.project_env_vars
  for select using (
    exists (
      select 1 from public.projects p
      where p.id = project_env_vars.project_id and p.user_id = auth.uid()
    )
  );

create policy "project_env_vars_insert_own" on public.project_env_vars
  for insert with check (
    exists (
      select 1 from public.projects p
      where p.id = project_env_vars.project_id and p.user_id = auth.uid()
    )
  );

create policy "project_env_vars_update_own" on public.project_env_vars
  for update using (
    exists (
      select 1 from public.projects p
      where p.id = project_env_vars.project_id and p.user_id = auth.uid()
    )
  );

create policy "project_env_vars_delete_own" on public.project_env_vars
  for delete using (
    exists (
      select 1 from public.projects p
      where p.id = project_env_vars.project_id and p.user_id = auth.uid()
    )
  );

alter table public.conversation_env_vars enable row level security;

create policy "conversation_env_vars_select_own" on public.conversation_env_vars
  for select using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_env_vars.conversation_id and c.user_id = auth.uid()
    )
  );

create policy "conversation_env_vars_insert_own" on public.conversation_env_vars
  for insert with check (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_env_vars.conversation_id and c.user_id = auth.uid()
    )
  );

create policy "conversation_env_vars_update_own" on public.conversation_env_vars
  for update using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_env_vars.conversation_id and c.user_id = auth.uid()
    )
  );

create policy "conversation_env_vars_delete_own" on public.conversation_env_vars
  for delete using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_env_vars.conversation_id and c.user_id = auth.uid()
    )
  );
