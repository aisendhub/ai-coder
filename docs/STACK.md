# ai-coder — Stack & Deployment

One-page reference for every moving part: what runs where, how to connect, how to migrate, how to deploy.

---

## 1. Architecture

```
                ┌──────────────────────────┐
                │        Browser           │
                │  Vite + React + shadcn   │
                │  Supabase JS (auth)      │
                └───────────┬──────────────┘
                            │ /api/*  (SSE)
                            ▼
                ┌──────────────────────────┐
                │   Node service (Hono)    │
                │   server/index.ts        │
                │   - resolves project.cwd │
                │   - persists to Supabase │
                │   - runs Agent SDK on    │
                │     host with that cwd   │
                └───┬───────────────┬──────┘
                    │               │
                    ▼               ▼
         ┌──────────────┐   ┌──────────────────┐
         │  Supabase    │   │  Host filesystem │
         │  - Auth      │   │  project.cwd     │
         │  - Postgres  │   │  - user repo     │
         │  - Storage   │   │  - claude CLI    │
         └──────────────┘   └──────────────────┘
```

- **Frontend**: Vite SPA. Auth via `@supabase/supabase-js`. Talks to `/api/*` over `fetch` + SSE.
- **Backend**: Hono on Node. Reads/writes `conversations` + `messages` via service-role, spawns the Agent SDK on the host with `cwd = project.cwd`, streams events back as SSE.
- **Database**: Supabase Postgres with RLS. Source of truth for users, projects, conversations, messages.
- **Execution**: host VM, per-project cwd. `PROJECTS_ROOT` env var sandboxes the directory browser (`GET /api/fs/list`). **Container / microVM isolation is postponed** — not wired today.
- **LLM**: Claude Code subscription OAuth (personal) or API key (prod).

---

## 2. Services, providers, accounts

| Service | Purpose | Env vars | Dashboard |
|---|---|---|---|
| **Supabase** | Auth + Postgres + Storage | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `DATABASE_POOLER_URL` | https://supabase.com/dashboard/project/ferkiusbpvgeyefdrdnp |
| ~~**E2B**~~ | ⏸️ Postponed — per-user microVMs (revisit for multi-tenant) | — | https://e2b.dev/dashboard |
| **Anthropic** | LLM — via Claude Code CLI | `ANTHROPIC_API_KEY` (prod) or `claude /login` (dev) | https://console.anthropic.com |
| **GitHub** | OAuth + repo cloning | Via Supabase GitHub provider | https://github.com/settings/developers |
| **Google** | OAuth (secondary) | Via Supabase Google provider | https://console.cloud.google.com |
| **GitHub (repo)** | Source code | — | https://github.com/aisendhub/ai-coder |
| **Railway** | Backend hosting | env vars in dashboard | https://railway.com/project/586773a1-919d-46bf-9dd0-1d7833287eb1 |

**Production URL**: https://ai-coder-production-2cf1.up.railway.app

All secrets live in `.env` (local) or the host's secret store (prod). `.env` is gitignored — never commit.

---

## 3. Database — Supabase

### Connection strings

```bash
# Direct Postgres (IPv6-only; use only if your network has IPv6)
DATABASE_URL=postgresql://postgres:<password>@db.ferkiusbpvgeyefdrdnp.supabase.co:5432/postgres

# Transaction pooler (IPv4, use this from most networks / CI)
DATABASE_POOLER_URL=postgresql://postgres.ferkiusbpvgeyefdrdnp:<password>@aws-1-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require
```

- **Region** for this project: `us-east-1`, supavisor prefix `aws-1-`.
- Session-mode pooler is port **5432** on the same hostname; use it if you need prepared statements or `LISTEN/NOTIFY`.
- DB password is rotated from Project Settings → Database.

### Schema

Source of truth: `supabase/migrations/*.sql`. Current tables:

