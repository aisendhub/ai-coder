import { query } from "@anthropic-ai/claude-agent-sdk"
import type {
  AgentMessage,
  AgentRunOptions,
  LlmProvider,
  SystemPromptSpec,
} from "./provider.ts"

// Adapter for `@anthropic-ai/claude-agent-sdk`. Pure passthrough — the SDK is
// rich enough that AgentRunOptions maps 1:1 onto its `Options` shape.

function normalizeSystemPrompt(spec: SystemPromptSpec | undefined) {
  if (spec === undefined) return undefined
  if (typeof spec === "string") return spec
  return {
    type: "preset" as const,
    preset: spec.preset,
    append: spec.append,
    excludeDynamicSections: spec.excludeDynamicSections,
  }
}

export const claudeCodeProvider: LlmProvider = {
  id: "claude-code-sdk",
  label: "Claude Agent SDK",
  runAgent(opts: AgentRunOptions): AsyncIterable<AgentMessage> {
    return query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        resume: opts.resumeSessionId,
        model: opts.model,
        systemPrompt: normalizeSystemPrompt(opts.systemPrompt),
        allowedTools: opts.allowedTools,
        disallowedTools: opts.disallowedTools,
        permissionMode: opts.permissionMode,
        settingSources: opts.settingSources ?? [],
        includePartialMessages: opts.includePartialMessages ?? false,
        abortController: opts.abortController,
        canUseTool: opts.canUseTool,
        // `env` replaces the subprocess environment rather than merging, so
        // spread `process.env` first. Keeps per-run endpoint/key overrides
        // isolated without mutating global env.
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
      },
    })
  },
}
