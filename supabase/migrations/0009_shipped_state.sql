-- Shipping a task used to soft-trash it, which made it disappear. Users want
-- shipped work to stay visible (in the Board's Shipped column, or filtered
-- out of the sidebar) until they explicitly delete it. `shipped_at` is the
-- marker: non-null = merged/closed but not user-trashed.

alter table public.conversations
  add column shipped_at timestamptz;

-- Cheap lookup for the board's Shipped column.
create index conversations_shipped_at_idx
  on public.conversations (shipped_at)
  where shipped_at is not null;
