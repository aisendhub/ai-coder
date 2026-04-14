import "dotenv/config"

// Dev: use Claude Code subscription OAuth (via `claude /login`) — no API billing.
// Prod: let ANTHROPIC_API_KEY through so the CLI authenticates with paid API credits.
// The CLI prefers the env var when set, so unsetting it in dev forces OAuth.
if (process.env.NODE_ENV !== "production") {
  delete process.env.ANTHROPIC_API_KEY
}

import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve } from "node:path"
import chokidar from "chokidar"
import { EventEmitter } from "node:events"

const execFileP = promisify(execFile)

// Working directory for the agent (and for git status). Dev: local repo you
// point to; prod: swapped per-conversation to the E2B sandbox cwd.
const WORKSPACE_DIR = resolve(process.env.WORKSPACE_DIR ?? process.cwd())

// Filesystem watcher → emits "changed" events when any tracked file mutates.
const fsBus = new EventEmitter()
fsBus.setMaxListeners(100)

const watcher = chokidar.watch(WORKSPACE_DIR, {
  ignored: [
    /(^|[/\\])\.git([/\\]|$)/,
    /(^|[/\\])node_modules([/\\]|$)/,
    /(^|[/\\])dist([/\\]|$)/,
    /(^|[/\\])\.next([/\\]|$)/,
    /(^|[/\\])\.cache([/\\]|$)/,
  ],
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
})

let debounce: NodeJS.Timeout | null = null
const notify = (path: string) => {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    fsBus.emit("changed", { path, at: Date.now() })
  }, 200)
}
watcher.on("add", notify).on("change", notify).on("unlink", notify).on("addDir", notify).on("unlinkDir", notify)

const app = new Hono()

app.get("/api/health", (c) => c.json({ ok: true, workspace: WORKSPACE_DIR }))

// SSE stream that pings whenever a file in WORKSPACE_DIR changes.
// Frontend listens, then refetches /api/changes.
app.get("/api/changes/stream", (c) => {
  return streamSSE(c, async (stream) => {
    const onChanged = (data: { path: string; at: number }) => {
      void stream.writeSSE({ event: "changed", data: JSON.stringify(data) })
    }
    fsBus.on("changed", onChanged)
    // Initial ping so client refetches once on connect
    await stream.writeSSE({ event: "ready", data: "{}" })
    // Heartbeat to keep proxies happy
    const hb = setInterval(() => {
      void stream.writeSSE({ event: "ping", data: "{}" })
    }, 25_000)
    await new Promise<void>((resolveStream) => {
      stream.onAbort(() => {
        clearInterval(hb)
        fsBus.off("changed", onChanged)
        resolveStream()
      })
    })
  })
})

// Parsed git status + diff for the current workspace.
// Returns: { workspace, files: [{ path, status, diff, oldPath? }] }
app.get("/api/changes", async (c) => {
  try {
    const { stdout: porcelain } = await execFileP(
      "git",
      ["status", "--porcelain=v1", "-z"],
      { cwd: WORKSPACE_DIR, maxBuffer: 5 * 1024 * 1024 }
    )
    const files = parsePorcelain(porcelain)

    const withDiffs = await Promise.all(
      files.map(async (f) => {
        const diff = await fileDiff(f)
        return { ...f, diff }
      })
    )

    return c.json({ workspace: WORKSPACE_DIR, files: withDiffs })
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500
    )
  }
})

type ChangedFile = {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "untracked"
  oldPath?: string
}

function parsePorcelain(z: string): ChangedFile[] {
  const files: ChangedFile[] = []
  const entries = z.split("\0").filter(Boolean)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const xy = entry.slice(0, 2)
    const path = entry.slice(3)
    const code = xy.trim()
    let status: ChangedFile["status"]
    let oldPath: string | undefined
    if (code === "??") status = "untracked"
    else if (code.startsWith("A")) status = "added"
    else if (code.startsWith("D") || xy[1] === "D") status = "deleted"
    else if (code.startsWith("R")) {
      status = "renamed"
      // For renames the "from" path follows in the next entry (NUL-separated)
      oldPath = entries[i + 1]
      i += 1
    } else status = "modified"
    files.push({ path, status, oldPath })
  }
  return files
}

