# Multi-service per project — Design

Un-punting the "multi-service" open question from [RUNTIME.md § Open questions](RUNTIME.md) (line 124: *"Multi-service apps. Punt until a real use case shows up. When it does, the answer is probably 'multiple manifests grouped by the project', not a Compose equivalent we invented."*).

## Context

Today a project has one run manifest (`projects.run_manifest jsonb`). Fine for single-server apps — most of them. Breaks down for:

- Monorepos with `web` + `api` + `worker`
- Full-stack projects with a frontend dev server and a backend API
- Apps with a queue worker or scheduler alongside the web process

Users currently work around this by running the "main" service through our panel and the rest in separate terminals / docker-compose. We're one row-per-service away from handling this natively.

## Decision: list of service configurations per project

Model every service as a persistent *configuration* (name, manifest, enabled, restart policy). The registry already treats running services as service-id-keyed instances; we just need the *config* layer to expand to N rows.

### What changes vs. single-manifest

| Today | After |
|---|---|
| `projects.run_manifest jsonb` | `project_services` table, one row per service |
| `conversations.run_manifest_override jsonb` | `conversations.service_overrides jsonb` = `Record<serviceName, ManifestOverride>` |
| `conversations.assigned_port int` | `project_services.assigned_port int` (per-service, not per-conversation) |
| `GET/PUT/DELETE /api/projects/:id/manifest` | `GET/POST/PUT/DELETE /api/projects/:id/services[/:name]` |
| `POST /api/services/start` body `{ projectId }` | body `{ projectId, serviceName }` + `POST /api/projects/:id/services/run-all` |
| Agent emits one `<run-manifest>` block | Agent emits one `<run-services>` block with an array; legacy `<run-manifest>` still works as a single "default" service |
| UI: one `ConfiguredServiceCard` | UI: list of cards + **Run all** + **+ Add service** header buttons |
| Registry scope key `(ownerId, projectId, worktreeId)` | `(ownerId, projectId, serviceName, worktreePath)` — **cwd-based, not conversation-id-based** |
| restart on crash: no | `restart_policy` per service (`always` \| `on-failure` \| `never`), PM2-style backoff, escalate at `max_restarts` |

### Data model

```sql
create table public.project_services (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,                          -- stable id within project (web, api, worker)
  description text,
  stack text not null,                         -- node | bun | python | ...
  start text not null,
  build text,
  env jsonb not null default '{}'::jsonb,
  port int,
  dockerfile text,
  healthcheck jsonb,                           -- { path, timeoutMs }
  enabled boolean not null default true,       -- included in "Run all"
  order_index int not null default 0,
  restart_policy text not null default 'on-failure',  -- always | on-failure | never
  max_restarts int not null default 5,
  assigned_port int,                           -- stable localhost port across restarts
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);

-- Per-conversation env/start overrides, keyed by service name. Sparse.
alter table public.conversations
  add column service_overrides jsonb;
```

RLS: owner derived via `project_services.project_id → projects.user_id`.

### Backfill

On migration:

1. For each `projects.run_manifest != null`, insert a `project_services` row named `"default"` with the existing manifest fields.
2. For each `conversations.run_manifest_override != null`, set `conversations.service_overrides = jsonb_build_object('default', run_manifest_override)`.
3. For each `conversations.assigned_port != null`, write it to the corresponding service's `project_services.assigned_port` — first-writer wins when multiple conversations have one; the registry's `isPortFree` probe handles conflicts at runtime.

Keep the old columns for one release for safety, then drop in a follow-up migration once the feature has baked.

### Agent prompt update

Detect-services gets a new primary schema:

```
<run-services>
{
  "services": [
    {
      "name": "web",
      "stack": "node",
      "start": "npm run dev -- --port $PORT",
      "env": { "NODE_ENV": "development" },
      "port": 5173,
      "enabled": true,
      "rationale": "Vite dev server from package.json",
      "confidence": "high"
    },
    {
      "name": "api",
      "stack": "node",
      "start": "cd api && npm run dev",
      "env": {},
      "port": 3001,
      "enabled": true,
      "rationale": "Express API from api/package.json",
      "confidence": "medium"
    }
  ]
}
</run-services>
```

The legacy `<run-manifest>` block continues to parse — it just becomes a single service named `"default"`. This keeps existing agent replies valid while we roll out.

