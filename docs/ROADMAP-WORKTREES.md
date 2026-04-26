# Worktrees — Development Roadmap

Checklist-shaped plan to take the current ai-coder codebase to a public OSS launch as **Worktrees** (`worktrees.dev`). Grounded in [PRODUCT-WORKTREES.md](PRODUCT-WORKTREES.md) positioning and current [PROGRESS.md](PROGRESS.md) state.

Legend: ✅ done · 🟡 in progress · ⬜ not started · 🚫 blocked

---

## Goal

Ship Worktrees v1 as an open-source, self-hostable product at `worktrees.dev`, positioned as the kanban-where-each-ticket-is-an-AI-resolved-worktree.

## v1 success criteria

- [ ] One-command self-host works on a clean machine (Docker or Nix).
- [ ] A new user can sign in, create a project, create a ticket, watch the agent resolve it, merge the PR — all in under 10 minutes, no docs dive required.
- [ ] Marketing site at `worktrees.dev` with positioning, demo, docs.
- [ ] OSS license, README, contributing guide, and a public GitHub repo ready for external contributors.
- [ ] Basic production hardening — no public XSS / CORS / rate-limit footguns.
- [ ] We can run 3+ tickets in parallel on one project without regression.

Everything else is v1.1+.

---

## Phase W0 — Baseline audit

Snapshot the starting state before the roadmap. (Informational; no checklist work.)

**What's already working (carry forward):**
- Kanban board with 5 columns (backlog / running / review / shipped / trashed)
- Worktree isolation per task with symlink management + soft-trash reaper
- Services orchestration (detect / start / stop / verify-run, PM2-style supervisor)
- Evaluator-optimizer loop with iteration + cost caps
- Chat mode with mid-turn nudges via `canUseTool`
- Ship flow (FF merge, PR via `gh pr create`)
- Boot reconcile, orphan cleanup, unified lifecycle logs
- Supabase auth (GitHub + Google), RLS on all tables
- Railway deployment pipeline (`nixpacks.toml`, single-origin Hono serving Vite dist)

**What's flagged as partial in PROGRESS.md:**
- Kanban drag-and-drop + diff summary on cards (Phase 5 deferred items)
- Disk-usage indicator + manual prune UI (Phase 6 reliability gaps)
- Several Phase 2 Supabase wiring items still unchecked — needs verification they're actually still pending vs. just not marked
- Phase 5 hardening is all unchecked

---

## Phase W1 — Stabilize core loops

Eliminate known gaps so the product is regression-free before we invest in polish or packaging.

- [ ] Verify Phase 2 unchecked items in [PROGRESS.md](PROGRESS.md) — mark done or finish:
  - [ ] GitHub + Google OAuth providers enabled in Supabase dashboard
  - [ ] Conversations sidebar wired to live Supabase data
  - [ ] User + assistant messages persisted per conversation
  - [ ] Conversation history restored on page reload
  - [ ] Backend JWT verification + `conversation_id` lookup on `/api/chat`
  - [ ] GitHub `provider_token` captured on sign-in, stored for repo cloning
  - [ ] TS types generated from schema (`supabase gen types`)
- [x] Finish kanban deferred items:
  - [x] Drag-and-drop between columns (backlog ↔ running ↔ review ↔ shipped) — HTML5 native, transitions mapped to existing workspace methods, confirm dialogs on destructive drops
  - [x] Diff summary on cards (files-changed count, +/- line counts) — batched `POST /api/conversations/diff-summary`, rendered on running/review cards
- [ ] Finish reliability gaps:
  - [ ] Disk-usage indicator in UI (total worktree bytes)
  - [ ] Manual prune UI (reap soft-trashed now, not just on schedule)
- [ ] Services panel polish (already mostly done — final sweep):
  - [ ] Verify services proposal + approval flow end-to-end
  - [ ] Confirm worktree-scoped service registry works after crashes / restarts
