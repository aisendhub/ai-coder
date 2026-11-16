-- Per-turn change record. See docs/WORK-STATE.md.
--
-- Today: when an assistant turn edits files, the only trace is the messages.events
-- jsonb (tool_use entries). Reconstructing "what did this turn change?" requires
-- replaying tool calls and is brittle (Read+Edit pairs, MultiEdit, Write, Bash with
-- redirects, etc).
--
-- After: at the end of every assistant turn that touched files, the server
-- snapshots `git status` + `git diff --numstat` for the conversation cwd and
-- writes one row keyed by the assistant message_id. Optional one-line summary
-- comes from a <work-summary>...</work-summary> tag the agent emits (instructed
-- by the system-prompt addendum) or an auto-generated fallback.
--
-- The committed_in_sha column links a turn to the commit that captured its
-- changes (set by the post-commit watcher). Null = pending uncommitted work.
--
-- Keyed on message_id rather than a new uuid: every row is 1:1 with an
-- assistant turn, and the message_id is already client-generated per the
-- ARCHITECTURE-CLIENT-IDS.md rule.

create table public.turn_change_sets (
  message_id uuid primary key references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,

  -- [{path: text, status: 'A'|'M'|'D'|'R', insertions: int, deletions: int}]
  -- Capped to 50 entries; truncated=true when the turn touched more.
  files jsonb not null default '[]'::jsonb,
  files_count int not null default 0,
  truncated boolean not null default false,

  insertions int not null default 0,
  deletions int not null default 0,

  -- One-line description of what this turn did. Sourced from the agent's
  -- <work-summary> tag when present; otherwise auto-generated from the diff.
  summary text,

  -- The commit that captured this turn's changes. Null while pending.
  -- on delete set null: if a commit row is removed (e.g. project deleted),
  -- the turn record stays around as historical metadata.
  committed_in_sha text references public.commits(sha) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index turn_change_sets_conversation_idx
  on public.turn_change_sets (conversation_id, created_at desc);

create index turn_change_sets_pending_idx
  on public.turn_change_sets (conversation_id)
  where committed_in_sha is null;

create index turn_change_sets_committed_in_sha_idx
  on public.turn_change_sets (committed_in_sha)
  where committed_in_sha is not null;

-- Auto-bump updated_at — set when committed_in_sha is backfilled, summary
-- regenerated, or files re-snapshotted.
create or replace function public.touch_turn_change_set()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger turn_change_sets_touch_updated_at
  before update on public.turn_change_sets
  for each row execute function public.touch_turn_change_set();

-- RLS: ownership flows through conversations.user_id (same shape as messages).
alter table public.turn_change_sets enable row level security;

create policy "users read own conversation turn change sets"
  on public.turn_change_sets for select
  using (
    exists (
      select 1 from public.conversations c
      where c.id = turn_change_sets.conversation_id and c.user_id = auth.uid()
    )
  );

create policy "users insert own conversation turn change sets"
  on public.turn_change_sets for insert
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = turn_change_sets.conversation_id and c.user_id = auth.uid()
    )
  );

create policy "users update own conversation turn change sets"
  on public.turn_change_sets for update
  using (
    exists (
      select 1 from public.conversations c
      where c.id = turn_change_sets.conversation_id and c.user_id = auth.uid()
    )
  );

create policy "users delete own conversation turn change sets"
  on public.turn_change_sets for delete
  using (
    exists (
      select 1 from public.conversations c
      where c.id = turn_change_sets.conversation_id and c.user_id = auth.uid()
    )
  );

-- Realtime: in-chat work stripes update live as turns finish and commits
-- backfill the committed_in_sha link.
alter publication supabase_realtime add table public.turn_change_sets;
alter table public.turn_change_sets replica identity full;

comment on table public.turn_change_sets is
  'Per-turn change record (one row per assistant message that touched files). See docs/WORK-STATE.md.';
comment on column public.turn_change_sets.files is
  'Up to 50 file entries: [{path, status: A|M|D|R, insertions, deletions}]. Set truncated=true when the turn touched more.';
comment on column public.turn_change_sets.committed_in_sha is
  'The commit that captured this turn. Null while the turn''s changes are still pending.';
