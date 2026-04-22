# Runtime & Deploy — Implementation Progress

Tracking doc for the runtime/deploy feature. Design lives in [RUNTIME.md](RUNTIME.md).

Legend: ✅ done · 🟡 in progress · ⬜ not started · 🚫 blocked · ⏸️ deferred

---

## Phase overview

Each phase is independently useful — we can ship, stop, and reassess between any two.

| # | Phase | Surface | Blocking? |
|---|---|---|---|
| 1 | **Local-process runner** | Run a service from the UI, no containers | foundation |
| 2 | Manifest detection + caching | Per-project default, per-worktree override | extends 1 |
| 3 | Local container runner (`docker run`) | Prod-parity sandbox on the laptop | extends 2 |
| 4 | Generated Dockerfile | Universal build artifact (via Nixpacks) | needed for 5+ |
| 5 | Railway adapter | First cloud target | extends 4 |
| 6 | Fly.io adapter | Second cloud target, stresses the Runner abstraction | extends 4 |
| 7 | Cloudflare Workers adapter | Non-Docker escape hatch for edge-compatible apps | independent of 4 |
| 8+ | Additive adapters (Cloud Run, Vercel, Render, …) | One file each in `server/runtime/runners/` | additive |

---

## Phase 1 — Local-process runner

Goal: **Run** button in the UI that spawns the user's dev server for a project or worktree, streams logs back, and lists what's running. Zero container dependency — just `child_process.spawn`. This is also the primitive for the "run worktrees" question from earlier design chats.

### 1a — Manifest type + minimal detector

