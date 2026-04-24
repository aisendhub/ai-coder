# Hangar (`hangar.build`)

The open-source, team-oriented, worktree-to-branch-to-deploy automation product on the shared platform. Scopes are provisional — see [NAMING.md](NAMING.md) for family context.

## Positioning

**One-liner:** The AI closes your ticket, opens the PR, runs the tests, and deploys it.

**For:** Dev teams shipping to production who want one platform for tickets, resolution, preview environments, and deploys — instead of stitching Linear + GitHub + Railway + Cloudflare + an AI coding tool.

**Not for:** Solo devs who don't deploy (use Worktrees). Non-developers building no-code apps (use Windtunnel). Teams already on Vercel/Railway/CF who are happy with their current workflow.

## What it does

Everything Worktrees does, plus:

1. **Orgs, projects, teams, ACL.** Shared projects across a team with role-based access. Audit log.
2. **Deploy targets.** Connect to hosting providers (Cloudflare, Railway, Vercel, custom VPS) per project or per environment.
3. **Preview environments per worktree.** Each running ticket gets a live preview URL. PR reviewers see the change deployed, not just diffed.
4. **Environment management.** Env vars per environment (dev / preview / staging / production). Secret storage.
5. **Test integration.** Agent runs the project's test suite as part of its evaluator loop; tickets don't ship if tests fail.
6. **Ship-to-prod flow.** Merge → deploy. The same agent that resolved the ticket pushes it to production.
7. **Rollback.** Git-native — revert the merge; deploy tracking surfaces the rollback in the audit log.

## UI shape

Primary surfaces are **projects / environments / deploys** and **team ticket board**. The Worktrees kanban is embedded for ticket resolution but shares screen with deployment telemetry.

Layout composition (shared components from the monorepo):
- Org / team / project hierarchy — sidebar
- Environments + deploy pipelines — primary dashboard
- Ticket board (from Worktrees) — tab or sibling view
- Deploy history + rollback — primary
- Env var / secret editor — per-environment modal
- Audit log — org-level
- Services / preview URLs — per-worktree

## Competitive landscape

| Tool | Closest on | Where Hangar wins |
|---|---|---|
| Railway | Deploy + preview environments | Railway has no ticket or AI-resolution story — you still need Linear + Cursor upstream |
| Vercel | Deploy + preview environments | Same gap; Vercel is deployer-only |
| Cloudflare Pages / Workers | Deploy | Same gap |
| Render | Deploy | Same gap |
| Linear + Graphite + Railway (stitched) | Full flow via 3+ tools | Hangar is one product; state (ticket ↔ branch ↔ deploy) lives in one place |
| GitHub + Copilot Workspace + Actions + Vercel | Full flow via GitHub stack | Tightly GitHub-locked; Hangar is platform-agnostic and self-hostable |
| Replit Deployments | All-in-one dev + deploy | Replit targets solo/hobbyist; Hangar targets teams with real deploy needs |

**Core differentiator:** The same agent that resolved the ticket ships it to production. No handoff between "AI tool" and "deploy tool." Full loop in one product.

## MVP scope

Heaviest lift of the three products. Depends on Worktrees shipping first so ticket resolution is a known-working primitive.

**Inherited from Worktrees:**
- Ticket board, worktree isolation, services, evaluator-optimizer, ship flow

**New for Hangar v1:**
- Orgs / teams / projects schema + UI
- Role-based access (owner / admin / member / viewer)
- One deploy-target integration (pick one — **Cloudflare Pages** is cheapest and closest to existing Railway deployment knowledge)
- Preview URL per worktree (requires deploy-on-push for worktree branches)
- Env var / secret management per environment
- Deploy history + one-click rollback
- Agent integration: test runner as part of evaluator loop

**v1.1 and beyond:**
- Additional deploy targets (Railway, Vercel, custom VPS)
- Audit log
- SSO / SAML
- Billing (if hosted tier offered even as OSS)

**Explicitly out of scope for v1:**
- Non-dev UI (that's Windtunnel)
- Container / microVM isolation
- Multi-region deploy
- Full CI pipeline builder (use the deploy target's CI; we just trigger and report)

## Open questions

- **Which deploy target first?** Cloudflare (cheapest runtime, closest to existing infra) vs Railway (simplest mental model) vs Vercel (widest adoption). Leaning: **Cloudflare Pages + Workers** — price, scale, alignment with existing stack choices.
- **How deep does the deploy integration go?** Thin wrapper (trigger-and-report) vs. rich (manage domains, routes, SSL, scaling)? MVP: thin wrapper; grow into rich if users demand.
- **Team ticket features.** Assignees, mentions, comments, priority — all needed for a "team" product. Decide which ship with v1 and which wait.
- **Self-hosted vs hosted tier.** Since everything is OSS, is there a hosted tier? If yes, what does it cost and who runs it? Unresolved; affects monetization story.
- **Ticket-to-branch policy.** One branch per ticket (current Worktrees behavior) or allow ticket stacks (merge-train-like)? Teams with high PR volume need the latter.
- **Relationship to external ticket sources.** Should Hangar sync with Linear / Jira / GitHub Issues, or be the source of truth? MVP: source of truth; offer GitHub Issues import later.
