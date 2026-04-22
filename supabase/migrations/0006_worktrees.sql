-- Worktrees: each conversation can own its own git worktree + branch so
-- parallel agents don't step on each other. Existing rows stay in "shared"
-- mode (one cwd per project, today's behavior) and opt in per project.

alter table public.projects
  add column worktree_mode text not null default 'shared'
    check (worktree_mode in ('shared', 'per_conversation')),
  add column default_base_ref text;

alter table public.conversations
  add column worktree_path text,
  add column branch text,
  add column base_ref text,
  add column deleted_at timestamptz;

-- Soft-trash index so the reaper can find expired rows cheaply.
create index conversations_deleted_at_idx
  on public.conversations (deleted_at)
  where deleted_at is not null;
