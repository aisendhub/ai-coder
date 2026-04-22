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

## Phase 3 — Projects (host cwd)

- ✅ Migration `0002_projects.sql` (projects table, RLS, `conversations.project_id`)
- ✅ Server resolves `cwd` per conversation from `projects.cwd`
- ✅ `GET /api/fs/list` directory browser sandboxed under `PROJECTS_ROOT`
- ✅ Project switcher + new-project dialog in nav
- ✅ Conversations scoped to active project
- ⬜ Optional: per-project git status cached (today re-runs on every request)
- ✅ Surface file-tree + diff of in-flight changes in the right panel

## Phase 3.5 — Worktrees + Task mode 🟡 in progress

Design: [WORKTREES.md](WORKTREES.md) · Tracker: [WORKTREES-PROGRESS.md](WORKTREES-PROGRESS.md) · User guide: [CHAT-VS-TASK.md](CHAT-VS-TASK.md)

- ✅ Phase 1 — schema (`0006_worktrees.sql`), git helpers, `cwdForConversation` prefers worktree
- ✅ Phase 2 — per-conversation worktree on create, soft-trash + 7-day reaper, server-side project/conversation endpoints, UI worktree-mode toggle + branch chip
- ✅ Phase 3 — ship endpoint (commit/merge/PR modes, agent-generated commit message, merge-conflict handoff via rebase prompt)
- ✅ Phase 4a — task schema (`0007_tasks.sql`: `kind`, `auto_loop_*`, `loop_*`, `max_*`)
- ✅ Phase 4b — evaluator-optimizer loop in `startRunner` (worker → fresh read-only evaluator → stop conditions → next turn)
- ✅ Phase 4c — task header strip with pause/resume/stop, iteration banners, Chats/Tasks sidebar split, `+ Task` dialog, Merge/PR buttons, mid-turn nudges via `canUseTool`, "Spin off as task" from any chat
- 🟡 Phase 5 — kanban board meta-view shipped (5 columns + live state derivation + card actions); drag-and-drop + diff summary on cards deferred
- ✅ Phase 6 (reliability core) — boot reconcile + symlink repair + auto-orphan cleanup + `git worktree prune` + unified `[worktree]` lifecycle logs; disk-usage indicator + manual prune UI still pending

## Phase 3b — Container / microVM isolation ⏸️ POSTPONED

Revisit when we actually need multi-tenant isolation. Schema keeps `sandbox_id` as a placeholder.

- ⏸️ E2B (or Firecracker/Fly Machines) template image
- ⏸️ Create sandbox on new conversation
- ⏸️ Clone user's repo into sandbox using GitHub OAuth token
- ⏸️ Run Agent SDK inside the sandbox
- ⏸️ Pause on idle, resume on next message
- ⏸️ Cron/cleanup job for orphaned sandboxes

## Phase 4 — Deployment

- ✅ `nixpacks.toml` for Railway build (installs `claude` CLI)
- ✅ Hono serves Vite dist in production (single-origin)
- ✅ Railway project created
- ✅ Railway source connected to `aisendhub/ai-coder`
- ✅ Public domain generated: https://ai-coder-production-2cf1.up.railway.app
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
- **Execution**: host cwd per project, no container isolation yet. E2B/Firecracker deferred until multi-tenant.
- **Auth provider**: Supabase (managed GitHub + Google OAuth).
- **Primary OAuth**: GitHub (grants `repo` scope for cloning private repos).
- **LLM runner**: Claude Agent SDK spawning `claude` CLI. Subscription OAuth in dev, API key in prod.
- **Frontend deploy**: served by the same Railway backend in production (single-origin). Split to Cloudflare Pages later if needed.
- **No Cloudflare Workers** for the backend — Agent SDK needs `child_process`.