async function fileDiff(f: ChangedFile): Promise<string> {
  try {
    if (f.status === "untracked") {
      // Synthesize a diff-like blob so the viewer can render it
      const { stdout } = await execFileP("cat", [f.path], {
        cwd: WORKSPACE_DIR,
        maxBuffer: 5 * 1024 * 1024,
      }).catch(() => ({ stdout: "" }))
      return stdout
    }
    const args =
      f.status === "renamed" && f.oldPath
        ? ["diff", "HEAD", "--", f.oldPath, f.path]
        : ["diff", "HEAD", "--", f.path]
    const { stdout } = await execFileP("git", args, {
      cwd: WORKSPACE_DIR,
      maxBuffer: 5 * 1024 * 1024,
    })
    return stdout
  } catch {
    return ""
  }
}

app.post("/api/chat", async (c) => {
  const body = await c.req.json<{ prompt?: string; sessionId?: string }>()
  const prompt = body.prompt
  const sessionId = body.sessionId

  if (!prompt || typeof prompt !== "string") {
    return c.json({ error: "prompt required" }, 400)
  }

  const turnId = Math.random().toString(36).slice(2, 8)
  const log = (event: string, payload: Record<string, unknown> = {}) => {
    console.log(`[${turnId}] ${event}`, payload)
  }
  log("turn.start", { prompt: prompt.slice(0, 80), resume: sessionId })

  return streamSSE(c, async (stream) => {
    const send = async (event: string, data: unknown) => {
      await stream.writeSSE({ event, data: JSON.stringify(data) })
    }

    try {
      const messages = query({
        prompt,
        options: {
          resume: sessionId,
          cwd: WORKSPACE_DIR,
          permissionMode: "bypassPermissions",
          settingSources: [],
          includePartialMessages: false,
        },
      })

      for await (const msg of messages) {
        if (msg.type === "system" && msg.subtype === "init") {
          log("session", { sessionId: msg.session_id, model: msg.model })
          await send("session", {
            sessionId: msg.session_id,
            model: msg.model,
            cwd: msg.cwd,
          })
          continue
        }

        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") {
              log("text", { len: block.text.length })
              await send("text", { text: block.text })
            } else if (block.type === "thinking") {
              log("thinking", { len: block.thinking.length })
              await send("thinking", { text: block.thinking })
            } else if (block.type === "tool_use") {
              log("tool_use", { name: block.name, id: block.id })
              await send("tool_use", {
                id: block.id,
                name: block.name,
                input: block.input,
              })
            }
          }
          continue
        }

        if (msg.type === "user") {
          const content = msg.message.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === "object" && block && "type" in block && block.type === "tool_result") {
                const output =
                  typeof block.content === "string"
                    ? block.content
                    : Array.isArray(block.content)
                      ? block.content
                          .map((p) => (p.type === "text" ? p.text : ""))
                          .join("")
                      : ""
                log("tool_result", {
                  id: block.tool_use_id,
                  isError: block.is_error,
                  len: output.length,
                })
                await send("tool_result", {
                  toolUseId: block.tool_use_id,
                  isError: Boolean(block.is_error),
                  output: output.slice(0, 4000),
                })
              }
            }
          }
          continue
        }

        if (msg.type === "result") {
          log("done", {
            durationMs: msg.duration_ms,
            turns: msg.num_turns,
            subtype: msg.subtype,
          })
          await send("done", {
            durationMs: msg.duration_ms,
            numTurns: msg.num_turns,
            subtype: msg.subtype,
            usage: msg.usage,
          })
          break
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log("error", { message })
      await send("error", { message })
    }
  })
})

// Serve the built Vite app in production (single-origin deploy).
if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist" }))
  app.get("*", serveStatic({ path: "./dist/index.html" }))
}

const port = Number(process.env.PORT ?? 3001)
serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`ai-coder backend listening on :${port}`)
})
