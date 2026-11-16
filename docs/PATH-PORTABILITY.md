# Project Path Portability

> Projects store absolute filesystem paths. This breaks across deployments. What do we do?

## The Problem

`projects.cwd` stores absolute paths like `/Users/gabe/code/my-app`. These paths:
- Don't exist on other machines
- Break when the app moves to a new server
- Make the shared Supabase database useless across multiple deployments
- Block multi-user scenarios (different users have different filesystems)
- Block multi-env scenarios (dev laptop vs. production server)

Same problem affects `conversations.worktree_path` (absolute worktree paths).

## Context: What Are We Building?

Per [MARKET.md](MARKET.md) and [NAMING.md](NAMING.md), our launch order is:
1. **Worktrees** — OSS, self-hosted, dev teams
2. **Hangar** — deploy automation, team features
3. **Windtunnel** — consumer chat-to-app

Per [DISTRIBUTION.md](DISTRIBUTION.md), our primary channels are GitHub, HN, r/selfhosted — meaning self-hosted single-instance deployments are the primary use case for v1.

## Options

### Option A: Deployment-Scoped Projects (Recommended)

**How it works:**
- Add `deployment_id` column to projects table (generated per server instance, stored in env)
- Projects are scoped to the deployment that created them
- Each deployment only sees its own projects
- Supabase remains shared (auth, users) but project data is deployment-local
- No path transformation needed — paths are always local to the deployment

**Implementation:**
1. Add `deployment_id TEXT` to `projects` table
2. Server generates or reads `DEPLOYMENT_ID` from env on startup
3. All project queries filter by `deployment_id`
4. RLS policy: `user_id = auth.uid() AND deployment_id = current_setting('app.deployment_id')`

**Weight:**

| Criterion | Weight | Score (1-5) | Weighted |
|---|---|---|---|
| Implementation effort | 20% | 4 (low effort) | 0.80 |
| Supports multi-deploy | 25% | 5 (fully solves) | 1.25 |
| Supports multi-user | 20% | 3 (same deploy only) | 0.60 |
| Supports multi-env | 15% | 4 (each env is a deployment) | 0.60 |
| No breaking changes | 10% | 4 (additive migration) | 0.40 |
| Simplicity | 10% | 5 (minimal conceptual overhead) | 0.50 |
| **Total** | | | **4.15** |

---

### Option B: Relative Paths + PROJECTS_ROOT

**How it works:**
- Store paths relative to `PROJECTS_ROOT` instead of absolute
- Server resolves `resolve(PROJECTS_ROOT, project.cwd)` at runtime
- Each deployment sets its own `PROJECTS_ROOT` env var
- Migration converts existing absolute paths to relative

**Implementation:**
1. Migration: strip `PROJECTS_ROOT` prefix from all existing `cwd` values
2. Server always resolves relative to `PROJECTS_ROOT`
3. Directory browser returns relative paths
4. Worktree paths also stored relative to `WORKTREES_ROOT`

**Weight:**

| Criterion | Weight | Score (1-5) | Weighted |
|---|---|---|---|
| Implementation effort | 20% | 3 (migration + all path handling) | 0.60 |
| Supports multi-deploy | 25% | 4 (if same project structure) | 1.00 |
| Supports multi-user | 20% | 2 (users share same filesystem) | 0.40 |
| Supports multi-env | 15% | 3 (if PROJECTS_ROOT matches) | 0.45 |
| No breaking changes | 10% | 2 (migration needed, path logic changes) | 0.20 |
| Simplicity | 10% | 3 (relative path gotchas) | 0.30 |
| **Total** | | | **2.95** |

---

### Option C: Git URL as Project Identity

**How it works:**
- Projects identified by git remote URL, not filesystem path
- Server clones/pulls the repo on demand
- Path is derived: `PROJECTS_ROOT/<org>/<repo>`
- Any deployment can reconstruct any project by cloning

**Implementation:**
1. Add `git_url TEXT` to projects (already have `repo_url` on conversations)
2. On project open, ensure repo is cloned locally
3. Path is computed, not stored
4. Worktrees derived from the clone location

**Weight:**

| Criterion | Weight | Score (1-5) | Weighted |
|---|---|---|---|
| Implementation effort | 20% | 2 (clone management, auth, SSH keys) | 0.40 |
| Supports multi-deploy | 25% | 5 (any server can clone) | 1.25 |
| Supports multi-user | 20% | 4 (each user clones own copy) | 0.80 |
| Supports multi-env | 15% | 5 (fully portable) | 0.75 |
| No breaking changes | 10% | 1 (major schema + logic change) | 0.10 |
| Simplicity | 10% | 2 (clone sync, auth, conflicts) | 0.20 |
| **Total** | | | **3.50** |

