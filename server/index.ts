import "dotenv/config"

// Force Claude Code subscription OAuth (via `claude /login`) instead of API billing.
// If ANTHROPIC_API_KEY is set, the CLI prefers it and bills API credits.
delete process.env.ANTHROPIC_API_KEY

import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { serve } from "@hono/node-server"
import { query } from "@anthropic-ai/claude-agent-sdk"

const app = new Hono()

app.get("/api/health", (c) => c.json({ ok: true }))

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

const port = Number(process.env.PORT ?? 3001)
serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`ai-coder backend listening on :${port}`)
})
