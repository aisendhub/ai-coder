# Progress

Running checklist of what's done, in flight, and open. Updated as we go.

Legend: ✅ done · 🟡 in progress · ⬜ not started · 🚫 blocked

---

## Phase 0 — Scaffolding

- ✅ Vite + React + TypeScript + Tailwind v4 + shadcn
- ✅ Three-panel responsive layout (conversations / chat / code changes)
- ✅ Mobile layout (left + right sheets, top bar with triggers)
- ✅ Auto-sizing composer with upload + send buttons
- ✅ Git repo initialized, pushed to `aisendhub/ai-coder`

## Phase 1 — Agent SDK chat

- ✅ Hono backend on Node (`server/index.ts`)
- ✅ SSE streaming `POST /api/chat`
- ✅ Session persistence via Agent SDK `resume`
- ✅ Subscription OAuth for local dev (`claude /login`), API key for prod
- ✅ Markdown rendering with live streaming (GFM via react-markdown)
- ✅ Activity rows: thinking, tool_use, tool_result
- ✅ Thinking-dots animation while streaming

## Phase 2 — Supabase + Auth

- ✅ Supabase project created (`ferkiusbpvgeyefdrdnp`)
- ✅ Initial SQL migration (`conversations`, `messages`, RLS, trigger)
- ✅ Supabase JS client + auth context
- ✅ GitHub + Google sign-in UI buttons
- ✅ Auth gate in `App.tsx`
- ⬜ Enable GitHub OAuth provider in Supabase dashboard
- ⬜ Enable Google OAuth provider in Supabase dashboard
- ⬜ Wire conversations sidebar to live Supabase data
- ⬜ Persist user + assistant messages per conversation
- ⬜ Restore conversation history on page reload
- ⬜ Backend: verify Supabase JWT on `/api/chat` and look up `conversation_id`
- ⬜ Backend: capture GitHub `provider_token` on sign-in, store for repo cloning
- ⬜ Generate TypeScript types from schema (`supabase gen types`)

## Phase 3 — E2B sandboxes

- ✅ E2B account + API key in `.env`
- ⬜ Build E2B template image (`ai-coder-node`: git + node + claude CLI)
- ⬜ Create sandbox on new conversation, save id to `conversations.sandbox_id`
- ⬜ Clone user's repo into sandbox using GitHub OAuth token
- ⬜ Run Agent SDK inside the sandbox (not on the host)
- ⬜ Pause sandbox on idle, resume on next message
- ⬜ Kill sandbox on conversation delete
- ⬜ Cron/cleanup job for orphaned sandboxes
- ⬜ Surface file-tree + diff of in-flight changes in the right panel

## Phase 4 — Deployment

- ✅ `nixpacks.toml` for Railway build (installs `claude` CLI)
- ✅ Hono serves Vite dist in production (single-origin)
- ✅ Railway project created
- 🟡 Reconnect Railway source to `aisendhub/ai-coder`
- ⬜ Set Railway env vars (`E2B_API_KEY`, Supabase keys, `ANTHROPIC_API_KEY`, `NODE_ENV=production`)
- ⬜ First successful production deploy
- ⬜ Generate Railway public domain
- ⬜ Custom domain (e.g. `ai-coder.aisendhub.com`)
- ⬜ GitHub OAuth callback updated to prod URL

## Phase 5 — Production hardening

- ⬜ Real `ANTHROPIC_API_KEY` in prod (not subscription OAuth)
- ⬜ CORS lockdown to prod origin only
- ⬜ Rate limiting per user on `/api/chat`
- ⬜ Sentry or similar for frontend + backend errors
- ⬜ Healthcheck endpoint wired to Railway
- ⬜ Migrations run via `release` hook, not manually
- ⬜ Daily DB backup script + storage

## Phase 6 — Multi-channel (future)

- ⬜ WhatsApp inbound via sendhub's `wa-cloudflare` → proxy to this backend
- ⬜ CLI slash commands mapped to options (`/plan`, `/bypass`, `/cd`)
- ⬜ Long-running agent tasks with progress updates to chat

---

## Decisions log

- **Backend host**: Railway (cheapest quick deploy, $5/mo Hobby credit).
- **Sandbox provider**: E2B (purpose-built per-user microVMs, pause/resume).
- **Auth provider**: Supabase (managed GitHub + Google OAuth).
- **Primary OAuth**: GitHub (grants `repo` scope for cloning private repos).
- **LLM runner**: Claude Agent SDK spawning `claude` CLI. Subscription OAuth in dev, API key in prod.
- **Frontend deploy**: served by the same Railway backend in production (single-origin). Split to Cloudflare Pages later if needed.
- **No Cloudflare Workers** for the backend — Agent SDK needs `child_process`.