`verify-run` gets a `serviceName` arg so the agent knows which service it's verifying (otherwise it might conflate two running services).

### Registry scope — configurations vs. instances

There are two distinct concerns that today's code conflates:

1. **Configurations** — what services a project has (`web`, `api`, `worker`). Lives on `project_services`. Project-wide, same no matter which conversation you have open.
2. **Instances** — actual running processes, scoped to the filesystem they're running against. A Vite dev server running in the base project cwd should stay running when you switch chats; the same Vite on a task's worktree should be a separate process.

The current registry scope key is `(ownerId, projectId, worktreeId)` where `worktreeId` is set from the *conversation id*. That's wrong for chats: two chats on the same main branch have different ids, so the panel filters one chat's services out of the other's view, even though the processes and files are identical.

Fix: **the scope discriminator is the cwd itself, not the conversation id.**

- Chat conversation (no worktree) → scope `worktreePath = null`. All main-branch chats on project P share the `null` bucket — open any chat, see the same running dev server.
- Task conversation (with worktree) → scope `worktreePath = "/abs/path/to/worktree"`. Each task's instances stay isolated.

Concretely:

```ts
type ServiceScope = {
  ownerId: string
  projectId: string
  serviceName: string        // new — which configured service
  worktreePath: string | null  // renamed from worktreeId; now the actual
                               // filesystem path, or null for main cwd
  label?: string | null
}
```

UI implication: switching between conversations re-fetches `GET /api/services?projectId=P&worktreePath=…` (or the derived equivalent). Service *cards* come from `project_services` and are identical across conversations; *status dots / live instance data* update with the scope.

### Can we build on top, or do we need a refactor?

Build on top. The scope change is a **field rename + derivation tweak** in ~5 places:

- Registry: rename `RunningService.worktreeId` → `worktreePath`; it's already opaque to runners.
- `startService`/`listServices`/`stopService` call sites: pass `conv.worktree_path ?? null` instead of `conv.id`.
- Restart-before-start filter: match on `(owner, project, serviceName, worktreePath)` instead of the conversation id.
- `conversations.assigned_port` is replaced by `project_services.assigned_port` (migration 0014 handles this).
- Client: `ServiceList` calls derive `worktreePath` from `active.worktreePath` instead of `active.id`.

