-- Access requests: users can request access; admin approves/denies.
-- Until container isolation lands, this is the gate that keeps non-admin
-- users off a local install's filesystem + Agent SDK.

create table public.access_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  email       text not null,
  display_name text,
  avatar_url  text,
  status      text not null default 'pending'
                check (status in ('pending', 'approved', 'denied')),
  requested_at timestamptz not null default now(),
  resolved_at  timestamptz,
  unique (user_id)
);

alter table public.access_requests enable row level security;

-- Users can read their own request (to show pending/denied state).
create policy "users read own access request"
  on public.access_requests for select
  using (user_id = auth.uid());

-- Users can create their own request (one per user, enforced by unique).
create policy "users insert own access request"
  on public.access_requests for insert
  with check (user_id = auth.uid());
