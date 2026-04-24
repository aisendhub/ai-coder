# File annotations — design & plan

Line-anchored annotations in the file panel. Two concrete types share one UI primitive:

- **Comments** — user-authored, persist in DB per `(project, file_path)`, survive file edits via snapshot+diff, post into the active chat so the agent can read them.
- **Blame** — per-line `git blame` info (author, commit SHA, date, subject), derived from the current file state on every load.

Each is toggled independently from the top bar (same pattern as the existing right/terminal/services/file-tree toggles).

> **Scope note (v1):** both types render only for **Shiki-highlighted files**. Plain `<pre>` fallback has no `.line` spans to anchor to and is punted.

## Confirmed decisions

| Decision | Value |
|---|---|
| Scope | Comments per `(project_id, file_path)`. Comments persist through worktree merges. |
| Comment lifecycle | Soft states only: `open`, `resolved`, `outdated`. No hard delete in v1. |
| Comment anchor unit | **Block** (anchored line + 1 line before + 1 after). Pin renders at the first surviving line of the block. |
| Top-bar toggles | Two icons, one per annotation type. Independent on/off. |
| Expand-all controls | Separate per type (`〈〉 comments`, `〈〉 blame`). |
| Fallback path | Punt on non-highlighted files. |

## Unified annotation model

Both types are line-anchored annotations with author + timestamp + body. The data sources and lifecycles differ, but the UI shape is the same.

| Dimension | Comments | Blame |
|---|---|---|
| Conceptual shape | Line-anchored annotation | Line-anchored annotation |
| Data source | DB (`file_comments` table) | `git blame --porcelain` on current blob |
| Per-line density | Sparse | Every line |
| Mutability | Edit / resolve / reopen | Immutable |
| Survives edits via | Snapshot + diff (re-resolve on load) | Re-derived from source of truth on every load |
| Uncommitted state | N/A | `Not Committed Yet` — special render |
| Action on expand | Body + resolve + show in chat | Commit subject + full SHA + date + open in git log |

### Shared primitive

The primitive is **components and state**, not a single rail. Blame lives in a left rail (dense, always-on, groups with diff stripe + line numbers); comments live in a right rail merged with the minimap (sparse, attention-grabbing, groups with the diff heatmap).

- **`<AnnotationAccordion>`** — shared expand-collapse container. Takes a `header` slot + `body` slot. Comment and blame accordions are structurally identical; only content differs. Inline between code rows, same as GitHub review comments.
- **`<AnnotationChip>`** — one chip component with two flavors (`blame` / `comment`). Different default opacity, different icons, but identical hover/click contract and accordion wiring.
- **Shared expand-all store** — the two top-bar buttons drive the same underlying `Set<openId>`. Each annotation type has its own expand-all toggle (`〈〉 comments`, `〈〉 blame`).
- **Shared row highlight** — whichever line has an open annotation (comment OR blame) gets the same `bg-accent/15` row tint. The faint connector line from chip to code line works the same on either side (mirrored direction only).

### Visual differentiation

Separate visual weight so dense blame doesn't drown sparse comments:

- **Blame chips** — faded (opacity 0.35 at rest, 1.0 on hover, matching the line-number pattern). Thin 3px vertical stripe colored by commit SHA hash so consecutive same-commit lines visually group. On panels wider than ~400px, additional `AB 3w` text. Full `abc123d Alice 3 weeks ago` only in the expanded accordion.
- **Comment pins** — full opacity. Solid dot with count badge if > 1 comment on the line. Distinct accent color.
- **Uncommitted-line blame** — dim outline, no author color (since there is none). Tooltip: "uncommitted — working tree."

When both types are toggled on, the rail renders blame first, then the comment pin. Order and widths are fixed so nothing jumps when you hover.

## Top-bar toggles

Two new icons in the top bar, beside the existing panel toggles (`RightPanel`, `Terminal`, `Services`, `FileTree`):

- `MessageSquare` (comments) — on by default.
- `GitCommit` (blame) — off by default.

State persists per user (same `usePersistentState` key pattern as the other toggles). Hiding an annotation type collapses its chips to zero width and hides its accordions entirely — state in DB is untouched.

