-- Third message role: `notice`. Written by the server when the app itself
-- speaks into a conversation (merge kickoff, future: ship results, bg events).
-- Renders as a centered badge in the chat — not attributed to the user,
-- not attributed to the agent.
--
-- We also keep these rows out of nudge sweeps: the pending-nudges query
-- currently uses `role = 'user'` so notices are ignored by default. No
-- change needed there.

alter table public.messages
  drop constraint if exists messages_role_check;

alter table public.messages
  add constraint messages_role_check
  check (role in ('user', 'assistant', 'notice'));
