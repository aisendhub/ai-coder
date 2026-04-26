# Product signal

The one sentence that decides every UI argument:

> **The developer's job is to orchestrate AI work, not to supervise it minute-by-minute.**

Everything we build should push the user further away from "watching the cursor type" and closer to "reviewing finished work, then dispatching the next move."

---

## What we optimise for

### 1. Async supervision over real-time supervision

The default coding-agent UI is a chat box that streams tokens. The user sits and watches. That's the wrong loop for a 3-minute task and a catastrophic loop for a 30-minute one.

We optimise for the **review loop**:

```
dispatch  →  AI works (minutes / hours)  →  user reviews finished work  →  decide
                                                                         ├─ continue
                                                                         ├─ fork
                                                                         ├─ abandon
                                                                         └─ nudge & re-iterate
```

A user should be able to start a task, close the laptop, and come back to a coherent diff with a coherent commit message. The UI's job is to make the *come-back step* fast: what changed, why, is it good, what's next.

### 2. Long tasks are a feature, not a failure mode

If a task takes 30 seconds, the user waits. If it takes 30 minutes, they go do something else. Long tasks are how we **buy the user parallelism** — they free attention to run more agents, plan more work, or simply do something that isn't this.

Implications:
- Don't design for "the user is watching." Design for "the user is gone."
- Background work needs persistent surfaces — a kanban / task list visible from any conversation, with state that survives reload.
- Streamed events are a liveness indicator, not the primary artefact. The primary artefact is the **commit** (or the failed attempt and its trace).
- The agent should be biased toward **completing more before stopping** when given autonomy — make a coherent commit, run tests, draft a PR — instead of pausing for confirmation every two tool calls.

### 3. The user is the orchestrator, not a co-typist

Treat the user as a conductor of multiple parallel runs:
- **Choose** which path to keep.
- **Abandon** wrong directions cheaply.
- **Fork** from any point — a commit, a turn, a worktree state — into a new exploration.
- **Continue from a point** — pick up an old run instead of starting clean.
- **Compare** parallel attempts against the same prompt.

The git log isn't a passive history — it's the **menu of branch points**. Every commit is a "what if I ran from here?" handle. Every conversation is a checkpoint to fork from. Every worktree is a parallel attempt to keep or discard.

### 4. Commits are the unit of trust

The diff in your editor can be wrong. The chat transcript can be misleading. The commit — message + files + tests — is what we ship and what we judge.

So:
- Make the commit message **load-bearing**: enough context that the user can review without re-reading the chat.
- Make every commit **navigable**: who/why (which conversation, which prompt), what (per-file diffs), where it goes (branch, PR, merge state).
- Make every commit **actionable**: continue, fork, revert, comment — without leaving the surface.

---

## What this means in practice

| Decision | Pulled by signal | Pushed away by signal |
|---|---|---|
| Surface for finished work | A reviewable commit + diff | A scrolling chat transcript |
| Default task length | Long enough to make a commit | Short enough to babysit |
| Sidebar shape | Tasks + chats + worktrees as parallel lanes | One linear conversation list |
| Notifications | "Agent finished, here's the diff" | "Agent is typing…" |
| Confirmation prompts | At meaningful checkpoints | Every tool call |
| Git log | Interactive, expandable, action-rich | Read-only metadata strip |
| Failure UX | Trace + "retry / fork / nudge" | Generic error toast |

---

## Anti-signals (what we do **not** want)

- A UI that punishes the user for looking away.
- "Are you sure?" prompts that turn the agent back into a co-typist.
- Hiding the AI's reasoning and leaving only the diff (we lose the *why*).
- Hiding the diff and leaving only the chat (we lose the *what*).
- Linear, single-thread mental models that treat parallel runs as an edge case.

---

## How to use this doc

When designing any feature, ask:

1. **Does this make async review faster?** If clicking through finished work is still slow, the signal is missing.
2. **Does this enable parallelism?** Can the user dispatch this and walk away? Can they run two of them at once?
3. **Does this give the user an orchestration handle?** Can they fork, abandon, or continue from this surface?
4. **Is the commit (or task outcome) the artefact?** Or are we still treating the chat stream as the deliverable?

If a feature can't answer at least one of these, it's probably the wrong feature, or framed the wrong way.

---

## Related

- [PLAN.md](PLAN.md) — what we're building.
- [CHAT-VS-TASK.md](CHAT-VS-TASK.md) — how the chat / task split already encodes this signal.
- [PRODUCT-WORKTREES.md](PRODUCT-WORKTREES.md) — parallel-attempt isolation.
- [GIT-LOG.md](GIT-LOG.md) — first concrete UI artefact of this signal: the expandable git log as the review-and-orchestrate surface.
