# Competition

> Deep competitive analysis — features, pricing, strengths, weaknesses — for every tool in our space.

## Direct Competitors (Autonomous Agent Space)

### Devin (Cognition) — The Incumbent

**Valuation:** $25B (in talks, April 2026). Previously $10.2B (Sept 2025).
**Revenue:** $73M ARR (June 2025), growing rapidly.
**Customers:** Goldman Sachs, Citi, Dell, Cisco, Ramp, Palantir, Nubank.

**Pricing:**
- Core: $20/mo + $2.25/ACU (~15 min of work each)
- Team: $500/mo (250 ACUs included)
- Enterprise: custom

**Strengths:**
- First mover in "AI software engineer" category
- Full autonomy — plans, executes, debugs, deploys, monitors
- Deep integrations (GitHub, GitLab, Linear, Jira, Slack, 20+ tools)
- Parallel sessions (Feb 2026)
- ~75% task completion rate
- Enterprise credibility (Goldman, Citi)

**Weaknesses:**
- Closed source, SaaS-only — no self-hosted option
- Expensive for small teams ($500/mo for Team)
- Opaque execution — you send a task and hope
- No kanban / task management surface — runs via Slack or web
- Code runs in Devin's cloud, not your infra
- Privacy concerns for enterprises with sensitive code

**Our edge:** Open source, self-hosted, transparent execution (watch the agent work), kanban task management, code stays on your machines, services orchestration.

---

### Claude Code (Anthropic) — The Engine We Wrap

**Pricing:**
- Pro: $20/mo (included with Claude subscription)
- Max $100: 5x usage, Opus access
- Max $200: 20x usage
- Teams: $100–125/seat/mo
- API: pay-per-token

**Strengths:**
- Best satisfaction metrics in the market (91% CSAT, 54 NPS)
- 1M token context window
- Agentic — reads, writes, runs commands, commits
- Terminal-native, works anywhere SSH works
- Anthropic's model quality (Opus 4.6, Sonnet 4.6)

**Weaknesses:**
- CLI only — no visual UI, no task management
- Single-agent, single-project at a time
- No parallel execution
- No services orchestration
- No team features (shared task boards, assignment, review)
- No web UI for non-terminal users

**Our edge:** We add the UI, task management, parallel execution, and team layer on top of Claude Code. We're not competing — we're building on top.

---

### Conductor (Melty Labs) — Closest Competitor

**Pricing:** Free (uses your Claude Code login). Y Combinator backed.

**Strengths:**
- Parallel agents with git worktree isolation (same core mechanic as us)
- Dashboard view of all agents
- Handles merging and PRs
- Free — no additional cost beyond Claude subscription
- Clean, focused UX

**Weaknesses:**
- Mac-only native app — no web, no Linux, no Windows
- Closed source
- No task management / kanban
- No services orchestration
- No team features
- No self-hosted server option
- No persistence layer (ephemeral sessions)

**Our edge:** Web-based (any platform), open source, task board, services orchestration, team-ready, persistent state (Supabase), self-hostable.

---

### OpenAI Codex — The Platform Play

**Pricing:** Included in ChatGPT plans ($20–200/mo). Token-based metering.

**Strengths:**
- Massive existing ChatGPT user base
- Cloud-based coding agent with built-in worktrees
- Parallel agents across projects
- OpenAI's distribution muscle
- GPT-5.3-Codex-Spark for Pro users

**Weaknesses:**
- Locked into OpenAI ecosystem
- Cloud-only — code runs on OpenAI's servers
- No self-hosted option
- No kanban / task management
- Relatively new (launched April 2025), still proving quality
- No services orchestration

**Our edge:** Model-agnostic potential (wrap any agent), self-hosted, task management, services, open source.

---

### Google Jules — The Google Play

**Pricing:**
- Free: 15 tasks/day, 3 concurrent
- AI Pro: $19.99/mo (5x limits)
- Ultra: $124.99/mo (20x limits)

**Strengths:**
- Free tier is generous (15 tasks/day)
- Powered by Gemini 2.5 Pro
- GitHub integration
- Google ecosystem backing

**Weaknesses:**
- Async only — submit task, come back later
- GitHub-only (no GitLab, no self-hosted git)
- No services orchestration
- No team features beyond what GitHub provides
- Google's track record of killing products

**Our edge:** Real-time + async, any git host, services, team features, self-hosted.

---

## Adjacent Competitors (IDE + Extensions)

### Cursor (Anysphere) — The King of IDE AI

**Valuation:** $50–60B (in talks). $2B+ ARR.
**Users:** Multi-million MAU.

**Pricing:**
- Hobby: Free (limited)
- Pro: $20/mo
- Pro+: $60/mo
- Ultra: $200/mo
- Teams: $40/user/mo

**Why we don't compete directly:** Different form factor. Cursor is an IDE — you sit in it and code with AI help. We're a task board — you dispatch work and review results. Cursor is for the developer who wants AI as a co-pilot. We're for the developer who wants AI as a contributor.

**Overlap risk:** Cursor adding agent mode and background tasks means they could move toward our space. Their distribution advantage is enormous.

---

### Cline / Roo Code — OSS Extensions

**Pricing:** Free (BYOK — bring your own API key). Teams tiers for enterprise.

**Strengths:** Open source, VS Code native, transparent execution, no vendor lock-in.
**Weaknesses:** Editor-bound, single agent, no parallel execution, no web UI.

**Relevance:** Similar OSS ethos. Our users likely also use Cline. Not competing — complementary. A Cline user who wants parallel autonomous tasks would use Worktrees.

---

### Aider — CLI Pioneer

**Pricing:** Free, open source. User pays for API tokens.
**GitHub stars:** 39K. Installs: 4.1M.

**Strengths:** Git-native (auto-commits), 100+ languages, works with any API.
**Weaknesses:** CLI only, single agent, no UI, no task management.

**Relevance:** Proves the market for git-native AI coding. Our git-worktree approach is the natural evolution of Aider's git-commit approach.

---

## Consumer Competitors (Windtunnel's Future Space)

### Lovable — The Efficiency Machine

**Valuation:** $6.6B. **Revenue:** $400M+ ARR. **Employees:** 146. **Efficiency:** $2.7M ARR/head.

**Pricing:**
- Free: 5 daily credits
- Pro: $25/mo (100 credits)
- Business: $50/mo

**Strengths:** Fastest startup to $100M ARR in history. 200K new projects/day. Plain English to full-stack React + Supabase apps. One-click deploy. Export to GitHub.

**Weaknesses:** Iteration degrades after first pass — regenerates rather than surgically edits. No real version control underneath. Loses coherence over N turns.

**Windtunnel's edge:** Real git + worktrees underneath chat UI. Iteration is surgical, not regenerative.

---

### Bolt.new (StackBlitz) — Browser-First Builder

**Valuation:** ~$700M. **Revenue:** $40M+ ARR. **Users:** 5M registered.

**Pricing:**
- Free: 1M tokens/mo
- Pro: $25/mo (10M tokens)
- Teams: $30/member/mo

**Strengths:** Zero-friction browser experience. Supabase integration. Figma import. 170+ Pica integrations. Profitable.

**Weaknesses:** Same iteration problem as Lovable. Token-based pricing can be unpredictable.

---

### Replit — The Platform

**Valuation:** $9B. **Revenue:** $240M (2025), targeting $1B. **Funding:** $922M total.

**Pricing:**
- Starter: Free
- Core: $20–25/mo
- Pro: $100/mo

**Strengths:** Complete platform (IDE + agent + deploy + hosting). Browser-based. Education market penetration. Agent 3 with natural language to full app.

**Weaknesses:** Replit owns the runtime — you're locked in. Export story is weak. Performance concerns at scale. Targeting $1B ARR is aggressive.

---

## Competitive Matrix — Autonomous Agent Segment

| Feature | Worktrees | Devin | Conductor | Codex | Jules | Claude Code |
|---|---|---|---|---|---|---|
| Web UI | Yes | Yes | No (Mac) | Yes | Yes | No (CLI) |
| Parallel agents | Yes | Yes | Yes | Yes | Limited | No |
| Git worktree isolation | Yes | No | Yes | Built-in | No | No |
| Services per worktree | Yes | No | No | No | No | No |
| Task board / kanban | Yes | No | No | No | No | No |
| Self-hosted | Yes | No | No | No | No | Yes (CLI) |
| Open source | Yes | No | No | No | No | No |
| Team features | Planned | Enterprise | No | Org-level | No | Teams |
| Cost transparency | Yes | ACU-based | Free | Token-based | Free tier | Token-based |
| Model choice | Claude (via SDK) | Proprietary | Claude | GPT | Gemini | Claude |
| Pricing | OSS / hosted TBD | $20+/mo + ACU | Free | Included in ChatGPT | Free–$125/mo | $20–200/mo |
