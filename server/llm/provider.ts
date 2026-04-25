import type {
  CanUseTool,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk"

// ─── Provider interface ──────────────────────────────────────────────────────
// One abstraction over whatever drives an agent loop (LLM + tools + sessions).
// Today the only implementation is the Claude Agent SDK (see
// claude-code-provider.ts). The message stream is intentionally typed as
// `SDKMessage` for now — adapting another SDK means mapping its native events
// to this shape, or we redesign when a second provider lands. See
// docs/LLM-PROVIDER.md.

export type AgentMessage = SDKMessage
export type AgentUserMessage = SDKUserMessage

/** How the system prompt is composed.
 *  - `string` → full replacement; the provider's defaults (Claude Code's
 *    coding rules, tool docs, env context) are dropped.
 *  - `{ preset: "claude_code", append? }` → keep the preset, optionally
 *    append project-/turn-specific text. Recommended for almost every case.
 *  See docs/SYSTEM-PROMPT.md for the layering. */
export type SystemPromptSpec =
  | string
  | {
      preset: "claude_code"
      append?: string
      /** Move dynamic context (cwd, git status, time) into the first user
       *  message so the system prompt itself is cacheable across machines /
       *  sessions. Useful for multi-user fleets; off by default. */
      excludeDynamicSections?: boolean
    }

export type AgentRunOptions = {
  /** A plain user prompt OR a stream of SDK user messages (used for
   *  multi-block content like file attachments). */
  prompt: string | AsyncIterable<AgentUserMessage>
  cwd: string
  /** Resume an existing session by id. Provider-specific; for the Claude
   *  SDK this maps to `Options.resume`. */
  resumeSessionId?: string
  systemPrompt?: SystemPromptSpec
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: PermissionMode
  /** Which on-disk settings layers to load (`CLAUDE.md`, `.claude/skills/`,
   *  `.claude/settings.json`). Default `[]` — fully isolated. The main chat
   *  runner overrides this to `["project"]` so the user's project CLAUDE.md
   *  is respected. Headless flows (evaluator, commit-msg, detect-services)
   *  stay isolated. */
  settingSources?: SettingSource[]
  abortController?: AbortController
  canUseTool?: CanUseTool
  includePartialMessages?: boolean
}

export interface LlmProvider {
  /** Stable id, e.g. "claude-code-sdk". Used in logs / future env switch. */
  readonly id: string
  /** Human-readable label for UI / diagnostics. */
  readonly label: string
  /** Run an agent turn (or session) and stream messages back. The async
   *  iterable terminates on a `result` message or when the abort controller
   *  fires. */
  runAgent(opts: AgentRunOptions): AsyncIterable<AgentMessage>
}
