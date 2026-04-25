# LLM provider abstraction

ai-coder runs all agent turns through a single `LlmProvider` interface so we
can swap the underlying SDK / model / vendor without touching the chat runner,
evaluator, commit-message generator, or service detector.

> Companion: [SYSTEM-PROMPT.md](./SYSTEM-PROMPT.md) — what the system prompt
> looks like and how `settingSources` / addendums layer on.

## Today

There is exactly one provider: the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`). Its `query()` function drives both the
interactive chat runner and the headless one-shot flows.

```
server/llm/
├── provider.ts                # interface + types (no impl)
├── claude-code-provider.ts    # implementation (passthrough to query())
└── index.ts                   # getLlmProvider() factory + re-exports
```

Callers depend on `server/llm/index.ts`. They do **not** import from
`@anthropic-ai/claude-agent-sdk` directly.

## The interface

[`server/llm/provider.ts`](../server/llm/provider.ts):

```ts
export interface LlmProvider {
  readonly id: string                    // e.g. "claude-code-sdk"
  readonly label: string                 // human label for logs / UI
  runAgent(opts: AgentRunOptions): AsyncIterable<AgentMessage>
}

export type AgentRunOptions = {
  prompt: string | AsyncIterable<AgentUserMessage>
  cwd: string
  resumeSessionId?: string
  systemPrompt?: SystemPromptSpec
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: PermissionMode
  settingSources?: SettingSource[]
  abortController?: AbortController
  canUseTool?: CanUseTool
  includePartialMessages?: boolean
}

export type SystemPromptSpec =
  | string                                // raw replacement
  | {
      preset: "claude_code"
      append?: string
      excludeDynamicSections?: boolean
    }
```

The shape is deliberately Claude-SDK-flavored — `AgentMessage` is a re-export
of `SDKMessage`, `PermissionMode` is the SDK's enum, `CanUseTool` is the
SDK's hook signature. We're not pretending to be model-agnostic at the type
level today; the abstraction is in **the call site**, not in inventing a new
universal message format. See "Adding a non-Claude provider" below for what
that means in practice.

## Usage

Every call goes through `getLlmProvider().runAgent(...)`:

```ts
import { getLlmProvider } from "./llm/index.ts"

const messages = getLlmProvider().runAgent({
  prompt: "List the files in this repo",
  cwd: "/Users/gabe/code/myproj",
  systemPrompt: { preset: "claude_code", append: "Be terse." },
  allowedTools: ["Read", "Glob"],
  settingSources: [],
  permissionMode: "bypassPermissions",
})

for await (const msg of messages) {
  if (msg.type === "assistant") { /* … */ }
  else if (msg.type === "result") { break }
}
```

### Where it's used

- **Chat runner** — [`server/index.ts`](../server/index.ts) `startRunner`.
  Long-running, session-resuming, full tool surface, `canUseTool` hook for
  mid-turn nudges, `settingSources: ["project"]`.
- **Evaluator** — [`server/agent-loop.ts`](../server/agent-loop.ts)
  `runEvaluator`. Stateless, JSON output, read-only tools.
- **Commit-message generator** — same file, `generateCommitMessage`.
  Stateless, conventional-commit output.
- **Run-config detector (one-shot)** — same file, `detectManifestWithLLM`.
- **Run-config detector (multi-service)** — same file,
  `detectServicesWithLLM`.

## The factory

[`server/llm/index.ts`](../server/llm/index.ts):

```ts
export function getLlmProvider(): LlmProvider {
  return claudeCodeProvider
}
```

When a second provider lands, this becomes:

```ts
export function getLlmProvider(): LlmProvider {
  const id = process.env.LLM_PROVIDER ?? "claude-code-sdk"
  switch (id) {
    case "claude-code-sdk": return claudeCodeProvider
    case "openai-agents":   return openAiAgentsProvider     // hypothetical
    default:
      throw new Error(`unknown LLM_PROVIDER: ${id}`)
  }
}
```

## Adding a non-Claude provider

The honest tradeoff: the message stream is currently typed as the Claude SDK's
`SDKMessage`. A new provider has two options.

### Option A — adapt to the existing message shape

Implement `LlmProvider.runAgent(opts)` and emit `SDKMessage`-shaped events:
`{ type: "system", subtype: "init", session_id, model, cwd }`,
`{ type: "assistant", message: { content: [...] } }`,
`{ type: "result", total_cost_usd }`, etc.

Pros: zero changes to callers. The chat runner, evaluator, commit-message
generator all keep working unmodified.

Cons: every provider has to translate its native event types into a shape
that was designed for the Claude SDK. That can be lossy or awkward for
events the source SDK doesn't have a natural analogue for.

This is the right choice if you only need to swap **the model** (e.g. running
the same Claude SDK against Bedrock or Vertex) or you have a small set of
events to emit.

### Option B — redesign the message shape

When a second non-Claude provider lands and Option A starts feeling forced,
we redesign:

1. Define a smaller, provider-neutral `AgentMessage` union: text deltas, tool
   calls, tool results, session start, session end, errors.
2. Rewrite `claude-code-provider.ts` to translate `SDKMessage` → the neutral
   union.
3. Rewrite the call sites to consume the neutral union (mostly mechanical —
   they already only care about `assistant.text`, `tool_use`, and `result`).

We don't pre-build that abstraction today. YAGNI: it would be guesswork
without a real second provider, and the call sites are small enough to update
when we have one.

### What a new provider must support

Looking at how the chat runner uses the SDK, the must-haves are:

| Capability               | Used by                                      |
| ------------------------ | -------------------------------------------- |
| Streaming agent loop     | All flows                                    |
| Tool use (file system, bash, search) | All flows                            |
| Session resume by id     | Chat runner                                  |
| `cwd` per session        | All flows                                    |
| Abort via `AbortController` | All flows                                 |
| `canUseTool` hook (deny + interrupt) | Chat runner (mid-turn nudges)        |
| Permission modes         | Chat runner (`bypassPermissions`)            |
| Cost tracking            | Chat runner, headless flows (`total_cost_usd`)|
| `CLAUDE.md` / project settings discovery | Chat runner                          |
| Skills (or equivalent)   | Chat runner (optional but expected)          |

A provider that can't hit those (e.g. one without sessions, or without
tool-use streaming) isn't a drop-in replacement.

## What about MCP / subagents?

The Claude SDK exposes `agents` (subagents) and MCP server config via
`Options`. We don't surface them through `AgentRunOptions` yet because
nothing in ai-coder uses them. When we do, they get added to the interface as
new optional fields and the Claude provider wires them through.

## File map

| File                                           | Role                                |
| ---------------------------------------------- | ----------------------------------- |
| `server/llm/provider.ts`                       | Interface + types. No imports of the SDK at runtime. |
| `server/llm/claude-code-provider.ts`           | Wraps `query()` from the Claude SDK. The only place SDK behavior lives. |
| `server/llm/index.ts`                          | `getLlmProvider()` factory + public re-exports. |
| `server/llm/system-prompt.ts`                  | Builds the `append` text (host context + project addendum). |
| `server/index.ts` `startRunner`                | Chat runner — long-running session via the provider. |
| `server/agent-loop.ts`                         | Headless one-shot flows via the provider. |
