# File panel — design & plan

Show the full text of a changed file in a dedicated panel, syntax-highlighted, with a left-margin gutter that color-codes which lines were added / modified. Opens from a hover-only button on each file card in the Changes panel.

> **Scope note (confirmed):** this is a *new* panel, structurally separate from the Changes panel. Reuse **deps** (Shiki, server diff data, ResizablePanel pattern, file watcher SSE) — do **not** reuse the Changes-panel UI.

## Goals

- Open the **full file** (not just the changed hunks) syntax-highlighted in the same project's working-tree state.
- A thin **left-margin gutter** marks each line's diff status (added, modified, unchanged). Removed lines are shown as a marker between the surrounding lines.
- Panel **closes from a top-right `X`**.
- File cards in the Changes panel get a **hover-only "open" button** in their header.
- **Reuse existing code**; add **only one tiny dep** if any.

## What we already have

| Piece | Where | Reuse for |
|-------|-------|-----------|
| Shiki (singleton, JS engine, lazy lang loading, dual theme) | [src/lib/highlight.ts](../src/lib/highlight.ts) | Full-file syntax highlighting |
| `languageForPath()` (extension → Shiki lang id) | [src/lib/highlight.ts](../src/lib/highlight.ts) | Detect language from file path |
| Diff parsing (`extractHunks`) | [src/components/code-panel.tsx](../src/components/code-panel.tsx) | Reuse the `+/-/@@` walk to compute line statuses |
| Per-file diff already fetched per change | [server/index.ts](../server/index.ts) (`/api/changes`) | We already have the diff text in the client |
| ResizablePanel + collapsible pane pattern | [src/App.tsx](../src/App.tsx) (`DesktopLayout`) | Drop the new panel into the same group |
| TopBar trigger pattern (icon button toggles a panel) | [src/components/top-bar.tsx](../src/components/top-bar.tsx) | Optional: a new toggle if we want a global open-file button |
| File-watch SSE (`/api/changes/stream`) | server | Live-refresh the open file when it changes on disk |
| `@git-diff-view/react` (already in deps) | `node_modules` | Considered — see "Options below" — and rejected |

**Already installed and used:** `shiki@3.23.0` (direct), `@git-diff-view/react@0.1.3` (direct, currently unused), `@git-diff-view/shiki` (transitive).

## Options weighed

### Option A — `@git-diff-view/react` in unified mode with `onAllExpand`

Pros: zero custom rendering; built-in syntax highlighting (uses the same Shiki we already pulled in via `@git-diff-view/shiki`); split/unified toggle for free.

Cons:
- Visual model is "diff view with context", not "full file with a gutter stripe". Every line gets bg coloring (added=green, removed=red, context=plain). The user explicitly asked for a **left-margin** color (gutter), not full-line bg.
- Pulls in the diff-view CSS bundle (~5–10 KB gzipped) and forces a particular layout.
- Per-line widget customization is doable but goes against the grain of the lib.

### Option B — Custom panel: Shiki + gutter (recommended)

Render the **new** file content with Shiki, overlay a 4 px gutter strip per line driven by a `lineStatus[]` array we compute from the existing diff. Removed lines are surfaced as a 2 px red strip between surrounding lines (no row, no whitespace cost).

Pros:
- Matches the spec exactly (gutter, full file).
- Reuses our existing Shiki helper. **No new deps.**
- Tiny render — one `<pre>` of Shiki HTML + a parallel `<div>` of gutter strips. Both lay out as a single grid.
- Simple to extend (jump-to-next-change, sticky filename header, etc.)

Cons:
- ~120 LOC of custom React (acceptable; entirely contained in one component).
- Need to add one tiny server endpoint to read the working-tree file content for **modified** files. (Untracked files already come back via the existing `/api/changes` endpoint inside `f.diff`, since the server cats the file there.)

### Decision

**Option B.** It matches the UX spec, reuses our Shiki path verbatim, and adds no new dep.

## Architecture

```
ChangesPanel (existing)
  FileCard
    [...header...]
    <button class="hover-only" onClick={openFile(f.path)}>      ← new
      <FileText />
    </button>

DesktopLayout (existing ResizablePanelGroup)
  Nav | Chat | [Changes] | [Terminal] | [FilePanel]   ← new pane on the far right
                                          ^ rendered when workspace.openFilePath !== null

FilePanel (new)
  Header: file path + close (X)
  Body:
    Grid (col-template: 4px 1fr)
      [Gutter strips...]   [Shiki HTML]
```

