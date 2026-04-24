# Worktrees (`worktrees.dev`)

The open-source, git-native, team-and-ticket-focused product on the shared platform. Scopes are provisional — see [NAMING.md](NAMING.md) for family context.

## Positioning

**One-liner:** A kanban where each ticket is an AI-resolved worktree.

**For:** Dev teams who already think in tickets and branches and want an AI that closes tickets the way a human contributor would — on its own branch, with its own tests, opening its own PR.

**Not for:** Solo devs who just want chat-in-editor (use Cursor / Cline). Non-developers who want to describe an app in natural language (use Windtunnel). Teams who want deploy automation as part of the same product (use Hangar).

## What it does

1. **Ticket-shaped task board.** Kanban with columns for backlog → running → review → shipped → trashed. Tickets carry a goal, acceptance criteria, iteration cap, and cost budget.
2. **Each ticket runs in its own git worktree** on a dedicated branch off the project's base ref, so N tickets can execute in parallel on the same repo without colliding.
3. **The agent resolves the ticket.** Evaluator-optimizer loop: worker makes changes, read-only evaluator judges against the goal, orchestrator decides next iteration. Bounded by max iterations and max cost.
4. **Services orchestration per worktree.** Each ticket gets its own dev-server instance(s); isolation extends beyond the filesystem to running processes.
5. **Chat mode (secondary surface)** for ad-hoc steering that doesn't warrant a ticket.
6. **Ship flow** — fast-forward merge into base, or push + `gh pr create`. Conflict handling via chat.
7. **Mid-turn nudges** — add instructions while the agent is mid-task; injected at the next tool boundary.
8. **Soft-trash + reaper** — 7-day grace period on deletes so tickets can be resumed.

## UI shape

Primary surface is the **kanban board**. Chat and code panels are secondary. Dev surfaces (file tree, git log, terminal) are accessible but not front-and-center.

Layout composition (shared components from the monorepo):
- Kanban / task board — primary
- Task detail view (chat + diff + activity + services) — opened on card click
- Project switcher — sidebar
- Services panel — toggleable
- Terminal — toggleable
- File tree / git log — promotable to side panes

## Competitive landscape

| Tool | Closest on | Where Worktrees wins |
|---|---|---|
| Linear + Agent (e.g., Graphite AI, Linear AI) | Ticket tracking with AI assist | Our AI *does the work*, not just summarize it; isolated worktree, not just suggestions |
| Cursor Projects | Multi-project dev workspace | Worktrees isolate parallel work; Cursor is single-agent-in-editor |
| Cline Kanban | Kanban + agent | Cline is editor-bound, single worktree, no services orchestration |
| GitHub Projects + Copilot Workspace | Tickets → AI resolution | Copilot Workspace is session-per-task but locked to GitHub; we're self-hostable and multi-project |
| Conductor | Parallel agents + worktrees | Conductor is Mac-only, closed; no ticket surface, no services |

**Core differentiator:** The unit of work is a **resolved ticket**, not a chat message or a code suggestion. The AI operates as a contributor, not an assistant.

## MVP scope

Mostly already built. Remaining work is polish, hardening, and OSS readiness:

**Shippable now or near-term:**
- Kanban + task lifecycle ✅
- Worktree isolation ✅
- Services orchestration ✅
- Evaluator-optimizer loop ✅
- Chat mode + mid-turn nudges ✅
- Ship flow (merge / PR) ✅
- Soft-trash + reaper ✅

**Needed for v1 launch:**
- README / contributing guide / license
- One-command install (Docker Compose or similar)
- Self-host docs covering Supabase setup
- Production hardening (CORS, rate limits, error reporting)
- Ticket detail UI polish (acceptance criteria editor, goal clarification flow)
- Marketing site at `worktrees.dev`
- Demo video / screenshots

**Explicitly out of scope for v1:**
- Deploy automation (that's Hangar)
- Chat-first UI for non-devs (that's Windtunnel)
- Container / microVM isolation (postponed)
- WhatsApp / remote agent channels (postponed)

## Open questions

- **Chat-out decision.** Should chat move out of the primary surface entirely in v1, or stay as a toggleable mode? Leaning: keep chat available, de-emphasize in default view.
- **Ticket schema.** Do tickets stay lightweight (goal + acceptance criteria) or grow toward Linear-parity (priority, labels, assignees, subtasks)? MVP: lightweight; expand based on usage.
- **External ticket source integration.** Should Worktrees import from Linear / Jira / GitHub Issues? Deferred; add if users ask.
- **Multi-user team features.** Schema already supports multi-user via Supabase RLS; UI surfaces (assigning tickets to humans, comment threads, mentions) are not yet built. Needed before calling this a "team" product.
- **Self-host experience.** Currently requires Supabase project setup + env vars + host VM. Needs to be one command.
