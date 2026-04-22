# Chat vs Task — when to use which

ai-coder has two ways to talk to the agent. They look similar, behave very differently. Pick deliberately.

## Mental model

Two underlying primitives:

**Branch alone** — one working tree, switch contexts with `git checkout`. Lightweight; file watchers and IDE indexers rebuild on every switch; dirty state blocks switches; only one branch is "live" at a time.

**Worktree** — a branch *plus* its own directory. N branches live on disk at once. Dirty state in one doesn't touch the others. Costs disk space (source duplicates; `node_modules` and build caches are symlinked from the base repo).

**Quick heuristic**

> If two pieces of work might **run at the same time** and could **touch overlapping files**, use a worktree. Otherwise a branch is fine.

## When to use each

### Chat — interactive, shared cwd

Use a chat when:
- You're steering the agent turn-by-turn (you read each reply before sending the next).
- The work is short — minutes, not hours.
- You're exploring, pair-programming, asking questions about the codebase.
- You want edits to land directly in the project's working tree — `Commit` and `Push` go straight to the main repo.
- You're the only thing happening — a branch per chat would pollute `git branch -a` with nothing to show for it.

Ship story: none. A chat is the conversation. Commits land on whatever branch the project cwd is on.

### Task — autonomous, per-task worktree

Use a task when:
- You can write the goal once and walk away (grab coffee, open another task, close the laptop).
- The work is meaningfully long — 5+ iterations, multiple file edits, maybe minutes to hours.
- You want to run **parallel** agents without them stepping on each other's files.
- You want a clean branch you can ship as a Merge or PR.
- You might want to review the diff before integrating.
- You're fine with the evaluator-optimizer loop deciding next steps between iterations.

Ship story: `Merge` (fast-forward into base) or `PR` (push + `gh pr create`). Worktree is removed on merge.

## Rule of thumb

> Would you write a ticket for this work? → Task. Are you just talking? → Chat.

Tasks are *units of shippable work* with an explicit goal, caps, and a branch. Chats are *conversations* — steering, exploration, Q&A, one-off edits.

## Mechanical differences (ai-coder specifics)

| | Chat | Task |
|---|---|---|
| Worktree | Never — runs on `project.cwd` | Own worktree under `.ai-coder-worktrees/<project>/<conv-id>` |
| Branch | None — commits hit whatever branch is checked out | `ai-coder/<slug>-<id6>` branched off `project.default_base_ref` |
| Agent loop | Interactive: one turn per user send | Autonomous: worker turn → read-only evaluator → next worker turn, capped by `max_iterations` and `max_cost_usd` |
| Nudging | `Send` while streaming → nudge queued, flushed at next tool boundary via `canUseTool` | Same — nudges work identically |
| Changes panel | Shows real repo state (you see what you'd commit) | Shows the task's worktree (isolated) |
| Right-panel actions | `Commit` + `Push` (prompts the agent) | `Merge` + `PR` (ship the worktree) |
| Stop / resume | `Stop` aborts; next `Send` resumes the session | Same, plus `Pause` / `Resume` toggles the loop flag |
| Shows up in | `Chats` section in the sidebar | `Tasks` section + the `Board` meta-view |
| Created via | `+ Chat` | `+ Task` (or `Spin off` from any chat's top bar) |

## Converting between them

**Chat → Task**: click `Spin off` in the top bar. Pre-fills a task's goal with the chat's last few user prompts. The chat stays where it is; the task starts fresh with its own worktree.

**Task → Chat**: not supported. A task is its own thing; to "demote" one, delete it and start a chat. Or if you just want to steer interactively for a moment, pause the loop — the task becomes effectively a chat on its worktree until you resume.

## Disk-usage caveat

Each active task carries a worktree. Twenty active tasks on a 500 MB repo ≈ 10 GB on disk even with symlinks (source files duplicate; `.git/worktrees/*` metadata duplicates). Use `Merge` / `PR` or trash tasks you're done with — the reaper hard-deletes after 7 days.

## See also

- [WORKTREES.md](WORKTREES.md) — design of the task / worktree / ship system.
- [WORKTREES-PROGRESS.md](WORKTREES-PROGRESS.md) — what's shipped vs pending.
