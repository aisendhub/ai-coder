# Naming

Decision record for the product name, domains owned, and the research behind it.

## Decision

Three products built from **one open-source monorepo, one shared UI codebase**. Each product is a configured composition of shared UI screens and layouts, not a separate codebase. Deployment picks the layout mix for its target product.

- **`worktrees.dev`** — team- and ticket-focused. Kanban-centric task management with git-native execution. OSS.
- **`hangar.build`** — worktree → branch → deploy automation. Railway / Cloudflare-class deploy platform with orgs, projects, teams, ACL. Uses Worktrees for ticket resolution. OSS.
- **`windtunnel.dev`** — a Bolt / Lovable / v0 competitor that can *iterate and refactor* using git-ecosystem guarantees, closing the gap where those tools fail on the second pass. OSS.

Scopes are provisional — to be finalized after more research. Date decided: 2026-04-24.

## Product family strategy

All three products live in **one monorepo with one UI codebase**. The shared platform (Agent SDK host, Supabase backend, Hono/SSE streaming, worktree execution, services orchestration) is common. Each product is assembled by composing a specific mix of **UI screens and layouts** — the shared components stay the same; which ones are surfaced, arranged, and styled differs per deployment.

| Product | Audience | License | Hosting | Shape of the UI |
|---|---|---|---|---|
| **Worktrees** | Dev teams | OSS | Self-hosted or hosted | Kanban-first, ticket-first, git-native execution |
| **Hangar** | Dev teams shipping to production | OSS | Self-hosted or hosted | Projects / environments / deploy pipelines + Worktrees ticket surface + orgs/ACL |
| **Windtunnel** | Non-developers / builders | OSS | Hosted | Chat-first, preview-first; dev surfaces hidden but git/worktree engine still runs underneath |

**Why three products, not one with modes:**
- Different audiences need different defaults and conceptual models. A non-developer does not need a kanban; a team shipping to production does not need a Lovable-style chat-only surface.
- Each brand owns a clean narrative instead of one muddled "it does everything" pitch.
- Shared monorepo + shared UI codebase means building three products is mostly **layout and configuration work**, not three codebases.

**How the one codebase splits into three products:**
- **Shared**: execution engine (agents, worktrees, services), data model (projects, conversations, messages, tasks), auth, UI component library.
- **Per-product**: which screens are primary vs. hidden, navigation shape, default workflows, onboarding copy, marketing site.
- **Mix-and-match at deploy time**: the same binary can be configured to launch in Worktrees mode, Hangar mode, or Windtunnel mode — the layout composition determines which product a given deployment *is*.

**Positioning detail by product:**

- **Worktrees** — team-focused, ticket-focused. Leads with the kanban board of tasks. Each task resolves to a worktree + branch + PR via the agent. Competes more with Linear-plus-agent than with Cursor — the differentiator is that tickets don't just *track* work, the AI *does* the work inside them.
- **Hangar** — worktree to branch to deploy. Positioned against Railway and Cloudflare for the deploy half; against Worktrees itself for the ticket/resolution half. Adds orgs, projects, teams, ACL. The novel pitch: "the same agent that resolved the ticket ships it to production."
- **Windtunnel** — the weakness of Bolt / Lovable / v0 is iteration. They generate well on the first pass, then fall apart when you want targeted fixes or refactors. Windtunnel closes that gap by keeping a real git repo, worktrees, and a proper agent underneath a simplified UI — so second-pass changes are surgical rather than regenerative.

## What the shared platform is (research context)

The three products sit on top of a web UI that orchestrates parallel Claude Code agents across multiple projects. Distinctive traits of the underlying platform:

- Web UI on a host VM (not a CLI, not a VS Code extension).
- Chat vs Task duality — chats steer, tasks ship in isolated git worktrees.
- Parallel agents per repo via git worktrees (N tasks, N branches, no collisions).
- Evaluator-optimizer autonomy loop bounded by iterations and cost.
- First-class services orchestration (detect / start / stop / verify dev servers per worktree).
- Supabase-backed, multi-user from day one.
- Open source, self-hostable.

Closest single-feature neighbor: **Conductor** (parallel agents + worktrees, Mac-only, closed-source).

## Competitive landscape considered (platform-level research)

This is the landscape that informed naming. Per-product competitive analyses live in [PRODUCT-WORKTREES.md](PRODUCT-WORKTREES.md), [PRODUCT-HANGAR.md](PRODUCT-HANGAR.md), and [PRODUCT-WINDTUNNEL.md](PRODUCT-WINDTUNNEL.md).