- [ ] Run a 3-task parallel stress test on a real repo; fix any surfaced races.
- [ ] Remove lingering `userId` from client-side JSON payloads and query strings. Server ignores them post-JWT migration (userId comes from `c.get("userId")`), but the shape is still sent as dead weight. Sweep these when the owning call sites are next edited — see affected files: [src/models/Workspace.model.ts](../src/models/Workspace.model.ts), [src/models/ServiceList.model.ts](../src/models/ServiceList.model.ts), [src/models/ProjectServiceList.model.ts](../src/models/ProjectServiceList.model.ts), [src/models/Conversation.model.ts](../src/models/Conversation.model.ts), [src/components/services-panel.tsx](../src/components/services-panel.tsx).
- [ ] Retire `authorizeProject` / `authorizeConversation` helpers. They still use `sbSystem` and manually check `user_id === userId` — correct but redundant now that routes use the user-scoped client and RLS enforces the same constraint. Replace each caller with a direct `sb.from(...).select("id").eq("id", ...).single()` and 404 on empty. Files: [server/index.ts](../server/index.ts) (lines ~3651 + ~4065 define the helpers; grep for callers).

**Exit criteria:** All PROGRESS.md items either ✅ or explicitly deferred with a reason. No known data-loss or lifecycle bugs.

---

## Phase W2 — Brand migration to Worktrees

Rename the product from `ai-coder` to `Worktrees` across the codebase, docs, and surfaces.

- [ ] Decide repo strategy:
  - [ ] Rename `aisendhub/ai-coder` → `<org>/worktrees`, or create a new repo and migrate history
  - [ ] Update all clone URLs in docs
- [ ] Register identities:
  - [ ] GitHub org for `worktrees` (or fallback `worktrees-dev`, `useworktrees`)
  - [ ] npm package name — `worktrees` or `@worktrees/*` scope
  - [ ] Docker Hub / GHCR namespace
- [ ] Domain setup:
  - [ ] DNS for `worktrees.dev` pointed to marketing host
  - [ ] `app.worktrees.dev` or similar pointed to hosted app (if offering one)
- [ ] Codebase rename sweep:
  - [ ] Package name in `package.json`
  - [ ] README / CLAUDE.md / docs references from "ai-coder" → "Worktrees"
  - [ ] UI copy (page title, header, about screen)
  - [ ] Marketing meta tags (OG, Twitter card)
- [ ] Create placeholder logo / wordmark (can be text-only for v1 — polish later)
- [ ] Update [PLAN.md](PLAN.md), [STACK.md](STACK.md), [PROGRESS.md](PROGRESS.md) with the new product name

**Exit criteria:** No user-facing "ai-coder" references remain. GitHub repo, npm package, and domain all resolve under the new name.

---

## Phase W3 — v1 product polish

Shape the UI for the ticket-and-kanban positioning. Chat de-emphasized, kanban front and center.

- [ ] Kanban-first layout:
  - [ ] Default view on project open is the kanban, not chat
  - [ ] Chats list remains accessible as a sibling tab / section
- [ ] Ticket detail view:
  - [ ] Editable goal + acceptance criteria fields
  - [ ] Iteration cap + cost budget sliders visible (not buried in settings)
  - [ ] Activity log scoped to that task's worktree
- [ ] Onboarding flow:
  - [ ] First-run wizard: "connect a project" → "create your first ticket" → "watch it resolve"
  - [ ] Seed ticket template (e.g., "add a README.md to your project")
- [ ] Empty states:
  - [ ] No projects — clear "create project" CTA
  - [ ] No tickets — clear "create ticket" CTA with example
- [ ] Cosmetic sweep:
  - [ ] Consistent spacing / typography (Tailwind v4 + shadcn already aligned; audit for drift)
  - [ ] Light + dark mode verified
  - [ ] Mobile layout verified for kanban (column horizontal scroll or stacked?)
- [ ] Decide on **chat-out** for v1: keep chat as secondary tab or hide entirely?
  - [ ] Resolve and update [PRODUCT-WORKTREES.md](PRODUCT-WORKTREES.md) open question

**Exit criteria:** A user who lands on the app understands "this is a ticket board that AI resolves" within 15 seconds.

---

## Phase W4 — OSS readiness

Make the repo legible and contributable to the open-source community.

