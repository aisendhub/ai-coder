# Worktrees — Implementation Progress

Tracking doc for the worktree feature. Design lives in [WORKTREES.md](WORKTREES.md).

Legend: ✅ done · 🟡 in progress · ⬜ not started · 🚫 blocked · ⏸️ deferred

---

## Phase 1 — Schema + cwd plumbing

Shared-mode-safe foundation. Existing conversations keep working; no user-visible behavior change.

- ✅ Migration `0006_worktrees.sql` — applied to Supabase
  - ✅ `conversations.worktree_path`, `branch`, `base_ref`
  - ✅ `projects.worktree_mode` (`per_conversation` | `shared`, default `shared` for existing)
  - ✅ `projects.default_base_ref`
  - ✅ `conversations.deleted_at` for soft-trash
- ⬜ Regenerate TS types (`src/lib/database.types.ts`) — after migration applied
- ✅ Server: git helpers (`server/worktrees.ts`)
  - ✅ `isGitRepo(cwd)`
  - ✅ `detectDefaultBaseRef(cwd)`
  - ✅ `addWorktree({ baseCwd, worktreePath, branch, baseRef })`
  - ✅ `removeWorktree({ baseCwd, worktreePath, branch, force })`
  - ✅ `reconcileWorktrees()` on boot — see Phase 6
  - ✅ Symlink helper (`node_modules`, `.env*`, `dist/`, `.next/`, `.venv/`, `target/`, `vendor`, `.cache`, `.turbo`, `.nuxt`)
- ✅ `cwdForConversation()` prefers `worktree_path`, falls back to `project.cwd`
- ✅ `WORKTREES_ROOT` env var with sane default

## Phase 2 — Per-conversation worktree creation

New conversations in per-conv projects get their own worktree + branch.

- ✅ `POST /api/conversations` server endpoint
  - ✅ Insert row (server-side, service role)
  - ✅ Resolve worktree mode from parent project
  - ✅ If `per_conversation`: create worktree + symlinks, persist `worktree_path` / `branch` / `base_ref`
  - ✅ Shared mode: no-op, legacy behavior preserved
  - ✅ Graceful fallback to shared mode when worktree creation fails
- ✅ Client: `Workspace.createNew()` calls endpoint instead of direct insert
- ✅ `DELETE /api/conversations/:id` soft-trashes by setting `deleted_at`
- ✅ `POST /api/conversations/:id/restore` clears `deleted_at`
- ✅ Background reaper: hourly sweep; after 7 days, `git worktree remove --force`, `git branch -D`, hard delete row
- ✅ Client `Workspace.remove()` routes through DELETE endpoint
- ✅ Sidebar filters out `deleted_at IS NOT NULL` rows (list query + realtime)
- ✅ `POST /api/projects` server endpoint + client wire-up
- ✅ `GET /api/fs/git-info?path=…` probe for the dialog
- ✅ New-project dialog: `worktree_mode` toggle (disabled for non-git dirs, explains what the mode does)
- ✅ Capture `default_base_ref` at project creation
- ✅ Branch chip on conversation rows in nav

## Phase 3 — Shipping (commit + PR)

Explicit "this task is done, merge it."

- 🟡 `POST /api/conversations/:id/ship { mode: "commit" | "merge" | "pr" }`
  - ✅ `commit` mode: stages + commits pending changes on the branch; leaves worktree + branch intact
  - ✅ `merge` mode: commit + fast-forward `base_ref`; removes worktree + branch; soft-trashes conversation
  - ✅ `pr` mode: commit + `git push -u origin <branch>` + `gh pr create --base <base>`; leaves worktree intact; returns `prUrl`
  - ✅ Result shape: `{ mode, committed, commitSha, merged, baseAdvanced, pushed, prUrl, warning }`; non-ff and gh-missing both surface as `warning` instead of crashing
  - ✅ `gh` added to [nixpacks.toml](../nixpacks.toml) for Railway builds; inherits ambient `gh auth login` / `GH_TOKEN` on the host
  - ✅ Agent-generated commit message via `generateCommitMessage()` in [agent-loop.ts](../server/agent-loop.ts) — stateless query with Bash/Read/Glob/Grep, conventional-commit system prompt; only fires when the worktree is dirty; falls back to conversation title on error
  - ✅ Merge-conflict handoff via `POST /api/conversations/:id/rebase` — enqueues a focused rebase prompt on the conversation's runner; non-ff warning toast exposes "Ask agent to rebase" action
