-- Per-user tokens for external providers (Railway, Fly, Cloudflare, etc.).
-- See docs/RUNTIME.md — each cloud runner in Phase 5+ needs a credential to
-- act on the user's behalf. We centralize them here instead of one-column-
-- per-provider so adding a new cloud target is a runner file + nothing else.
--
-- Tokens are encrypted at rest with the INTEGRATIONS_KEY env var (AES-GCM).
-- We store the ciphertext + IV + auth tag as a single base64 blob; the server
-- decrypts on read. The DB never sees plaintext.

create table public.user_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Provider key. Open-ended by convention: new runners pick their own slug
  -- (e.g. 'railway', 'fly', 'cloudflare'). One row per (user, provider).
  provider text not null,
  -- Encrypted token blob (base64). Never queried directly — loaded + decrypted
  -- in the server and discarded. Rotate the INTEGRATIONS_KEY to invalidate
  -- all tokens at once.
  token_ciphertext text not null,
  -- Free-form metadata the provider returns during `connect` validation.
  -- For Railway: { username, email, teams?: [...] }. Helps the UI surface
  -- "connected as X" without re-hitting the provider.
  account jsonb,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

comment on table public.user_integrations is
  'Per-user provider credentials. Tokens stored AES-GCM encrypted (server-side), never plaintext.';
comment on column public.user_integrations.provider is
  'Provider slug (railway, fly, cloudflare, …). One row per (user, provider).';
comment on column public.user_integrations.token_ciphertext is
  'Base64(IV + authTag + ciphertext) from AES-256-GCM with INTEGRATIONS_KEY.';
comment on column public.user_integrations.account is
  'Provider-returned account snapshot at connect time (username, email, teams).';

alter table public.user_integrations enable row level security;

-- Users can read/modify only their own integrations. The server writes via
-- the service role (which bypasses RLS) — we still add these for defense in
-- depth and to prevent the anon key from ever seeing ciphertext.
create policy "user_integrations_select_own" on public.user_integrations
  for select using (auth.uid() = user_id);
create policy "user_integrations_insert_own" on public.user_integrations
  for insert with check (auth.uid() = user_id);
create policy "user_integrations_update_own" on public.user_integrations
  for update using (auth.uid() = user_id);
create policy "user_integrations_delete_own" on public.user_integrations
  for delete using (auth.uid() = user_id);

-- Per-project + per-worktree bindings to a specific provider resource. Added
-- upfront so Phase 5 Slice 2 (binding a project to a Railway project/service)
-- doesn't need a follow-up migration.
alter table public.projects
  add column railway_project_id text,
  add column railway_service_id text;

alter table public.conversations
  add column railway_deployment_id text;

comment on column public.projects.railway_project_id is
  'Railway project id bound to this ai-coder project. Null until the user links.';
comment on column public.projects.railway_service_id is
  'Railway service id within the bound project. One service per ai-coder project for now.';
comment on column public.conversations.railway_deployment_id is
  'Last Railway deployment triggered from this worktree. Null until first deploy.';
