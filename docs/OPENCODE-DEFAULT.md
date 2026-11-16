# OpenCode as the default agent runtime

Status: **plan** · Created 2026-11-16
Companions: [LLM-PROVIDER.md](./LLM-PROVIDER.md) · [SYSTEM-PROMPT.md](./SYSTEM-PROMPT.md) · [PLAN.md](./PLAN.md)

> **Implementation status (2026-11-16):** the OpenCode adapter is built behind
> `LLM_PROVIDER=opencode` and is **not the default**. It supports sessions,
> model refs, streaming text/reasoning, canonicalized tool calls/results,
> usage/cost, abort, steering queueing, per-session instructions, and a model
> catalog. Unit tests use mock event payloads and a fake host; the e2e test
> runs a real DeepSeek turn and resumes the same session.
>
> Still open: model picker UI, provider-credential UI, permission approval
> cards, headless-flow migration, multi-tenant host isolation, and the neutral
> `AgentEvent` contract refactor. Those are the phases below.

## Decision

Run this in two tracks.

1. **Now — other models on the existing runtime.** The Claude Agent SDK stays.
   Non-Anthropic models are reached through Anthropic-compatible endpoints.
   DeepSeek is the first target (`https://api.deepseek.com/anthropic`).
   This requires no agent-loop rewrite.
2. **Later — OpenCode V2 as the default runtime.** Adopt OpenCode when we need
   providers that do not speak the Anthropic API (OpenAI, Gemini, local Ollama),
   or when per-conversation model choice, permission approvals, and mid-turn
   steering become product requirements.

OpenCode is **not** required to run DeepSeek. It is the plan for becoming
model-agnostic in the strong sense, not a prerequisite for the next release.

---

## Why OpenCode

Today ai-coder owns the UI, persistence, projects, worktrees, and diffs, but
rents the agent loop from Claude Code. OpenCode V2 provides the same layer with
a provider-neutral model catalog and an embeddable server:

- **Model breadth.** Anthropic, OpenAI, Google, OpenRouter, Groq, xAI, DeepSeek,
  local Ollama, and custom OpenAI-compatible providers.
- **Model catalog.** `GET /api/model` returns capabilities, context/output
  limits, pricing, variants, status, and availability.
- **Per-session model.** `POST /api/session/{id}/model` switches a conversation
  without replacing the session.
- **Native steering.** `sessions.prompt({ delivery: "steer" })` replaces the
  current `canUseTool` deny-and-reenter nudge hack.
- **Permission bridge.** `permission.asked` plus `reply` supports real approval
  cards instead of `bypassPermissions` everywhere.
- **Compaction, subagents, skills, MCP.** Already implemented; we do not rebuild.
- **One credential store.** `integration` / `credential` APIs cover API keys and
  OAuth for all providers.

Verified baseline: `@opencode/sdk` **2.3.0** (MIT), local `opencode` CLI
**2.2.5**. V2 is explicitly embeddable: `OpenCode.create()` hosts the router
in-process with no HTTP listener.

### What OpenCode does not replace

- Browser UI, SSE transport, local Postgres/PostgREST, RLS, `messages` persistence
- Projects, `project.cwd`, task worktrees, merge flow
- File panel, git log, services, env drawer, access requests
- ai-coder's auto-loop evaluator and work-summary/commit-trailer rules

Those stay ours. OpenCode owns the turn: prompt, model, tools, permissions,
session, usage.

---

## Current architecture (for reference)

```
Browser
  │  POST /api/chat (SSE)
  ▼
server/index.ts  startRunner()
  └─ getLlmProvider().runAgent()        server/llm/index.ts
       └─ claudeCodeProvider            server/llm/claude-code-provider.ts
            └─ query()                  @anthropic-ai/claude-agent-sdk
                 └─ Claude Code CLI ──► Anthropic API or compatible endpoint
```

All four flows use this path: chat (`startRunner`), auto-loop evaluator,
commit-message generation, and run-config/service detection (`agent-loop.ts`).

The `LlmProvider` seam exists, but its message type is `SDKMessage` and its
options are Claude SDK options. It is a call-site abstraction, not a model
abstraction.

### DeepSeek on this architecture

DeepSeek officially supports the Anthropic API format and documents Claude Code
integration. The existing server needs **no code change** to use it; the SDK
passes its subprocess environment through.

```sh
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=<DeepSeek API key>
ANTHROPIC_MODEL=deepseek-flash[1m]
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-flash[1m]
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-flash[1m]
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash
CLAUDE_CODE_EFFORT_LEVEL=max
CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432
```

Notes:

- Use `ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY`. In dev the server
  deletes `ANTHROPIC_API_KEY` to force `claude /login`.
- This switches the whole server. Per-conversation choice needs the small
  provider change described in [LLM-PROVIDER.md](./LLM-PROVIDER.md) plus a
  `conversations.model` column and a picker.
- DeepSeek maps Claude names: `claude-opus*` → `deepseek-v4-pro`,
  `claude-sonnet*` / `claude-haiku*` → `deepseek-flash`.
