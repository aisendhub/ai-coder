import { claudeCodeProvider } from "./claude-code-provider.ts"
import type { LlmProvider } from "./provider.ts"

export type {
  AgentMessage,
  AgentRunOptions,
  AgentUserMessage,
  LlmProvider,
  SystemPromptSpec,
} from "./provider.ts"

// Single source of truth for which provider drives the agent. Today there is
// only one (the Claude Agent SDK). When another lands, switch via env:
//
//   const id = process.env.LLM_PROVIDER ?? "claude-code-sdk"
//   switch (id) { case "claude-code-sdk": return claudeCodeProvider; ... }
//
// Callers should NEVER import `query` from `@anthropic-ai/claude-agent-sdk`
// directly — go through `getLlmProvider().runAgent(...)` so the swap is
// one-line. See docs/LLM-PROVIDER.md.
export function getLlmProvider(): LlmProvider {
  return claudeCodeProvider
}