- ✅ `server/runtime/manifest.ts`
  - ✅ `RunManifest` type (stack, build?, start, cwd, env, port?, healthcheck?, dockerfile?)
  - ✅ `detect(cwd): Promise<RunManifest | null>` — Node-only for Phase 1
    - ✅ Read `package.json`; prefer `scripts.dev`, fall back to `scripts.start`
    - ✅ Infer package manager from `packageManager` field, then lockfile (`bun.lockb`/`bun.lock` → `bun`, `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, `package-lock.json` → `npm`)
    - ✅ Return `null` if no `package.json` — user gets a "Configure run command" prompt
  - ✅ `mergeManifest(base, override)` — deep-merge for env; stubbed for later fields
- ✅ `server/runtime/index.ts` — single export barrel (enforces §1f isolation)
- ✅ Smoke-tested: detects `npm run dev` on ai-coder repo; returns `null` for `/tmp`

### 1b — Services registry + log hub (in-memory)

- ✅ `server/runtime/ring-buffer.ts` — bounded line buffer (2000 lines cap) + line framer for stdio chunks
- ✅ `server/runtime/registry.ts`
  - ✅ `Map<serviceId, RunningService>` — `{ id, manifest, cwd, pid, port, status, startedAt, logs: RingBuffer, emitter }`
  - ✅ `startService(manifest, { ownerId, projectId, worktreeId?, label? })` → `ServiceSnapshot`
    - ✅ Auto-assign free port via real `net.createServer().listen()` probe in sandbox range (default `4100-4999`, env `RUNTIME_PORT_RANGE`)
    - ✅ Inject `PORT=<assigned>` into child env
    - ✅ `spawn(manifest.start, { cwd, env, shell: true, detached: true })` — new process group for group-kill
    - ✅ Pipe stdout/stderr into ring buffer + `EventEmitter` fanout for SSE subscribers
    - ✅ Line-framing so partial-chunk stdio becomes clean log lines
  - ✅ `stopService(id, ownerId)` — negative-PID SIGTERM → 5s grace → SIGKILL
  - ✅ `listServices({ ownerId, projectId?, worktreeId? })` with ownership scoping
  - ✅ `subscribeLogs(id, ownerId)` → `{ history, onLine, onStatus, onEnd, unsubscribe }`
  - ✅ `getLogHistory(id, ownerId)` for tail-on-open
  - ✅ Marks `status = 'crashed'` with exit code when child dies unexpectedly; `'stopped'` on graceful exit

### 1c — Lifecycle safety

- ✅ On server shutdown (`SIGINT`/`SIGTERM`): kills all child processes before re-raising the signal — verified in boot test (`[runtime] shutdown.signal signal=SIGTERM` on kill)
- ✅ Per-user concurrent service cap (default `5`, env `RUNTIME_MAX_SERVICES_PER_USER`) — surfaces as `RuntimeError("user_cap_reached")` → HTTP 429
- ✅ Port range exhaustion → `RuntimeError("port_range_exhausted")` → HTTP 503
- ⏸️ Shell-metachar filtering on `start` — intentionally skipped: manifest is the user's own repo, spawned with their perms; same trust boundary as `tsx server/index.ts`

### 1d — HTTP endpoints (Hono)

- ✅ `POST /api/services/start` — body: `{ userId, projectId, conversationId?, label?, overrides? }` → `ServiceSnapshot`
  - ✅ Detects manifest via `detect(cwd)`; 422 if no runnable app found
  - ✅ Verifies project ownership; if `conversationId` provided, verifies it belongs to that project
  - ✅ Resolves cwd from `conversations.worktree_path` when present, else `projects.cwd` via `resolveProjectCwd()`
- ✅ `POST /api/services/:id/stop`
- ✅ `DELETE /api/services/:id?userId=…` — stops if live, then removes the record
- ✅ `GET /api/services?userId=…&projectId=…&conversationId=…` — scoped list
- ✅ `GET /api/services/:id?userId=…` — single-service status
- ✅ `GET /api/services/:id/logs?userId=…` — SSE stream (history tail + live + status + end), cleans up on client abort
- ✅ `RuntimeError` → status code mapping (`user_cap_reached` 429, `port_range_exhausted` 503, `not_found` 404, `not_owner` 403, `already_stopped` 409)

### 1e — UI

- ✅ `src/models/Service.model.ts` — `Service` model with MobX observables
- ✅ `src/models/ServiceList.model.ts` — list with `refresh`, `start`, `stop`, `remove`, `subscribeLogs` (manages EventSources)
- ✅ Wired into `Workspace.services` and exported from `src/models/index.ts`
- ✅ `src/components/services-panel.tsx`
  - ✅ `ServicesTrigger` — top-bar icon button (`Server`), shows live count badge when any services are running
  - ✅ Sheet-based panel opens on trigger click, auto-refreshes every 5s while open
  - ✅ `Run` button starts a service for the active conversation's worktree (or the active project if no conversation)
  - ✅ Row per service: status dot (emerald/amber/red/grey), label, stack + command, port, "Open in browser" link, Stop/Remove button
  - ✅ Inline log viewer below the list when a service is selected — streams via SSE, stderr tinted red, autoscroll-until-scrolled-up with "Jump to latest" prompt
  - ✅ Toasts on start/stop failure via `sonner` — dedicated message when manifest detection returns 422
- ✅ Plugged into [src/components/top-bar.tsx](../src/components/top-bar.tsx) next to `ChangesTrigger`
- ⏸️ Run button on project/worktree headers outside the sheet — Phase 2 (once manifest caching lands, makes sense as quick-action)

### 1f — Isolation hygiene

- ✅ All Phase 1 server code lives under `server/runtime/` only
- ✅ Runtime module has zero imports from chat, agent SDK, or DB modules
- ✅ Chat/agent code only imports from `server/runtime/index.ts` (the barrel)
- ✅ Single export barrel: `server/runtime/index.ts`

### 1g — Done criteria

- ✅ Killing the Hono server kills every child it spawned (registry smoke-test: SIGTERM to two running services cleaned up via `shutdownAll()`; server boot test logged `shutdown.signal` on kill)
- ✅ Two services in parallel get distinct ports — smoke-tested (4100, 4101)
- 🟡 End-to-end "Run → open browser → watch logs → Stop" in the UI — wiring complete, awaiting live browser verification

---

## Phase 2 — Manifest detection + caching

Cache detection results; let users edit; introduce project vs. worktree scope.

> Schema correction from the design doc: this repo stores per-task state on `conversations`, not a dedicated `worktrees` table. So the override + assigned port live on `conversations.*` (task = conversation).

- ✅ Migration `supabase/migrations/0011_runtime_manifest.sql`
  - ✅ `projects.run_manifest jsonb null`
  - ✅ `conversations.run_manifest_override jsonb null`
  - ✅ `conversations.assigned_port int null`
  - ✅ Applied to Supabase via `psql "$DATABASE_POOLER_URL" -f supabase/migrations/0011_runtime_manifest.sql`
- ✅ First-run flow: Run click → `GET /api/projects/:id/manifest` → if `cached === null`, client swaps panel body to an inline manifest editor pre-filled with `detected`, user confirms/edits, `PUT` saves, then start fires
- ✅ Worktree start: `loadManifestContext()` reads `projects.run_manifest` + `conversations.run_manifest_override` and `mergeManifest`s them before spawn; cwd is always re-anchored to the effective worktree (stored `cwd` is ignored)
- ✅ Port policy: `conversations.assigned_port` preferred on restart via `startService(..., { preferredPort })`; registry probes `isPortFree` first and falls back to linear allocation; actual bound port is written back so the stored value reflects reality
- ✅ "Edit start command" UI — gear icon in the services panel header opens the same editor in `edit-project` mode
- ✅ Detector extended:
  - ✅ `Procfile` (any stack, wins over everything — user-authored override)
  - ✅ Python (`pyproject.toml` / `requirements.txt` + entry probe for `manage.py`, `main.py`, `app.py`, `server.py`; returns partial manifest with empty start when no entry found so the UI can prompt)
  - ✅ Static (`index.html` at root with no `package.json` → `npx --yes serve -l $PORT .`)
- ✅ Input sanitization on PUT endpoints (whitelisted fields; `cwd` never persisted — always derived at runtime)
- ✅ Manifest CRUD endpoints:
  - ✅ `GET /api/projects/:id/manifest?userId=` — returns `{ cached, detected, effective, cwd }`
  - ✅ `PUT /api/projects/:id/manifest` — saves sanitized manifest
  - ✅ `DELETE /api/projects/:id/manifest?userId=` — clears cached
  - ✅ `GET /api/conversations/:id/manifest?userId=` — returns `{ projectCached, override, detected, effective, assignedPort, cwd }`
  - ✅ `PUT /api/conversations/:id/manifest-override` — saves sparse override
  - ✅ `DELETE /api/conversations/:id/manifest-override?userId=` — clears override
- ⏸️ UI for conversation override (separate from project default) — deferred to Phase 2 polish; project default + edit covers 90% of cases. Users who need the override can `PUT` directly until we surface it in the editor.

## Phase 3 — Local container runner

Same manifest, run in Docker/Podman/OrbStack via CLI. Proves the manifest-to-container path end-to-end before any cloud target.

- ✅ `server/runtime/runners/types.ts` — `Runner` interface (isAvailable, start, stop); registry delegates through this
- ✅ `server/runtime/runners/local-process.ts` — existing spawn logic extracted from registry.ts behind the interface (no behaviour change, cleaner separation)
- ✅ `server/runtime/runners/local-docker.ts`
  - ✅ Availability probe via `docker version` — works for Docker Desktop / OrbStack / Podman / Colima / Rancher Desktop; cached 60s; bespoke install hints per failure mode (binary missing vs daemon down)
  - ✅ Dockerfile source: root `Dockerfile` wins, else `.ai-coder/Dockerfile` (ours), else generated
  - ✅ `docker build -f <path> -t ai-coder:<hash> .` with build output streamed into the service log buffer (prefixed `[build]`)
  - ✅ `docker run --rm -d --name ai-coder-<id> -p <hostPort>:3000 -e PORT=3000 …` (fixed container port, host port dynamic)
  - ✅ Log stream via `docker logs -f` piped into the same log emitter as local-process
  - ✅ Stop via `docker stop -t 5 <name>` — idempotent; "No such container" is ignored
  - ✅ Exit code inspected via `docker inspect` (best-effort — `--rm` races); falls back to clean exit
- ✅ `GET /api/services/runners` — returns `[{ id, available, reason? }]` for UI disabling
- ✅ New `runner_unavailable` error code → HTTP 503 with the install hint
- ✅ UI: runner picker (`Process` / `Docker`) next to the Run button
  - ✅ Native `<select>` with availability-gated options (Docker disabled + amber when unavailable)
  - ✅ Tooltip surfaces the install hint as the disabled-reason
  - ✅ Toast on Docker start says "Building image…" so users aren't surprised by the first build's wait

## Phase 4 — Generated Dockerfile

- ✅ `server/runtime/dockerfile.ts` — hand-written templates for `node`, `bun`, `python`, `static`, generic fallback
- ✅ Cache at `.ai-coder/Dockerfile` — rewrite only when content differs so Docker's layer cache stays warm
- ✅ Ownership escape hatch: user-committed root `Dockerfile` always wins; we don't overwrite
- ✅ Stable image tag per cwd (`ai-coder:<hash>`) — keeps the Docker layer cache hit-path tight across restarts
- ⏸️ Nixpacks shell-out as an enhancement — templates cover the top stacks; ship Nixpacks when a user needs Ruby/Elixir/Rust/etc. that we don't template
- ⏸️ Hash-based dirty check (manifest-hash → rebuild) — Docker's own context diffing handles this today

## Phase 5 — Railway adapter

- ⬜ `server/runtime/runners/railway.ts` using Railway GraphQL API
- ⬜ Per-user Railway token in `user_integrations`
- ⬜ Create/update service from repo + env vars
- ⬜ Deploy triggered by pushing the worktree branch
- ⬜ Log stream via Railway's log API
- ⬜ UI: "Deploy to Railway" button on worktree header (once user has connected)

## Phase 6 — Fly.io adapter

- ⬜ `server/runtime/runners/fly.ts` — `flyctl` shell-out (simpler) or Fly Machines API (cleaner)
- ⬜ Generate `fly.toml` from manifest on first deploy
- ⬜ Auto-region, scale-to-zero defaults
- ⬜ Log stream via `flyctl logs`

## Phase 7 — Cloudflare Workers adapter

Non-Docker path. Target: edge-compatible Hono / Next edge / plain Worker projects.

- ⬜ `server/runtime/runners/cloudflare-workers.ts` — `wrangler deploy`
- ⬜ Detect edge-compatibility: no `child_process`/`fs`/`net` imports in entry + deps
- ⬜ Generate `wrangler.toml` if absent
- ⬜ Per-user CF API token

## Phase 8+ — Additive adapters

Each is one file; order by user demand.

- ⏸️ GCP Cloud Run
- ⏸️ Vercel
- ⏸️ Render
- ⏸️ Netlify
- ⏸️ AWS App Runner
- ⏸️ Docker-compose (multi-service) — only if users ask

---

## Open questions tracked

- ⬜ Is in-memory services registry OK, or do we need Postgres-backed so services survive Hono restarts? Lean in-memory for Phase 1 (services are ephemeral anyway).
- ⬜ Should Phase 4 prefer Nixpacks (dependency) or hand-written templates (zero dep, more code)? Start with Nixpacks, template top 3 stacks if it becomes a liability.
- ⬜ Do chats get a "Run" button or only worktrees/projects? Probably project-level only; worktrees inherit, chats are interactive and shouldn't be long-running service owners.
- ⬜ Secrets: `.env` discovery locally vs. platform-native in prod — finalize on Phase 2.