- Images: `deepseek-flash` accepts image input; `deepseek-v4-pro` replaces them
  with `[Unsupported Image]`.
- Verify `result.total_cost_usd`; Claude Code's pricing table may not know
  DeepSeek rates. Do not rely on it for budget stops until reconciled.

**Interim exit criteria**

- A real chat turn edits and reads files in a project cwd.
- A task worktree run completes and leaves an uncommitted diff.
- Auto-loop evaluator and commit-message generation both run.
- Attachments degrade cleanly on a text-only model.
- Cost shown in the UI matches a hand calculation from token usage.

---

## Target architecture

```
Browser
  │  POST /api/chat (SSE)
  ▼
server/index.ts  startRunner()
  └─ AgentService
       ├─ ClaudeProvider      (kept as fallback / subscription OAuth)
       └─ OpenCodeProvider    (default)
            ├─ embedded OpenCode host
            ├─ session per conversation
            ├─ location.directory = project.cwd or worktree
            ├─ Model.Ref per conversation
            └─ credentials / permissions / usage
```

### Neutral event contract

The frontend already speaks a neutral shape (`text`, `thinking`, `tool_use`,
`tool_result`). Promote that to the server contract and let both providers emit
it.

```ts
type AgentRef = { providerID: string; modelID: string; variant?: string }

type AgentEvent =
  | { type: "session"; sessionId: string; model: AgentRef }
  | { type: "text.delta"; text: string; messageId: string }
  | { type: "reasoning.delta"; text: string; messageId: string }
  | { type: "tool.call"; id: string; name: string; input: unknown }
  | { type: "tool.result"; id: string; ok: boolean; output: string }
  | { type: "permission"; request: PermissionRequest }
  | { type: "usage"; costUsd?: number; tokens?: TokenUsage }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "done"; reason: "stop" | "error" | "aborted" }
  | { type: "error"; message: string }

interface AgentRun {
  sessionId: string
  events: AsyncIterable<AgentEvent>
  steer(text: string): Promise<void>
  abort(): Promise<void>
}
```

`AgentProvider` adds `capabilities`, `listModels()`, `createRun()`, and
`generateText()`.

### Event mapping

| OpenCode V2 | AgentEvent | SSE today |
| --- | --- | --- |
| `session.text.delta` | `text.delta` | `text` |
| `session.reasoning.delta` | `reasoning.delta` | `thinking` |
| `session.tool.called` | `tool.call` | `tool_use` |
| `session.tool.success` / `failed` | `tool.result` | `tool_result` |
| `permission.asked` | `permission` | new `permission_ask` |
| `session.usage.recorded` / `updated` | `usage` | cost footer |
| `session.retry.scheduled` | `retry` | new status row |
| `session.idle` / `execution.*` | `done` | `done` |

Tool names need canonicalization so the file-touch tracker keeps working:

| OpenCode | Canonical | UI |
| --- | --- | --- |
| `read` | `Read` | file view |
| `write` | `Write` | file touch |
| `edit`, `patch` | `Edit` | file touch |
| `bash`, `shell` | `Bash` | terminal row |
| `glob`, `grep`, `list` | `Glob` / `Grep` / `List` | search row |

Normalize input keys (`filePath` → `file_path`, `command` stays) and keep the
raw name/input on the event for the inspector.

---

## Migration phases

### Phase 0 — Spike (2 days)

Throwaway script against the embedded SDK:

1. Node 22/25 compatibility (no Bun required).
2. Two sessions in different cwds, two models, concurrently.
3. Text, reasoning, tool, permission, idle ordering.
4. Abort and steer mid-turn.
5. Restart the host; resume the same session.
6. Switch model mid-session.
7. Image attachment on a vision model.
8. `snapshots: false` leaves no stray git refs.

**Go/no-go:** abort, resume, concurrent cwds, no git pollution.

### Phase 1 — Neutral contract (3–4 days)

- `server/llm/types.ts`: `AgentEvent`, `AgentRef`, `AgentModel`, `AgentRun`.
- `server/llm/claude/`: translate `SDKMessage` → `AgentEvent`.
- Rewrite `startRunner` and `agent-loop.ts` consumers.
- Keep SSE event names unchanged.
- Replay-fixture tests. Ship dark.

### Phase 2 — OpenCode chat provider (5–7 days)

- `server/llm/opencode/`: host lifecycle, session map, event pump, model set,
  abort, idle, usage, retry/errors.
- Migration `0022`:
  - `conversations.runtime text default 'claude-code-sdk'`
  - `conversations.model jsonb`
  - `conversations.agent text`
- `AGENT_RUNTIME=claude|opencode` flag; enable one internal project.
- Replace the nudge path with `delivery: "steer"`.
- Tool normalization layer.

**Exit:** one internal project runs a full task turn on OpenCode with identical
UI behavior; Claude path still works.

### Phase 3 — Model catalog and selection (3–4 days)

