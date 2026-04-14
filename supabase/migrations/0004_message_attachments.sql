-- Add attachments metadata column to messages.
-- Stores [{filename, mimeType, sizeBytes}] — the base64 payload is NOT persisted.
alter table public.messages
  add column attachments jsonb not null default '[]'::jsonb;

comment on column public.messages.attachments is
  'Array of {filename, mimeType, sizeBytes} for files attached to this message';
