# Plan

What we're building, why, and the shape of the thing.

---

## The product

**ai-coder** is a chat UI that lets a user pick a GitHub repo, open a conversation with Claude, and have Claude edit code inside an isolated sandbox VM — per conversation.

It's a multi-tenant, browser-first version of Claude Code:

- You don't install anything.
- You sign in with GitHub.
- You paste a repo URL (or pick from your list).
- You chat. Claude reads, edits, runs tests, commits.
- Every conversation has its own sandbox so nobody's work touches anybody else's.

## Why

1. **Mobility**: Claude Code is terminal-only. We want it from a browser, and later from WhatsApp (sendhub).
2. **Multi-user**: Claude Code assumes one user on one machine. We want a SaaS shape.
3. **Safety**: running the agent in a sandbox per user means `bypassPermissions` is actually safe — worst case you nuke a throwaway VM.
4. **Composability for sendhub**: the same backend can accept messages from WhatsApp, web, CLI. The channel doesn't matter — Agent SDK sessions are portable.

## Non-goals (for now)

- Replacing VS Code. No file editor, no terminal panel. Just chat + diff summary.
- Building our own agent loop. We use the Claude Agent SDK directly.
- Supporting non-Anthropic models.
- Persisting file-level history beyond the sandbox. Git is the record.

---

## Shape of the system

```
Browser (React)
  ├─ Supabase Auth (GitHub OAuth → repo scope)
  └─ fetch /api/chat  (SSE)
        │
        ▼
Railway (Node + Hono)
  ├─ Verify JWT, look up conversation
  ├─ Persist user message + assistant events to Postgres
  ├─ Spawn / resume E2B sandbox
  └─ Run Agent SDK inside sandbox, pipe events back
        │
        ▼
E2B microVM (per conversation)
  ├─ Cloned repo at /workspace
  ├─ `claude` CLI
  └─ git push back to user's fork/branch
```

## Data model

One-to-many, user → conversations → messages.

```
users           (supabase.auth.users)
conversations   id, user_id, title, session_id, sandbox_id, repo_url, updated_at
messages        id, conversation_id, role, text, events jsonb, created_at
```

Two IDs are the glue:
- `session_id` — Agent SDK conversation, persists full transcript on disk.
- `sandbox_id` — E2B VM, contains the cloned repo.

Both are resumable: user reconnects → we resume sandbox, resume session, the agent picks up where it left off.

---

## Phases

### Phase 1 — Plain chat ✅ done
Type a message, Claude replies. No auth, no DB, no sandbox. Prove the Agent SDK works, the SSE stream is clean, the UI renders markdown live.

### Phase 2 — Auth + persistence 🟡 in progress
Users sign in via GitHub. Conversations + messages stored in Supabase with RLS. Refreshing the page restores history. The sidebar becomes a real list.

### Phase 3 — Per-user sandbox ⬜ next
First-message in a new conversation spins up an E2B sandbox. Repo cloned with the user's GitHub token. Agent runs inside the sandbox. Pause on idle. Resume on message. This is the unlock — safely running `bypassPermissions` because blast radius = one microVM.

### Phase 4 — Deploy ⬜
Push to Railway. First public URL. Real ANTHROPIC_API_KEY.

### Phase 5 — Harden ⬜
CORS, rate limiting, error tracking, backups, healthchecks.

### Phase 6 — WhatsApp channel ⬜
`wa-cloudflare` webhook forwards to our backend. One Agent SDK session per chat. WhatsApp just becomes another UI for the same underlying pipeline.

---

## Architectural bets (worth remembering)

1. **Agent SDK, not our own loop.** Cline built its own, we don't need to. We get tool orchestration, context compaction, plan mode, skills for free.
2. **One sandbox per conversation, not per user.** Lets the same user open five repos in five tabs without them stomping each other.
3. **Session IDs are source of truth.** The CLI writes the full transcript to disk keyed by `session_id`. We only cache message metadata in Supabase for the sidebar.
4. **GitHub OAuth first, GitHub App later.** OAuth token scopes are enough for solo users. Upgrade path exists when we need fine-grained repo selection.
5. **Single-origin deploy.** Hono serves the Vite bundle in prod. One URL, one CORS config, no cookie-domain games. Split later if frontend outgrows it.

## Known unknowns

- **How we run `claude` inside E2B.** Two options: (a) install the CLI into the template image and `sandbox.commands.run(claude …)`; (b) use the Agent SDK in-process on the host with a virtualized `cwd` pointing at the sandbox FS via E2B's filesystem API. (a) is cleaner. We'll go with (a) but may need to pipe stdin/stdout for interactive streaming.
- **Stale sandboxes.** Need a cron that reaps paused sandboxes older than N days. Cost + privacy both concerns.
- **Long-running tasks.** If the agent spends 3 minutes editing, the SSE stream must survive. Railway has a 10-min idle timeout; we may need periodic heartbeats.
- **GitHub OAuth token expiry.** ~8h. We'll need a re-auth flow when cloning fails.

## What we won't do yet

- **No self-hosted sandboxing.** E2B until we scale past their margins.
- **No collaborative editing.** One user, one conversation.
- **No payment system.** Burn personal credit until it matters.
- **No mobile app.** Responsive web is fine.
- **No audit log UI.** Server logs are enough for now.

---

## Progress tracking

See [PROGRESS.md](PROGRESS.md) — the live checklist. This doc (`PLAN.md`) describes the destination; progress describes the stepwise state.