## Comment anchor strategy — snapshot + diff (chosen)

Five approaches were considered. Snapshot + diff wins.

### Options weighed

1. **Fuzzy hash match** — ambiguous on repeated passages (imports, `})`), whitespace-fragile.
2. **Delta-aware edit log** — breaks whenever anything edits the file outside our capture (external editors, `git ops`, formatters). Recovery after a break requires snapshot+diff anyway → reduces to option 5.
3. **CRDT / OT (Yjs, Automerge)** — wrong tool: stabilizes anchors only for edits *through* the CRDT. Files live on disk, edited by Claude Code's Edit/Write tool, `git`, formatters. Would require a daemon converting disk ↔ CRDT on every change.
4. **Git history (`git log -L`, `git blame`)** — authoritative for committed changes only; agent does many uncommitted edits between commits, often never commits at all. Punted as optional v2 augmentation.
5. **Snapshot + diff — chosen.** Store the full file content at comment creation. On every file-panel render: `diff(snapshot, current) → hunks → lineMap`. Pin to the first surviving line in the anchor block. This is exactly what GitHub does for PR review comments.

### How blame's anchor stability differs

Blame is re-derived from git on every load. The source of truth is `git blame` against the current blob. No anchor-resolution math — whatever `git blame` returns is authoritative for the line in its current state. Comments need snapshot+diff because they are NOT derived from a source of truth that rebuilds on every edit; they're user-authored and must be re-anchored against the moving file.

### Block anchor details

Anchor stores `anchor_start_line` + `anchor_block_length` (default 3: target + 1 before + 1 after) + `anchor_snapshot` (full file content, line-ending-normalized, trailing-whitespace-stripped).

On re-resolution:
- Compute `diff(anchor_snapshot, currentContent)` via the `diff` npm package.
- Build `lineMap: Map<int, int | "deleted">` from the hunks.
- Walk block lines: first survivor → pin there, confidence `shifted`.
- All deleted → `outdated`, move to drawer.
- Successful re-anchor → optionally roll `anchor_snapshot` forward so subsequent diffs stay small.

## Data model

One new table. Blame has no DB table — it's derived.

```sql
-- 0016_file_comments.sql
create table public.file_comments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  file_path text not null,

  body text not null,
  status text not null default 'open'
    check (status in ('open', 'resolved', 'outdated')),

  -- anchor
  anchor_start_line int not null,
  anchor_block_length int not null default 3,
  anchor_snapshot text not null,

  -- cached resolved anchor (against current file content)
  resolved_line int,
  resolved_at timestamptz,
  resolved_confidence text
    check (resolved_confidence in ('exact','shifted','outdated')),

  -- chat link
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,

  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index file_comments_project_file_idx
  on public.file_comments (project_id, file_path);
create index file_comments_conversation_idx
  on public.file_comments (conversation_id);

alter table public.file_comments enable row level security;
-- RLS: user must own the project (read/insert/update policies same shape)
```

## Server API

### Comments

- `GET /api/file-comments?projectId=&filePath=` — returns comments with resolved anchors (runs the resolver server-side and caches the computed `resolved_line` in the row).
- `POST /api/file-comments` — inserts comment, captures snapshot, posts the structured chat message in the same transaction.
- `PATCH /api/file-comments/:id` — status updates, body edits.

### Blame

- `GET /api/blame?conversationId=&path=` — shells out to `git blame --porcelain <path>` in the conversation's cwd (worktree-aware via `cwdForConversation`). Returns `{ lines: [{ line, sha, author, authorEmail, committerTime, subject, isUncommitted }] }`.
- **Caching**: keyed by `(cwd, path, blob SHA)`. The file-watcher SSE invalidates the cache entry on change. Cache lives in-process; LRU with ~200 entries.

## Agent wiring (comments only)

When a comment is posted, the insert + chat message happen in one request:

```
[comment on {file_path}:{line}]
> {anchored_line_content}

{body}
```

The `message_id` lives on the comment row so "Show in chat" can deep-link back.

Potential future hook: agent emits `[comment-resolved {id}]` marker → existing agent-response-hooks machinery auto-resolves.

