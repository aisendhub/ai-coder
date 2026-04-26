# W1 Validation — services-panel audit + stress-test plan

Closes the two non-code W1 items from [ROADMAP-WORKTREES.md](ROADMAP-WORKTREES.md): "Services panel proposal+approval flow end-to-end verify" and "3-task parallel stress test." Both are runtime / human-in-the-loop validation tasks; this doc captures the code-level audit and the manual procedure to verify.

## Services panel — end-to-end audit

### Path: agent emit → running service

1. Agent emits `<run-services>` (or legacy `<run-manifest>`) in chat. Parsed in [src/lib/hooks/services-proposal.ts](../src/lib/hooks/services-proposal.ts) (lines 44-130). Dispatches `ai-coder:services-proposed` event.
2. Panel auto-opens. [src/components/services-panel.tsx](../src/components/services-panel.tsx) listens via `consumeLatestServicesProposal()` (~line 71), populates picker, spawns `EditorState` per candidate (lines 85-102, modes: `first-run` / `edit-project` / `add-service`).
3. User saves → [src/models/ProjectServiceList.model.ts](../src/models/ProjectServiceList.model.ts) calls `POST /api/projects/:id/services` (line 86) or `PUT /api/projects/:id/services/:name` (line 102). Server `sanitizeServiceWrite()` validates, upserts `project_services`, mirrors `default` to legacy `projects.run_manifest`.
4. Per-task overrides via `PUT /api/conversations/:id/services/:name/override` write to `conversations.service_overrides` JSONB.
5. Start: `POST /api/services/start` → `loadManifestContext()` resolves project row → falls back to legacy `run_manifest` for `default` → reads worktree path + per-service override → returns `effectiveCwd` + manifest + assigned port.
6. Registry scope key is `(ownerId, projectId, serviceName, worktreePath)` — worktree-aware. Chats on main share `worktreePath = null`; tasks get isolated instances.
7. Supervisor (PM2-style) is wired: restart policy + max restarts + escalation via chat notice.
8. Boot reconcile: `service_instances` table records live PIDs; on restart, the supervisor reattaches.

### What works as-is

- Schema + persistence (`project_services` with unique `(project_id, name)`).
- Proposal parsing (handles both `<run-services>` and legacy `<run-manifest>`).
- All CRUD routes for services + per-conversation overrides + LLM/heuristic detection variants.
- Registry scope is correctly worktree-aware (strict `!==` on `worktreePath` in `listServices` filter).
- Supervisor + restart policy.
- Instance persistence + boot reconcile.

### Known gaps

| Severity | Issue | File / fix |
|---|---|---|
| 🚨 **Ship blocker** | Agent `<run-services>` proposals don't auto-persist on turn reconcile — user must manually click Save in the panel for every candidate. There is no server-side hook between message-write and `upsertProjectService()`. | [server/index.ts](../server/index.ts) — add a turn-reconcile hook in `startRunner` that parses `<run-services>` blocks from agent messages and calls `upsertProjectService()` per candidate (with a `proposed: true` flag so the UI shows them as suggestions until confirmed, OR auto-save with a "review and edit" call-out). |
| 🔴 Data bug | In `loadManifestContext()` (~line 3715), per-task override path doesn't null-check `serviceRow`. If a task overrides a non-default service that was never configured at the project level, the override silently writes against the wrong key. | [server/index.ts:3667-3716](../server/index.ts) — guard with `if (!serviceRow && serviceName !== "default") return error`. |
| ⚠️ Race | Restart filter (`listServices` + `stopServiceAndWait`) doesn't account for instances mid-`stopping`. Rapid reruns within the 8-second wait can spawn duplicates on the same port. | [server/index.ts:3842-3871](../server/index.ts) — add a "stopping" grace period before spawn. |
| ⚠️ UX consistency | Port persistence updates `project_services.assigned_port` but only fills `conversations.assigned_port` when null. Tasks can lose stable port URLs across service-config edits. | [server/index.ts:3902-3907](../server/index.ts) — unconditionally mirror the latest port to `conversations.assigned_port`. |

