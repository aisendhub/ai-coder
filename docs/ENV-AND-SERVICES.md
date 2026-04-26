# Env & Services

End-to-end design for how Worktrees runs, scopes, and wires services — including env vars, secrets, service-to-service injection, and worktree-scoped services. Builds on [SERVICES.md](SERVICES.md) (which covers project-switch UX) and [W1-AUDIT.md](W1-AUDIT.md) (the lifecycle audit).

This doc takes positions, not surveys. Every decision is anchored to a "what would Railway / Cloudflare / Render / Vercel / Fly do" comparison so we're not reinventing where the answer is settled.

## Table of contents

1. [The four scope axes](#the-four-scope-axes)
2. [Env var hierarchy (the recommendation)](#env-var-hierarchy-the-recommendation)
3. [Secrets model](#secrets-model)
4. [Service-to-service injection](#service-to-service-injection)
5. [Worktree-scoped services](#worktree-scoped-services)
6. [Multi-level kill controls](#multi-level-kill-controls)
7. [What gets built when](#what-gets-built-when)
8. [Industry research summary](#industry-research-summary)

---

## The four scope axes

A service definition + the env around it lives at the intersection of four axes:

| Axis | Values | Notes |
|---|---|---|
| **Ownership** | per-user (RLS) | Always. Multi-tenant baseline. |
| **Configuration scope** | project / worktree | Today only project; *worktree-scoped services are new in this doc.* |
| **Operational scope** | one shared OS | One process tree, one port space, one filesystem. Doesn't change. |
| **Logical session** | active project / chat / task | Drives what the UI surfaces, not what's running. |

Every UX decision in this doc traces back to making these four axes legible. The user shouldn't need to hold them in their head.

---

## Env var hierarchy (the recommendation)

**Layers in precedence order (later overrides earlier):**

1. **Discovery vars** (runtime, auto-injected) — `<NAME>_URL/HOST/PORT` for every running sibling. *Lowest precedence so users can override:* set `API_URL=https://staging` to point past the local sibling.
2. **Project defaults** — committed to repo as `.ai-coder/env.example` (or similar). Non-secret only. Documents what env keys the project expects. Optional.
3. **Project shared** — gitignored, shared across all chats and worktrees on this project. *DB-stored*, not file-stored, so multi-user teams sync via Supabase RLS. Table: `project_env_vars`.
4. **Worktree-scoped** — overrides for a specific worktree (= conversation). Table: `conversation_env_vars`. Cleaned up via FK CASCADE when the conversation hard-deletes.
5. **Service-scoped** — per-service overrides at start time. `project_services.env` (JSONB). Per-task variants land in `conversations.service_overrides[svc].env`.
6. **System metadata** (runtime, reserved) — `WORKTREES_PROJECT_ID`, `WORKTREES_CONVERSATION_ID`, `WORKTREES_BRANCH`, `WORKTREES_BASE_REF`. *Highest precedence — user can't shadow ground truth.*

The PORT-related env (PORT, HOST, framework aliases like VITE_PORT) is layered on top of all of this in a separate registry pass — see [Port semantics + framework aliases](#port-semantics--framework-aliases).

**Why three persisted layers (not five like Railway, not one like Fly)?**
- Project shared = the 90% case. Most env is "DATABASE_URL = ..." that every service needs.
- Worktree = the parallel-tasks case. A task experimenting with different `OPENAI_API_KEY` shouldn't pollute mainline dev.
- Service = the rare case. Per-service overrides happen, but we already model them.

We **deliberately do not** introduce a prod / preview / dev split. Worktrees is a *local dev* tool. If you want prod env, pull it from your actual deploy platform (`railway run`, `vercel env pull`, etc.).

### Editor surface

A new tab in the services panel: **Env**. Shows the merged result with badges per-row indicating which layer set it (`project default` / `project shared` / `worktree` / `service`). User can edit at any layer; the UI shows resolution order.

---

## Secrets model

**Write-only after first save.** Once you save `STRIPE_SECRET_KEY=sk_live_...`, the UI shows `••••••••` and the value is no longer downloadable. To rotate, you re-enter. Mirrors Cloudflare, Fly, Vercel — universal pattern, every platform that's been around long enough lands here.

**Storage:** AES-256-GCM encrypted in Postgres, same as `user_integrations` tokens (we already have [server/integrations/crypto.ts](../server/integrations/crypto.ts)). Reuse `INTEGRATIONS_KEY`.

**Surface in env:** indistinguishable from non-secret env at process-spawn time — `process.env.STRIPE_SECRET_KEY` works. The "secret" flag is a UI/audit concern, not a runtime one.

**No file-on-disk for secrets.** Spawn services with the secret in the child process env block; never write to a `.env` file the dev might check in by accident. (This rules out a few launchers that only read `.env` — for those, document the workaround.)

---

## Service-to-service injection

The classic problem: web depends on api, api on postgres. How does web know api's URL when ports are dynamic?

### The recommendation: Railway syntax + auto-injected discovery vars

**1. Auto-inject for every running service** (the 90% case):

When service `web` starts, sibling services in the same scope (running in the same project + worktree) get these env vars auto-populated:

```
WEB_URL=http://localhost:4127
WEB_HOST=localhost
WEB_PORT=4127
```

Naming: `<UPPER_NAME>_<URL|HOST|PORT>`. Recompute on every service start within the same scope so subscribers see fresh values.

This is the **Render / Heroku convention** — unprefixed because the whole point of auto-discovery is that real apps can read it without knowing about Worktrees. `process.env.API_URL` is what existing code already does. Most users never need anything more.

**Discovery is the LOWEST-precedence layer**, so user-set values always win. If a user sets `API_URL=https://staging.example.com` in project env vars, that wins over the local sibling URL — pointing the app at remote staging keeps working even if a local `api` service starts. To opt back into local discovery, the user just unsets their override.

**2. Explicit reference syntax for composition** (the 10% case):

In any user-set env value, `${{svc.VAR}}` resolves at process-spawn time:

```
API_URL=https://${{api.HOST}}:${{api.PORT}}/v1
NEXT_PUBLIC_API=${{api.URL}}
DATABASE_URL=postgres://user:pass@${{db.HOST}}:${{db.PORT}}/myapp
```

References resolve against the *live registry* — so rotating a service's port flows automatically. This is Railway's killer feature. We implement it identically.

**Resolution rules:**
- `${{svc.URL}}`, `${{svc.HOST}}`, `${{svc.PORT}}` — the auto-discovery vars above.
- `${{svc.VAR}}` — looks up `VAR` in the referenced service's env block (after that service's own env is resolved).
- Self-reference `${{VAR}}` — looks up in the current service's env (use sparingly).
- Cycles — detected at spawn time, returns 422 with the cycle path.
- Missing target — spawn fails with `${{api.URL}} → no service named 'api' is running in scope`.

### Why not Cloudflare-style bindings (typed handles)?

Bindings are beautiful for code that runs *inside* the platform runtime. Worktrees runs arbitrary user code on the host shell — there's no SDK to inject a typed handle into. Env vars are the lingua franca. Bindings are right for SaaS, wrong for shell.

### Why not Fly-style internal DNS?

Tempting (`${{api.HOST}}` could resolve to `api.worktrees.local` and survive port changes), but requires either a DNS shim or `/etc/hosts` writes — both surprise the user. Defer to v2; auto-injected URLs cover the same ergonomic surface for v1.

## Port semantics + framework aliases

Two preference shapes drive port selection:

| Source | Semantics |
|---|---|
| **Strict port** — user explicitly set `manifest.port` (or per-task override) | Try that exact port. If taken, fail with `port_in_use` (HTTP 409). **No silent substitution.** Users who hardcode 3000 want 3000 (or to know it's busy), not magic. |
| **Sticky port** — last-used `assigned_port` from a previous run | Try first so `localhost:<port>` URLs stay stable across restarts; fall back to auto-allocate if taken. |
| Neither | Auto-allocate from `RUNTIME_PORT_RANGE` (default `4100-4999`). |

This matches Railway / Heroku / Render / Cloud Run convention (auto-allocate, inject as `PORT`) while letting users opt into strict binding when they need it (e.g., webhook expecting `localhost:3000`).

**At spawn time, the registry injects PORT-related env on top of the resolved env block** (user-set values win when keys collide):

| Key | Always set | Notes |
|---|---|---|
| `PORT` | yes | The bound port. Universal convention. |
| `HOST` | yes | `localhost`. |
| `VITE_PORT` | when stack ~= "vite" | Many users write `vite.config.ts` reading `process.env.VITE_PORT`. |
| `NUXT_PORT`, `NUXT_PUBLIC_PORT` | when stack ~= "nuxt" | Nuxt convention. |
| `ASTRO_PORT` | when stack ~= "astro" | Astro convention. |
| `NEXT_PUBLIC_PORT` | when stack ~= "next" | Useful for client-side reads. |
| `SVELTEKIT_PORT` | when stack ~= "svelte" | SvelteKit convention. |
| `REMIX_PORT` | when stack ~= "remix" | Remix convention. |
| `DJANGO_PORT`, `RAILS_PORT`, `FLASK_RUN_PORT` | when stack matches | Backend framework conventions. |

Aliases are deliberately liberal — extra env vars are free; the cost of an unused alias is zero. Stack matching is substring-based (`"vite-react"` matches both `vite` and `react`).

The agent's detect-services system prompt is updated to know these — it should never set `PORT` manually in proposals, and should leave the `port` field unset unless a fixed port is genuinely required. See [server/agent-loop.ts](../server/agent-loop.ts) (`buildDetectServicesSystemPrompt`).

---

## Worktree-scoped services

### The problem

Today, `project_services` is the only place service definitions live. A task experimenting with a new microservice (say `auth`) has two options:
- Add `auth` to the project — pollutes mainline; if the task is abandoned, the service definition lingers.
- Use per-task override — only works if `auth` already exists at the project level.

Neither lets a worktree introduce a *new* service that ships only with that worktree.

### The schema change

Add `conversation_id text NULL` to `project_services`:
- `NULL` → project-scoped (today's behavior).
- Set → worktree-scoped: visible only to that conversation, cleaned up via FK CASCADE on conversation hard-delete.

Unique index becomes `(project_id, conversation_id, name)` — same name allowed in project scope and per-worktree, no collision.

The runtime registry's existing 4-tuple `(user, project, name, worktreePath)` already isolates *instances*. The schema change isolates *definitions* too.

### Lifecycle

| Event | Worktree-scoped service behavior |
|---|---|
| Worktree created (task armed) | No services yet. Agent or user creates them with `conversation_id` set. |
| Service running, task soft-trashed | Service is stopped immediately (not at reaper time — the user just trashed it). |
| Soft-trash undone (restore) | Service definitions still exist; instances are not auto-restarted. |
| Task hard-deleted (reaper or manual prune) | FK CASCADE drops worktree-scoped service rows; reaper also stops any still-running instances first. |
| Task shipped (merged) | Worktree gone → registry GC reaps instances → service rows hard-deleted on next cleanup pass. (Open question: should we *promote* worktree-scoped services to project on ship? Leaning no — too magical; user should explicitly add to project if they want it.) |

### UX

In the services panel, worktree-scoped services get a subtle badge (`scoped to this task`). Editor has a "promote to project" action that copies the row to project scope (`conversation_id = NULL`).

---

## Multi-level kill controls

The user needs to stop services at every level of the hierarchy. The drawer (described in [SERVICES.md](SERVICES.md)) groups instances:

```
● 7 running                                       [Stop all running]
├─ Project: my-app
│  ├─ chat instances (cwd = project)
│  │  ├─ web @ 4127        [Stop]
│  │  └─ api @ 4128        [Stop]
│  └─ task: "fix auth bug" (worktree)
│     ├─ web @ 4129        [Stop]
│     └─ auth @ 4130       [Stop]   ← worktree-scoped service
└─ Project: side-bot
   └─ chat instances
      └─ bot @ 4200        [Stop]
```

**Kill scopes (each with confirm):**

| Scope | Stops |
|---|---|
| Single instance | One process. |
| Worktree (one task's services) | All instances scoped to that worktree path. |
| Project, all chats (project cwd) | All instances scoped to that project with `worktreePath = null`. |
| Project, everything | All instances on this project across all worktrees. |
| Global (the user) | Every running service across every project. |

**Confirmation rules:**
- Single instance: no confirm (fast inner-loop action).
- Worktree level: confirm with count.
- Project level: confirm with count + list of impacted services.
- Global: confirm + lists all projects affected.
- ⌥-click bypasses confirm at any level (power user opt-out, persisted as a per-user flag once first used).

**Force kill:** any "Stop" button has a hidden ⌃-click for SIGKILL (graceful by default, force on demand). Visible affordance lives in the per-instance row's overflow menu.

---

## What gets built when

### Now (this commit)

- [x] Design doc (this file).
- [ ] **Server**: `GET /api/services/all` (cross-project listing for the user).
- [ ] **Server**: `POST /api/services/stop-scope` (stop by filter: user / project / project+worktree / single).
- [ ] **Client**: global running-services chip in the top bar.
- [ ] **Client**: services drawer with Global → Project → Worktree grouping.
- [ ] **Client**: per-level "Stop all" buttons with confirm.
- [ ] **Client**: project-switch passive notice.

### Next commit (schema work)

- [ ] Migration: add `conversation_id text NULL` to `project_services`, with FK + cascade.
- [ ] Migration: `project_env_vars` (project-shared layer) + `conversation_env_vars` (worktree layer).
- [ ] Server: env resolution pipeline at `startService` (merge layers → resolve `${{}}` references → auto-inject discovery vars).
- [ ] Server: cycle detection on reference resolution.
- [ ] Client: Env tab in services panel with layer badges.

### Follow-up (polish)

- [ ] Secret rotation UI (rotate without re-entering all vars).
- [ ] "Promote worktree service to project" action.
- [ ] `.internal`-style DNS shim (revisit when complaints accumulate).
- [ ] Cross-project port map view.
- [ ] `dependsOn` between services (block start until dep healthy).

---

## Industry research summary

Pulled into one table for reference. Detailed analysis lives in the research notes that informed this doc.

| Platform | Env layers | Secret handling | Service-to-service | Per-env split | Notes |
|---|---|---|---|---|---|
| **Railway** | service > shared > system | Encrypted, "seal" toggle for write-only | `${{ServiceName.VAR}}` runtime references | First-class envs + ephemeral PR envs | Reference syntax is the killer feature |
| **Cloudflare** | env-block override (non-inheritable) | `wrangler secret put` (write-only) | Service bindings (typed handles, not URLs) | Named environments in wrangler.toml | Bindings are great for SaaS, wrong for shell |
| **GCP Cloud Run** | flat per-revision | Secret Manager (versioned) | Manual URL paste | One service per env (convention) | Too low-level; build-it-yourself |
| **Render** | service > env-group > secret-files | Encrypted, secret-files for blobs | `fromService.host/port` in render.yaml | Project envs + preview-per-PR with `sync: false` | `sync: false` placeholder is a great safety rail |
| **Vercel** | per-project, env-tagged with checkbox | Encrypted (no separate primitive) | None (single-project model) | Tags per env, branch override | Checkbox-per-env is the most ergonomic UI |
| **Fly.io** | `[env]` block + secrets | Encrypted vault, write-only | `<app>.internal` DNS, no env injection | One app per env (convention) | DNS-based discovery cleaner than env |

### What we steal

- **Railway's `${{svc.VAR}}` runtime references** — adopt verbatim.
- **Render's auto-injected `<SVC>_URL`** — auto-discovery for the 90% case.
- **Cloudflare/Fly's write-only secrets** — non-negotiable, every long-lived platform converges here.
- **Vercel's checkbox-per-env tagging UI** — though we don't have multiple envs, we'll use the same UI shape for "applies to project" / "applies to this worktree" / "applies to this service."
- **Fly's `.internal` DNS** — deferred but earmarked for v2.

### What we reject

- **Per-env splits (prod/preview/dev)** — out of scope for a local dev tool.
- **Cloudflare's non-inheritable env blocks** — bug masquerading as feature.
- **Render's order-of-creation precedence** — footgun.
- **GCP's "build from primitives"** — tools exist to take positions.
