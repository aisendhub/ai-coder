# Git log — expandable commit detail

Status: design proposal. No code written yet.

The git log is the user's **review-and-orchestrate surface** for finished AI work. This doc proposes what an expanded commit row should show, the UI pattern, the server endpoints needed, and a phased rollout.

Anchored in [PRODUCT-SIGNAL.md](PRODUCT-SIGNAL.md): commits are the unit of trust, and every commit is a "what if I ran from here?" handle.

---

## Today

- [`src/components/git-log-panel.tsx`](../src/components/git-log-panel.tsx) renders a flat list of commits via `GET /api/git/log`.
- Each `CommitRow` shows: shortSha · subject · author · relative time. Hover reveals copy-SHA.
- The panel can be promoted to a side panel and made fullscreen ([section-menu](../src/components/section-menu.tsx) controls).
- Bidirectional `ai-coder:focus-commit` event already exists — clicking a blame chip in [`file-panel.tsx`](../src/components/file-panel.tsx) scrolls + highlights its commit row in the log.
- Clicking a commit currently does **nothing**. That's what we're designing.

---

## What signal a commit carries (and what to surface)

A commit produced by an AI run is dense with signal. The expanded view should make all of it scannable in one glance, and most of it actionable.

### Tier 0 — already in the row (don't re-show in expanded view)

- shortSha, subject, author, relative time

### Tier 1 — the "should I care?" stripe

- **Full commit message body** — the AI's rationale (we only fetch `%s` today; need `%B`).
- **Stats**: N files changed · +X / −Y lines.
- **State chips**:
  - branch this commit lives on (e.g. `worktrees/abc123`)
  - pushed? (`origin/<branch>` reachable)
  - merged into a base? (e.g. `merged into main`)
  - has open PR? (link)
  - signed-off-by AI / human / mixed
- **Origin link** — which conversation produced this commit, and which turn within it. This is the bridge back to the *why*. Inferred from commit time + worktree → conversation mapping (we already track this via `conversations.session_id` + `worktrees`).

### Tier 2 — files changed

- Per-file row: status badge (`A` / `M` / `D` / `R`), path (truncated middle), small `+12 / −3` stat.
- Click a file → opens the **existing file panel** in *commit-pinned* mode showing that file at that commit, with the diff vs parent. Re-uses frosted-glass blame, comments, syntax highlighting we already have. No duplicate diff renderer.

### Tier 3 — actions (orchestration, not metadata)

These are the buttons that turn the log from a passive history into a menu of branch points.

- **Continue from here** — start a new chat with cwd reset to this commit (a worktree branched at this SHA).
- **Fork from here** — same as continue, but explicitly marks the new task as a parallel exploration.
- **Open originating chat** — jump to the conversation that produced the commit.
- **Revert** — `git revert <sha>` in the active worktree.
- **Cherry-pick into…** — choose another worktree to apply this commit on top of.
- **Explain** — ask the AI to summarize the commit (useful for terse messages or rebased commits).
- **Copy SHA / Open on GitHub** — already exists for SHA copy.

