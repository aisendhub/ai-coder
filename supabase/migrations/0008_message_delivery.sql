-- Track when each message was actually handed to the agent. New nudges that
-- arrive while a turn is in flight start with delivered_at = null and get
-- flushed into the conversation at the next canUseTool boundary (see
-- docs/WORKTREES.md § Mid-turn nudges). Existing rows backfill to created_at
-- so they render as already delivered in the UI.

alter table public.messages
  add column delivered_at timestamptz;

update public.messages
  set delivered_at = created_at
  where delivered_at is null;

-- Partial index so the canUseTool callback's hot-path query
--   `where conversation_id = ? and role = 'user' and delivered_at is null`
-- stays cheap even after millions of rows.
create index messages_pending_nudges_idx
  on public.messages (conversation_id, created_at)
  where delivered_at is null and role = 'user';
