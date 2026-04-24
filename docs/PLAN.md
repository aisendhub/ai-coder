# Plan

What we're building, why, and the shape of the thing.

Related strategy docs:
- [NAMING.md](NAMING.md) — three-product family (Worktrees, Hangar, Windtunnel) and launch order.
- [MARKET.md](MARKET.md) — competitor valuations, consumer vs developer market, and penetrability analysis that backs the launch order.

---

## The product

**ai-coder** is a chat UI that lets a user open a conversation with Claude scoped to a **project** (a working directory on the host VM), and have Claude read, edit, and commit code there.

It's a browser-first version of Claude Code:

- You sign in with GitHub.
- You create a project pointing at a directory on the host.
- You chat. Claude reads, edits, runs tests, commits inside that cwd.
- Conversations are scoped per project; each has its own Agent SDK session.

> **Execution model (current): host-only.** Agent SDK runs on the Railway/VM host with a per-project `cwd`. Container / microVM isolation (E2B, Firecracker) is **postponed** until we need real multi-tenant isolation. Today's deployment is effectively single-tenant.

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
  ├─ Supabase Auth (GitHub OAuth)
  └─ fetch /api/chat  (SSE)
        │
        ▼
Railway (Node + Hono)
  ├─ Look up conversation → project.cwd
  ├─ Persist user message + assistant events to Postgres
  └─ Run Agent SDK on host with cwd = project.cwd, pipe events back
        │
        ▼
Host filesystem (Railway VM)
  ├─ Project cwd (user-picked path, e.g. /workspaces/foo)
  ├─ `claude` CLI
  └─ git push back to user's fork/branch

(Future) Container isolation: spawn Agent SDK inside a per-conversation
microVM with the project dir bind-mounted in. Not implemented.
```

## Data model

user → projects → conversations → messages.

```
users           (supabase.auth.users)
projects        id, user_id, name, cwd, updated_at
conversations   id, user_id, project_id, title, session_id, sandbox_id, repo_url, updated_at
messages        id, conversation_id, role, text, events jsonb, created_at
```

Keys:
- `project.cwd` — absolute path on the host used as Agent SDK `cwd`.
- `session_id` — Agent SDK session, persists full transcript on disk.
- `sandbox_id` — **placeholder** for future container id; unused today.

---

## Phases

### Phase 1 — Plain chat ✅ done
Type a message, Claude replies. No auth, no DB, no sandbox. Prove the Agent SDK works, the SSE stream is clean, the UI renders markdown live.

### Phase 2 — Auth + persistence 🟡 in progress
Users sign in via GitHub. Conversations + messages stored in Supabase with RLS. Refreshing the page restores history. The sidebar becomes a real list.

### Phase 3 — Projects (host cwd) 🟡 in progress
Users create projects pointing at a directory on the host. Conversations scoped per project. Agent SDK runs on the host with `cwd = project.cwd`. Directory picker sandboxed under `PROJECTS_ROOT` (defaults to parent of install dir).

### Phase 3b — Container isolation ⏸️ postponed
Originally: one E2B sandbox per conversation, repo cloned with user's GitHub token, `bypassPermissions` safe because blast radius = one microVM. **Deferred** until we actually need multi-tenant isolation — today the host VM is the trust boundary. Schema keeps `sandbox_id` as a placeholder.

### Phase 4 — Deploy ⬜
Push to Railway. First public URL. Real ANTHROPIC_API_KEY.

### Phase 5 — Harden ⬜
CORS, rate limiting, error tracking, backups, healthchecks.

### Phase 6 — WhatsApp channel ⬜
`wa-cloudflare` webhook forwards to our backend. One Agent SDK session per chat. WhatsApp just becomes another UI for the same underlying pipeline.

---

## Architectural bets (worth remembering)

1. **Agent SDK, not our own loop.** Cline built its own, we don't need to. We get tool orchestration, context compaction, plan mode, skills for free.
2. **Project is the cwd boundary.** Each project owns a host path; conversations inherit it. When we eventually add container isolation, the project model stays and the backend swaps `cwd: path` for `sandbox.cwd`.
3. **Session IDs are source of truth.** The CLI writes the full transcript to disk keyed by `session_id`. We only cache message metadata in Supabase for the sidebar.
4. **GitHub OAuth first, GitHub App later.** OAuth token scopes are enough for solo users. Upgrade path exists when we need fine-grained repo selection.
5. **Single-origin deploy.** Hono serves the Vite bundle in prod. One URL, one CORS config, no cookie-domain games. Split later if frontend outgrows it.

## Known unknowns

- **How we run `claude` inside a container (when we return to it).** Options: (a) install the CLI into the image and `sandbox.commands.run(claude …)`; (b) use the Agent SDK in-process on the host with a virtualized `cwd` via a filesystem API. We'll revisit when we need it.
- **Long-running tasks.** If the agent spends 3 minutes editing, the SSE stream must survive. Railway has a 10-min idle timeout; we may need periodic heartbeats.
- **GitHub OAuth token expiry.** ~8h. We'll need a re-auth flow when cloning fails.

## What we won't do yet

- **No container / microVM isolation.** Host VM is the trust boundary until multi-tenant demands otherwise.
- **No collaborative editing.** One user, one conversation.
- **No payment system.** Burn personal credit until it matters.
- **No mobile app.** Responsive web is fine.
- **No audit log UI.** Server logs are enough for now.

---

## Progress tracking

See [PROGRESS.md](PROGRESS.md) — the live checklist. This doc (`PLAN.md`) describes the destination; progress describes the stepwise state.
