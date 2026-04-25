# System prompt, settings, and addendums

How the agent's system prompt is composed for ai-coder, what filesystem
settings get loaded, and where you plug in project-specific instructions.

> Companion: [LLM-PROVIDER.md](./LLM-PROVIDER.md) describes the provider
> abstraction. Everything below is currently routed through the Claude Agent
> SDK provider.

## TL;DR

| Surface          | Preset       | Append                                                  | `settingSources` | CLAUDE.md / skills loaded? |
| ---------------- | ------------ | ------------------------------------------------------- | ---------------- | -------------------------- |
| Main chat runner | `claude_code` | host context + (optional) `<cwd>/.ai-coder/instructions.md` | `["project"]`    | ✅ project only             |
| Evaluator        | replaced     | n/a                                                     | `[]`             | ❌                          |
| Commit-message   | replaced     | n/a                                                     | `[]`             | ❌                          |
| Detect-services  | replaced     | n/a                                                     | `[]`             | ❌                          |

The headless flows are stateless one-shots that should never inherit anything
from the user's environment. The chat runner is the only place we deliberately
let the user's `CLAUDE.md` / `.claude/skills/` shape behavior.

## What the SDK does by default

When you call `query()` (the underlying `@anthropic-ai/claude-agent-sdk`
function) with no options, it runs in **isolation mode**:

- The system prompt is **minimal** — only tool-use instructions. The full
  Claude Code system prompt (coding rules, response style, env context, safety
  guidance) is **not** included.
- No `CLAUDE.md` is loaded — neither the project's nor `~/.claude/CLAUDE.md`.
- No skills from `.claude/skills/` or `~/.claude/skills/`.
- No `.claude/settings.json`.

That's the opposite of the interactive `claude` CLI, which loads everything by
default. The SDK is built for headless / programmatic use, so isolation is
the safe default.

You opt back in via two options:

| Option            | What it controls                                                  |
| ----------------- | ----------------------------------------------------------------- |
| `systemPrompt`    | Whether to use the Claude Code preset, and what to append to it.   |
| `settingSources`  | Which on-disk settings layers to load (`CLAUDE.md`, skills, …).   |

## How we configure the chat runner

In [`server/index.ts`](../server/index.ts) (`startRunner`), every chat turn
goes through `getLlmProvider().runAgent(...)` with this shape:

```ts
getLlmProvider().runAgent({
  prompt: queryPrompt,
  resumeSessionId: currentResume,
  cwd,
  permissionMode: "bypassPermissions",
  settingSources: ["project"],            // load project CLAUDE.md + skills
  abortController: abort,
  systemPrompt: {
    preset: "claude_code",                // keep all Claude Code defaults
    append: systemPromptAppend,           // host context + project addendum
  },
  canUseTool: async () => { /* nudge sweep */ },
})
```

### Why `["project"]` and not `["project", "user"]`

`"user"` would pull in `~/.claude/CLAUDE.md` and `~/.claude/skills/` from the
**server operator's** account, not the project user's. On a deployed instance
that's noise (or worse — the operator's instructions leaking into every
user's session). `"project"` only loads from the project's own `cwd`, which
is what users expect when they author a `CLAUDE.md` for their own repo.

If you ever run ai-coder as a single-user local-only setup, flipping this to
`["project", "user"]` makes sense.

### What `["project"]` actually loads

- `<cwd>/CLAUDE.md` (or `<cwd>/.claude/CLAUDE.md`) — appears as additional
  context for the agent.
- `<cwd>/.claude/skills/*.md` — discovered as skills; the agent can invoke
  them via the `Skill` tool (allowed by default in this preset).
- `<cwd>/.claude/settings.json` — hooks, permissions, env vars defined in
  the project's settings file.
- `<cwd>/.claude/settings.local.json` — only when `"local"` is in
  `settingSources`. We don't include it, since it's typically per-developer
  uncommitted overrides.

## The `append` text

`systemPromptAppend` is the string we hand to the SDK as
`systemPrompt.append`. It's composed in two layers:

```
[host append]
  +
[project addendum]    (only when <cwd>/.ai-coder/instructions.md exists)
```

### Layer 1 — host append

Built by `buildSystemPromptAppend()` in
[`server/llm/system-prompt.ts`](../server/llm/system-prompt.ts). Two shapes:

