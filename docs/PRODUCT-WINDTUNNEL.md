# Windtunnel (`windtunnel.dev`)

The open-source, chat-first, non-developer-facing product on the shared platform. A Bolt / Lovable / v0 alternative with a real git repo underneath. Scopes are provisional — see [NAMING.md](NAMING.md) for family context.

## Positioning

**One-liner:** Like Bolt, Lovable, v0 — but it can actually iterate.

**For:** Non-developers, product managers, founders, designers, and devs prototyping quickly who want natural-language app building *without* the pain of having generated code that can't be refactored.

**Not for:** Devs who want IDE-grade control (use Worktrees). Teams with deploy infrastructure needs (use Hangar). Anyone committed to their existing Bolt/Lovable/v0 project and happy with it.

## The problem it solves

Bolt, Lovable, v0, Replit Agent, Create all generate convincing apps on the **first pass**. The second pass is where they fall over:

- Ask for a "small change" and they regenerate a large section, losing the tweaks you already made.
- Fixes hallucinate on top of hallucinations; coherence degrades per iteration.
- There's no audit trail — you can't see what changed, why, or how to undo it.
- Refactoring across files is unreliable because there's no real version control to anchor against.

**Windtunnel's bet:** keep a real git repo, real worktrees, and a real agent under the hood — and expose only a chat + preview UI. Every iteration is a surgical commit on a branch, not a regeneration. The user never sees the git, but they benefit from it.

## What it does

1. **Chat-first UI.** Conversation on the left, live preview on the right. No file tree, no git log, no terminal.
2. **"Build this for me"** — describe the app, Windtunnel scaffolds, the preview updates live.
3. **Iterate surgically.** "Make the signup button blue" touches one component, commits one diff, preserves everything else.
4. **Real undo.** "Undo the last change" is a git revert under the hood; "go back to before the checkout flow" is a branch checkout.
5. **Fork / variant.** "Try this with a different layout" creates a parallel worktree, previews both — pick the winner, discard the other.
6. **Templates / starters.** Opinionated starting points (SaaS landing, marketplace, dashboard, blog) — the agent takes over from there.
7. **Publish.** One-click deploy to a public URL (likely sharing Hangar's deploy infrastructure when Hangar ships).
8. **Export.** User owns the git repo; if they outgrow Windtunnel, they can hand the repo to a developer and keep going.

## UI shape

Primary surface is **chat + preview**. Everything dev-shaped is hidden by default.

Layout composition (shared components from the monorepo):
- Conversation panel — primary left
- Live preview iframe / device frame — primary right
- Project switcher — minimal, top-left
- "Variants" drawer — shows parallel worktree experiments
- Publish / export drawer — opens on demand
- Hidden by default: file tree, git log, terminal, services panel, kanban

## Competitive landscape

| Tool | Closest on | Where Windtunnel wins |
|---|---|---|
| Bolt.new | Chat → app in browser | Real git backing; iteration stays coherent across N turns |
| Lovable | Chat → app with preview | Same — Lovable regenerates; Windtunnel commits surgical diffs |
| v0 (Vercel) | Chat → UI components | v0 is component-level; Windtunnel builds full apps with iteration |
| Replit Agent | Chat → full app | Replit owns runtime; Windtunnel users own their git repo |
| Create.xyz | Chat → app | Same regeneration problem |
| StackBlitz Codeflow | Browser dev environment | StackBlitz is dev-facing; Windtunnel hides dev surface |
| Claude.ai / ChatGPT + code | Chat → code snippets | Conversational only; no preview, no deploy, no iteration structure |

**Core differentiator:** Real git + real worktrees under a chat UI. Every other tool in this category regenerates; Windtunnel iterates.

## MVP scope

Medium lift. Polish-heavy and design-heavy — the UI bar is higher than Worktrees or Hangar because the target audience doesn't tolerate rough edges.

**Inherited from the platform:**
- Agent execution, worktree isolation, services orchestration, evaluator-optimizer loop, Supabase auth

**New for Windtunnel v1:**
- Chat-first UI (redesigned from current dev-focused UI)
- Live preview iframe with device frames (mobile / tablet / desktop)
- Template gallery + onboarding flow
- Hidden-git UX: "undo" / "revert to this point" / "fork this" without exposing git language
- Export repo (download or push to user's GitHub)
- Publish to public URL (depends on Hangar's deploy infrastructure — may need to ship with a minimal standalone publish if Hangar is behind)

**v1.1 and beyond:**
- Richer variants / experiments UI
- Collaboration (multiple people editing the same Windtunnel project)
- Integrations (Supabase, Stripe, Resend) as one-click add-ons
- Mobile-responsive editor

**Explicitly out of scope for v1:**
- Dev-facing surfaces (kanban, git log, terminal) — that's Worktrees
- Team / org / ACL features — that's Hangar
- Fine-grained CI / deploy configuration — use Hangar

## Open questions

- **Template catalog curation.** How many templates at launch? Who builds them? Leaning: 3–5 opinionated starters at v1, community-contributed after.
- **Publish story if Hangar isn't ready.** Options: (a) ship a minimal publish-to-subdomain feature standalone; (b) require Hangar to exist; (c) push to user's connected Vercel / Cloudflare. Leaning: (c) for v1 — let users bring their own hosting.
- **How much dev escape hatch?** If a user wants to drop into the file tree or terminal, do we allow it? Leaning: yes, as "advanced mode" — but genuinely hidden, not just demoted.
- **Pricing / hosted tier.** OSS means anyone can self-host, but the target audience won't. Hosted tier likely needed. Affects sustainability plan.
- **Preview runtime.** Do we run the user's app in a sandboxed worker / container for the preview, or accept that they run locally? For non-devs, local-run is a non-starter — we need a hosted preview runtime, which is its own infra lift.
- **Visual editor integration.** Will non-devs accept chat-only, or do they also want click-to-edit ("make this button bigger")? The latter is a huge design + engineering scope; punt to v2.
