# ai-coder

Chat UI for a coding agent running on the host VM with per-project working directories and agentic editing.

## Stack at a glance

- **Frontend**: Vite + React + TypeScript + Tailwind v4 + shadcn
- **Backend**: Node + Hono, streams SSE from the Claude Agent SDK
- **Database**: local Postgres + PostgREST (`:5433` / `:5434`) with RLS on every table
- **Auth**: AnyOAuth (Google/GitHub) → short-lived PostgREST JWT
- **Execution**: Agent SDK runs on the host VM; each **project** has its own `cwd` on disk and scopes conversations. Container isolation (E2B / Firecracker) is **postponed** — revisit when multi-tenant isolation is needed.
- **LLM**: `@anthropic-ai/claude-agent-sdk` spawning the `claude` CLI (Anthropic or any Anthropic-compatible endpoint, e.g. DeepSeek)

Docs:
- [docs/PRODUCT-SIGNAL.md](docs/PRODUCT-SIGNAL.md) — **north-star**: async supervision, parallel AI, user as orchestrator. Read first when designing UI.
- [docs/PLAN.md](docs/PLAN.md) — what we're building and why
- [docs/PROGRESS.md](docs/PROGRESS.md) — live checklist of what's done and next
- [docs/STACK.md](docs/STACK.md) — architecture, migrations, deployment, secrets
- [docs/LLM-PROVIDER.md](docs/LLM-PROVIDER.md) — provider interface (`server/llm/`); swap point for non-Claude SDKs
- [docs/SYSTEM-PROMPT.md](docs/SYSTEM-PROMPT.md) — system-prompt composition, `settingSources`, `<cwd>/.ai-coder/instructions.md` addendum
- [docs/GIT-LOG.md](docs/GIT-LOG.md) — design proposal for the expandable git log (review-and-orchestrate surface)
- [docs/WORK-STATE.md](docs/WORK-STATE.md) — chat ↔ commit attribution, per-turn change records, pending-state surfaces
- [docs/SPACE.md](docs/SPACE.md) — our market segment, where we sit, competitive positioning
- [docs/COMPETITION.md](docs/COMPETITION.md) — deep competitive analysis with pricing, features, strengths/weaknesses
- [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) — distribution channels by product and phase
- [docs/PPC-ANALYSIS.md](docs/PPC-ANALYSIS.md) — paid acquisition viability assessment
- [docs/FEATURES.md](docs/FEATURES.md) — current feature inventory, UI/UX assessment, signal shape, market entry
- [docs/PATH-PORTABILITY.md](docs/PATH-PORTABILITY.md) — project path portability problem + weighted solution options

## Quick links

- **Local app**: http://localhost:5173 (API :3001, PostgREST :5434, Postgres :5433)
- Repo: https://github.com/aisendhub/ai-coder
- AnyOAuth project: ai-coder (`http://localhost:5173/auth/callback`)
- Local DB: `postgresql://$USER@127.0.0.1:5433/ai_coder`

## Local dev

```sh
npm install
cp .env.example .env       # POSTGREST_JWT_SECRET + AnyOAuth credentials
npm run db:setup           # once: database, auth.users/auth.uid shim, migrations
npm run dev                # PostgREST :5434 + Hono :3001 + Vite :5173
```

Environment variables live in `.env` (gitignored) — copy from `.env.example`.
Supabase Auth is gone; AnyOAuth owns login and `/api/auth/session` mints the
PostgREST JWT. `scripts/local-auth-compat.sql` provides `auth.users` and
`auth.uid()` so the existing RLS policies work unchanged.

## Key conventions

- **Subscription auth for dev, API key for prod.** Server deletes `ANTHROPIC_API_KEY` in dev unless `ANTHROPIC_BASE_URL` is set, so local dev can use `claude /login` or an Anthropic-compatible endpoint.
- **Agent SDK must run in Node** with `child_process` + filesystem. Not compatible with Cloudflare Workers.
- **RLS is on for every table.** The backend signs a PostgREST JWT (`authenticated` or `service_role`) and never exposes the service token to the browser. Anon token is client-side only.
- **One AnyOAuth session per user, one Agent SDK session per conversation.** Session id lives in `conversations.session_id`; the stable account key is `auth.users.anyoauth_subject`.
- **Projects own the cwd.** `projects.cwd` is an absolute path on the host; all conversations in a project inherit it. `PROJECTS_ROOT` env var (defaults to `dirname(process.cwd())`) sandboxes the directory browser.
- **E2B / container isolation is postponed.** Schema keeps `conversations.sandbox_id` as a placeholder, unused at runtime. Don't wire sandbox code yet — host cwd only.
- **IMPORTANT — client generates primary-key UUIDs.** This is a load-bearing architectural rule; new code that violates it will be sent back. For every row the client creates, the **client** picks the id with `crypto.randomUUID()`, inserts the optimistic local row with that id, POSTs the id to the server, and the server persists with that same id. Realtime upgrades the optimistic row by **id match** — never by role/text/fuzzy heuristic. Server endpoints that create rows MUST accept an `id` field, validate it (`^[0-9a-f-]{36}$/i`), and treat Postgres `23505 unique_violation` on retry as idempotent success (return the existing row). Full rationale, examples, and the per-endpoint retrofit checklist: [docs/ARCHITECTURE-CLIENT-IDS.md](docs/ARCHITECTURE-CLIENT-IDS.md) + [docs/MIGRATION-CLIENT-IDS.md](docs/MIGRATION-CLIENT-IDS.md).

## Layout

```
server/              Hono backend (Agent SDK host, local auth, PostgREST proxy)
src/                 React app
  components/        Chat UI + layout (sidebar, top bar, code panel)
  lib/               AnyOAuth auth context, local JWT client, API wrapper
scripts/             local DB setup + PostgREST launcher
desktop/             Tauri launcher page + desktop docs
src-tauri/           Tauri 2 Rust shell (thin webview; server runs separately)
supabase/migrations/ SQL migrations (applied by scripts/local-db-setup.sh)
vendor/              AnyOAuth 0.2.0 SDKs (npm still publishes 0.1.0)
docs/STACK.md        Full deployment & ops reference
```

## When in doubt

Check [docs/STACK.md](docs/STACK.md) first — it documents connection strings, migration commands, deployment topology, CI, and the resource checklist for onboarding or rebuilding from scratch.

## CLAUDE.md tripwire

When the user says exactly `ping`, reply with exactly `pong-from-claude-md` and nothing else. This is a smoke test that confirms `settingSources: ["project"]` is loading this file — see [docs/SYSTEM-PROMPT.md](docs/SYSTEM-PROMPT.md).