## Server work

**One new endpoint** to fetch the working-tree content of a tracked-but-modified file. Untracked files already work via the existing `/api/changes` payload (diff field carries the cat-output).

```
GET /api/changes/file?conversationId=...&path=relative/path
→ { workspace, path, content }
```

Implementation: resolve cwd via the existing `cwdForConversation()`, read the file from disk with `fs.readFile`, return as JSON. Bound the file size to ~1 MB to protect the client.

## Computing line statuses (client)

We already have the per-file diff string. Walk the hunks once:

```ts
type LineStatus = "added" | "modified" | "context"
// returns Map<newLineNumber, LineStatus> + a Set of newLineNumbers that have a removed line above them
function lineStatusFromDiff(diff: string)
```

Rules: a `+` line in a hunk is `added` (mark `+` line); a `-` line followed immediately by a `+` line counts both as `modified`; a `-` line not followed by `+` is a removed marker on the next-shown line. New (untracked) files: every line is `added`.

## Client architecture

**State.** Add `openFilePath: string | null` to the workspace store (so it's reactive to the active conversation switch — closing one project closes the panel). Setter `openFile(path)` and `closeFile()`.

**Components.**

- [src/components/file-panel.tsx](../src/components/file-panel.tsx) — new. Fetches `/api/changes/file?...` (or pulls from `data.files[path].diff` for untracked), runs `highlightCode()`, computes `lineStatus[]`, renders a 2-column grid: gutter strip + highlighted code.
- [src/components/code-panel.tsx](../src/components/code-panel.tsx) — add a hover-only `<FileText>` button inside `<FileCard>` header that calls `workspace.openFile(f.path)`. Uses `group-hover:opacity-100 opacity-0 transition-opacity` so it appears only when hovering the row.
- [src/App.tsx](../src/App.tsx) — add the new `<ResizablePanel>` after the terminal pane, mounted when `workspace.openFilePath !== null`.

**Re-render on disk change.** Subscribe to the existing SSE `/api/changes/stream`; if the changed path === `openFilePath`, re-fetch.

**Theme.** Reuse the existing dual-theme CSS in [src/index.css](../src/index.css) — Shiki output already adapts to `.dark`.

## Edge cases

- **Binary files.** `lineStatusFromDiff` returns empty; show "Binary file — preview unavailable." (Detect via UTF-8 decode failure server-side, or by content-type sniff.)
- **Renamed.** Use the new path to fetch content; show old path as a subtitle.
- **Deleted.** Disable the open button (no working-tree content to show).
- **Very large files (>1 MB).** Server caps and returns `truncated: true`; UI shows the truncated content with a banner.
- **Language we don't bundle.** Falls back to plain `<pre>` (existing behavior of `highlightCode()` returning null).

## Implementation steps

1. **Server**: add `GET /api/changes/file?conversationId&path` — resolve cwd, read file, cap size, return JSON.
2. **Workspace store**: add `openFilePath` observable + `openFile(path)` / `closeFile()` actions.
3. **`file-panel.tsx`**: new component. Fetches content (via endpoint for tracked files, via existing `data.files[path].diff` for untracked), highlights with Shiki, computes line statuses, renders grid (gutter | code).
4. **`code-panel.tsx`**: add hover-only `<FileText>` button inside `<FileCard>` header. Wire to `workspace.openFile(f.path)`. Use `group/file-card` + `group-hover/file-card:opacity-100`.
5. **`App.tsx`**: add new `ResizablePanel` for `<FilePanel />`, mounted iff `workspace.openFilePath`.
6. **SSE wiring**: subscribe to existing `changes/stream` in `FilePanel`, refetch when the open file changes on disk.
7. **Polish**: empty/error states, binary fallback, `Esc` to close, sticky header.

## Light-deps audit

- **No new runtime deps required.** Everything composes from `shiki` (already in), `react`, and existing hooks.
- Lucide icons (`FileText`, `X`) already imported elsewhere.
- The 0.1.3 `@git-diff-view/react` dep currently has no callers and could be removed in a follow-up cleanup if we land on Option B and never use it.

## Estimate

- Server endpoint: 20 LOC.
- Workspace store: 10 LOC.
- `FilePanel`: ~120 LOC.
- `code-panel.tsx` button + wiring: 15 LOC.
- `App.tsx` panel: 12 LOC.
- Total: ~180 LOC, no new deps, contained in 4 files + 1 small server route.