| Tool | Form factor | OSS | Closest on |
|---|---|---|---|
| Claude Code | CLI | No | The agent we wrap |
| Cline / Roo / Kilo | VS Code extension | Yes | Inline agent UX |
| Cursor / Windsurf | Standalone IDE | No | Ergonomic editor |
| Aider | CLI | Yes | Git-native agent |
| Conductor | Native Mac app | No | Parallel worktrees |
| ParallelCode | Electron desktop | Yes | Parallel branches |
| Goose | Desktop + CLI | Yes | General agent runner |
| Continue | IDE extension | Yes | PR-quality checks |
| Bolt.new / Lovable | Web SaaS | No | Browser AI IDE (greenfield) |
| Plandex | CLI | Yes | Long-context planning |
| OpenCode / Crush | CLI / TUI | Yes | Terminal agent |

None hit **web UI + multi-project + parallel worktrees + services orchestration + multi-user + OSS** simultaneously.

## Naming research — patterns observed

**What works in this category:**
- Short single real words with a metaphor: Cursor, Goose, Crush, Bolt, Continue, Aider, Cline.
- Metaphor that gives the product a role/persona: Conductor (orchestrator), Aider (helper), Crush (emotion).
- Charm's playbook (Crush, Glow, Soft Serve): emotional/non-technical words in a design-forward voice.

**What's tired:**
- `<thing>Code` suffix — OpenCode, RooCode, KiloCode, ParallelCode; indistinguishable noise.
- `AI<thing>` prefix — reads 2023.
- Cursor-clone typography/pointer names — TM risk vs. Anysphere.
- Claude-adjacent names — gravity well, eats your brand.

**Domain reality:**
- `.com` is gone for every real English single word.
- `.dev`, `.ai`, `.sh`, `.build` are the current survivors.
- Best pattern: claim 2 of 3 across `<name>.<tld>` + GitHub org + npm package.

## Candidates evaluated

See availability check results below. Checked via RDAP (bulk).

### Round 1 — 20 single words × 5 TLDs

Only 9 of 100 available. Key survivors:

- `hangar.build`
- `flotilla.sh` + `flotilla.build`
- `skein.sh` + `skein.build`
- `thicket.build`, `forge.build`, `rig.build`, `delta.build`

Dead: grove, loom, nebula, orchard, arbor, canopy, prism, weave, atelier, smithy, bosun, skipper, hatch — all five TLDs taken.

### Round 2 — compounds and two-word combos

15 of ~82 available — all `.dev`. Highlights:

- `hangar.build` (from R1) + `codehangar.dev` + `hangarworks.dev` — three-domain Hangar brand
- `windtunnel.dev` — distinctive, novel metaphor
- `worktrees.dev` — literal, developer-native
- `groveworks.dev` / `groveyard.dev` / `getgrove.dev` — Grove brand compounds
- `weavehq.dev` / `weavelabs.dev` — Weave brand
- `nebulahq.dev` / `codenebula.dev` / `usenebula.dev` — Nebula brand

Zero `.com` available in round 2. Even obscure compounds gone.

### Names considered and rejected

| Name | Why not |
|---|---|
| Grove | All five TLDs taken; compound fallbacks available but weaker |
| Loom | Toyota "Woven by Toyota" + Loom video brand collision |
| Nebula | Crowded namespace (VPN, gaming, many products) |
| Constellation | 5 syllables; astronomy pond over-fished (Nova, Orbit, Stellar, Cosmos) |
| Cosmix | "-ix" suffix dated; no metaphor lift |
| Stell | Reads as half a word; Stellar blockchain collision |
| Kai | Over-crowded given name; too close to AWS Kiro |
| M82 | Barrett M82 sniper rifle association |
| Auggy | Augment Code trademark proximity + *Wonder* cultural association |
| Glade | SC Johnson air-freshener brand |
| Glide | Glide Apps (no-code builder) direct conflict |
| Mindsurf | Windsurf knockoff read |
| Cowd | Pronunciation ambiguous; reads as typo |
| Forge | Overused in dev tooling |

## Why `worktrees.dev`

**Positioning:** team- and ticket-focused. Kanban-first task management with git-native execution under the hood. See [PRODUCT-WORKTREES.md](PRODUCT-WORKTREES.md).

**Strengths:**
- Literal honesty — tasks resolve to worktrees, which is both a git primitive and the product's core execution mechanic.
- Developer-native convention, like `typescript`, `prettier`, `tailwindcss`.
- Domain clean, uncontested by major brands.
- Closest to what is already built — smallest gap to a v1 ship.