No table changes beyond what 0014 already does. No registry internals change (it's still a `Map<serviceId, RunningService>`). The runners are untouched.

What *would* need a refactor is if we wanted *per-conversation* ports on chats (we don't — chats share, that's the whole point) or separate supervisor state per conversation on the same worktree (also out of scope).

## Non-goals for this milestone

- **Compose-style dependency graphs** (service A depends_on service B). Run-all starts everything in `order_index` order; users can tune the order. Full DAGs are a later step if anyone asks.
- **Per-service stacks across runners**. The docker/process runner choice is still global per service-start, not per service-row. If you need service A on Docker and B on process, pick at run time like today.
- **Shared ports / reverse proxy**. No unified URL — each service gets its own `localhost:PORT` entry. A "preview link" aggregator is out of scope.
- **Arbitrary secret stores**. Env stays in `project_services.env` as plaintext-ish JSON (same as today). Platform-native secrets come with cloud adapters, not here.

## Phase breakdown

Each phase is independently shippable and reversible. Do not jump ahead — phases 1-3 establish the foundation every later phase depends on.

| # | Phase | Scope | Status |
|---|---|---|---|
| 1 | Schema + backfill + read-path abstraction | migration 0014, `services-store` helper, `loadManifestContext` routes through it | ✅ done |
| 2 | Endpoints (plural) + registry scope rework (`serviceName` + `worktreePath`) | new `/api/projects/:id/services/*`, start/stop take `serviceName`, `listServices` filters by `worktreePath`, legacy `/api/projects/:id/manifest` aliased to the default row | ✅ done |
| 3 | Client models | `ProjectService`, `ProjectServiceList` models on the workspace, auto-refreshed on project change + on every `ai-coder:turn-done` | ✅ done |
| 4 | List rendering + Run all + Add service | Panel renders one card per configured service, "Run all" + "+ Add" header buttons, editor grows a name field for `add-service` mode | ✅ done |
| 5 | Agent multi-service detect + reconcile | `<run-services>` array block parsed by `extractDetectedServices`, reconcile hook upserts each by name; legacy `<run-manifest>` still saves to `default` | ✅ done |
| 6 | Per-service verify-run + chat notices | `VerifyRunSnapshot.serviceName` wired end-to-end; agent tells it to emit a targeted single-entry `<run-services>` block for fixes | ✅ done |
| 7 | Per-conversation overrides | plural `/api/conversations/:id/services/:name/override` endpoints + model helpers + "Save for task" / "Clear task override" buttons in the editor | ✅ done |
| 8 | Supervisor (restart policy + backoff) | PM2-style supervisor attached after startService when `restart_policy != never`; exponential backoff capped at 30s, counter resets after 10s uptime, `role:"notice"` chat insert on exhaustion | ✅ done |
| 9 | Instance persistence + boot reconcile | migration 0015 `service_instances`, `instance-store` helpers, `reconcileServiceInstances` probes pids at boot and re-registers via the new `external` runner (or reaps the row) | ✅ done |

## Phase 1 checklist — ✅ done

Un-punt the schema. Reads go through a new helper so every later phase plugs in cleanly. Writes still hit the legacy column.

- [x] `supabase/migrations/0014_project_services.sql` (bumped from 0013 to match the live sequence)
  - [x] `project_services` table with all columns + `unique(project_id, name)`
  - [x] RLS policies via `projects.user_id`
  - [x] `conversations.service_overrides jsonb`
  - [x] Backfill: existing `projects.run_manifest` → a `"default"` service row
  - [x] Backfill: existing `conversations.run_manifest_override` → `service_overrides = {"default": override}`
  - [x] Backfill: existing `conversations.assigned_port` → `project_services.assigned_port` where match
- [x] Applied to Supabase
- [x] `server/services-store.ts` — thin helpers:
  - [x] `listProjectServices(projectId): ProjectServiceRow[]`
  - [x] `getProjectService(projectId, name): ProjectServiceRow | null`
  - [x] `upsertProjectService(projectId, write): ProjectServiceRow`
  - [x] `deleteProjectService(projectId, name): void`
  - [x] `patchProjectService` for column-by-column updates (assigned_port, etc.)
  - [x] `getConversationServiceOverride` + `setConversationServiceOverride`
  - [x] `manifestFromRow` / `writeFromManifest` adapters
- [x] `loadManifestContext` reads from `project_services` first, falls back to `projects.run_manifest` only when `serviceName === "default"` and no row exists
- [x] Legacy endpoints (`GET /api/projects/:id/manifest`, detect-services refine branch, verify-run context, start endpoint) keep working — they route through the default service row
- [x] Boot-smoke verified via the running tsx-watch dev server; typecheck clean

## Phase 2 checklist — ✅ done

- [x] `POST /api/projects/:id/services` — create
- [x] `GET /api/projects/:id/services` — list
- [x] `GET /api/projects/:id/services/:name` — read
- [x] `PUT /api/projects/:id/services/:name` — update (mirrors to legacy `projects.run_manifest` when name = default)
- [x] `DELETE /api/projects/:id/services/:name` — delete
- [x] `POST /api/services/start` accepts `serviceName?: string` (default `"default"`)
- [x] Registry `ServiceScope.worktreeId` → `worktreePath`; `ServiceSnapshot.serviceName` added; `startService` takes both
- [x] `listServices` filter accepts optional `serviceName` and `worktreePath`
- [x] Start-endpoint derives `worktreePath` from `conversations.worktree_path ?? null`
- [x] Restart-before-start matches `(owner, project, serviceName, worktreePath)` — chats share the null bucket, different worktrees stay isolated, different services coexist
- [x] Legacy manifest endpoints keep reading/writing the default service row (mirror to `projects.run_manifest` for one release so a rollback is safe)
- [x] `runnerId` surfaced in DTO so the client can detect reattached (external) instances

## Phases 3–9 — ✅ done

See the table above. Client models, multi-card UI, `<run-services>` agent block, per-service verify-run, per-task overrides, PM2-style supervisor, and instance persistence (migration 0015 + boot reconcile via `process.kill(pid, 0)`) are all implemented.

## Follow-up work (out of scope for the multi-service milestone)

- Drop the legacy `projects.run_manifest` column in a follow-up migration once the new code has baked for a release.
- Periodic reaper for stopped `service_instances` rows so the table doesn't grow unbounded (current strategy: cheap `last_seen_at` + status index; stopped rows are small).