### Manual test plan (services flow)

1. Create a project with 2+ runnable services (monorepo with `web/` + `api/`).
2. Chat → ask the agent to detect services. Confirm panel opens with both candidates. Click Save on each.
3. Run `web`. Open logs; verify SSE stream.
4. Open a second chat tab on the same project — verify it sees the same running `web` instance (no duplicate).
5. Create a task. Agent edits `api/`. Agent emits `<run-services>` for both; pick `api`. Save + run.
6. Verify the task's `api` instance is **separate** from chat — different PID, different port if needed, isolated cwd (= worktree path).
7. In the task, edit the `api` service's `start` command, click "Save for task". Restart the service. Verify task's instance uses the override; chat's `api` doesn't.
8. Manually `kill <pid>` of one instance. Verify supervisor restarts it (logs say "restarting after crash"). Repeat 3× → escalation notice in chat.
9. Kill + restart the server. Open the panel; verify the previously-running services are still listed with the reattach notice.

## 3-task parallel stress test plan

The goal: prove that N agents working in N worktrees on one repo never collide, never hit the same file, and clean up correctly.

### Setup
- Pick a repo with 5+ source files, a test suite, and ≥1 dev service.
- Project mode: `per_conversation` (each task gets its own worktree).

### Procedure
1. Create 3 tasks against the same project, all targeting different parts of the repo (e.g., goals: "add a TODO comment to file A", "rename function X in file B", "extend test for file C").
2. Arm all three within 30 seconds of each other.
3. Watch the kanban board:
   - All three should appear in `running` simultaneously.
   - Each card's diff summary (just shipped) should show *different* file counts and `+/-` deltas.
4. Disk indicator at the top of the board should reflect 3× the typical worktree footprint.
5. While all three are running, run `du -sh .ai-coder-worktrees/` on the host to confirm the indicator matches reality.
6. Each task should stop independently (running → review). Cards should not flicker between columns.
7. Open each task one at a time:
   - Diff view should show only that task's changes.
   - Services panel should show only that task's running instance(s) (if started).
8. Ship one task via merge. Confirm the other two are unaffected (their worktrees still on disk, branches still alive).
9. Trash one task. Confirm:
   - Card moves to `trashed` column with the same disk hint.
   - "Prune trashed" button enables.
   - The other two are unaffected.
10. Click "Prune trashed". Confirm:
    - Card disappears, disk indicator drops by ~the trashed amount.
    - `ls .ai-coder-worktrees/` confirms the worktree directory is gone.

### What to watch for
- **File-locking errors** in agent logs — would indicate a worktree race.
- **Phantom cards** in the kanban (rows that don't reflect DB state) — realtime/reconciliation gap.
- **Services running on the wrong worktree path** — registry scope-key bug.
- **Disk indicator showing 0 when worktrees exist** — `du` wrapper crashed or path encoding issue.
- **Symlinked dirs (node_modules) double-counted** — `du -sk` follows or skips depending on platform; we expect skip via `-P` if added later.

### Race-condition audit (code-level)

Reading the worktree creation + reaper code:
- Worktree creation in [server/worktrees.ts](../server/worktrees.ts) uses `git worktree add` which is atomic per branch. Concurrent creates on different branches don't collide.
- The 7-day reaper (`reapTrashedConversations`) and the new manual prune (`POST /api/projects/:id/prune-trashed`) both call `removeWorktree` with `force: true`. If both fire on the same row in the same tick (manual prune racing the cron), Postgres `DELETE` is idempotent and `git worktree remove --force` no-ops on the second call. **Safe.**
- Services registry uses an in-process `Map`; concurrent `startService` for the same scope key serializes via `stopServiceAndWait`. The race noted above (instances mid-`stopping`) is the only known issue.
- Supabase Realtime fan-out for the kanban can deliver duplicate `UPDATE` events; the board's `findIndex` + `slice + assign` upsert pattern is idempotent. **Safe.**

No additional race conditions surfaced in this pass.
