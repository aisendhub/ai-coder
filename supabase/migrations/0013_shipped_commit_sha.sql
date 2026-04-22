-- Remember the base-branch SHA at the moment a merge completed. Enables the
-- Revert action on a shipped task: the server instructs the agent to reset
-- the base branch to the parent of this SHA and recreate the worktree at the
-- SHA itself (so task work isn't lost, just unstaged). See docs/MERGE-FLOW.md.
-- Captured by reconcileMergeIfCompleted, not by the agent.

alter table public.conversations
  add column shipped_commit_sha text;

comment on column public.conversations.shipped_commit_sha is
  'Base-branch HEAD SHA recorded at the moment reconcile marks the task shipped. Used by the Revert action. Null for tasks shipped before this column existed.';
