# Work state — chats, turns, commits, pending changes

Status: design + implementation tracker. Phase A in progress (data plumbing).

The chat is where work originates; the git log is where it lands. Today there's no link between them: a user can't see which chat made which commit, which chats have pending uncommitted work, or what each LLM turn actually changed. This doc fixes that.

Anchored in [PRODUCT-SIGNAL.md](PRODUCT-SIGNAL.md) — "commits are the unit of trust" and "every conversation is a checkpoint to fork from." Complements [GIT-LOG.md](GIT-LOG.md), which designs the commit-detail surface; this doc owns the **chat ↔ commit** binding and the **per-turn change record**.

---

## Goals

1. Every commit produced by the agent is attributable to a specific conversation and (where possible) the LLM turn that produced it.
2. Every chat surfaces its pending state at a glance: uncommitted edits, unmerged commits, shipped state.
3. Every assistant turn that touches files leaves a per-turn record (paths, +/-, one-line summary), visible inline in the chat history.
4. Cross-links: clicking a commit opens its originating chat; clicking a turn opens the file panel pinned to that turn's diff; the changed-files panel and blame chips both name the chat that produced the work.

Non-goals (for now):
- Auto-committing per turn. Squash-on-ship + explicit commits stay the model. Per-turn records are a *log*, not a sequence of commits.
- Replacing git as the source of truth. The new tables are an index; git stays authoritative for content.

---

## Data model

Two new tables, additive. Both adhere to [ARCHITECTURE-CLIENT-IDS.md](ARCHITECTURE-CLIENT-IDS.md) where applicable; `commits.sha` is the natural key from git, so server-side write happens after the agent commits.

### `commits` (migration 0019)

```sql
create table public.commits (
  sha text primary key,                       -- 40-char git sha
  short_sha text generated always as (substr(sha, 1, 7)) stored,
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  project_id uuid not null references public.projects(id) on delete cascade,
  branch text,
  parent_shas text[],
  subject text,
  body text,
  files_changed int,
  insertions int,
  deletions int,
  authored_at timestamptz,
  pushed_at timestamptz,                      -- null until detected on origin/<branch>
  merged_at timestamptz,                      -- null until merged into base_ref
  shipped_at timestamptz,                     -- mirrors conversations.shipped_at
  kind text not null default 'turn'           -- 'turn' = per-turn commit on task branch
                                              -- 'squash' = squash-merge commit on base branch
                                              -- 'manual' = human-authored, attributed only if trailer present
    check (kind in ('turn', 'squash', 'manual')),
  created_at timestamptz default now()
);
```

Indexed on `(conversation_id, authored_at desc)` and `(project_id, authored_at desc)` for the kanban / sidebar / git-log joins.

### `turn_change_sets` (migration 0020)

```sql
create table public.turn_change_sets (
  message_id uuid primary key references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  files jsonb not null default '[]'::jsonb,   -- [{path, status, insertions, deletions}], cap ~50 with truncated flag
  insertions int not null default 0,
  deletions int not null default 0,
  summary text,                               -- one-line agent-emitted or auto
  committed_in_sha text references public.commits(sha) on delete set null, -- null = pending
  created_at timestamptz default now()
);
```

Keyed on the assistant `message_id` (the turn that produced the changes). Indexed on `(conversation_id, created_at desc)`.

RLS on both: ownership flows through `conversations.user_id` (existing pattern from [0006_worktrees.sql](../supabase/migrations/0006_worktrees.sql)).

---

## Attribution mechanism

Two layers — durable and fast.

1. **Git trailers (durable, survives push/clone).** Every commit produced by an agent run carries `Ai-Coder-Conversation: <uuid>` and `Ai-Coder-Message: <uuid>` trailers. Written either by the agent itself (instructed via system-prompt addendum) or by a server-side post-commit amend if missing and safe (commit is HEAD, not pushed).
2. **Supabase index (fast UI joins).** A chokidar-driven watcher detects new commits in each conversation's worktree, parses trailers (if present) or falls back to `worktree → conversation` mapping, and upserts into `commits`. Pushed/merged/shipped state is updated by the same watcher and by existing ship/merge flows.

Origin precedence:
1. Trailer → `conversation_id` from `Ai-Coder-Conversation`, `message_id` from `Ai-Coder-Message`.
2. Fallback: `worktree_path` → `conversations.id` (when `worktree_mode = 'per_conversation'`).
3. Otherwise: project-only attribution (no chat link).

### Task-level vs turn-level attribution (squash semantics)

Two scopes, two trailers, intentionally different:

- **Per-turn commits (inside the task's worktree/branch)** carry both trailers — `Ai-Coder-Conversation` *and* `Ai-Coder-Message`. They're the granular history a user sees while reviewing a task.
- **Squash-merge commits (on the base branch)** carry only `Ai-Coder-Conversation`. The base branch is told *which task produced this work*, not which turn within it. The base log stays clean: one commit per shipped task.

The `commits` table mirrors this: the squash row has `message_id = NULL` and a `kind = 'squash'` flag. Pre-squash commits stay in the table even after their branch is reaped — they're metadata, not git objects we depend on. The task view (chat history + git-log inside the worktree panel) keeps showing the full per-turn breakdown; the base-branch git log shows one row per task and pivots to the chat via `conversation_id` for drill-down.

This is why we don't need to "collapse trailers into a list at squash time": the per-turn provenance lives in the `commits` + `turn_change_sets` tables, scoped to the task. Base-branch consumers (humans, CI, archived clones) only need to know which task shipped the change.

---

## Per-turn change capture

At the end of every assistant turn that touched files:

1. Server snapshots `git status --porcelain -z` + `git diff --numstat` against the previous snapshot for that conversation's cwd.
2. The agent's final assistant text is scanned for a `<work-summary>...</work-summary>` tag (instructed via system-prompt addendum). If absent, fall back to an auto-generated `"<verb> <N> files in <top-dir>"`.
3. Insert/upsert a `turn_change_sets` row keyed on the assistant `message_id`.
4. If a commit lands during or just after the turn, the post-commit watcher backfills `committed_in_sha` on the matching turn rows (best-effort: turns whose paths intersect the commit's file list and which are still `committed_in_sha IS NULL`).

Boundary signal: existing `loop_iteration` events in [Message.model.ts](../src/models/Message.model.ts) plus the SSE close on `POST /api/chat`. We piggyback on those instead of inventing a new "turn done" hook.

---

## Server work

- **[`server/llm/system-prompt.ts`](../server/llm/system-prompt.ts)** — extends `buildSystemPromptAppend` with two lines: one telling the agent to emit `<work-summary>...</work-summary>` at end-of-turn when files were touched, one telling it to add `Ai-Coder-Conversation: <uuid>` to the commit message trailer block. The conversation id flows in via the new `conversationId` field on `WorkerPromptContext`.
- **[`server/git-attribution.ts`](../server/git-attribution.ts)** — pure helpers, no I/O: `parseTrailers`, `appendTrailers` (idempotent), `parseWorkSummary`, `stripWorkSummary`, `autoSummarize`.
- **[`server/work-state.ts`](../server/work-state.ts)** — per-iteration capture: `snapshotBeforeTurn(cwd)` runs *before* `query()` (to record HEAD + dirty paths), `captureTurnAndCommits({...})` runs at iteration end (compares post-turn state, walks new commits in `pre.headSha..HEAD`, upserts `commits` with attribution, derives the file list, parses or auto-generates a summary, upserts `turn_change_sets`). All operations are best-effort — never throw.
- **[`server/index.ts`](../server/index.ts)** — wires `snapshotBeforeTurn` ahead of the `query()` call and `captureTurnAndCommits` into the per-iteration `finally`. Pulls `project_id` into the existing `convMeta` select.

Deliberately NOT in Phase A:

- **No chokidar-driven watcher.** The iteration boundary is a cleaner trigger than file events, since we know the exact `message_id` that owns the changes. A watcher only earns its keep when we want to attribute commits the user makes outside the agent (Phase D).
- **No post-commit amend.** Amend rewrites the SHA, which would invalidate the upsert we just performed. Trailers are agent-written via the system prompt; missing trailers fall through to the worktree → conversation mapping. Add amend later if downstream consumers (push, archive) need trailer permanence.

### New endpoints

### New endpoints

- `GET /api/conversations/:id/work-state` → `{ pending: { staged, unstaged, untracked, ahead, behind }, commits: Commit[], turns: TurnChangeSet[] }`
- `GET /api/commits/:sha/origin` → `{ conversationId, messageId } | null`
- Extend [`GET /api/git/commit`](../server/index.ts#L1258) to include `origin` from the `commits` table.
- Extend [`POST /api/conversations/diff-summary`](../server/index.ts#L1183) to include `pending: boolean` and `commitCount: number`.

---

## UI surfaces (in priority order)

1. **Sidebar / kanban card pending badge.** A pending dot + `+120/-32` chip on every conversation with uncommitted work or unshipped commits. Drives off the extended `diff-summary`.
2. **In-chat work stripes.** Between [`MessageBubble`](../src/components/chat-panel.tsx) entries, render a thin row per `turn_change_sets` entry: `📝 4 files · +120/-32 · "Wired the kanban filter" · pending` (or `committed in abc1234`). Click expands to file list; click a file → [`file-panel.tsx`](../src/components/file-panel.tsx) pinned to that turn's diff.
3. **Git log → originating chat.** Phase 2 of [GIT-LOG.md](GIT-LOG.md). With `commits.conversation_id` populated, "Open originating chat" becomes a one-line lookup.
4. **Changed-files panel header.** [`code-panel.tsx`](../src/components/code-panel.tsx) ChangesSection header shows "From this chat: 3 turns, 4 pending files."
5. **Blame chip → turn.** [`annotation-chip.tsx`](../src/components/annotation-chip.tsx) extended to name the originating chat (joined via `commits.conversation_id`); click jumps to the turn in chat history.

---

## Phases

### Phase A — data plumbing (no UI) ✅

Goal: tables, attribution, capture. Shipped silently. Validates that origin attribution works before any UI depends on it.

- ✅ Migration `0019_commits.sql` (table + RLS + indexes) — applied
- ✅ Migration `0020_turn_change_sets.sql` (table + RLS + indexes) — applied
- ✅ [`server/git-attribution.ts`](../server/git-attribution.ts) — trailer read/write helpers + `<work-summary>` parse + auto-summary fallback
- ✅ System-prompt addendum: `<work-summary>` instruction + trailer instruction in [`buildSystemPromptAppend`](../server/llm/system-prompt.ts)
- ✅ Per-iteration capture in [`server/work-state.ts`](../server/work-state.ts): `snapshotBeforeTurn` + `captureTurnAndCommits`, wired into `startRunner` per-iteration finally
- ✅ Backfill `committed_in_sha` on `turn_change_sets` when the iteration ended with all changes committed (no remaining dirty paths)
- ⬜ End-to-end smoke: trigger a chat that edits + commits, verify rows in both tables and that `commits.conversation_id` / `turn_change_sets.message_id` line up. Helper unit tests + live `snapshotBeforeTurn` already verified.

### Phase B — read surfaces ✅

Goal: "I can see what work was done by which chat" without leaving the app.

- ✅ Extend [`POST /api/conversations/diff-summary`](../server/index.ts) with `pending` + `commitCount` (joined off the new `commits` table)
- ✅ [`GET /api/conversations/:id/turns`](../server/index.ts) endpoint (scoped to `turn_change_sets`; the omnibus work-state endpoint was scope-cut — pending lives in the extended diff-summary, commits in `/api/git/log`)
- ✅ [`useDiffSummaries`](../src/hooks/use-diff-summaries.ts) hook (refetches on `ai-coder:turn-done`)
- ✅ Pending dot + +/- chip on chat rows via [`ConversationRow`](../src/components/conversation-row.tsx) `summary` prop, fed by [`ChatsSection`](../src/components/chats-section.tsx)
- ✅ Kanban [`board.tsx`](../src/components/board.tsx) `DiffSummary` type widened with the new fields (UI already shows +/-; the `pending` flag is available for future tweaks)
- ✅ [`useConversationTurns`](../src/hooks/use-conversation-turns.ts) hook + [`WorkStripe`](../src/components/work-stripe.tsx) component
- ✅ Work stripes rendered under each assistant `MessageBubble` in [`chat-panel.tsx`](../src/components/chat-panel.tsx); collapsed = summary + counts + committed/pending state, expanded = file list with status badges and per-file +/-
- ⬜ Stripe file-row click → file-panel pinned mode (blocked on [GIT-LOG Phase 1](GIT-LOG.md) commit-pinned mode in `file-panel.tsx`; deferred to Phase C)

### Phase C — cross-links ⬜

Goal: close the loop between commits, turns, files.

- ⬜ Extend `GET /api/git/commit` with `origin`
- ⬜ Git-log row "Open originating chat" action
- ⬜ Changed-files panel header: "From this chat: N turns, M pending files"
- ⬜ Blame chip names originating chat; click jumps to turn

### Phase D — orchestration handles ⬜

Goal: act on the history. Cheap once Phase A landed attribution.

- ⬜ Continue / Fork from a turn (worktree branched at `committed_in_sha`)
- ⬜ Revert a turn (revert its commit if committed; discard its files if pending)
- ⬜ Cherry-pick a turn into another worktree

---

## Risks & open questions

- **Amend safety.** Server-side amend is only safe if the commit is HEAD and unpushed. Otherwise: skip amend, just upsert. Worktree-mode `shared` projects rely entirely on trailers for attribution.
- **`turn_change_sets.files` size.** A turn that touches 200 files would bloat the row. Cap to first 50 and set `truncated: true` (mirrors GIT-LOG.md's open question for commit file lists).
- **Agent compliance with `<work-summary>`.** Models drop tags occasionally. The auto-generated fallback covers the gap; we don't gate UI on the tag being present.
- **Commit attribution latency.** The watcher debounces, so a commit may take a beat to appear in the UI. Acceptable: optimistic UI on the sending side renders the stripe immediately as `pending`.
- **Multi-conversation worktree edits.** If two chats share a cwd (worktree_mode=`shared`) and both edit overlapping files, the per-turn change capture races. Fallback: trailer wins; if both turns claim the same commit, both rows point at it (intentional — both contributed).

---

## Related

- [GIT-LOG.md](GIT-LOG.md) — commit-detail surface; this doc supplies the `origin` field and chat linkback.
- [PRODUCT-SIGNAL.md](PRODUCT-SIGNAL.md) — async supervision; the visual surface for "what got done by which run."
- [ARCHITECTURE-CLIENT-IDS.md](ARCHITECTURE-CLIENT-IDS.md) — id rules for `turn_change_sets` (uses existing `message_id`, no new client-generated id needed).
- [SYSTEM-PROMPT.md](SYSTEM-PROMPT.md) — where the `<work-summary>` instruction layers in.
- [MERGE-FLOW.md](MERGE-FLOW.md) — how `shipped_commit_sha` works, mirrored into `commits.shipped_at`.
