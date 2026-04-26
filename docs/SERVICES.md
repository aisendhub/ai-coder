# Services Management

Long-form design for how Worktrees configures, runs, and surfaces dev services. Anchors the answer to "what happens when I switch projects?" and adjacent UX questions.

## The scope mismatch (the core tension)

Services have three different scopes that don't line up cleanly:

| Scope | What it means | Where it lives |
|---|---|---|
| **Configuration** | "This project has a `web` service that runs `npm dev`." | Per-project — `project_services` table, RLS-scoped to user. |
| **Logical session** | "Right now I'm working on Project A; show me Project A's services." | Per-project — UI-driven, derived from `activeProjectId`. |
| **Operational** | "The `node` process is bound to PID 12345 and port 4127." | Per-OS — one shared process tree, one shared port space, one shared filesystem. |

The configuration and logical-session scopes match (project). The operational scope doesn't. **Services are configured per-project, run on the shared OS.** Every UX problem in this doc traces back to that mismatch.

## Today's behavior

- **Per-project services panel.** Shows configured services + running instances scoped to `(user, activeProject, *, *)`. Worktree-aware via the registry's 4-tuple key.
- **Project switch ignores running services.** [src/models/Workspace.model.ts:135](../src/models/Workspace.model.ts#L135) clears the panel's row cache and refetches for the new project. The actual running processes are unaffected — they keep running on their ports.
- **No global view.** A user in Project B has no way to know that Project A still has 3 services running. They'll find out when port 3000 is taken.
- **Port allocation is automatic** ([server/runtime/registry.ts:142](../server/runtime/registry.ts#L142)), but `RUNTIME_PORT_RANGE` defaults to `4100-4999` — collisions across projects are *avoidable* but the user can't see what's claimed.
- **Cleanup happens at:** explicit stop button per service, server shutdown (process exit), boot-reconcile (recovers orphans). No "stop all" surface.

## Use cases (before designing for them)

**A. Active dev session.** Solo dev, one project at a time. Starts services, codes, stops services, switches projects. Wants services to do the obvious thing — start when asked, stop when explicitly asked.

**B. Multi-project full-stack.** Frontend in Project A, API in Project B, monitoring dashboard in Project C. All three running concurrently. Wants explicit, durable control — *never* auto-stop on project switch.

**C. Long-running background.** A bot, a webhook handler, a watcher. User starts and walks away for hours/days. Auto-stop would be destructive.

**D. Parallel agents (worktrees).** Three tasks running on the same project. Each has its own worktree, possibly its own service instance. Tasks need isolated services; the project's "shared" services keep running underneath.

## Design principles

1. **Never auto-kill running services.** Data loss risk is too high. Stopping is *always* explicit.
2. **Always surface what's running, anywhere.** A global "running services" view exists at all times so the user can see across projects.
3. **Configuration is per-project; operation is per-OS.** Acknowledge the mismatch in the UI rather than papering over it.
4. **Port allocation is invisible by default.** Auto-assign from a range; show the assignment, never make the user pick. Collision avoidance is the runtime's job.
5. **Worktree isolation is opt-out, not opt-in.** Tasks (worktree-backed conversations) get their own service instances by default. Chats share the project-cwd instance.
6. **Failure modes are loud.** Crashes, port conflicts, supervisor escalations get a chat notice — not a silent log line.
7. **Lifecycle hooks at user boundaries.** Sign-out, server shutdown, explicit "stop all" — predictable, never surprising.

## The recommended UX

### Three surfaces

**1. Per-project services panel** (today's surface, kept).
Lists configured services for the active project, with their current run state. Per-card actions: start/stop/restart, edit config, view logs, save-as-task-override. Unchanged from today.

**2. Global running-services indicator** (new).
A small chip in the top bar: `● 4 running` with a colored dot per running service. Click → opens a drawer listing every running service across all projects, grouped by project, with per-row stop button and a global "Stop all" at the bottom. Clicking a row jumps to that project.

**3. Project-switch passive notice** (new).
When you switch projects and the *previous* project still has services running, surface a one-line dismissable notice in the new project's panel: *"Project A still has 3 services running. View."* Click "View" → opens the global drawer scoped to Project A. **No auto-stop.** No modal. The notice is informational, not an interruption.

### Project switch behavior table

| Previous project state | New project state | Action |
|---|---|---|
| 0 running | any | Silent switch. |
| 1+ running | 0 running | Show passive notice in new panel: "Project A: N services still running." |
| 1+ running | 1+ running (different services) | Show passive notice + scope global indicator to "all" by default. |
| 1+ running | 1+ running (port collision risk: same `assigned_port`) | Show notice with warning icon: "Port 4127 already in use by Project A's `web`. Project B's `web` will get a new port." |

### Per-service controls in the global drawer

For each running service:
- Project, service name, current PID, port, uptime, restart count
- **Stop** (graceful), **Force-stop** (SIGKILL), **Restart** (stop-then-start)
- **Pin to project** (default = pinned). Unpinned services are flagged for "consider stopping when this user signs out."
- **View logs** (jumps to the project's services panel with this service's logs open)

### Global "Stop all" semantics

- Default: stops all services for the current user across all projects.
- Confirm dialog: lists what will be stopped + estimated impact (e.g., "will free ports 4100, 4127, 4234").
- Power user: cmd-click "Stop all" to skip confirmation (after first use).

### Sign-out behavior

- Sign-out today: services keep running (the OS process tree doesn't care).
- **Recommended:** offer to stop all on sign-out, default = NO (preserve background work). Persist this choice per-user.

### Server shutdown behavior

- Today: shutdown sends SIGTERM, then SIGKILL after timeout. Boot-reconcile recovers anything still alive.
- **Recommended:** keep this behavior. It's correct.

## Worktree isolation — the second axis

Tasks (worktree-backed conversations) introduce a second scope dimension. The registry handles it correctly today via the 4-tuple key `(ownerId, projectId, serviceName, worktreePath)` — chats on main share `worktreePath = null`; each task has its own worktree path.

What this means in practice:
- Project A has `web` configured. Chats on Project A share one running `web` instance.
- Open a task on Project A. The agent runs `web` inside the task's worktree → second `web` instance, different port.
- Task ships → worktree gone → that instance is orphaned and cleaned up by reconcile.
- Trash a task → worktree marked for cleanup → the instance is stopped during prune.

The global drawer should show worktree-scoped instances grouped under their parent project, with the task title as a sub-row label: `Project A › Task #4 — "fix the auth bug" › web`.

## Port allocation strategy

Today: `allocatePort(preferred?)` searches `RUNTIME_PORT_RANGE` (default `4100-4999`) for a free port, optionally honoring a preferred port from the manifest.

**Recommendations:**
- Keep the auto-assign default. Don't make users pick ports.
- When a service has a manifest-specified port and it's free, use it. When taken, allocate a free one and **surface the substitution in the chat** as a notice: *"`web` requested port 3000 but it was taken — running on 4127."*
- For long-running services, persist the assigned port in `project_services.assigned_port` so subsequent restarts try the same port first (already done in [server/index.ts:3902-3907](../server/index.ts#L3902)). Currently has a bug — port isn't always mirrored to `conversations.assigned_port` for tasks; see [W1-AUDIT.md](W1-AUDIT.md).

## Open questions / future considerations

- **Inter-service health checks.** Should a `web` service that depends on `api` block its start until `api` is healthy? Today: no, services start independently. Future: optional `dependsOn` in the manifest.
- **Resource caps.** Max RAM, max CPU, max processes per service. Today: none. Hangar (the hosted product) will need these.
- **Cross-project port maps.** A read-only "what's bound to port X across all my projects" view. Useful for debugging.
- **Headless mode.** Services that start when the project is added (no chat needed) for true background workers. Requires a "background services" config that runs at server startup.
- **Service templates.** Cataloged manifests for common stacks (Next.js dev, Vite dev, Rails, Django, Postgres) so the agent doesn't need to redetect from scratch.

## What's actually getting built today

From this doc, the immediate priorities (in W1 / early W3):

- ✅ Per-project services panel — already shipped.
- ✅ Worktree-aware registry — already shipped.
- ✅ Auto-port-allocation — already shipped.
- ⬜ Global running-services indicator — **W3 (UI polish)**.
- ⬜ Project-switch passive notice — **W3**.
- ⬜ Global "Stop all" — **W3** (small endpoint + UI).
- ⬜ Sign-out cleanup prompt — **W3**.
- ⬜ Cross-project port map view — **W4 / OSS docs surface**.

The bug-class items get fixed alongside this work:
- Auto-persist `<run-services>` proposals (so the panel isn't a "click Save 5 times" wall) — fixed in this commit.
- Null-check service row in per-task override path — fixed in this commit.
- Restart race for instances mid-stopping — fixed in this commit.
