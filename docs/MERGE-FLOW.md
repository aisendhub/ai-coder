# Merge flow (AI-driven)

Replaces the current synchronous server-side ship flow for tasks. Merging a task back into its base branch now happens **in the chat, driven by the agent**, so conflicts become a normal back-and-forth instead of a silent server error.

PR mode is removed. Revisit later if wanted.

Related: [WORKTREES.md](WORKTREES.md), [CHAT-VS-TASK.md](CHAT-VS-TASK.md).

## Why

Old flow (`POST /api/conversations/:id/ship { mode: "merge" }`): server tries `git merge --ff-only` from the base cwd, silently falls back to `git update-ref` (working tree not updated, user told to `git pull`), and on conflict fires a second-class "handoff" prompt that requires the user to click Merge again. In a dirty base checkout the whole thing looks like nothing happened.

New flow: one button, one agent turn, full visibility.

## Flow

```
[Merge button in chat]
      │
      ▼
POST /api/conversations/:id/merge
      │
      │  Server:
      │  - assert kind="task" + worktree_path set
      │  - set conversations.merge_requested_at = now()
      │  - inject a structured user turn with the merge prompt
      │  - start runner with cwdOverride = baseCwd
      ▼
Agent turn (cwd = baseCwd, not the worktree):
  1. git -C <worktree> status        → commit pending work on branch
  2. git -C <baseCwd>  status        → clean? if dirty, STOP + ask user
  3. git -C <baseCwd>  checkout <baseRef>   (remember prior branch)
  4. git -C <baseCwd>  merge --squash <branch>
      ├─ clean → git commit -m "<title>\n\n<goal>"
      └─ conflict → list files, STOP, wait for user reply in chat
  5. git -C <baseCwd>  worktree remove --force <worktreePath>
  6. git -C <baseCwd>  branch -D <branch>
  7. restore prior branch in baseCwd
  8. end turn
      │
      ▼
After-turn reconcile:
  if merge_requested_at set AND worktree dir missing on disk
      → shipped_at = now(), worktree_path = branch = base_ref = null
      → merge_requested_at stays (history)
  next chat turn resolves cwd to project.cwd
```

## Decisions (defaults)

| Question | Default | Rationale |
|---|---|---|
| Merge strategy | `--squash` | One commit per task on base; cleaner history. Matches `johannesjo/parallel-code`. |
| Base cwd dirty | Refuse + ask user | Stashing is a footgun; let the user decide. |
| Base cwd on another branch | Checkout baseRef, restore after | Expected for devs working on their own branch. |
| PR mode | Deleted | User requested disable; code removed, not feature-flagged. |
| Non-task chat Commit/Push buttons | Unchanged | They already dispatch agent prompts; out of scope here. |
| Prompt style | Strictly scripted | Merges are not the place for agent creativity. |

## Schema change

`supabase/migrations/0010_merge_flow.sql`

```sql
alter table public.conversations
  add column merge_requested_at timestamptz;

-- keep shipped_at and worktree_path as the source of truth for final state
comment on column public.conversations.merge_requested_at is
  'Set when user clicks Merge; cleared only implicitly by shipped_at advancing. Lets the UI show a "merging" pill.';
```

## Code changes

### Server

- **delete** `shipWorktree`, `tryRebaseWorktree` in `server/worktrees.ts`
- **delete** `POST /api/conversations/:id/ship` in `server/index.ts`
- **delete** `buildMergeHandoffPrompt`, `handMergeOffToAgent` (or fold into new merge endpoint)
- **add** `POST /api/conversations/:id/merge` — validates, sets `merge_requested_at`, injects merge prompt as a user message, kicks runner
- **add** `buildMergePrompt({ worktreePath, baseCwd, branch, baseRef, title, goal })` in `server/worktrees.ts`
- **modify** `startRunner` to accept `cwdOverride?: string` and use it instead of `cwdForConversation` when set
- **add** after-turn reconcile in the runner's completion path: if `merge_requested_at` set and worktree dir missing → clear worktree fields, set `shipped_at`

### Frontend

- **modify** `src/models/Workspace.model.ts`: rename `shipConversation` → `mergeConversation`, drop `mode`, drop `prBody`
- **modify** `src/models/Conversation.model.ts`: add `mergeRequestedAt`, `shippedAt` mapping (already there for shipped)
- **modify** `src/components/code-panel.tsx`:
  - delete the PR button + `handleShip("pr")` branch
  - rename "Merge" tooltip to "Ask agent to merge into `<baseRef>`"
  - disable while `mergeRequestedAt` set and not yet shipped
  - drop the synchronous merged/warning/prUrl toasts — merge result arrives as chat messages

## What can go wrong

| Risk | Mitigation |
|---|---|
| Agent's cwd is the worktree; `git worktree remove` kills it mid-turn | Pass `cwdOverride = baseCwd` to runner so the agent starts in base |
| Agent switches branches / detaches HEAD in the worktree | Prompt step 1 includes `git status` + assertion; on mismatch STOP |
| Base cwd has uncommitted edits | Prompt step 2 requires clean — agent reports and stops, user cleans up |
| Merge conflict mid-squash | Prompt step 4 instructs agent to STOP and list conflicts for user |
| Agent hangs / wanders | Evaluator loop already caps iterations + cost; merge turn is a single turn so this is less relevant |
| Worktree removed but DB not updated (server crash between agent finishing and reconcile) | Boot-time reconcile already checks for missing worktree dirs; add merge-aware branch |
| Two merges in parallel on same repo | Same-conversation: UI disables button while `mergeRequestedAt`. Cross-conversation on one repo: last-write-wins on base ref; live with it for now |
| Task's auto-loop runner still in flight when user clicks Merge | `/merge` calls `existing.abort.abort()` instead of awaiting — user should not have to wait for an evaluator iteration to finish |
| Resumed session with different cwd behaves oddly | `/merge` does NOT resume (`resumeSessionId: undefined`) — fresh session, fully primed by the scripted prompt + override system prompt |
| Old runner's `runners.delete(id)` racing the merge runner's `runners.set(id)` | `finally` only deletes if the map still points at *this* runner |

## Manual test checklist

- [ ] Clean base cwd, clean merge → success, worktree gone, shipped pill shown
- [ ] Dirty base cwd → agent stops, explains, user cleans up and re-clicks
- [ ] Base cwd on feature branch → agent checks out base, merges, restores feature branch
- [ ] Conflict on squash → agent lists files, waits; user instructs resolution
- [ ] Agent committed on branch but left uncommitted changes → agent commits first, then merges
- [ ] No changes on branch → agent reports, cleans up worktree without a commit

## Implementation checklist

- [x] Write this doc
- [x] `0010_merge_flow.sql` migration
- [x] Delete `/ship` endpoint and PR code paths
- [x] `buildMergePrompt` helper
- [x] `POST /api/conversations/:id/merge` endpoint
- [x] Runner `cwdOverride` + `oneShot` + `systemPromptOverride` plumbing
- [x] After-turn merge reconcile (`reconcileMergeIfCompleted`)
- [x] Frontend `mergeConversation` + `mergeRequestedAt` model field
- [x] `code-panel.tsx`: drop PR, rewire Merge, show pending state
- [x] Typecheck clean
- [x] Apply `0010_merge_flow.sql` to Supabase (column verified)
- [x] Smoke test: `/api/conversations/:id/merge` routes and validates input
- [ ] End-to-end test from UI: create task → agent change → click Merge → verify shipped state
