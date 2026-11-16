# Current Application — Features, UI/UX, Signal Shape

> What we've built, how it looks, and how it maps to our market entry.

## Application Overview

ai-coder is a browser-based chat + task board UI for Claude Code running on a host VM. Each project has its own working directory, and conversations/tasks are scoped to projects. The Agent SDK runs Claude Code on the server, streaming results to the browser via SSE.

**Stack:** Vite + React + TypeScript + Tailwind v4 + shadcn (frontend), Node + Hono (backend), Supabase Postgres + RLS (database), Claude Agent SDK (LLM execution).

## Feature Inventory

### Core: Chat & Agent Interaction

| Feature | Status | Description |
|---|---|---|
| SSE streaming chat | ✅ | Real-time token streaming from Claude Code |
| Markdown rendering | ✅ | GFM with syntax highlighting, tables, code blocks |
| Thinking/tool activity | ✅ | Collapsible activity rows showing agent reasoning |
| File attachments | ✅ | Images, PDFs, documents — drag-drop or click |
| Mid-turn nudges | ✅ | Inject instructions while agent is working |
| Stop/pause/resume | ✅ | Control running agent turns |
| Message history | ✅ | Persistent via Supabase with Realtime sync |
| Conversation search | ✅ | Filter conversations by title |

### Core: Task Automation (Worktrees)

| Feature | Status | Description |
|---|---|---|
| Kanban board | ✅ | Backlog → Running → Review → Shipped → Trashed |
| Auto-loop (evaluator-optimizer) | ✅ | Worker + read-only evaluator + orchestrator loop |
| Iteration cap + cost budget | ✅ | Configurable per task |
| Git worktree isolation | ✅ | Each task gets own worktree + branch |
| Ship flow | ✅ | Fast-forward merge to base or PR creation |
| Soft-trash + 7-day reaper | ✅ | Grace period before permanent delete |
| Task → chat promotion | ✅ | "Spin off" a chat into a task |
| Work stripe | ✅ | Per-turn change summary (files, +/-, commit status) |

### Code & Git Integration

| Feature | Status | Description |
|---|---|---|
| File viewer + syntax highlighting | ✅ | Highlight.js-powered code display |
| Live diff / changes panel | ✅ | Real-time file change tracking |
| Git log browser | ✅ | 100 most recent commits, expandable |
| Commit file details | ✅ | Status, insertions, deletions per file |
| Git blame | ✅ | Author, date, commit per line |
| Commit pinning | ✅ | View file at specific SHA |
| File tree browser | ✅ | Lazy-load directory navigation |
| File comments | ✅ | Open/resolved/outdated states, line-anchored |

### Services Orchestration

| Feature | Status | Description |
|---|---|---|
| Auto-detect services | ✅ | Heuristic + LLM-powered detection |
| Start/stop/restart | ✅ | Per-service lifecycle management |
| Port binding + URL | ✅ | Auto-assigned ports with preview URLs |
| Live log tailing | ✅ | Real-time service output |
| Per-worktree isolation | ✅ | Each task gets own service instances |
| Global services dashboard | ✅ | Cross-project running services view |
| Environment variables | ✅ | Project-scoped + task-scoped env vars |
| Multi-runner support | ✅ | local-process, local-docker, external |

### Terminal

| Feature | Status | Description |
|---|---|---|
| xterm.js terminal | ✅ | WebSocket-based, conversation-scoped CWD |
| Resize handling | ✅ | Dynamic rows/cols |
| Theme sync | ✅ | Dark/light mode aware |

### Auth & Access Control

| Feature | Status | Description |
|---|---|---|
| Supabase auth (GitHub OAuth) | ✅ | Primary auth method |
| RLS on all tables | ✅ | Row-level security, user-scoped |
| Admin gating | ✅ | ADMIN_EMAIL env var |
| Access request workflow | ✅ | Request → approve/deny flow |

### UI/UX

| Feature | Status | Description |
|---|---|---|
| Responsive layout | ✅ | Desktop multi-panel + mobile drawer |
| Resizable panels | ✅ | Drag-to-resize with state persistence |
| Section promotion | ✅ | Move panels to side/fullscreen |
| Dark/light mode | ✅ | Toggle with localStorage persistence |
| Optimistic UI | ✅ | Client-generated UUIDs, instant feedback |
| Background notifications | ✅ | OS notification when agent finishes |
| Unread badges | ✅ | Conversations that finished while inactive |

## UI/UX Assessment

### Strengths

1. **Information density** — five-panel layout (nav, chat, code, file tree, terminal) gives developers everything they need without switching contexts
2. **Real-time feedback** — SSE streaming, live diffs, service logs, terminal — nothing feels stale
3. **Progressive disclosure** — panels collapse, promote, fullscreen. Start with chat; expand as needed.
4. **Developer-native conventions** — git log, blame, diff, terminal, env vars — speaks the developer's language
5. **Kanban is first-class** — not an afterthought; genuine task lifecycle management