- `public.projects` — `(id, user_id, name, cwd, created_at, updated_at)`
- `public.conversations` — `(id, user_id, project_id, title, session_id, sandbox_id, repo_url, created_at, updated_at)` — `sandbox_id` is a placeholder column reserved for future container isolation.
- `public.messages` — `(id, conversation_id, role, text, events jsonb, attachments jsonb, created_at)`
- Trigger: `messages_touch_conversation` bumps `conversations.updated_at` on each new message.
- RLS: every policy gates on `auth.uid() = user_id` (directly or through the conversations join for messages).

### Migrations — how to run them

We keep migrations as plain SQL files in `supabase/migrations/NNNN_name.sql`. Two supported runners.

**Option A — `psql` via pooler (what we use locally):**

```sh
# Apply a single migration file
PGPASSWORD="$DB_PASSWORD" psql \
  "postgresql://postgres.ferkiusbpvgeyefdrdnp@aws-1-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require" \
  -f supabase/migrations/0001_init.sql

# List tables to verify
PGPASSWORD="$DB_PASSWORD" psql "<pooler-url>" -c "\dt public.*"
```

**Option B — Supabase CLI (for CI and multi-env):**

```sh
npm i -D supabase
npx supabase login                             # once per machine, issues access token
npx supabase link --project-ref ferkiusbpvgeyefdrdnp --password "$DB_PASSWORD"
npx supabase db push                           # pushes any new files in supabase/migrations
npx supabase gen types typescript --linked > src/lib/database.types.ts
```

The CLI records applied migrations in `supabase_migrations.schema_migrations`, so re-running is safe.

### Automating migrations on deploy

Preferred pattern: a `scripts/migrate.ts` that reads `DATABASE_POOLER_URL` from the environment, finds unapplied files in `supabase/migrations/`, and runs them inside a transaction with an advisory lock. Run it as a one-shot step before starting the Node service (Fly `release_command`, Railway `release` hook, GitHub Actions job, etc.).

Minimum viable migrate script: use `postgres` (the npm client), record applied filenames in a `_migrations` table, wrap each in `BEGIN/COMMIT`.

For now (solo dev), running `psql -f` manually is fine. Wire the CLI once we have more than one migration in flight.

### Backups

Supabase runs daily backups on paid plans. Free tier: use `pg_dump` on a cron:

```sh
pg_dump "$DATABASE_POOLER_URL" --no-owner --no-privileges > backup-$(date +%F).sql
```

### Row-level security (RLS) — critical

- Every new table **must** have `alter table ... enable row level security;` or it's wide open through the anon key.
- Service-role key bypasses RLS. Only the server uses it, never the browser.
- Test policies before deploying:
  ```sql
  set role authenticated;
  set request.jwt.claims to '{"sub":"<test-user-uuid>"}';
  select * from conversations;  -- should only see that user's rows
  ```

---

## 4. Auth

### Supabase providers

1. **GitHub** (primary): https://supabase.com/dashboard/project/ferkiusbpvgeyefdrdnp/auth/providers
   - Create OAuth app: https://github.com/settings/developers → New OAuth App
   - Authorization callback URL: `https://ferkiusbpvgeyefdrdnp.supabase.co/auth/v1/callback`
   - Paste Client ID + Client Secret into Supabase → save.
   - Scopes we request: `read:user user:email repo` (the `repo` scope lets us clone private repos).
2. **Google** (secondary): same flow via Google Cloud Console → OAuth consent + client ID.

### Token lifecycle

- Supabase returns a session JWT valid ~1 hour, auto-refreshed by the client.
- The browser sends it as `Authorization: Bearer <jwt>` to our backend. The backend verifies it with the Supabase JWT secret (or by calling `supabase.auth.getUser(jwt)` with the anon key).
- The **GitHub OAuth access token** (used for `git clone`) is exposed only on the **initial sign-in** callback. Capture it in `onAuthStateChange('SIGNED_IN')` and persist to `user_identities` (or similar) on the server if you want to reuse it later.

### Service-role key

- Used only by `server/index.ts` for admin operations (e.g. creating a conversation row owned by a specific user before the user is authenticated in the request flow — rare).
- Never ship to the browser. Never log.

---

## 5. Execution — host cwd (projects)

The agent runs directly on the host VM. Each **project** owns a `cwd` path; conversations in that project inherit it.

