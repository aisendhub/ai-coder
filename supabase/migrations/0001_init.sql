-- ai-coder initial schema
-- Conversations and messages owned by auth.users, gated by RLS.

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  session_id text,        -- Claude Agent SDK session id
  sandbox_id text,        -- E2B sandbox id (set in PR 2)
  repo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_user_id_updated_at_idx
  on public.conversations (user_id, updated_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  text text not null default '',
  events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index messages_conversation_id_created_at_idx
  on public.messages (conversation_id, created_at);

-- Auto-bump conversations.updated_at on any message insert
create or replace function public.touch_conversation()
returns trigger language plpgsql as $$
begin
  update public.conversations
    set updated_at = now()
    where id = new.conversation_id;
  return new;
end $$;

create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute function public.touch_conversation();

-- RLS
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

create policy "users read own conversations"
  on public.conversations for select
  using (auth.uid() = user_id);

create policy "users insert own conversations"
  on public.conversations for insert
  with check (auth.uid() = user_id);

create policy "users update own conversations"
  on public.conversations for update
  using (auth.uid() = user_id);

create policy "users delete own conversations"
  on public.conversations for delete
  using (auth.uid() = user_id);

create policy "users read own messages"
  on public.messages for select
  using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

create policy "users insert own messages"
  on public.messages for insert
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );
