# Our Space

> Where ai-coder (Worktrees / Hangar / Windtunnel) sits in the market.

## The Category

**AI-assisted software development** — a $12.8–34.6B market in 2026, projected to reach $91.3B by 2032 (~17.5% CAGR). Over 84% of developers now use or plan to use AI coding tools. GitHub reports 51%+ of all committed code in early 2026 is AI-generated or AI-assisted.

## Market Segments

The market has split into three distinct segments with different dynamics:

### 1. IDE-Native AI (Developer Power Tools)

**What it is:** AI integrated into the code editor — completions, inline chat, multi-file edits, agent mode.

**Who's here:** Cursor ($50–60B), GitHub Copilot (4.7M paid subs), Windsurf (acquired by Cognition), Augment Code ($977M), Amazon Q Developer, Google Gemini Code Assist.

**Dynamics:** Winner-take-most. Cursor captured nearly all upside. TAM is ~30M professional developers. High ACV ($20–200/mo per seat), sticky once adopted, but saturated. Every new entrant benchmarked against Cursor.

**Our position:** We don't compete here. We wrap Claude Code, not replace it.

### 2. Autonomous AI Agents (Task-Shaped Coding)

**What it is:** AI that takes a task description and autonomously writes code, runs tests, opens PRs — operating as a contributor, not an assistant.

**Who's here:** Devin ($25B in talks), Claude Code (CLI agent), OpenAI Codex (cloud agents), Google Jules, Linear (coding agents coming).

**Dynamics:** Nascent but exploding. Devin went from $1M to $73M ARR in 9 months. The form factor is shifting from "AI in your editor" to "AI as a teammate." Key differentiator is autonomy + quality of work produced.

**Our position:** This is our primary space. Worktrees is a task board where each ticket is an autonomous agent working in an isolated git worktree. We differentiate on:
- **Parallel execution** — N tasks running simultaneously via git worktrees
- **Self-hosted / OSS** — Devin is closed SaaS; we're open source
- **Web UI** — not CLI (Claude Code) or Mac-only (Conductor)
- **Services orchestration** — dev servers per worktree, not just code

### 3. Consumer AI Builders (No-Code / Vibe Coding)

**What it is:** Chat-to-app tools for non-developers. Describe what you want in natural language, get a working app.

**Who's here:** Lovable ($6.6B, $400M ARR), Replit ($9B, $240M ARR), Bolt.new (~$700M, $40M+ ARR), v0 (Vercel), Create.xyz, Firebase Studio.

**Dynamics:** 10–100x larger TAM than developer tools. Still fragmenting — no single dominant player. Lovable is the efficiency outlier ($2.7M ARR/employee). Growth is viral and product-led. The weakness across all tools: **iteration breaks after the first pass** — they regenerate rather than surgically edit.

**Our position:** Windtunnel (third product) enters here with a real git repo underneath the chat UI, so iteration stays coherent. But this is the hardest segment to enter — polish is table stakes, paid acquisition likely needed, hosted runtime required.

## Where We Sit: The Gap

No existing tool hits **web UI + multi-project + parallel worktrees + services orchestration + multi-user + open source** simultaneously.

| Capability | Cursor | Claude Code | Devin | Conductor | Cline | Lovable |
|---|---|---|---|---|---|---|
| Web UI | No (IDE) | No (CLI) | Yes | No (Mac) | No (VSC) | Yes |
| Parallel agents | No | No | Yes | Yes | No | No |
| Git worktree isolation | No | No | No | Yes | No | No |
| Services per worktree | No | No | No | No | No | No |
| Self-hosted / OSS | No | No | No | No | Yes | No |
| Task board / kanban | No | No | Slack-based | Dashboard | No | No |
| Multi-user / teams | Enterprise | No | Enterprise | No | Teams | No |

**Our unique position:** The open-source, self-hosted, web-based task board where each ticket runs as an autonomous agent in its own git worktree with its own dev servers. We're what you'd get if Linear and Claude Code had a baby that could deploy itself.

## Segment We're Targeting First

**Autonomous AI Agents** (Segment 2) via **Worktrees** — the developer-team task board.

**Why this segment:**
- Nascent market, no dominant incumbent in our specific niche
- Free distribution via HN, GitHub, developer Twitter
- High ACV potential ($40–200/seat/mo for teams)
- We're 80% built already
- Validates the platform before Hangar (deploy) or Windtunnel (consumer)

**Who we're NOT trying to beat:**
- Cursor (IDE space — different form factor entirely)
- Lovable/Bolt (consumer space — different audience, different polish bar)
- GitHub Copilot (completions — we don't do inline code suggestions)