**Chat conversations** — one short line so Claude doesn't hallucinate
placeholder paths like `/Users/user/foo.ts` when asked to create a file:

```
You are working in: /Users/gabe/code/myproj
Use relative paths (e.g. "./src/foo.ts") or absolute paths inside the cwd. Never invent placeholder absolute paths like "/Users/user/...".
```

**Task worktrees** (auto-loop, ship-to-PR flows) — adds branch / base-ref
context and forbids `git worktree` commands so the runner can't kill its own
cwd.

### Layer 2 — project addendum

Optional. Loaded from `<cwd>/.ai-coder/instructions.md` if the file exists.
Capped at 32 KB; cached by mtime so edits are picked up on the next turn.

This is the **per-project escape hatch** for instructions that should travel
with the repo:

```markdown
# .ai-coder/instructions.md

- Always use TypeScript strict mode.
- Run `npm run lint` after any code change.
- Database migrations live in `db/migrations/`. Never edit applied migrations
  in place — add a new one.
```

The composed append looks like:

```
You are working in: /Users/gabe/code/myproj
Use relative paths (e.g. "./src/foo.ts") or absolute paths inside the cwd...

# Project instructions

- Always use TypeScript strict mode.
- ...
```

Layered last so it can refine or override generic rules. Commit it for
team-shared instructions; `.gitignore` it for local-only.

> ### `instructions.md` vs `CLAUDE.md`
>
> They serve overlapping purposes. The difference:
>
> - **`CLAUDE.md`** is loaded by the SDK via `settingSources: ["project"]`
>   and put into the conversation as additional context. The agent treats it
>   as user content.
> - **`.ai-coder/instructions.md`** is appended to the system prompt by us.
>   The agent treats it as system instructions — higher priority, harder to
>   override mid-conversation.
>
> Use `CLAUDE.md` for "background reading" (architecture, conventions,
> docs the agent should know about). Use `instructions.md` for hard rules
> ("never do X", "always run Y after Z") that you want at system-prompt
> level.

## How the headless flows differ

The evaluator, commit-message generator, and run-detection helpers in
[`server/agent-loop.ts`](../server/agent-loop.ts) all run with:

```ts
{
  systemPrompt: SOME_SPECIFIC_PROMPT,   // a raw string — REPLACES the preset
  allowedTools: ["Read", "Glob", "Grep", ...],
  settingSources: [],                   // fully isolated
  permissionMode: "default" | "bypassPermissions",
}
```

These are stateless one-shots that should never see the user's `CLAUDE.md`,
project addendum, or skills. They run their own task-specific rubric and
emit structured output (JSON for the evaluator, a conventional-commit string
for the commit generator, a `<run-services>` block for detection).

## What you cannot inspect

The resolved system prompt that the SDK actually sends to the model is **not
exposed** as a readable string. We don't have a way to log or compare the
exact bytes. We control the **inputs** (`preset`, `append`, `settingSources`,
the `cwd`) and trust the SDK's composition.

If you need to debug what the agent saw, the practical move is: temporarily
swap the `claude_code` preset for a known string and observe the behavior
delta.

## Hooks

The SDK exposes lifecycle hooks (`PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, etc.). We currently use only one:

- **`canUseTool`** in `startRunner` — fired before each tool invocation.
  Used to sweep mid-turn nudges and interrupt the run when the user posts
  one. See [WORKTREES.md § Mid-turn nudges](./WORKTREES.md).

We do **not** use `UserPromptSubmit` to mutate the user prompt before send.
If you ever need to inject context into the user-side of the conversation
(without touching the system prompt), that's the right hook.

## Where to change things

| Goal                                              | File                                                   |
| ------------------------------------------------- | ------------------------------------------------------ |
| Change the host append text (cwd / branch rules)  | `server/llm/system-prompt.ts` → `buildSystemPromptAppend` |
| Add a project-specific instruction                | Create `<your-project>/.ai-coder/instructions.md`      |
| Toggle `settingSources` for the chat runner       | `server/index.ts` → `startRunner` → `runAgent({...})`  |
| Change a headless flow's prompt or tools          | `server/agent-loop.ts`                                 |
| Swap to a non-Claude provider                     | `server/llm/index.ts` → `getLlmProvider`               |
