-- Worktree-scoped services. See docs/ENV-AND-SERVICES.md.
--
-- Today: project_services rows are project-scoped only. A task experimenting
-- with a new service has to add it to the project (polluting mainline) or
-- can only override existing services per-task.
-- After: project_services.conversation_id NULL = project-scoped (today's
-- behavior); set = scoped to that worktree only. FK CASCADE on conversation
-- delete cleans up automatically (reaper or manual prune both trip it).

alter table public.project_services
  add column conversation_id uuid
  references public.conversations(id) on delete cascade;

comment on column public.project_services.conversation_id is
  'NULL = project-scoped (visible to chats and all tasks). Set = worktree-scoped (visible only to that conversation). Cascades on conversation delete.';

-- Drop the old project-scoped uniqueness; the new constraint is across both
-- conversation_id and name so the same name can exist at project scope and
-- per-worktree without colliding. Postgres treats NULL as distinct in unique
-- constraints, so two rows with (project_id, NULL, name) would violate —
-- handle via a partial index for the project scope and a separate partial
-- index for the worktree scope.

alter table public.project_services
  drop constraint project_services_project_id_name_key;

create unique index project_services_project_default_name_uniq
  on public.project_services (project_id, name)
  where conversation_id is null;

create unique index project_services_project_worktree_name_uniq
  on public.project_services (project_id, conversation_id, name)
  where conversation_id is not null;

-- Lookup index for worktree-scoped reads.
create index project_services_conversation_idx
  on public.project_services (conversation_id)
  where conversation_id is not null;

-- RLS already covers ownership via projects.user_id. The new column is
-- nullable + cascade-on-delete; nothing to update there.