- ✅ `Merge` + `PR` buttons on the changes-panel header for worktree-backed conversations
  - ✅ Confirm prompts tailored per mode
  - ✅ Toasts: merged (success), PR opened (success with Open action), warning, error
- ✅ `Workspace.shipConversation(id, { mode })` client wrapper
- ✅ Warn on discard if branch has uncommitted files or unpushed/local-only commits — sidebar `Delete` confirm probes `GET /api/conversations/:id/discard-status` and adds the warning text inline

## Phase 4 — Task mode (evaluator-optimizer loop) vs Chat mode

See [WORKTREES.md § Agent loop for Task mode](WORKTREES.md#agent-loop-for-task-mode-evaluator-optimizer). "Task" = worktree + bounded evaluator-optimizer loop; "Chat" = interactive single-turn on shared cwd.

### 4a — Schema + orchestrator

- ✅ Migration `0007_tasks.sql` applied
- ✅ `conversations.kind` (`chat` | `task`, default `chat`)
- ✅ `conversations.auto_loop_enabled` (bool)
- ✅ `conversations.auto_loop_goal` (text — full-scope goal for the task)
- ✅ `conversations.loop_iteration` (int, default 0)
- ✅ `conversations.loop_cost_usd` (numeric, default 0)
- ✅ `conversations.max_iterations` (int, default 5)
- ✅ `conversations.max_cost_usd` (numeric, default 1.00)
- ✅ Index `conversations_kind_updated_at_idx` for future board view
- ✅ `Conversation` model observables + `setFromRow` pick up all new columns

### 4b — Worker/evaluator loop in `startRunner`

Loop wraps the existing runner, doesn't replace it.

- ✅ `server/agent-loop.ts` — `runEvaluator`, `parseEvaluatorJson`, `summarizeTools`, `feedbackHash`
- ✅ After worker `result` event, if `auto_loop_enabled`: spin second `query()`
  - ✅ fresh session (no `resume`)
  - ✅ `allowedTools: ["Read", "Glob", "Grep"]`
  - ✅ system prompt = rubric + JSON schema `{ status, feedback, nextSteps }`
  - ✅ input = `{ goal, lastAssistantText, toolsUsed }`
- ✅ Parse evaluator JSON (wrapped; parse failure = stop, strips accidental ```json fences)
- ✅ On `continue`: drive the next worker turn in-line with `nextSteps` as the prompt and the worker session resumed
- ✅ On `done` / empty nextSteps / evaluator error: emit `auto_loop_stopped` and end
- ✅ Stop conditions (orchestrator code):
  - ✅ `loop_iteration >= max_iterations`
  - ✅ `loop_cost_usd >= max_cost_usd` (worker + evaluator summed)
  - ✅ No-progress hash (same evaluator `feedback` twice in a row)
  - ✅ User cancel via existing abort controller (checked between iterations)
- ✅ Persist `loop_iteration` + `loop_cost_usd` on each iteration
- ✅ New SSE events: `auto_loop_evaluating`, `auto_loop_iteration`, `auto_loop_stopped` (client consumption + UI shipped in 4c below)

### 4c — UI for Task mode

- ✅ Task header strip: branch, iteration meter, cost meter, loop on/off
- ✅ Live transcript with iteration dividers (evaluating / iteration card / stopped card)
- ✅ `Conversation.runTurn` ingests `auto_loop_evaluating`, `auto_loop_iteration`, `auto_loop_stopped`
- ✅ Sidebar: `Tasks` + `Chats` sections with distinct icons (Gauge vs MessageSquare)
- ✅ Split new-button: `[+ Chat]` vs `[+ Task]` — both create drafts in-place (no modal) and open the new row in the chat pane
- ✅ Fresh-task empty state carries the goal textarea + caps form inline; `POST /api/conversations/:id/arm` persists + provisions the worktree + kicks the first turn
- ✅ Mid-turn nudges via `canUseTool` (next-tool-boundary injection — see [WORKTREES.md § Mid-turn nudges](WORKTREES.md#mid-turn-nudges-next-tool-boundary-injection))
  - ✅ Migration `0008_message_delivery.sql` applied; partial index on pending user rows
  - ✅ Server: `POST /api/messages/nudge` — inserts with `delivered_at = null`; if no runner active, marks delivered + auto-starts runner with `skipFirstUserInsert`
  - ✅ Server: `/api/chat` sweeps pending nudges and prepends them to the new prompt
  - ✅ Server: `canUseTool` flushes pending → deny+interrupt; runner re-enters via existing while loop with `skipUserInsertThisIteration = true`
  - ✅ Server: end-of-turn safety net catches nudges sent during pure-text turns
  - ✅ Server: emits `nudge_flushed` SSE event so the UI can confirm the flush
  - ✅ Client: `Conversation.send` routes to `/api/messages/nudge` while streaming; no client-side queue
  - ✅ Client: clock icon + "queued" label on pending user rows, check tick on delivered
- ✅ Controls: pause / resume / stop on the task header
  - ✅ Pause flips `auto_loop_enabled = false`; loop breaks cleanly at next iteration boundary
  - ✅ Resume flips it back and kicks a fresh worker turn with a "continue" prompt + session resume
  - ✅ Stop aborts the in-flight runner and (for tasks) flips loop off so it doesn't auto-continue
  - ✅ Ship covered by Merge/PR buttons in the changes panel (Phase 3)
- ✅ "Spin off as task" — top-bar button on regular chats; opens `NewTaskDialog` pre-filled with the chat's last 5 user prompts as `auto_loop_goal` and the chat's title

## Phase 5 — Board meta-view (power-user affordance)

Kanban-style overview of all tasks across the active project.

- ✅ Full-viewport modal (`src/components/board.tsx`) triggered by the `LayoutGrid` icon in the nav (both collapsed and expanded) and from the `Tasks` section header
- ✅ Columns: Backlog / Running / Review / Shipped / Trashed
  - Derivation: `running` via `workspace.runningServerIds`; `backlog` when `loop_iteration == 0`; `review` when the loop has stopped and the worktree still exists; `shipped` when `deleted_at` is set and `worktree_path` has been cleared (merged); `trashed` when `deleted_at` is set but `worktree_path` still lingers
- ✅ Card: title, branch chip, iteration meter (`n/max`), cost (`$x.xxx/$max`), running pulse dot
- ✅ Card actions: click body to open the task; Pause/Resume mini-button on active cards; Ship button (routes to task for Merge/PR); Trash button with confirm
- ✅ Realtime subscription: any `conversations` change in the active project auto-re-shuffles cards between columns
- ⬜ Drag-and-drop between columns (card actions drive transitions today — lower-priority nicety)
- ⬜ Diff summary on cards (deferred; board stays fast without per-card `git diff` shell-outs)

## Phase 6 — Reliability

- ✅ Boot-time worktree reconciliation against `git worktree list`
  - ✅ Detects + logs orphan worktrees on disk (no DB row — live or trashed)
  - ✅ Detects + logs DB rows whose `worktree_path` no longer exists on disk
  - ✅ Repairs broken symlinks inside tracked worktrees via `repairSymlinks()`
  - ✅ Auto-removes truly orphan worktrees when they match `.ai-coder-worktrees/*` path + `ai-coder/*` branch prefix AND have no DB reference (live or trashed). Uses `git worktree remove` *without* --force so dirty worktrees are left intact; dirty orphans just log instead of removing.
  - ✅ Runs `git worktree prune --verbose` per project to clean git's metadata for missing-on-disk entries
- ✅ Lifecycle logs: unified `[worktree] <event> key=value…` format via `logWorktreeEvent()` — adopted in create / create.failed / remove / remove.failed / symlink.broken / symlink.repaired / ship.commit / ship.merge / ship.pr / ship.warning / arm / prune / reconcile.orphan / reconcile.missing / reconcile.auto_removed / reap.hard_delete
- ⬜ Disk-usage indicator per project
- ⬜ Prune shipped/trashed branches UI (on-demand manual prune from the Board)

## Non-goals (for now)

- Dependency chains between tasks (Kanban's ⌘-click linking) — defer until Phase 4 lands
- Auto-commit / auto-PR without review — dangerous default, opt-in only
- Windows support — POSIX symlinks assumed
- Worktrees for non-git projects — forced to shared mode

---

## Decisions log

- **Per-conversation, not per-project** — see [WORKTREES.md](WORKTREES.md#decision-per-conversation-not-per-project).
- **Default `worktree_mode`**: `shared` for existing projects (backwards-compat), `per_conversation` for new projects once Phase 2 ships.
- **Soft-trash window**: 7 days. Kanban-style resume within that window.
- **Branch prefix**: `ai-coder/`.
- **Worktree root**: `WORKTREES_ROOT` env, defaults to `${PROJECTS_ROOT}/.ai-coder-worktrees`.
- **Chat vs Task** as distinct conversation kinds (not a toggle on a single row) — the agent loop semantics differ (bounded turns, ship action).
- **Only tasks get worktrees.** Chats always use the project's shared cwd, even in `per_conversation` projects. The project flag gates the *feature* (enable worktrees) for tasks; it doesn't force every conversation onto a branch.
