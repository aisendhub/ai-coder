import { claudeCodeProvider } from "./claude-code-provider.ts"
import type { LlmProvider } from "./provider.ts"

export type {
  AgentMessage,
  AgentRunOptions,
  AgentUserMessage,
  LlmProvider,
  SystemPromptSpec,
} from "./provider.ts"

const PROVIDERS: Record<string, LlmProvider> = {
  [claudeCodeProvider.id]: claudeCodeProvider,
}

const DEFAULT_PROVIDER_ID = claudeCodeProvider.id

// Single source of truth for which provider drives the agent. Today the
// only implementation is `claude-code-sdk`. Set `LLM_PROVIDER` in `.env`
// to switch when another lands. Unknown ids throw on first call so a
// typo in env doesn't silently fall back.
//
// Callers should NEVER import `query` from `@anthropic-ai/claude-agent-sdk`
// directly — go through `getLlmProvider().runAgent(...)`. See
// docs/LLM-PROVIDER.md.
export function getLlmProvider(): LlmProvider {
  const id = process.env.LLM_PROVIDER?.trim() || DEFAULT_PROVIDER_ID
  const provider = PROVIDERS[id]
  if (!provider) {
    const known = Object.keys(PROVIDERS).join(", ")
    throw new Error(
      `LLM_PROVIDER="${id}" is not registered (known: ${known}). ` +
      `Unset to use the default ("${DEFAULT_PROVIDER_ID}"), or register a new provider in server/llm/index.ts.`
    )
  }
  return provider
}