- [ ] License:
  - [ ] Choose (MIT or Apache 2.0 — MIT recommended for minimum friction)
  - [ ] Add `LICENSE` file at repo root
  - [ ] Add SPDX headers or license reference in key source files
- [ ] README (hero doc):
  - [ ] One-sentence positioning
  - [ ] Screenshot / hero image
  - [ ] Quick start (`docker compose up`, env setup)
  - [ ] Link to demo video
  - [ ] Link to `worktrees.dev`
  - [ ] Link to contributing guide
- [ ] CONTRIBUTING.md:
  - [ ] Dev setup from scratch
  - [ ] Branch naming / PR conventions
  - [ ] How to run tests
  - [ ] How to add a migration
- [ ] CODE_OF_CONDUCT.md (Contributor Covenant v2.1 or similar)
- [ ] SECURITY.md (how to report vulnerabilities, response SLA)
- [ ] `.github/ISSUE_TEMPLATE/` — bug report, feature request
- [ ] `.github/PULL_REQUEST_TEMPLATE.md`
- [ ] CHANGELOG.md started (v0.x pre-launch entries, v1.0 entry for launch)
- [ ] One-command install:
  - [ ] `docker-compose.yml` covering app + Postgres
  - [ ] `.env.example` with every required variable documented
  - [ ] `make install` or equivalent wrapper command
  - [ ] Install docs in README + verified on a clean machine (not the dev's laptop)
- [ ] Self-host guide covering:
  - [ ] Supabase project setup (or alternative: bring-your-own-Postgres + manual RLS)
  - [ ] GitHub OAuth app setup
  - [ ] Setting `ANTHROPIC_API_KEY`
  - [ ] Running migrations

**Exit criteria:** Someone who has never used Worktrees before can clone the repo, run one command, and be signed in within 10 minutes on a fresh machine.

---

## Phase W5 — Production hardening

Close the Phase 5 gaps from [PROGRESS.md](PROGRESS.md) plus Worktrees-specific hardening.

- [ ] Real `ANTHROPIC_API_KEY` in prod (not subscription OAuth)
- [ ] CORS lockdown to prod origin(s) only — no wildcards
- [ ] Rate limiting per user on `/api/chat` (token + request count)
- [ ] Cost caps enforced server-side per user per day (not just per task)
- [ ] Sentry (or similar) wired for both frontend and backend
- [ ] Healthcheck endpoint wired to Railway / Docker health
- [ ] Migrations run via release hook, not manually
- [ ] Daily DB backup (automated, off-site storage)
- [ ] Security review pass:
  - [ ] RLS policies audited — no accidentally-public rows
  - [ ] Service-role key never exposed to browser
  - [ ] SSE endpoint can't be used to DoS via unbounded stream
  - [ ] Shell injection audit on anything that calls `exec` / spawn with user input
  - [ ] File-path traversal audit on the directory browser (`PROJECTS_ROOT` boundary)
- [ ] Load test:
  - [ ] Simulate 10 concurrent tickets on one VM — measure memory, CPU, disk
  - [ ] Document known limits in self-host guide

**Exit criteria:** We would feel comfortable if 1000 strangers signed up tomorrow.

---

## Phase W6 — Marketing site + launch materials

Build `worktrees.dev` as the public face of the product.

- [ ] Landing page at `worktrees.dev`:
  - [ ] Above-the-fold: positioning, hero screenshot/loop, CTA to GitHub + CTA to hosted (if any)
  - [ ] "How it works" section (3-step: create ticket → AI resolves in worktree → review and merge)
  - [ ] Differentiator section vs Linear+AI, Cursor, Cline, Conductor
  - [ ] Open-source badge + GitHub stars
  - [ ] Self-host link + hosted link (if offered)
- [ ] Docs:
  - [ ] Getting started
  - [ ] Self-hosting guide
  - [ ] Configuration reference
  - [ ] FAQ
- [ ] Demo video (60–90 seconds):
  - [ ] Script: sign in → create project → create ticket → watch resolution → merge
  - [ ] Screencast with voiceover or captions
  - [ ] Posted to YouTube + embedded on landing
- [ ] Screenshots:
  - [ ] Kanban board
  - [ ] Ticket detail during agent execution
  - [ ] Diff + ship flow
- [ ] Social handles:
  - [ ] Twitter / X: `@worktrees_dev` (or fallback)
  - [ ] Bluesky (optional)
  - [ ] GitHub org social links filled in
- [ ] Launch assets:
  - [ ] HN post draft (title + body + first comment)
  - [ ] Product Hunt listing draft (tagline, description, gallery, maker comment)
  - [ ] Twitter/X launch thread (8–12 tweets)
  - [ ] Reddit post drafts for r/ClaudeAI, r/selfhosted, r/programming

**Exit criteria:** A non-technical visitor to `worktrees.dev` understands what it is, why it's different, and how to try it within 30 seconds.

---

## Phase W7 — Private beta

De-risk the public launch.

- [ ] Recruit 10–20 beta users (friends, X/Twitter dev network, Claude Code community)
- [ ] Private Discord / Slack for beta feedback
- [ ] Run each beta user through the onboarding flow; watch for drop-off points
- [ ] Bug bash week: fix everything surfaced
- [ ] Collect 3–5 usage testimonials / quotes for the landing page
- [ ] Dry run of launch-day materials (HN title A/B, PH timing)

**Exit criteria:** 3+ beta users have independently resolved a real ticket end-to-end without our help, and we've fixed every bug they hit.

---

## Phase W8 — Public launch

Go live. Timing matters — pick a Tuesday or Wednesday, 6–9am PT for HN.

- [ ] Ship v1.0.0 tag on GitHub
- [ ] Publish landing page + docs as final versions
- [ ] Post to Hacker News (Show HN)
- [ ] Post to Product Hunt
- [ ] Publish Twitter/X launch thread
- [ ] Post to Reddit (stagger across 24h: r/ClaudeAI, r/selfhosted, r/programming, r/SaaS)
- [ ] Post to Lobste.rs
- [ ] Post to dev.to / Hashnode
- [ ] Email beta users with launch link + ask for reshares
- [ ] DM 10–20 friendly dev influencers with a personal note
- [ ] Staff the comments for 24h — respond within 15 min, fix bugs as they surface
- [ ] Open a `#launch` channel in community for live issue triage

**Exit criteria:** Launch day doesn't crash, critical bugs get patched within hours, and we end the week with a running community.

---

## Phase W9 — Post-launch iteration

First 30 days after launch. Don't pre-commit scope; let feedback drive it.

- [ ] Public roadmap on GitHub (Project board or pinned issue)
- [ ] Weekly patch releases based on reported issues
- [ ] First feature vote / poll in community
- [ ] Write a "what we learned" post (HN retrospective-style)
- [ ] Evaluate which Hangar prerequisites to queue next (orgs / teams / ACL schema work is the natural bridge)

**Exit criteria:** Worktrees has a living issue tracker, active contributors, and the team has decided whether to start Hangar or continue investing in Worktrees based on data.

---

## Dependencies & blockers

- **Supabase dashboard OAuth config** (Phase W1) — prerequisite for anyone signing in; currently blocking the end-to-end demo.
- **Marketing site host** (Phase W6) — decide Cloudflare Pages / Vercel / GitHub Pages. Lowest friction: host on same Railway deployment as app, subdomain-routed.
- **Demo video** (Phase W6) — budget a day for scripting + recording; this is the single highest-leverage asset for launch.
- **GitHub org / npm name** (Phase W2) — if `worktrees` is taken, decide fallback *before* renaming the codebase to avoid a second rename.

## Open questions

- Do we offer a **hosted tier** alongside the self-host OSS story? If yes, cost model? If yes, what's the migration path from self-host → hosted?
- **External ticket source integration** (Linear / Jira / GitHub Issues) — cut from v1, but decide *now* whether to hold the schema shape for it.
- **Team features at v1** — shared projects, assignees, comments, mentions. None are built. Ship v1 solo-user-only and add team features as v1.1, or hold v1 until they're in? Leaning: ship solo first, team features in v1.1 (aligns with earning credibility before Hangar).
- **Observability.** Sentry covers errors; do we also add analytics (PostHog, Plausible) for funnel measurement? Leaning: Plausible for marketing site, nothing in-app initially.