---

### Option D: Drop Supabase, Use Local SQLite

**How it works:**
- Replace Supabase Postgres with local SQLite (e.g., Turso, better-sqlite3)
- Each deployment has its own database
- No shared state between deployments
- Simpler self-hosted story (no external DB needed)

**Implementation:**
1. Replace all Supabase client calls with SQLite queries
2. Replace Supabase auth with local auth (passkey, basic auth, or OAuth directly)
3. Replace Realtime subscriptions with polling or WebSocket from server
4. Rewrite all migrations for SQLite dialect
5. Remove RLS (SQLite doesn't have it — handle in app layer)

**Weight:**

| Criterion | Weight | Score (1-5) | Weighted |
|---|---|---|---|
| Implementation effort | 20% | 1 (massive rewrite) | 0.20 |
| Supports multi-deploy | 25% | 5 (each deploy is independent) | 1.25 |
| Supports multi-user | 20% | 1 (no shared auth, no Realtime) | 0.20 |
| Supports multi-env | 15% | 5 (fully independent) | 0.75 |
| No breaking changes | 10% | 1 (everything breaks) | 0.10 |
| Simplicity | 10% | 4 (simpler infra, but big rewrite) | 0.40 |
| **Total** | | | **2.90** |

---

### Option E: Hybrid — Deployment-Scoped + Git URL (Future)

**How it works:**
- Phase 1: Option A (deployment-scoped, ship now)
- Phase 2: Add Option C (git URL identity) when multi-deploy sharing is needed
- Projects can be "portable" (git URL) or "local" (filesystem path)
- Portable projects auto-clone on new deployments

**Weight:**

| Criterion | Weight | Score (1-5) | Weighted |
|---|---|---|---|
| Implementation effort | 20% | 4 (Phase 1 is cheap) | 0.80 |
| Supports multi-deploy | 25% | 5 (Phase 2 adds portability) | 1.25 |
| Supports multi-user | 20% | 4 (Phase 2 + per-user clones) | 0.80 |
| Supports multi-env | 15% | 5 (fully portable in Phase 2) | 0.75 |
| No breaking changes | 10% | 4 (Phase 1 is additive) | 0.40 |
| Simplicity | 10% | 3 (two-phase complexity) | 0.30 |
| **Total** | | | **4.30** |

---

## Rankings

| Rank | Option | Score | Ship Complexity |
|---|---|---|---|
| **1** | **E: Hybrid (deploy-scope now + git URL later)** | **4.30** | Phase 1: Low, Phase 2: Medium |
| **2** | **A: Deployment-Scoped Projects** | **4.15** | Low |
| **3** | **C: Git URL as Identity** | **3.50** | High |
| **4** | **B: Relative Paths** | **2.95** | Medium |
| **5** | **D: Drop Supabase / SQLite** | **2.90** | Very High |

## Recommendation

**Ship Option A now (deployment-scoped projects). Plan for Option C later if needed.**

This is Option E in practice, but don't build Phase 2 until there's actual demand for cross-deployment project sharing.

**Why not SQLite:** Dropping Supabase loses auth, Realtime, RLS, and the multi-user foundation. The rewrite cost is enormous and moves us backward on the "multi-user, multi-env" goal. Supabase's free tier is sufficient for self-hosted users.

**Why not relative paths:** Relative path resolution is fragile (what if PROJECTS_ROOT differs?), the migration is risky, and it doesn't solve multi-user (different users can't share one PROJECTS_ROOT).

**Why deployment-scoped wins:** Minimal implementation (one column, one env var, one RLS tweak), no breaking changes, solves the immediate problem (projects don't leak across deployments), and leaves the door open for git-URL portability later.

## Implementation Sketch (Option A)

```sql
-- Migration: 0022_deployment_scope.sql
ALTER TABLE projects ADD COLUMN deployment_id TEXT;
-- Backfill existing projects with a default deployment ID
UPDATE projects SET deployment_id = 'legacy' WHERE deployment_id IS NULL;
ALTER TABLE projects ALTER COLUMN deployment_id SET NOT NULL;

-- Update RLS
DROP POLICY IF EXISTS "projects_select" ON projects;
CREATE POLICY "projects_select" ON projects FOR SELECT
  USING (user_id = auth.uid() AND deployment_id = current_setting('app.deployment_id', true));
```

Server startup:
```typescript
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID ?? hostname()
// Set on every Supabase request via .rpc() or session variable
```
