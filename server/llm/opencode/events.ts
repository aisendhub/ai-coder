import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { canonicalizeTool, toolContentToText } from "./tools.ts"

// Maps OpenCode V2 events to the Claude-SDK-shaped messages the existing chat
// runner consumes. The mapping is intentionally one-way and stateless except
// for a few correlations:
//   - tool.input.started carries the tool name; tool.called carries the parsed
//     input and the same id.
//   - text/reasoning deltas stream; text/reasoning.ended are only emitted when
//     no delta was seen (some providers send only the final text).
//   - usage.updated carries cumulative cost/tokens; the terminal result reads
//     it.
//
// The mapper is pure enough to unit-test with recorded event payloads.

export type OpenCodeEvent = {
  type: string
  data?: Record<string, any>
  [key: string]: unknown
}

export type DoneReason = "success" | "error" | "aborted"

export type MapperResult = {
  messages: SDKMessage[]
  done?: DoneReason
  error?: Error
}

export type MapperOptions = {
  sessionId: string
  model: string
  cwd: string
}

type TokenUsage = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export class OpenCodeEventMapper {
  readonly sessionId: string
  readonly model: string
  readonly cwd: string
  costUsd = 0
  tokens: TokenUsage | undefined

  private toolNames = new Map<string, string>()
  private textSeen = new Set<string>()
  private reasoningSeen = new Set<string>()
  private started = false
  private finished = false
  private steps = 0
  private lastText = ""
  private sawText = false
  private sawTool = false

  constructor(opts: MapperOptions) {
    this.sessionId = opts.sessionId
    this.model = opts.model
    this.cwd = opts.cwd
  }

  systemInit(): SDKMessage {
    return {
      type: "system",
      subtype: "init",
      session_id: this.sessionId,
      model: this.model,
      cwd: this.cwd,
      tools: [],
      permissionMode: "bypassPermissions",
      apiKeySource: "none",
      mcp_servers: [],
      slash_commands: [],
      output_style: "default",
      skills: [],
      plugins: [],
    } as unknown as SDKMessage
  }

  handle(event: OpenCodeEvent): MapperResult {
    const d = event.data ?? {}
    switch (event.type) {
      case "session.execution.started":
        this.started = true
        return { messages: [] }

      case "session.step.started":
        this.steps += 1
        return { messages: [] }

      case "session.text.delta": {
        const key = this.textKey(d)
        this.textSeen.add(key)
        const text = typeof d.delta === "string" ? d.delta : ""
        if (!text) return { messages: [] }
        this.sawText = true
        this.lastText += text
        return { messages: [this.assistant([{ type: "text", text }])] }
      }

      case "session.text.ended": {
        const key = this.textKey(d)
        if (this.textSeen.has(key)) return { messages: [] }
        const text = typeof d.text === "string" ? d.text : ""
        if (!text) return { messages: [] }
        this.textSeen.add(key)
        this.sawText = true
        this.lastText += text
        return { messages: [this.assistant([{ type: "text", text }])] }
      }

      case "session.reasoning.delta": {
        const key = this.reasoningKey(d)
        this.reasoningSeen.add(key)
        const text = typeof d.delta === "string" ? d.delta : ""
        if (!text) return { messages: [] }
        return {
          messages: [this.assistant([{ type: "thinking", thinking: text }])],
        }
      }

      case "session.reasoning.ended": {
        const key = this.reasoningKey(d)
        if (this.reasoningSeen.has(key)) return { messages: [] }
        const text = typeof d.text === "string" ? d.text : ""
        if (!text) return { messages: [] }
        this.reasoningSeen.add(key)
        return {
          messages: [this.assistant([{ type: "thinking", thinking: text }])],
        }
      }

      case "session.tool.input.started": {
        if (typeof d.id === "string" && typeof d.name === "string") {
          this.toolNames.set(d.id, d.name)
        }
        return { messages: [] }
      }

      case "session.tool.called": {
        if (typeof d.id !== "string") return { messages: [] }
        this.sawTool = true
        const rawName = this.toolNames.get(d.id) ?? "tool"
        const { name, input } = canonicalizeTool(rawName, d.input)
        return {
          messages: [
            this.assistant([
              { type: "tool_use", id: d.id, name, input: input ?? {} },
            ]),
          ],
        }
      }

      case "session.tool.success": {
        if (typeof d.id !== "string") return { messages: [] }
        return {
          messages: [this.toolResult(d.id, false, toolContentToText(d.content))],
        }
      }

      case "session.tool.failed": {
        if (typeof d.id !== "string") return { messages: [] }
        const output =
          (typeof d.error?.message === "string" && d.error.message) ||
          toolContentToText(d.content) ||
          "tool failed"
        return { messages: [this.toolResult(d.id, true, output)] }
      }

      case "session.usage.updated": {
        if (typeof d.cost === "number") this.costUsd = d.cost
        if (d.tokens && typeof d.tokens === "object") this.tokens = d.tokens
        return { messages: [] }
      }

      case "session.execution.succeeded":
        return this.done("success")

      case "session.execution.failed":
        return this.done(
          "error",
          new Error(
            (typeof d.error?.message === "string" && d.error.message) ||
              "OpenCode execution failed"
          )
        )

      case "session.execution.interrupted":
        return this.done("aborted")

      case "session.idle":
        // `idle` can arrive before this turn starts (e.g. resuming an idle
        // session). Only treat it as completion after execution.started.
        return this.started ? this.done("success") : { messages: [] }

      default:
        return { messages: [] }
    }
  }

  resultMessage(reason: DoneReason, info?: any, durationMs = 0): SDKMessage {
    const success = reason === "success"
    return {
      type: "result",
      subtype: success ? "success" : "error_during_execution",
      duration_ms: durationMs,
      duration_api_ms: durationMs,
      is_error: !success,
      num_turns: Math.max(1, this.steps),
      result: success ? this.lastText : reason === "aborted" ? "Interrupted" : "OpenCode execution failed",
      session_id: this.sessionId,
      total_cost_usd: typeof info?.cost === "number" ? info.cost : this.costUsd,
      usage: info?.tokens ?? this.tokens,
      modelUsage: {},
    } as unknown as SDKMessage
  }

  get startedTurn(): boolean {
    return this.started
  }

  get hasOutput(): boolean {
    return this.sawText || this.sawTool
  }

  private done(reason: DoneReason, error?: Error): MapperResult {
    if (this.finished) return { messages: [] }
    this.finished = true
    return { messages: [], done: reason, error }
  }

  private textKey(d: Record<string, any>): string {
    return `${d.assistantMessageID ?? "unknown"}:${d.ordinal ?? 0}`
  }

  private reasoningKey(d: Record<string, any>): string {
    return `${d.assistantMessageID ?? "unknown"}:${d.ordinal ?? 0}`
  }

  private assistant(content: unknown[]): SDKMessage {
    return {
      type: "assistant",
      message: { role: "assistant", content },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: globalThis.crypto.randomUUID(),
    } as unknown as SDKMessage
  }

  private toolResult(
    toolUseId: string,
    isError: boolean,
    output: string
  ): SDKMessage {
    return {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            is_error: isError,
            content: output,
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: globalThis.crypto.randomUUID(),
    } as unknown as SDKMessage
  }
}
