-- Add projects: each project owns a cwd on the host filesystem and scopes conversations.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  cwd text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index projects_user_id_updated_at_idx
  on public.projects (user_id, updated_at desc);

alter table public.projects enable row level security;

create policy "users read own projects"
  on public.projects for select
  using (auth.uid() = user_id);

create policy "users insert own projects"
  on public.projects for insert
  with check (auth.uid() = user_id);

create policy "users update own projects"
  on public.projects for update
  using (auth.uid() = user_id);

create policy "users delete own projects"
  on public.projects for delete
  using (auth.uid() = user_id);

-- Attach conversations to a project.
alter table public.conversations
  add column project_id uuid references public.projects(id) on delete cascade;

-- Backfill: one "Default" project per user who already has conversations,
-- pointing at the server's configured workspace (WORKSPACE_DIR at migration time
-- is unknown here, so we store '.' and the server will resolve it).
do $$
declare
  u record;
  pid uuid;
begin
  for u in select distinct user_id from public.conversations loop
    insert into public.projects (user_id, name, cwd)
    values (u.user_id, 'Default Project', '.')
    returning id into pid;

    update public.conversations
      set project_id = pid
      where user_id = u.user_id and project_id is null;
  end loop;
end $$;

-- Require project_id going forward.
alter table public.conversations
  alter column project_id set not null;

create index conversations_project_id_updated_at_idx
  on public.conversations (project_id, updated_at desc);

-- Realtime for projects (matches messages/conversations setup in 0003).
alter publication supabase_realtime add table public.projects;
alter table public.projects replica identity full;
