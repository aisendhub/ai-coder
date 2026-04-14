-- Enable Supabase Realtime broadcasts on messages + conversations so the
-- client can react to background runners writing rows.
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.conversations;

-- Realtime needs UPDATE/DELETE row payloads to include the previous values
-- when filtering against client subscriptions. REPLICA IDENTITY FULL captures
-- the whole row so filter expressions (eg conversation_id) match reliably.
alter table public.messages replica identity full;
alter table public.conversations replica identity full;