### Weaknesses

1. **Onboarding is non-existent** — new user sees empty state, no guidance beyond two cards
2. **Information overload** — five panels at once is powerful but overwhelming for new users
3. **Project path is filesystem-bound** — breaks across deployments (see path problem below)
4. **No mobile task management** — mobile layout shows chat only; no kanban, no task creation
5. **No collaboration features** — single-user experience despite multi-user database
6. **Services panel complexity** — powerful but dense; no progressive onboarding for first-time users
7. **No preview/deploy** — can't see running app inline (important for Windtunnel, nice-to-have for Worktrees)

### UI Polish Level

**Current:** 6/10 — functional and information-rich, but rough edges. Suitable for early-adopter developers who tolerate rough UIs for powerful tools. Not suitable for consumer/non-dev audience.

**Needed for Worktrees v1 launch:** 7/10 — clean up onboarding, improve empty states, polish the kanban, add keyboard shortcuts
**Needed for Windtunnel:** 9/10 — complete redesign for chat-first UX, preview pane, hidden dev surfaces

## Signal Shape

How our features map to the [PRODUCT-SIGNAL.md](PRODUCT-SIGNAL.md) design philosophy:

### Async Supervision ✅ Strong

- Kanban board surfaces finished work (review column), not in-progress streaming
- Background notifications when agent finishes
- Tasks run autonomously with evaluator-optimizer loop
- User can dispatch task, close laptop, come back to review

### Long Tasks as Feature ✅ Strong

- Iteration cap + cost budget enable multi-hour autonomous runs
- Work stripe shows per-turn changes — the commit is the artifact
- Evaluator-optimizer loop means agent does more before stopping

### User as Orchestrator ✅ Partial

- Parallel tasks via worktrees — N agents, N branches ✅
- Kanban for managing parallel work ✅
- Mid-turn nudges for steering ✅
- **Missing:** fork-from-any-point, branch comparison, "what if" from commit
- **Missing:** cross-task visibility (how do tasks relate to each other?)

### Commits as Unit of Trust ✅ Partial

- Work stripe shows commit status per turn ✅
- Git log is browsable ✅
- Ship flow merges to base ✅
- **Missing:** commit message quality enforcement
- **Missing:** interactive git log (continue/fork/revert from any commit)
- **Missing:** PR review surface

## Market Entry — Feature-to-Audience Mapping

### What We Have That's Unique

1. **Kanban + autonomous agents + git worktree isolation** — nobody else has this combination
2. **Services orchestration per worktree** — dev servers for each parallel task
3. **Web UI (not CLI, not IDE extension)** — accessible from any browser
4. **Open source + self-hosted** — appeals to privacy-conscious teams

### Best Customer Base for Launch

**Profile:** Small-to-medium dev teams (3–15 developers) who:
- Already use Claude Code (or want to)
- Think in tickets/tasks, not chat messages
- Want AI to do the work, not just suggest
- Value self-hosted/OSS (privacy, control, cost)
- Are comfortable with early-adopter rough edges

**Specific communities:**
- Claude Code power users who hit single-agent limits
- r/selfhosted enthusiasts who want AI coding tools on their own infra
- Teams using Linear/Jira who want "what if the AI just resolved the ticket?"
- Agencies/consultants juggling multiple client projects simultaneously

**NOT our launch customer:**
- Solo developers happy with Cursor/Cline (they don't need task management)
- Non-developers (they need Windtunnel, which isn't ready)
- Large enterprises (they need SOC2, SSO, audit logs we don't have)

### Entry Wedge

**"Like Conductor, but web-based, open-source, and with a task board."**

This positions us clearly:
- Developers who know Conductor understand parallel agents + worktrees
- "Web-based" = any platform, not Mac-only
- "Open-source" = inspect, self-host, trust
- "Task board" = the missing piece that makes parallel agents manageable

### Feature Gaps for v1 Launch

| Gap | Priority | Effort | Impact |
|---|---|---|---|
| One-command install (Docker Compose) | **Critical** | Medium | Removes setup friction |
| README / contributing guide | **Critical** | Low | OSS table stakes |
| Onboarding flow | High | Medium | First-time user experience |
| Interactive git log (fork/continue) | High | High | Core signal differentiator |
| Keyboard shortcuts | Medium | Low | Developer expectations |
| Multi-user team features (assign, comment) | Medium | High | "Team" positioning |
| PR review surface | Medium | High | Ship flow completion |
| Project path portability | Medium | Medium | Multi-deploy support |
