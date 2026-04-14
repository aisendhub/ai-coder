# ai-coder

Chat UI for Claude Code running per-user sandboxes with repo cloning + agentic editing.

## Stack at a glance

- **Frontend**: Vite + React + TypeScript + Tailwind v4 + shadcn
- **Backend**: Node + Hono, streams SSE from the Claude Agent SDK
- **Database**: Supabase Postgres (auth, conversations, messages) with RLS
- **Sandboxes**: E2B microVM per conversation
- **LLM**: `@anthropic-ai/claude-agent-sdk` spawning the `claude` CLI

Docs:
- [docs/PLAN.md](docs/PLAN.md) — what we're building and why
- [docs/PROGRESS.md](docs/PROGRESS.md) — live checklist of what's done and next
- [docs/STACK.md](docs/STACK.md) — architecture, migrations, deployment, secrets

## Quick links

- Project on GitHub: https://github.com/fijiwebdesign/ai-coder
- Supabase project: https://supabase.com/dashboard/project/ferkiusbpvgeyefdrdnp
- E2B dashboard: https://e2b.dev/dashboard

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
- **One E2B sandbox per conversation.** Sandbox id lives in `conversations.sandbox_id`. Paused on idle, resumed on next message.

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
