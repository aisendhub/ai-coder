-- Task mode: a conversation can be a plain chat (default) or a bounded,
-- autonomous task running the evaluator-optimizer loop on its worktree. The
-- orchestrator (server code) reads these columns to drive the loop and stop
-- at iteration / budget caps.

alter table public.conversations
  add column kind text not null default 'chat'
    check (kind in ('chat', 'task')),
  add column auto_loop_enabled boolean not null default false,
  add column auto_loop_goal text,
  add column loop_iteration integer not null default 0,
  add column loop_cost_usd numeric(10, 4) not null default 0,
  add column max_iterations integer not null default 5,
  add column max_cost_usd numeric(10, 4) not null default 1.0;

-- Tasks are the interesting case for dashboards/boards — index so the board
-- view stays cheap when we build it.
create index conversations_kind_updated_at_idx
  on public.conversations (kind, updated_at desc);
