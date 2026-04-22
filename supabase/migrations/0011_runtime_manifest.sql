-- Runtime manifest caching. See docs/RUNTIME.md.
--
-- Phase 2 of the runtime/deploy feature introduces per-project run manifests
-- (the "how to start this app" descriptor) and per-task overrides for when an
-- agent changes the start command on a worktree (e.g. npm → bun, Vite → Next).
--
--   projects.run_manifest              — the default for every task/chat in
--                                        this project. Cached once after
--                                        first-run detection, editable by the
--                                        user. cwd is NOT stored here; it's
--                                        always derived from projects.cwd.
--
--   conversations.run_manifest_override — sparse JSON patch over the project
--                                        default, applied at runtime by
--                                        mergeManifest(). Only tasks ever
--                                        write one; chats always use the
--                                        project default.
--
--   conversations.assigned_port        — stable port allocated on first
--                                        service start and kept for the life
--                                        of the worktree. Avoids the common
--                                        frustration of ports reshuffling
--                                        across restarts mid-task.

alter table public.projects
  add column run_manifest jsonb;

alter table public.conversations
  add column run_manifest_override jsonb,
  add column assigned_port int;

comment on column public.projects.run_manifest is
  'Cached RunManifest (server/runtime/manifest.ts): { stack, build?, start, env, port?, healthcheck?, dockerfile? }. cwd is derived from projects.cwd, not stored here.';
comment on column public.conversations.run_manifest_override is
  'Sparse patch over projects.run_manifest for this worktree. Merged at runtime via mergeManifest(). Only set when the task materially changes how the app runs.';
comment on column public.conversations.assigned_port is
  'Port assigned to this worktree on first service start. Retained so localhost:<port> stays stable across service restarts for the life of the task.';

-- No RLS changes — the new columns inherit the existing projects/conversations
-- policies (select/insert/update scoped to user_id).
