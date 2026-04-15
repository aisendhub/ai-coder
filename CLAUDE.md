# ai-coder

Chat UI for Claude Code running on the host VM with per-project working directories and agentic editing.

## Stack at a glance

- **Frontend**: Vite + React + TypeScript + Tailwind v4 + shadcn
- **Backend**: Node + Hono, streams SSE from the Claude Agent SDK
- **Database**: Supabase Postgres (auth, projects, conversations, messages) with RLS
- **Execution**: Agent SDK runs on the host VM; each **project** has its own `cwd` on disk and scopes conversations. Container isolation (E2B / Firecracker) is **postponed** — revisit when multi-tenant isolation is needed.
- **LLM**: `@anthropic-ai/claude-agent-sdk` spawning the `claude` CLI

Docs:
- [docs/PLAN.md](docs/PLAN.md) — what we're building and why
- [docs/PROGRESS.md](docs/PROGRESS.md) — live checklist of what's done and next
- [docs/STACK.md](docs/STACK.md) — architecture, migrations, deployment, secrets

## Quick links

- **Production**: https://ai-coder-production-2cf1.up.railway.app
- Repo: https://github.com/aisendhub/ai-coder
- Railway project: https://railway.com/project/586773a1-919d-46bf-9dd0-1d7833287eb1
- Supabase project: https://supabase.com/dashboard/project/ferkiusbpvgeyefdrdnp

## Local dev

```sh
npm install
claude /login              # uses your Claude Code subscription for the Agent SDK
npm run dev                # Vite :5173 + Hono :3001
```

Environment variables live in `.env` (gitignored) — copy from `.env.example`.

## Key conventions

- **Subscription auth for dev, API key for prod.** Server deletes `ANTHROPIC_API_KEY` at startup so local dev uses `claude /login`. Production sets the env var and keeps it.
- **Agent SDK must run in Node** with `child_process` + filesystem. Not compatible with Cloudflare Workers.
- **RLS is on for every table.** Never use the service-role key in the browser. Anon key only client-side.
- **One Supabase session per user, one Agent SDK session per conversation.** Session id lives in `conversations.session_id`.
- **Projects own the cwd.** `projects.cwd` is an absolute path on the host; all conversations in a project inherit it. `PROJECTS_ROOT` env var (defaults to `dirname(process.cwd())`) sandboxes the directory browser.
- **E2B / container isolation is postponed.** Schema keeps `conversations.sandbox_id` as a placeholder, unused at runtime. Don't wire sandbox code yet — host cwd only.

## Layout

```
server/              Hono backend (Agent SDK host)
src/                 React app
  components/        Chat UI + layout (sidebar, top bar, code panel)
  lib/               supabase client, auth context
supabase/migrations/ SQL migrations (applied in order)
docs/STACK.md        Full deployment & ops reference
```

## When in doubt

Check [docs/STACK.md](docs/STACK.md) first — it documents connection strings, migration commands, deployment topology, CI, and the resource checklist for onboarding or rebuilding from scratch.
