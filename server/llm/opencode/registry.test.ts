import test from "node:test"
import assert from "node:assert/strict"
import { getLlmProvider } from "../index.ts"

test("default runtime is still the Claude Agent SDK", () => {
  const prev = process.env.LLM_PROVIDER
  delete process.env.LLM_PROVIDER
  try {
    assert.equal(getLlmProvider().id, "claude-code-sdk")
  } finally {
    if (prev === undefined) delete process.env.LLM_PROVIDER
    else process.env.LLM_PROVIDER = prev
  }
})

test("LLM_PROVIDER=opencode selects the OpenCode provider", () => {
  const prev = process.env.LLM_PROVIDER
  process.env.LLM_PROVIDER = "opencode"
  try {
    assert.equal(getLlmProvider().id, "opencode")
  } finally {
    if (prev === undefined) delete process.env.LLM_PROVIDER
    else process.env.LLM_PROVIDER = prev
  }
})

test("an unknown LLM_PROVIDER fails loudly", () => {
  const prev = process.env.LLM_PROVIDER
  process.env.LLM_PROVIDER = "not-a-provider"
  try {
    assert.throws(() => getLlmProvider(), /not-a-provider.+is not registered/)
  } finally {
    if (prev === undefined) delete process.env.LLM_PROVIDER
    else process.env.LLM_PROVIDER = prev
  }
})
