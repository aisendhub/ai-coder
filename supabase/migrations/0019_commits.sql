-- Commit attribution index. See docs/WORK-STATE.md.
--
-- Today: commits live only in the git object database. There's no way to
-- answer "which chat made this commit?" or "what's pending in this chat?"
-- without scanning git log per request.
--
-- After: every agent-produced commit is upserted here by the post-commit
-- watcher, attributed via Ai-Coder-Conversation / Ai-Coder-Message git
-- trailers (with worktree → conversation fallback). Pre-squash per-turn
-- commits carry both ids; squash-merge commits on the base branch carry only
-- conversation_id (and kind = 'squash'). Rows persist even after their git
-- branch is reaped — this table is metadata, not a content store.
--
-- sha is the natural key; rows are written server-side after the agent
-- commits, so no client-id rule applies (see ARCHITECTURE-CLIENT-IDS.md).

create table public.commits (
  sha text primary key check (sha ~ '^[0-9a-f]{40}$'),
  short_sha text generated always as (substr(sha, 1, 7)) stored,

  -- Attribution. Both nullable so manual / unattributed commits can still be
  -- recorded (kind='manual') without losing project scope.
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  project_id uuid not null references public.projects(id) on delete cascade,

  branch text,
  parent_shas text[],
  subject text,
  body text,

  files_changed int,
  insertions int,
  deletions int,

  authored_at timestamptz,
  pushed_at timestamptz,
  merged_at timestamptz,
  shipped_at timestamptz,

  -- 'turn'   = per-turn commit on the task's worktree branch (full provenance)
  -- 'squash' = squash-merge commit on the base branch (conversation_id only)
  -- 'manual' = human-authored; attributed only when a trailer was present
  kind text not null default 'turn'
    check (kind in ('turn', 'squash', 'manual')),

  created_at timestamptz not null default now()
);

create index commits_conversation_authored_idx
  on public.commits (conversation_id, authored_at desc)
  where conversation_id is not null;

create index commits_project_authored_idx
  on public.commits (project_id, authored_at desc);

create index commits_message_idx
  on public.commits (message_id)
  where message_id is not null;

create index commits_branch_idx
  on public.commits (project_id, branch)
  where branch is not null;

-- RLS: ownership flows through projects.user_id (same shape as file_comments,
-- project_services, etc.). Writes happen exclusively from the server-side
-- watcher under the service-role client; the policies below cover read +
-- defensive write paths if a user-scoped client ever touches this table.
alter table public.commits enable row level security;

create policy "users read own project commits"
  on public.commits for select
  using (
    exists (
      select 1 from public.projects p
      where p.id = commits.project_id and p.user_id = auth.uid()
    )
  );

create policy "users insert own project commits"
  on public.commits for insert
  with check (
    exists (
      select 1 from public.projects p
      where p.id = commits.project_id and p.user_id = auth.uid()
    )
  );

create policy "users update own project commits"
  on public.commits for update
  using (
    exists (
      select 1 from public.projects p
      where p.id = commits.project_id and p.user_id = auth.uid()
    )
  );

create policy "users delete own project commits"
  on public.commits for delete
  using (
    exists (
      select 1 from public.projects p
      where p.id = commits.project_id and p.user_id = auth.uid()
    )
  );

-- Realtime: kanban / chat surfaces watch for new commits the same way they
-- watch for new messages today.
alter publication supabase_realtime add table public.commits;
alter table public.commits replica identity full;

comment on table public.commits is
  'Commit attribution index. Source of truth for "which chat/turn made this commit." See docs/WORK-STATE.md.';
comment on column public.commits.kind is
  'turn = per-turn commit on task branch (both ids set). squash = base-branch squash-merge (conversation_id only). manual = human-authored, attributed only via trailer.';
comment on column public.commits.message_id is
  'The assistant message_id that produced this commit. Null on squash commits and manual commits.';
