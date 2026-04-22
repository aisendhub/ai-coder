# Git Worktrees — Design

Per-conversation working directory isolation so parallel agents don't step on each other.

## Context

Today every conversation in a project shares the same `cwd` ([server/index.ts:60-83](../server/index.ts#L60-L83)). Two conversations in the same project step on each other: they edit the same files, their changes panels show each other's uncommitted work, they commit on the same branch, and diffs bleed across sessions.

We want parallel agents working on the same repo without conflicts — the pattern Cline Kanban and Boris Cherny's "5-15 parallel Claude sessions" workflow are built on. Git worktrees are the natural primitive: multiple working directories sharing one `.git`, each on its own branch, zero merge churn until you explicitly ship.

## Prior art

### [parallel-code](https://github.com/johannesjo/parallel-code)
- One worktree + one branch per task. Claude/Codex/Gemini each run in their own worktree side-by-side.
- Symlinks `node_modules` and gitignored dirs into the worktree (no reinstall).
- Merge back to main from a sidebar action; keyboard shortcuts for merge/push.

### [Cline Kanban](https://github.com/cline/kanban)
- Ephemeral worktree per task card. Each card gets its own terminal, worktree, and agent.
- Symlinks gitignored files (incl. `node_modules`).
- Cleanup: move card to trash → worktree removed; resume ID preserved so work is restorable.
- Dependency chains: ⌘-click links cards; trashing one auto-starts linked ones.
- Ship options: manual commit/PR, or auto-commit/auto-PR. On ship, Kanban sends a dynamic prompt to the agent to convert the worktree into a commit on the base ref or a new PR branch, resolving merge conflicts intelligently.
- Real-time diff viewer with inline PR-style comments for steering mid-task.

### Claude Code native `claude -w` / `--worktree` flag
- Built into the CLI as of early 2026. Auto-generates a worktree name or takes one explicitly. Sessions in different worktrees are genuinely isolated.

**Convergent pattern**: one worktree per *task* (not per project). One branch per worktree. Symlink heavy gitignored dirs. Explicit ship action. Cleanup on discard with a resume escape hatch.

## Decision: per-task, not per-chat or per-project

**Only tasks get worktrees.** Chats always run on the project's shared cwd. Tasks are the autonomous, ship-able unit of work; chats are interactive and often short-lived. Giving every chat its own branch would pollute `git branch -a` and offer no benefit — you don't "ship" a chat.

> For user-facing "when to use chat vs task", see [CHAT-VS-TASK.md](CHAT-VS-TASK.md).

Conversation ≈ task. Both external tools tie the worktree to the unit of parallel work.

Per-project worktree is a non-solution:
- Project already *has* a cwd ([projects.cwd](../supabase/migrations/0005_projects.sql)). Wrapping it in a worktree changes nothing for parallelism.
- The conflict we actually have is N conversations fighting over one working tree. Only per-conversation isolation fixes it.
- Matches our existing schema grain: `conversations.session_id`, `conversations.sandbox_id`.

Project stays the git-repo anchor. `projects.cwd` is the shared `.git` that worktrees are added to. Conversations get their own working directories branched off it.

## Design

### Data model — migrations `0006_worktrees.sql` + `0007_tasks.sql`

```sql
-- 0006_worktrees.sql
alter table conversations
  add column worktree_path text,   -- absolute path on host, null = use project.cwd
  add column branch text,          -- e.g. "ai-coder/learn-router-a3f2"
  add column base_ref text,        -- e.g. "main" — what we branched from, for shipping
  add column deleted_at timestamptz; -- soft-trash; reaper hard-deletes after 7d

alter table projects
  add column worktree_mode text not null default 'shared'
    check (worktree_mode in ('shared', 'per_conversation')),
  add column default_base_ref text; -- captured from HEAD at project create

-- 0007_tasks.sql
alter table conversations
  add column kind text not null default 'chat'
    check (kind in ('chat', 'task')),
  add column auto_loop_enabled boolean not null default false,
  add column auto_loop_goal text,
  add column loop_iteration integer not null default 0,
  add column loop_cost_usd numeric(10, 4) not null default 0,
  add column max_iterations integer not null default 5,
  add column max_cost_usd numeric(10, 4) not null default 1.0;
```

- `worktree_path` nullable so legacy conversations keep working.
- `worktree_mode = 'shared'` is the SQL default (existing rows stay put); the new-project dialog flips the checkbox to `per_conversation` on git repos.
- `kind` is the stable identity (`chat` vs `task`); `auto_loop_enabled` controls whether the loop is currently armed, so users can pause a task without losing its identity.
- `max_iterations` / `max_cost_usd` live per-conversation so users can tune caps from the new-task dialog without code changes.
- 1:1 with conversation → inline columns, no separate `worktrees` or `tasks` table.

### Filesystem layout

```
<PROJECTS_ROOT>/
  my-repo/                          ← projects.cwd (the anchor)
    .git/                           ← shared across all worktrees
    src/…
    node_modules/                   ← symlink target
  .ai-coder-worktrees/
    <project-id>/
      <conversation-id>/            ← conversations.worktree_path
        src/…                       ← real files, checked out on its branch
        node_modules → ../../../my-repo/node_modules   (symlink)
        .env → ../../../my-repo/.env                   (symlink, if present)
```

- Worktrees live **outside** the project tree so they don't pollute `git status`, file watchers, or IDE indexers scoped to the project.
- Parent dir grouped per project for easy cleanup.
- Configurable via `WORKTREES_ROOT` env var, default `${PROJECTS_ROOT}/.ai-coder-worktrees`.
- Stays inside `PROJECTS_ROOT` so existing sandbox checks cover it.

### Branch naming

`ai-coder/<slug>-<conv-id-first-6>`, e.g. `ai-coder/learn-router-a3f2c1`.
- Prefix namespaces all agent branches so users can filter/clean them.
- Slug from conversation title (or `chat` if untitled); ID suffix guarantees uniqueness.
- Base ref = `projects.default_base_ref` (captured at project creation from `git symbolic-ref --short HEAD`), overridable per conversation.

### Gitignored-file symlinking

Symlink `node_modules`, `.env*`, `dist/`, `.next/`, `.nuxt/`, `.venv/`, `target/`, `vendor/`, `.cache/`, `.turbo/`, plus user-configured entries (future `projects.symlink_paths`).

Create symlinks after `git worktree add`, before spawning the agent. Fail loudly if a symlink target doesn't exist in the base tree.

### Server flow

1. **Conversation create** — server endpoint `POST /api/conversations`:
   - inserts the row,
   - if `kind === 'task'` AND `project.worktree_mode === 'per_conversation'` AND the cwd is a git repo: runs `git worktree add -b <branch> <path> <base_ref>` from `project.cwd`, creates the symlinks, and persists `worktree_path` / `branch` / `base_ref` on the row.
   - Chats (`kind === 'chat'`) never get a worktree. They inherit `project.cwd` via `cwdForConversation`.

2. **`cwdForConversation()`** ([server/index.ts:60-83](../server/index.ts#L60-L83)) — prefer `conversations.worktree_path` when set; fall back to project cwd. One-line change, isolates the rest of the server from the worktree concept.

3. **Changes panel** ([server/index.ts:475-509](../server/index.ts#L475-L509)) — already uses the resolved conv cwd via `cwdForConversation()`. No change needed once step 2 ships.

4. **Ship** — `POST /api/conversations/:id/ship`:
   - `commit` — commit uncommitted changes, **fast-forward** the base ref via `git update-ref` (never touches the base working tree), delete worktree + branch on success. Non-fast-forward returns `{ warning }` and leaves the worktree intact for the user to rebase or hand back to the agent.
   - `pr` (future) — push branch to origin, open PR via `gh` CLI, leave worktree until PR closes.
   - True-merge (merge commit, not ff-only) + agent-driven conflict resolution are a Phase 3 follow-up. Commit message today uses the conversation title; agent-generated summary messages are follow-up too.

5. **Discard** — `DELETE /api/conversations/:id` → `git worktree remove --force <path>`, `git branch -D <branch>` (prompt first if branch has unpushed commits). Soft trash with a 7-day grace period before hard cleanup, preserving Kanban's resume pattern.

6. **Recovery** — on server start, reconcile `conversations.worktree_path` against `git worktree list` output; recreate missing symlinks; flag orphaned worktrees in logs.

### UI touches

- Conversation sidebar: branch name as a subtle chip next to the title.
- Changes panel header: add a Ship button with commit/PR split.
- New-project dialog: toggle for `worktree_mode` with an explanatory tooltip.
- Conversation delete confirm: warn if branch has unpushed commits.

### Guardrails / edge cases

- **Non-git project**: force `worktree_mode = 'shared'`, disable the toggle. Detect via `git rev-parse --git-dir` at project create.
- **Dirty base on worktree create**: allowed — `git worktree add` handles it, uncommitted changes don't leak.
- **Branch name collision**: retry with a longer ID suffix. Git enforces uniqueness.
- **Remote-only base branch**: not supported in v1.
- **Disk usage**: symlinks keep it modest but worktree files duplicate. Surface total size in project settings; add bulk cleanup of shipped/trashed worktrees.
- **Windows**: not a target (Railway Linux host). POSIX symlinks assumed.

### Migration for existing projects

- Existing conversations: `worktree_path = null` → continue using project cwd.
- Existing projects: default to `worktree_mode = 'shared'` in the migration.
- New projects created after the feature lands: default to `per_conversation`.
- No backfill; isolation is opt-in per project going forward.

## Agent loop for Task mode (evaluator-optimizer)

Tasks are the worktree-backed, bounded, long-running variant of a conversation. Chat is a single turn per user message. Task is an autonomous loop that keeps going until a goal is met, a budget is hit, or the user cancels.

**Pattern**: [evaluator-optimizer from Anthropic's *Building Effective Agents*](https://www.anthropic.com/engineering/building-effective-agents). Two separate `query()` calls per iteration — a **worker** that makes progress on the goal and an **evaluator** that judges whether the goal is met. The orchestrator (server code, not the prompt) decides whether to iterate again.

### Why two agents, not one

- **Self-critique in a single prompt rushes.** A dedicated evaluator call with only one job produces deeper critique. Same model is fine — what matters is the turn boundary.
- **Separate sessions, not one long one.** The worker's session stays clean (today's behavior via `conversations.session_id`). The evaluator is stateless: a fresh `query()` each iteration, seeded with the original goal + the worker's last assistant text + a short tools-used summary. Sharing sessions pollutes the worker's context with evaluator JSON.
- **Prompt vs code split.** Rubric, success criteria, and output schema live in the evaluator's system prompt. Iteration count, budget, no-progress detection, and stop condition live in orchestrator code — testable, not dependent on the model following instructions.

### Mapping onto our server

The loop **wraps** [`startRunner()`](../server/index.ts#L173), it doesn't replace it. Current flow — one `query()` per `POST /api/chat`, resumed via `conversations.session_id`, turns queued at [server/index.ts:626-630](../server/index.ts#L626-L630) — stays intact for the worker path.

Additions:

1. **Schema**: `conversations.auto_loop_enabled` (bool), `conversations.auto_loop_goal` (text — the full-scope instructions the user wrote), `conversations.loop_iteration` (int), `conversations.loop_cost_usd` (numeric).
2. **After worker's `result` event** (end of the existing `for await` in `startRunner`): if `auto_loop_enabled`, spin up a second `query()` with:
   - **fresh session** (no `resume`),
   - **read-only tools**: `allowedTools: ["Read", "Glob", "Grep"]`,
   - **input**: `{ goal, lastAssistantText, toolsUsed }`,
   - **system prompt**: rubric + JSON output schema `{ status: "continue" | "done" | "error", feedback, nextSteps }`.
3. **Parse the evaluator JSON.** On `continue`, enqueue `nextSteps` as the next prompt via the existing queue mechanism at [server/index.ts:351-369](../server/index.ts#L351-L369). On `done`, emit `turn-done` as today and clear the loop. On parse failure: treat as `error`, stop, don't retry in a tight loop.
4. **Track** `loop_iteration` and cumulative `loop_cost_usd` (summing `total_cost_usd` from both worker and evaluator `result` messages). Bail at limits.

### Stop conditions (orchestrator, not prompt)

- `maxIterations` — start at 5.
- `maxCostUsd` — sum worker + evaluator `total_cost_usd`.
- **No-progress hash** — hash the evaluator's `feedback` text; same hash twice in a row = stuck, break.
- **User cancel** — the existing [abort controller in Conversation.model](../src/models/Conversation.model.ts) already covers manual cancel; check it between iterations.

### Gotchas

- **Evaluator sees disk state, not tool trace.** Both the worker and the evaluator run in the same cwd (the worktree), so the evaluator can `Read`/`Grep` the files the worker edited. It does *not* see the worker's tool-call history — include a short tools-used summary in the evaluator prompt if the rubric cares about *how* something was done, not just the result.
- **Evaluator needs worker output, not its session.** Capture the final assistant text as it streams, pass it verbatim into the evaluator prompt. Do not try to `resume` the worker session for evaluation.
- **JSON parsing will fail occasionally.** Wrap it; one failure stops the loop. No retry.
- **UI needs iteration boundaries.** Emit a new SSE event type `auto_loop_iteration` (with `{ iteration, maxIterations, costUsd, feedback }`) so the chat UI can render `iteration 2 of 5` and show a cancel button. Don't hide iterations behind the existing `done` event.

### Minimal shape for v1

- Hardcode `maxIterations = 5`, `maxCostUsd = $1.00`.
- Fixed read-only evaluator (Read / Glob / Grep).
- One new SSE event: `auto_loop_iteration`.
- Reuse the existing prompt queue — don't build a parallel runner system.
- No subagents, no shared sessions, no loop-in-prompt.

Ship it, then tune the rubric.

### Evaluator system prompt (sketch)

```
You are a strict code-task evaluator. Given:
  - GOAL: the user's original task
  - LAST_OUTPUT: the worker agent's last assistant message
  - TOOLS_USED: a short summary of what the worker did

Use only read-only tools (Read, Glob, Grep) to verify the result against GOAL.

Respond with ONLY valid JSON:
{
  "status": "continue" | "done" | "error",
  "feedback": "concise critique, what's missing or wrong",
  "nextSteps": "if continuing, the exact next instruction to give the worker"
}

Continue if the goal is materially incomplete or incorrect.
Done if the goal is met, even if style could be better — don't chase perfection.
Error if the situation is unrecoverable (missing deps, broken tree, hostile state).
```

### Mid-turn nudges (next-tool-boundary injection)

The Agent SDK only delivers user messages between turns. For long-running tasks, that means the user's "wait, also do X" can sit in a queue for minutes. We use the SDK's `canUseTool` callback as the *earliest natural injection boundary* — between two tool calls, before the next one starts.

**Schema** (migration `0008_message_delivery.sql`):

```sql
alter table messages add column delivered_at timestamptz;
update messages set delivered_at = created_at where delivered_at is null;
-- new rows default null; server sets explicitly based on context
```

**Server flow:**
1. `POST /api/chat` (start a fresh turn) — inserts the user message with `delivered_at = now()`. Sweeps any older nudges that are still `delivered_at IS NULL` and folds them into the prompt at the same time.
2. `POST /api/messages/nudge` (during streaming) — inserts user message with `delivered_at = null`. Returns immediately; no runner kicked. UI flips to clock icon via realtime.
3. **`canUseTool` callback** — every time Claude is about to use a tool, the callback queries `messages where conversation_id = X and role = 'user' and delivered_at is null` ordered by `created_at`. If any:
   - Combine their text into a single nudge.
   - `update delivered_at = now()` on each.
   - Return `{ behavior: "deny", message: <combined>, interrupt: true }` — the SDK exits the turn cleanly.
4. **End-of-turn safety net** — if the turn ended without firing `canUseTool` (rare: pure-text response, no tools), the runner checks for pending nudges before declaring the turn done; same flow.
5. **Re-entry** — `startRunner`'s while loop re-enters with the combined nudge as the next prompt and the worker session resumed. Doesn't re-insert the user row (already in the DB).

**No polling.** The callback fires only when Claude is at a real tool boundary. No timers, no daemons.

**Client flow:**
- `Conversation.send()` checks `streaming`: if true → `POST /api/messages/nudge`; if false → existing `POST /api/chat`.
- Realtime delivers the new row to the UI; tick or timer renders from `delivered_at`.

**UX:**
- User message row renders a 🕒 clock icon when `delivered_at IS NULL`, ✓ tick when set.
- Assistant rows: no icon.
- Composer always sends — no client-side queue, no "queued" pill.

**Latency**: bounded by one tool call. For tool-heavy work (the typical Claude Code pattern: many Read/Edit/Bash calls per turn), seconds. For pure-text turns, end-of-turn (same as today).

**Why not push into the live `query()` iterator?** The SDK explicitly buffers `AsyncIterable<SDKUserMessage>` yields until the current turn ends — same boundary as today's queue. `canUseTool` deny+interrupt + re-enter is the only way to cut the wait.

### UX surfaces

- **Task header**: `iteration n / max`, running cost, elapsed time, worker status.
- **Nudge composer**: user can inject instructions between iterations; queued as the next worker prompt, overriding evaluator `nextSteps` for that iteration.
- **Chat timeline**: iteration dividers (`── iteration 2 ──`) separate worker transcripts visually.

---

## Evaluation

### Pros

- **Solves the actual problem.** Two conversations on one project stop fighting over files, branches, diffs, and the changes panel.
- **Convergent with the ecosystem.** Cline Kanban, parallel-code, and Claude Code's native `-w` all landed on the same shape. Low risk of picking the wrong abstraction.
- **Tiny schema cost.** 3 columns on conversations, 2 on projects. No new table, no join. `worktree_path = null` fallback means legacy rows are free.
- **Changes panel is a freebie.** [server/index.ts:475-509](../server/index.ts#L475-L509) already resolves via `cwdForConversation()`. Swap that function and the panel + file watcher are correctly scoped.
- **Ship = PR.** Per-conv branch means "open a PR from this chat" is one `gh pr create`. Today you'd have to instruct the agent which files to stage.
- **`bypassPermissions` gets safer.** Blast radius shrinks from "the project" to "this branch." Not isolation, but a meaningful reduction.
- **Composes with Phase 3b.** If E2B comes back, one worktree per microVM still works. Not a dead end.
- **Opt-in via `worktree_mode`.** Non-git projects and solo workflows aren't penalized.

### Cons

- **Conversation create becomes server-side.** Today the browser inserts directly to Supabase ([src/models/Workspace.model.ts:237-257](../src/models/Workspace.model.ts#L237-L257)). Adding a worktree means a real `POST /api/conversations` endpoint — more surface area, auth, error handling, and a 1-3s latency bump on "New chat."
- **Disk usage scales linearly.** Symlinks help with `node_modules`, but source files, build artifacts inside the worktree, and `.git/worktrees/<id>` metadata still duplicate per conversation. 20 active chats on a 500MB repo ≈ 10GB.
- **Shipping is where the real complexity lives.** Merge conflicts, base-ref drift, auto-commit-message quality, push auth, PR templates — none trivial. Kanban solves it by letting the agent handle conflicts; we'd need the same, which means prompt engineering and a new "ship" mode.
- **Soft-trash needs a reaper.** 7-day grace period means a background job, a `deleted_at` column, and logic to distinguish "trashed but resumable" from "actually gone."
- **Symlink fragility.** If the user reinstalls `node_modules` *in a worktree*, they silently mutate the base. Needs doc warnings or broken-symlink detection.
- **Recovery on crash is nontrivial.** Server dies mid-`git worktree add` → orphan directory without a DB row, or a DB row pointing at nothing. Reconciliation on boot is sketched but not specified.
- **Watchers scale.** One chokidar watcher per active conversation instead of per project. At 15 parallel chats: 15 watchers, 15 SSE streams. Probably fine, but worth measuring.
- **PR mode needs `gh` CLI + GitHub auth on the server.** Not currently required. Adds a setup step for self-hosted users.
- **Windows/CI assumptions.** POSIX symlinks. Fine for Railway, anyone running locally on Windows is out.
- **No help for non-git projects.** A folder of scripts gets nothing. Feature isn't universal.
- **Branch clutter.** After 100 trashed conversations, `ai-coder/*` branches litter `git branch -a` unless we're religious about `-D` on trash. Needs a prune UX.

### Net

Pros are structural, cons are operational. The design is right; what makes or breaks it is staffing the ship/discard/recovery paths properly instead of treating them as afterthoughts. Phasing matters: shared-mode fallback still default, per-conv worktree behind a flag, ship-as-commit before ship-as-PR, reaper last.

## Alternatives considered

- **Per-project worktree** — doesn't solve the real conflict (N conversations, 1 tree).
- **E2B microVM per conversation** (the original Phase 3b plan) — heavier, deferred for good reasons. Worktrees give 90% of the benefit for 5% of the operational cost, and are complementary: if Phase 3b reopens, each microVM can still hold one worktree.
- **Branch-switching on the shared cwd** — fragile, blocks on dirty state, breaks the file watcher.
- **Reusing `conversations.sandbox_id`** — reserved for the microVM path; keep it clean.

## Open amendments

The design above reflects what's shipped. Two choices are worth flagging separately because we may want to revisit them, not because they deviate:

- **SQL default `worktree_mode = 'shared'` for all rows.** Existing projects land in shared mode on migration with zero drama; the new-project dialog flips the checkbox to *on* for git repos, so new projects still end up in `per_conversation`. If we ever want a project-level default the UI doesn't need to manage, this moves to `'per_conversation'` in the SQL and we backfill existing rows explicitly.
- **Delete flow doesn't prompt on unpushed commits.** Soft-trash + 7-day reaper replaces the design's "prompt if unpushed" — delete is cheap, restore is cheap, only permanent after a week. If the grace window feels too long, add the unpushed-commits check.

Everything else in the plan is either shipped faithfully or scoped as future work (see [WORKTREES-PROGRESS.md](WORKTREES-PROGRESS.md)).

---

## Verification plan

1. Two conversations under one project, each on its own branch, editing overlapping files → no cross-contamination in changes panels, both commit independently.
2. Ship one as commit, the other as PR → base branch advances, second conversation's worktree rebases cleanly.
3. Trash a conversation → worktree and branch removed; resume within grace window restores them.
4. Legacy conversation (no `worktree_path`) → still works, still points at `project.cwd`.
5. Non-git project → toggle disabled, shared mode forced, no worktree created.
6. Server restart mid-session → worktree reconciliation runs; active conversations resume without manual fix.

## Implementation phasing (for the follow-up plan)

1. Migration `0006` + server-side conversation creation endpoint (shared mode still default).
2. `cwdForConversation()` prefers `worktree_path`; legacy path unchanged.
3. Worktree creation + symlinking on conversation create.
4. Ship endpoint (commit variant first, PR variant second).
5. Discard + soft-trash + recovery reconciliation.
6. UI: branch chip, Ship button, worktree-mode toggle in new-project dialog.