Not every action needs to ship in v1. See [Phases](#phases).

---

## UI pattern — locked: Option A

**Decision:** inline accordion expand + hand-off to the existing file panel.

Click a row → it expands in place. Phase 1 keeps the expanded body **lean**: only the list of files changed, with status badge + per-file +/-. No body, no stats line, no state chips — those land in later phases. Click a file → opens it in the file panel in **commit-pinned** mode (banner showing the short sha + "back to working tree"). On mobile the file panel is already a Sheet (floating), so commit-pinned mode shows up there too.

Why this shape:
- The hard part (diff rendering with blame, syntax, comments) is already polished in [`file-panel.tsx`](../src/components/file-panel.tsx) — we re-use it, not reimplement.
- The file panel becomes the canonical "look at one file" surface; commits, working-tree changes, and blame rail all funnel into it.
- Inline expansion stays cheap and predictable for the list itself.
- Falls back gracefully on mobile (file panel is already a sheet there).

Considered alternatives (rejected):
- **Master/detail (two-pane)** — needs width, bad on mobile, adds a third state to the existing promote/fullscreen modes.
- **Sheet/dialog takeover** — extra clicks to compare commits; would need to either re-implement diffs or load the file panel inside a sheet.

We can revisit master/detail later if commits grow so large that inline expand feels cramped — the data shape and endpoints don't need to change.

---

## Information density (visual sketch — phase 1)

```
┌─────────────────────────────────────────────────────────────┐
│ a1b2c3d  fix(file-panel): instant blame hover via deleg…    │  ← collapsed
│          Gabe · 2d ago                                      │
├─────────────────────────────────────────────────────────────┤
│ ▼ e74529e  docs(market): valuations, TAM, and penetrabil…   │  ← expanded
│           Gabe · 4d ago                                     │
│           ┌───────────────────────────────────────────────┐ │
│           │ M  docs/MARKET.md           +172 / −4         │ │
│           │ M  docs/PLAN.md               +6 / −4         │ │
│           │ M  docs/NAMING.md             +2 / −4         │ │
│           └───────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

Phase 1 keeps the expanded view minimal — just the list of files. Body, stats line, branch/PR chips, action buttons all land in later phases as called out in the [Phases](#phases) section.

Only one row expanded at a time (matches the existing single-accordion-open pattern in the file panel — see [`file-panel.tsx:175-196`](../src/components/file-panel.tsx#L175-L196)). Re-clicking the row collapses.

---

## Server endpoints needed

We can do this with two new endpoints; both are thin wrappers over `git` invocations we already use elsewhere.

### `GET /api/git/commit?conversationId=&sha=`

Returns full detail for one commit:

```ts
{
  sha: string
  shortSha: string
  parents: string[]                    // for revert / range
  authorName, authorEmail, authorTime  // ms
  committerName, committerEmail, committerTime
  subject: string                      // %s (already known)
  body: string                         // %b — the new field
  branches: string[]                   // refs that point here
  isPushed: boolean                    // origin/<branch> contains this sha
  isMerged: { base: string }[]         // base refs this is merged into
  pr?: { url: string; number: number; state: "open"|"merged"|"closed" }
  stats: { files: number; insertions: number; deletions: number }
  files: Array<{
    path: string
    oldPath?: string                   // for renames
    status: "A"|"M"|"D"|"R"|"C"|"T"
    insertions: number
    deletions: number
  }>
  origin?: {                           // best-effort link back to the chat
    conversationId: string
    messageId?: string
  }
}
```

Backed by:
- `git show --no-patch --pretty=format:…%H…%P…%B <sha>` for metadata + body
- `git diff-tree --numstat --name-status <sha>` for files + stats
- `git for-each-ref --contains <sha> refs/heads refs/remotes` for branches/pushed
- `git branch --merged --contains <sha>` for merge state vs known bases
- DB lookup: `conversations` + commit-time/branch heuristic for origin link

### `GET /api/git/show?conversationId=&sha=&path=`

Returns the file content + diff at a specific commit:

```ts
{
  sha: string
  path: string
  content: string                      // git show <sha>:<path>
  diff: string                         // git diff <sha>^ <sha> -- <path>
  isBinary: boolean
}
```

Used by the file panel when in commit-pinned mode. Same shape as `/api/changes/file` so the panel doesn't have to branch hard.

### Existing endpoints — no change required

- `/api/git/log` stays as-is (still returns the lightweight list — fast scan).
- `/api/blame` stays as-is.
- `/api/changes/file` stays as-is for working-tree mode.

---

## Client architecture

### Event surface

Extend the existing event vocabulary:

| Event | Direction | Purpose |
|---|---|---|
| `ai-coder:focus-commit` (existing) | blame → log | scroll log to commit |
| `ai-coder:expand-commit` (new) | any → log | scroll + expand commit row |
| `ai-coder:open-file-at-commit` (new) | log → file-panel | open file in commit-pinned mode |
| `ai-coder:exit-commit-pin` (new) | file-panel → self | back to working-tree mode |

Events keep the components loosely coupled — same pattern we already use for blame ↔ log focus.

### State

- `expandedSha` in `git-log-panel.tsx` — at most one.
- `pinnedCommit: { sha, path } | null` in `file-panel.tsx` — when set, fetches `/api/git/show` instead of `/api/changes/file` and renders a banner.

### Reuse, don't duplicate

- The file panel's diff renderer, blame rail, comments, frosted-glass accordions — all re-used unchanged in commit-pinned mode.
- Status badges (`A` / `M` / `D` / `R`) and per-file +/- stats — re-use whatever the changed-files panel already uses (see `/api/changes` response in [`server/index.ts`](../server/index.ts)).

---

## Phases

### Phase 1 — read-only expand (file list only) ⬜

Goal: clicking a commit shows the list of files it touched, and clicking a file opens it pinned at that commit. Lean: no body, no stats line, no state chips yet.

- ⬜ `GET /api/git/commit` endpoint (file list + per-file +/- and status; subject/body/branches included for later phases but unused in v1)
- ⬜ Inline accordion in `git-log-panel.tsx`: expand on row click, render only the file list
- ⬜ File-list rows show status badge + path + per-file +/-
- ⬜ Click a file → workspace pins commit + opens path
- ⬜ `GET /api/git/show` endpoint (content + diff at sha)
- ⬜ File panel handles commit-pinned mode + banner + "back to working tree"
- ⬜ Mobile: file panel is already a Sheet — confirm commit-pinned mode renders there too

### Phase 2 — orchestration handles ⬜

Goal: the buttons that make the log a menu of branch points.

- ⬜ "Open originating chat" — needs commit→conversation lookup (best-effort: by branch + commit time within worktree window)
- ⬜ "Continue from here" — creates a new conversation/worktree branched at this SHA
- ⬜ "Fork from here" — same as continue, marked as parallel attempt
- ⬜ "Revert" — runs `git revert <sha>` in the active worktree, opens diff for review

### Phase 3 — pushed / PR / merge state ⬜

Goal: situate every commit in its lifecycle.

- ⬜ `GET /api/git/commit` returns `isPushed`, `isMerged`, `pr` (best-effort GitHub lookup if we have the token)
- ⬜ State chips render in the expanded header
- ⬜ Optional: chip click → opens PR on GitHub

### Phase 4 — comparison & cherry-pick ⬜

Goal: compare two AI attempts that started from the same prompt, move good commits between worktrees.

- ⬜ Multi-select in the log (cmd-click)
- ⬜ "Compare" view — diff between two SHAs in the file panel
- ⬜ "Cherry-pick into…" — picker over the user's worktrees

### Phase 5 — explain & summarise ⬜

Goal: when a commit message is terse, ask the AI for the why.

- ⬜ "Explain this commit" button → spawns a short headless run with diff in context, returns a summary
- ⬜ Cached per-sha so repeat clicks are instant

---

## Open questions

- **Origin linkback heuristic.** A commit doesn't carry `conversation_id` in its trailers (yet). We can either (a) infer from worktree + commit time, (b) start writing a `Co-Authored-By` or trailer that carries `conversation_id`, or (c) maintain a `commits` table in Supabase that pairs SHA → conversation_id at commit-time. Option (c) is the cleanest but adds write work to the agent loop.
- **Massive commits.** A 200-file commit will explode the inline file list. Cap to first ~50 with a "show all" link?
- **Performance of state chips.** `git for-each-ref` over many refs can be slow on big repos. Cache per-sha results, invalidate on push/fetch.
- **Commit-pinned mode in file-panel.** Are blame and comments still meaningful when viewing a historical commit? Probably: blame is fine (it's the same `git blame` against that SHA), comments are tied to *file paths* — we'd want to scope comments to working-tree mode only and grey them out in commit-pinned mode.

---

## Related

- [PRODUCT-SIGNAL.md](PRODUCT-SIGNAL.md) — why this surface matters.
- [FILE-PANEL.md](FILE-PANEL.md) — the panel we're handing diffs off to.
- [FILE-ANNOTATIONS.md](FILE-ANNOTATIONS.md) — comments rail, relevant for commit-pinned mode behaviour.
- [WORKTREES.md](WORKTREES.md) — branched worktrees are the substrate for "Continue / Fork from here."
