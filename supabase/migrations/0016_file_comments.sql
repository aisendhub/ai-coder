-- Line-anchored comments on project files.
-- Scoped per (project_id, file_path) — survive worktree merges, persist across
-- chats/tasks. Anchoring uses snapshot+diff: we store the file content at
-- comment creation and re-resolve anchor positions by diffing against current
-- content on every read (same approach GitHub uses for PR review comments).

create table public.file_comments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  file_path text not null,

  body text not null,
  status text not null default 'open'
    check (status in ('open', 'resolved', 'outdated')),

  -- Anchor: a 3-line block (target + 1 before + 1 after by default) captured
  -- against the snapshot at insert time.
  anchor_start_line int not null check (anchor_start_line >= 1),
  anchor_block_length int not null default 3 check (anchor_block_length >= 1),
  anchor_snapshot text not null,

  -- Cached resolved position against the *current* file content. Updated by
  -- the server on every GET /api/file-comments.
  resolved_line int,
  resolved_at timestamptz,
  resolved_confidence text
    check (resolved_confidence in ('exact', 'shifted', 'outdated')),

  -- Link to the chat message that was posted when the comment was created
  -- (so "Show in chat" can deep-link). Nullable for future flexibility and
  -- because the chat message is inserted client-side after this row lands.
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,

  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index file_comments_project_file_idx
  on public.file_comments (project_id, file_path);

create index file_comments_conversation_idx
  on public.file_comments (conversation_id);

-- Auto-bump updated_at
create or replace function public.touch_file_comment()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger file_comments_touch_updated_at
  before update on public.file_comments
  for each row execute function public.touch_file_comment();

-- RLS: user must own the project that the comment belongs to. Same policy
-- shape as projects / messages — ownership is derived, not duplicated.
alter table public.file_comments enable row level security;

create policy "users read own project comments"
  on public.file_comments for select
  using (
    exists (
      select 1 from public.projects p
      where p.id = file_comments.project_id and p.user_id = auth.uid()
    )
  );

create policy "users insert own project comments"
  on public.file_comments for insert
  with check (
    exists (
      select 1 from public.projects p
      where p.id = file_comments.project_id and p.user_id = auth.uid()
    )
    and created_by = auth.uid()
  );

create policy "users update own project comments"
  on public.file_comments for update
  using (
    exists (
      select 1 from public.projects p
      where p.id = file_comments.project_id and p.user_id = auth.uid()
    )
  );

create policy "users delete own project comments"
  on public.file_comments for delete
  using (
    exists (
      select 1 from public.projects p
      where p.id = file_comments.project_id and p.user_id = auth.uid()
    )
  );

-- Realtime (matches messages/conversations/projects setup)
alter publication supabase_realtime add table public.file_comments;
alter table public.file_comments replica identity full;