## UI details

### Rail composition (left → right, per line)

```
[ 6px diff stripe | ~40px faded line-no | ~4–12px blame rail ]  code  [ ~10–12px comment+minimap rail ]
```

**Left side (dense, always-on):**
- Diff stripe (existing): 6px, line status in current working tree.
- Line-number zone (existing): ~40px, faded 0.35 opacity CSS counter.
- Blame rail (new): 3–4px commit-SHA-colored stripe at narrow widths; expands to `AB 3w` initials+age when panel > 400px. Full `abc123d Alice 3 weeks ago` only in the expanded accordion.

**Right side (sparse, attention):**
- Comment+minimap rail (new, merged): single 10–12px column. If a line has a comment → render comment pin (solid dot, count badge for > 1). Otherwise → render the diff heatmap slice for that line (existing minimap behavior). Comment pins take precedence when they overlap, since commented lines matter more than visual diff density.

Merging the comment pins into the minimap column means one fewer right-side strip and avoids the pin-rail drawing over the minimap. Click on a comment pin → opens the comment accordion. Click anywhere else on the rail → existing minimap scroll-to behavior.

### Accordion body

- **Comment**: body text, author + relative time, `Resolve`/`Reopen`, `Show in chat` link, optional `Edit` (author only).
- **Blame**: commit subject (bold), full SHA (monospace, copyable), author + email, committed date, "Open in git log" link (jumps the existing git-log panel to that commit).

Shifted comments show a small `moved from line 42` badge when `resolved_confidence === 'shifted'`.

### Composer (comments)

Pin rail has a hover affordance per line — a faint `+` appears when hovering an un-commented line's rail slot. Click → inline accordion opens with a textarea + submit/cancel.

### Outdated drawer (comments)

Collapsible strip below the file-panel header: "N outdated comments." Each row shows original line #, stale content excerpt, body, and a `Reopen on current line` action.

## Git blame as a stepping-stone to history

The git-log panel already exists. Blame's "Open in git log" action is the bridge: click → the git-log panel opens and scrolls to the commit. This gives us the historical view the user originally asked about without a separate "blame toggle" mode — you click a blame chip, you're in the log. No mode switching.

## Implementation phases

Build the unified primitive first with blame (no DB, contained scope). Layer comments on top once the rail is validated.

### Phase A — Annotation rail + blame

1. `<AnnotationRail>` component scaffolding in `file-panel.tsx`.
2. `<AnnotationAccordion>` shared container.
3. `GET /api/blame` endpoint with per-blob-SHA LRU cache.
4. Blame chip rendering + accordion body.
5. Top-bar `GitCommit` toggle (off by default).
6. "Open in git log" integration.

**Ship point**: blame works end-to-end. Rail primitive is proven on a non-DB consumer.

### Phase B — Comments

7. Migration `0016_file_comments.sql`.
8. `diff` npm package added.
9. `resolveAnchors()` helper + unit tests (clean insert above, delete before, reformat, full block deletion).
10. `GET`/`POST`/`PATCH` `/api/file-comments` endpoints.
11. Comment chip rendering through the existing `<AnnotationRail>`.
12. Inline composer on pin-rail click.
13. Outdated drawer.
14. Top-bar `MessageSquare` toggle (on by default).
15. Agent chat-message wiring on insert.

**Ship point**: comments end-to-end, shared primitive used by both.

## Open questions / v2

- Threading / replies — v1: flat. Threading is a future `parent_comment_id` column, no breaking migration.
- Markdown in comment bodies — v1: plain text. Use existing Markdown renderer later.
- `[comment-resolved id]` auto-resolution from agent — v1.5 if useful in practice.
- Collaborative / shared viewing — single-user scope today; RLS ready.
- `git log -L` augmentation for comments on long-lived committed files — optional v2.

## References

- GitHub PR review: `(blob SHA, path, diff position)` anchoring, "Outdated" state when position is lost.
- JS diff library: https://www.npmjs.com/package/diff — Myers, hunk output.
- `git blame --porcelain` output: https://git-scm.com/docs/git-blame#_the_porcelain_format
