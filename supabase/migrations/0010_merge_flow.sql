-- Merge flow moves from a synchronous server-side ship (ff-only / update-ref /
-- handoff-on-conflict) to an AI-driven merge: the Merge button injects a
-- scripted turn and the agent performs commit/checkout/squash-merge/cleanup
-- in the chat, visible to the user. merge_requested_at records the moment
-- the user asked; it's set once per conversation and not cleared by success
-- (shipped_at is the success marker). See docs/MERGE-FLOW.md.

alter table public.conversations
  add column merge_requested_at timestamptz;

comment on column public.conversations.merge_requested_at is
  'When the user clicked Merge. Stays set; shipped_at becoming non-null is the success marker. Used by the UI to show a "merging" pill.';