**Known weaknesses:**
- **SEO collision with git's own docs** — always brand with the `.dev` TLD; build visibility through GitHub/HN, not organic search.
- **Grammar friction** — plural form is awkward. Treat as proper noun in copy.
- **Hard to trademark** — generic term; protect the logo/wordmark, not the word.

## Why `hangar.build`

**Positioning:** worktree → branch → deploy automation. Railway- / Cloudflare-class deploy platform with orgs, projects, teams, ACL; uses the Worktrees ticket surface for resolution. See [PRODUCT-HANGAR.md](PRODUCT-HANGAR.md).

**Strengths:**
- Concrete orchestration metaphor (park, maintain, fuel, launch) that maps directly to environments, projects, and deployments.
- `hangar.build` TLD does naming work — "the hangar where you build and ship."
- Three-domain brand depth: `hangar.build`, `codehangar.dev`, `hangarworks.dev`.
- Industry peer pattern (Conductor.build).

## Why `windtunnel.dev`

**Positioning:** a Bolt / Lovable / v0 alternative that can *iterate and refactor* using git-ecosystem guarantees. Chat-first UI on top of a real repo, real worktrees, a real agent. See [PRODUCT-WINDTUNNEL.md](PRODUCT-WINDTUNNEL.md).

**Strengths:**
- Novel name; no trademark collisions.
- Metaphor fits the "tested parallel flows" and "streamlined iteration" positioning.
- Clean break from the dev-tooling brand lets the product sit in the chat-first AI builder category without the baggage of a developer UI.
- Concrete differentiator: existing tools in this category regenerate code on each iteration and lose coherence; Windtunnel's git/worktree engine keeps changes surgical.

## Launch order

**Decision: ship Worktrees first, Hangar second, Windtunnel third.**

Backed by the competitor valuation and market-penetrability analysis in [MARKET.md](MARKET.md).

### 1. Worktrees (first)

- **Why:** ~80% already built (kanban, worktree isolation, services orchestration, evaluator-optimizer loop, ship flow). Smallest gap to v1. Validates the shared platform cheaply before we invest in Hangar's deploy infrastructure or Windtunnel's polished non-dev UI.
- **Audience is free to reach:** HN, GitHub trending, Cursor / Cline / Claude Code communities, dev Twitter.
- **Earns credibility** we can later cash in for Hangar ("by the Worktrees team, for shipping to production") and Windtunnel ("by the Worktrees team, for everyone else").

### 2. Hangar (second)

- **Why second, not first:** depends on Worktrees as a ticket primitive; we can't ship "Hangar uses Worktrees for tickets" before Worktrees exists. Also the heaviest infra lift of the three — deploy targets, preview environments, rollback, env management, org/team/ACL. All of that needs Worktrees as a foundation.
- **Unlocks monetization path** (hosted tier for teams) even while the code stays OSS.

### 3. Windtunnel (third)

- **Why last:** highest polish bar (non-dev audience doesn't tolerate rough edges), crowded well-funded competitive set (Bolt, Lovable, v0), and needs a hosted preview runtime that's cheapest to build once Hangar's deploy infrastructure exists.
- **Benefits from both prior launches** — Worktrees credibility + Hangar's deploy/publish infrastructure.

### Why not ship Windtunnel first

Tempting because the market is loud, but: competes with hundred-million-dollar startups where polish is table stakes, needs preview-runtime infra we don't have, non-dev audience requires paid acquisition (no free HN channel), and the current codebase is far from Windtunnel's chat-first UI — mostly a rewrite.

### Why not ship Hangar first

Monetization is attractive but premature. Hangar depends on Worktrees' ticket primitive; deploy infrastructure is a heavy lift; team features (orgs, roles, ACL) aren't built. Building Hangar before validating Worktrees risks building deploy infrastructure nobody uses.

## Open questions

- GitHub orgs for `worktrees`, `hangar`, `windtunnel` — availability check; fallbacks like `worktrees-dev`, `use<name>`, `<name>-hq` if taken.
- npm package namespaces — check `worktrees`, `hangar`, `windtunnel` and matching `@scope/` forms.
- Logo / wordmark for each brand — separate decision.
- **Config / layout composition** — how does one binary flex into three products at deploy time? Environment variable? Config file? Subdomain routing? Track in [STACK.md](STACK.md) once decided.
- **Cross-product account story** — Supabase auth is already shared. Decide whether a user's Worktrees account carries into Hangar and Windtunnel automatically or whether each product is a separate account context.
