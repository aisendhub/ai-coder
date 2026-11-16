import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createOpenCodeProvider } from "./index.ts"

// Real end-to-end test against DeepSeek through the embedded OpenCode host.
// Opt-in: OPENCODE_E2E=1 and DEEPSEEK_API_KEY must be set.
//
//   DEEPSEEK_API_KEY=... OPENCODE_E2E=1 npm run test:e2e
//
// It uses isolated XDG dirs and a temp database, so the developer's global
// OpenCode auth/sessions are not touched.

const ENABLED =
  process.env.OPENCODE_E2E === "1" && Boolean(process.env.DEEPSEEK_API_KEY)

function makeConfig() {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "deepseek/deepseek-flash",
    providers: {
      deepseek: { settings: { apiKey: "{env:DEEPSEEK_API_KEY}" } },
    },
    snapshots: false,
  })
}

test(
  "OpenCode provider runs a real DeepSeek turn, resumes it, and reports cost",
  { skip: ENABLED ? false : "set OPENCODE_E2E=1 and DEEPSEEK_API_KEY", timeout: 240_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ai-coder-oc-e2e-"))
    const data = await mkdtemp(path.join(tmpdir(), "ai-coder-oc-data-"))
    const cwd = path.join(root, "project")
    process.env.XDG_DATA_HOME = data
    process.env.XDG_CONFIG_HOME = data
    process.env.OPENCODE_DATA_DIR = data
    process.env.OPENCODE_CONFIG_CONTENT = makeConfig()

    const provider = createOpenCodeProvider()
    try {
      const { mkdir } = await import("node:fs/promises")
      await mkdir(cwd, { recursive: true })

      const messages: any[] = []
      for await (const msg of provider.runAgent({
        prompt:
          "Create a file named hello.txt containing exactly the word hello. Then reply with one short line.",
        cwd,
        model: "deepseek/deepseek-flash",
        permissionMode: "bypassPermissions",
        settingSources: [],
      })) {
        messages.push(msg)
      }

      const init = messages.find((m) => m.type === "system")
      assert.ok(init, "expected a system/init message")
      assert.match(init.session_id, /^ses_/)
      const sessionId = init.session_id as string

      const toolUses = messages
        .filter((m) => m.type === "assistant")
        .flatMap((m) => m.message.content)
        .filter((b: any) => b.type === "tool_use")
      const write = toolUses.find((b: any) => b.name === "Write")
      assert.ok(write, `expected a Write tool call, got ${toolUses.map((b: any) => b.name).join(",")}`)
      assert.match(String(write.input.file_path ?? write.input.path), /hello\.txt$/)

      const toolResults = messages
        .filter((m) => m.type === "user")
        .flatMap((m) => m.message.content)
        .filter((b: any) => b.type === "tool_result")
      assert.ok(toolResults.some((b: any) => b.is_error === false))

      const result = messages.at(-1)
      assert.equal(result.type, "result")
      assert.equal(result.subtype, "success")
      assert.equal(result.is_error, false)
      assert.ok(result.total_cost_usd > 0, "expected a non-zero DeepSeek cost")

      const text = messages
        .filter((m) => m.type === "assistant")
        .flatMap((m) => m.message.content)
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("")
      assert.match(text, /hello\.txt/i)

      const file = await readFile(path.join(cwd, "hello.txt"), "utf8")
      assert.equal(file.trim(), "hello")

      const entries = await readdir(cwd)
      assert.equal(entries.includes(".git"), false, "snapshots:false must not create a .git")

      const models = await provider.listModels(cwd)
      const deepseek = models.find(
        (m) => m.providerID === "deepseek" && m.id === "deepseek-flash"
      )
      assert.ok(deepseek, "deepseek/deepseek-flash missing from the catalog")
      assert.equal(deepseek.enabled, true)

      // Resume the same session. This exercises the runtime session handle,
      // not a fresh conversation.
      const second: any[] = []
      for await (const msg of provider.runAgent({
        prompt: "What file did you just create? Reply in five words or fewer.",
        cwd,
        model: "deepseek/deepseek-flash",
        resumeSessionId: sessionId,
        permissionMode: "bypassPermissions",
        settingSources: [],
      })) {
        second.push(msg)
      }

      const secondInit = second.find((m) => m.type === "system")
      assert.equal(secondInit.session_id, sessionId)
      const secondText = second
        .filter((m) => m.type === "assistant")
        .flatMap((m) => m.message.content)
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("")
      assert.match(secondText, /hello\.txt/i)
      assert.equal(second.at(-1).subtype, "success")
    } finally {
      await provider.close()
      await rm(root, { recursive: true, force: true })
      await rm(data, { recursive: true, force: true })
    }
  }
)