- `GET /api/models`: cached, grouped by provider, availability from credentials,
  cost/context/capability/variant metadata.
- `PATCH /api/conversations/:id/model`; project default model.
- UI picker with search, badges, variant selector, unavailable-model disable.
- Capability-aware attachments.
- Model + cost in the turn footer.

### Phase 4 — Credentials and permissions (4–6 days)

- Provider setup UI using `integration` / `credential` endpoints.
- Keys server-side only; never returned to the browser.
- `permission.asked` → approval card → `reply` (`once` / `always` / `reject`).
- Default `allow` to match today; add per-project `ask` policy.
- **Multi-tenant rule:** OpenCode credentials are host-global. One host per
  user with an isolated data dir before shared tenancy.

### Phase 5 — Headless flows and prompt parity (3–4 days)

- Evaluator: temporary session, read-only permission ruleset.
- Commit message and detectors: `POST /api/experimental/generate/text`, or a
  tool-enabled temp session where file reads are needed.
- Instructions: `AGENTS.md` + `config.instructions` pointing at `CLAUDE.md` and
  `.ai-coder/instructions.md`; dynamic cwd/branch via per-session instruction
  entries.
- Preserve: no auto-commit, `<work-summary>` tag, `Ai-Coder-Conversation`
  trailer, worktree rules.
- Map `.claude/skills` into OpenCode skills.

### Phase 6 — Hardening and rollout (4–5 days)

- Restart recovery: OpenCode is authoritative; Postgres mirror; session
  export/import for rebuild.
- Cancel, reconnect, crash isolation, log redaction.
- Cost guardrails reconciled against provider invoices.
- Canary: internal → 10% → new conversations default → Claude fallback.

**Estimate:** ~4–5 weeks for one developer to parity; usable multi-model chat in
~2 weeks.

---

## Data model and API changes

### Database

```sql
alter table public.conversations
  add column runtime text not null default 'claude-code-sdk',
  add column model jsonb,          -- { providerID, modelID, variant }
  add column agent text;           -- OpenCode agent id, null = default

alter table public.projects
  add column default_model jsonb,
  add column permission_policy jsonb;
```

Keep `session_id` as the runtime session handle. Use `runtime` to interpret it.
Existing Claude sessions remain valid.

### Server endpoints

- `GET /api/models`
- `PATCH /api/conversations/:id/model`
- `GET /api/providers` (available integrations + connection state)
- `POST /api/providers/:id/connect`
- `POST /api/conversations/:id/permission/:requestId`
- `POST /api/conversations/:id/steer` (or reuse `/api/chat` while busy)

### Env / flags

```sh
AGENT_RUNTIME=claude            # default until Phase 6
OPENCODE_DATA_DIR=...           # persistent sessions/auth
OPENCODE_SNAPSHOTS=false
```

---

## Risks

| Risk | Mitigation |
| --- | --- |
| OpenCode V2 API churn | Pin `@opencode/sdk`; isolate mapping in one adapter; replay tests |
| Host-global credentials | Per-user host + isolated data dir before multi-tenant |
| Prompt/instruction parity | Golden prompt tests; explicit instruction mapping |
| Tool name/arg drift | Canonical tool layer; never branch in UI per provider |
| Git snapshot pollution | `snapshots: false`; assert refs unchanged |
| Cost reporting | Reconcile `usage` with invoices; do not trust `total_cost_usd` blindly |
| Attachment capability mismatch | Gate on `Model.Info.capabilities`; degrade to text |
| Vendor dependency | Keep Claude provider until parity is proven; clean interface |

---

## Acceptance criteria

- A conversation can switch from Claude to DeepSeek, GPT, Gemini, or a local
  model and keep its transcript.
- Tool calls render identically across providers.
- Abort completes in under a second; steering lands mid-turn.
- The same project runs two conversations on different models concurrently.
- API restart preserves sessions and resumes them.
- Cost per turn is within 5% of the provider invoice.
- Reloading the page rebuilds the transcript from Postgres.
- No secrets appear in logs, SSE payloads, or browser responses.

---

## Open questions

1. Platform-managed keys, BYOK, or both?
2. Is hosted multi-tenancy next, or does the single-tenant VM remain the trust
   boundary?
3. Keep Claude subscription OAuth for local dev, or standardize on API keys?
4. Day-one providers beyond Anthropic and DeepSeek?
5. Does OpenCode replace the Claude provider eventually, or remain one of two
   runtimes?

---

## References

- OpenCode V2 SDK — <https://opencode.ai/v2/docs/build/sdk>
- OpenCode V2 API — <https://opencode.ai/v2/docs/api>
- OpenCode V2 config — <https://opencode.ai/v2/docs/config>
- DeepSeek Anthropic API — <https://api-docs.deepseek.com/guides/anthropic_api>
- DeepSeek + Claude Code — <https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code>
- DeepSeek + OpenCode — <https://api-docs.deepseek.com/quick_start/agent_integrations/opencode>