Lifecycle:

1. User creates a project via the nav; directory browser (`GET /api/fs/list`) walks subdirs under `PROJECTS_ROOT` (default: `dirname(process.cwd())`).
2. Row inserted into `public.projects` with `(name, cwd)`.
3. On a new conversation, row inserted into `public.conversations` with `project_id`.
4. On each `POST /api/chat`, server resolves `project.cwd` for that conversation and passes it as the Agent SDK `options.cwd`.
5. `/api/changes` (git porcelain) + the lazy `chokidar` watcher in `/api/changes/stream` also scope to the resolved cwd.

### Env vars

| Var | Default | Purpose |
|---|---|---|
| `WORKSPACE_DIR` | `process.cwd()` | Fallback cwd for conversations whose project.cwd is `.` (legacy backfill). |
| `PROJECTS_ROOT` | `dirname(process.cwd())` | Root of the directory browser sandbox. Users cannot pick paths outside this. |

### ⏸️ Container isolation (postponed)

Originally planned: one E2B microVM per conversation, repo cloned with user's GitHub token, `claude` CLI run inside. **Deferred.** The schema keeps `conversations.sandbox_id` as a placeholder so we can wire it back in without another migration. Revisit when we need real multi-tenant isolation.

---

## 6. LLM auth — Claude Code

Two modes, mutually exclusive:

| Mode | Local dev | Production |
|---|---|---|
| **Subscription OAuth** (`claude /login`) | ✅ free under Pro/Max quota | ❌ TOS forbids reselling |
| **API key** (`ANTHROPIC_API_KEY`) | works | ✅ what to use |

Current setup: `server/index.ts` does `delete process.env.ANTHROPIC_API_KEY` so the CLI falls through to OAuth. For production, remove that line and set `ANTHROPIC_API_KEY` in the host's secret store.

When container isolation is revisited: set `ANTHROPIC_API_KEY` as a sandbox env var before invoking `claude`. Never mount the host's `~/.claude` OAuth token into a sandbox — that bypasses billing and breaks TOS at scale.

---

## 7. Local development

### First-time setup

```sh
git clone git@github.com:fijiwebdesign/ai-coder.git
cd ai-coder
npm install

# .env — copy from .env.example and fill in (request secrets from 1Password / teammate)
cp .env.example .env

# Ensure `claude` CLI is logged in with your subscription
claude /login

# Run migrations in order (idempotent, safe to re-run)
PGPASSWORD="$DB_PASSWORD" psql "$DATABASE_POOLER_URL" -f supabase/migrations/0001_init.sql
PGPASSWORD="$DB_PASSWORD" psql "$DATABASE_POOLER_URL" -f supabase/migrations/0002_projects.sql

# Start both frontend + backend
npm run dev
# → Vite on http://localhost:5173, Hono on :3001
```

### Scripts

- `npm run dev` — runs `dev:web` (Vite) + `dev:server` (Hono with tsx watch) concurrently
- `npm run build` — `tsc -b && vite build`
- `npm run lint` — ESLint

### Debugging

- Backend logs: every turn is tagged with a 6-char `turnId`. Grep server stdout for it.
- Network: DevTools → Network → `/api/chat` → EventStream tab shows raw SSE.
- DB: `npx supabase db remote list` or Supabase dashboard → Table Editor.

---

## 8. Production deployment

### Where things run

| Tier | Recommended host | Notes |
|---|---|---|
| **Frontend** (Vite build) | Cloudflare Pages, Vercel, Netlify | Static SPA output; set `VITE_*` env vars at build time |
| **Backend** (Hono + Agent SDK) | Fly.io Machines **or** Railway | Needs Node + `child_process` + outbound net to Anthropic + Supabase. **Not** Cloudflare Workers (no subprocess). |
| **Database** | Supabase (managed) | — |
| ~~**Sandboxes**~~ | ⏸️ Postponed — E2B / Firecracker | Revisit for multi-tenant. |

### Recommended: Fly.io

Why: per-region Machines start in ~1s, cheap at idle, first-class persistent volumes if ever needed, good log aggregation, one-shot `release_command` for migrations.

