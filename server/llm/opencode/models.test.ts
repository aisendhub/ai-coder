import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_OPENCODE_MODEL,
  formatModelRef,
  parseModelRef,
  toAgentModel,
} from "./models.ts"

test("parseModelRef handles provider/model and variants", () => {
  assert.deepEqual(parseModelRef("deepseek/deepseek-flash", {}), {
    providerID: "deepseek",
    id: "deepseek-flash",
  })
  assert.deepEqual(parseModelRef("anthropic/claude-sonnet-5-5#high", {}), {
    providerID: "anthropic",
    id: "claude-sonnet-5-5",
    variant: "high",
  })
  assert.deepEqual(parseModelRef("  openai/gpt-6.1-sol  ", {}), {
    providerID: "openai",
    id: "gpt-6.1-sol",
  })
})

test("parseModelRef falls back to OPENCODE_MODEL then the built-in default", () => {
  assert.deepEqual(parseModelRef(undefined, { OPENCODE_MODEL: "x/y" }), {
    providerID: "x",
    id: "y",
  })
  assert.deepEqual(parseModelRef(undefined, {}), {
    providerID: "deepseek",
    id: "deepseek-flash",
  })
  assert.equal(DEFAULT_OPENCODE_MODEL, "deepseek/deepseek-flash")
})

test("parseModelRef treats a bare id as the OPENCODE_PROVIDER model", () => {
  assert.deepEqual(parseModelRef("deepseek-flash", {}), {
    providerID: "deepseek",
    id: "deepseek-flash",
  })
  assert.deepEqual(
    parseModelRef("llama3", { OPENCODE_PROVIDER: "ollama" }),
    { providerID: "ollama", id: "llama3" }
  )
})

test("formatModelRef round-trips", () => {
  assert.equal(
    formatModelRef({ providerID: "deepseek", id: "deepseek-flash" }),
    "deepseek/deepseek-flash"
  )
  assert.equal(
    formatModelRef({ providerID: "x", id: "y", variant: "high" }),
    "x/y#high"
  )
})

test("toAgentModel maps catalog metadata", () => {
  const model = toAgentModel({
    providerID: "deepseek",
    id: "deepseek-flash",
    modelID: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    family: "deepseek",
    limit: { context: 1048576, output: 393216 },
    cost: [{ input: 0.1, output: 0.2 }],
    capabilities: { input: { image: true } },
    variants: [{ id: "default" }, "high"],
    status: "active",
    enabled: true,
  })
  assert.equal(model.providerID, "deepseek")
  assert.equal(model.id, "deepseek-flash")
  assert.equal(model.name, "DeepSeek V4.1 Flash")
  assert.equal(model.context, 1048576)
  assert.equal(model.output, 393216)
  assert.deepEqual(model.variants, ["default", "high"])
  assert.equal(model.enabled, true)
  assert.equal(model.status, "active")
})