```sh
# Install flyctl, log in
brew install flyctl
fly auth login

# Init in repo root (creates fly.toml)
fly launch --no-deploy --name ai-coder-api

# Set secrets (not in fly.toml)
fly secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  SUPABASE_SERVICE_ROLE_KEY=sb_secret_... \
  DATABASE_POOLER_URL='postgresql://...' \
  PROJECTS_ROOT=/workspaces

# Deploy
fly deploy
```

`fly.toml` essentials:
```toml
app = "ai-coder-api"

[build]
  dockerfile = "Dockerfile"

[deploy]
  release_command = "npx tsx scripts/migrate.ts"   # auto-runs on every deploy

[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 1
```

Dockerfile outline:
```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm i -g @anthropic-ai/claude-code
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3001
CMD ["npx", "tsx", "server/index.ts"]
```

### Frontend on Cloudflare Pages

1. Connect the GitHub repo.
2. Build command: `npm run build`. Output dir: `dist/`.
3. Env vars (build-time): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
4. Runtime redirect: proxy `/api/*` to the Fly app via a `_redirects` file or Cloudflare Worker.

### Domains

- `ai-coder.dev` → Cloudflare Pages (frontend)
- `api.ai-coder.dev` → Fly app (backend)
- CORS: backend allows only the frontend origin. Set `Access-Control-Allow-Origin` explicitly, never `*`.

---

## 9. CI/CD

GitHub Actions workflow (`.github/workflows/deploy.yml`) on push to `main`:

```yaml
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npx tsc --noEmit -p tsconfig.app.json
      - run: npm run build

  deploy-api:
    needs: test
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

Migrations run automatically because `fly.toml` has `release_command = "npx tsx scripts/migrate.ts"`.

For Supabase type sync, add a second job that runs `supabase gen types` and commits back to the repo (or fails CI if types drift).

---

## 10. Secrets management

Local: `.env` (gitignored).
Production: host-native secret store (Fly secrets, Cloudflare secrets, Vercel env vars).
Never: commit, log, or send secrets to the browser unless prefixed `VITE_` **and** safe for public exposure (only the Supabase `anon` key qualifies).

Rotation:
- Supabase DB password: dashboard → Settings → Database → Reset. Update `DATABASE_*` everywhere it's used.
- Supabase API keys: dashboard → Settings → API → Rotate. Update `VITE_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
- Anthropic: https://console.anthropic.com/settings/keys.

---

## 11. Monitoring & observability

- **Fly metrics**: CPU, memory, request rate in `fly dashboard`.
- **Supabase**: Dashboard → Logs → Postgres / API / Auth for query and auth events.
- **App-level**: server logs every turn with `turnId`, event name, payload size — grep in Fly / Railway logs.
- Add Sentry or similar on the frontend for unhandled errors once we have real users.

---

## 12. Resource checklist — what to create / have access to

Onboarding a new developer:

- [ ] GitHub push access to `fijiwebdesign/ai-coder`
- [ ] Supabase project membership (`ferkiusbpvgeyefdrdnp`)
- [ ] Anthropic console access (prod key) — optional for local if using subscription
- [ ] Fly.io team access — prod only
- [ ] Cloudflare account access — prod only
- [ ] `.env` contents (via secure share)
- [ ] `claude` CLI installed + logged in (`brew install claude-code` or `npm i -g @anthropic-ai/claude-code` → `claude /login`)
- [ ] `psql` installed (`brew install libpq`) for raw DB access

Creating fresh infra from scratch (if we ever rebuild):

- [ ] Register domain
- [ ] Supabase project + run all migrations in order
- [ ] GitHub OAuth app → paste into Supabase
- [ ] Google OAuth app → paste into Supabase
- [ ] Anthropic API key (for prod LLM billing)
- [ ] Fly.io app + Dockerfile + secrets
- [ ] Cloudflare Pages site + redirects
- [ ] GitHub repo secrets: `FLY_API_TOKEN`, `CLOUDFLARE_API_TOKEN`
