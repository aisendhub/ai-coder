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
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { MessageParam } from "@anthropic-ai/sdk/resources"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { dirname, resolve, basename } from "node:path"
import { promises as fsp } from "node:fs"
import chokidar from "chokidar"
import { EventEmitter } from "node:events"
import { createClient } from "@supabase/supabase-js"

const execFileP = promisify(execFile)

// Default working dir for legacy conversations (project.cwd = '.').
const WORKSPACE_DIR = resolve(process.env.WORKSPACE_DIR ?? process.cwd())

// Everything the directory browser is allowed to traverse. Defaults to the
// parent of the install directory — typically where sibling repos live.
const PROJECTS_ROOT = resolve(
  process.env.PROJECTS_ROOT ?? dirname(process.cwd())
)

// Supabase admin client — service-role key bypasses RLS so the server can
// own all message persistence, regardless of which (or no) user is connected.
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null

if (!sb) console.warn("[warn] Supabase service-role not configured; persistence disabled")

// ─────────────────────────────────────────────────────────────────────────────
// Project cwd resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve a project cwd string to an absolute path.
 *  '.' (the backfill marker) falls back to WORKSPACE_DIR. */
function resolveProjectCwd(cwd: string): string {
  if (!cwd || cwd === ".") return WORKSPACE_DIR
  return resolve(cwd)
}

async function cwdForConversation(conversationId: string): Promise<string> {
  if (!sb) return WORKSPACE_DIR
  const { data: conv, error: convErr } = await sb
    .from("conversations")
    .select("project_id")
    .eq("id", conversationId)
    .single()
  if (convErr || !conv?.project_id) {
    console.warn("[cwd] no project_id for conv", conversationId, convErr?.message)
    return WORKSPACE_DIR
  }
  const { data: proj, error: projErr } = await sb
    .from("projects")
    .select("cwd")
    .eq("id", conv.project_id)
    .single()
  if (projErr || !proj?.cwd) {
    console.warn("[cwd] project lookup failed", conv.project_id, projErr?.message)
    return WORKSPACE_DIR
  }
  const resolved = resolveProjectCwd(proj.cwd)
  console.log("[cwd]", conversationId.slice(0, 8), "→", resolved)
  return resolved
}

// ─────────────────────────────────────────────────────────────────────────────
// File-system watcher (changes panel) — lazy, one per cwd
// ─────────────────────────────────────────────────────────────────────────────

type WatcherEntry = { bus: EventEmitter; watcher: ReturnType<typeof chokidar.watch> }
const watchers = new Map<string, WatcherEntry>()

function getWatcher(cwd: string): WatcherEntry {
  const existing = watchers.get(cwd)
  if (existing) return existing
  const bus = new EventEmitter()
  bus.setMaxListeners(100)
  const watcher = chokidar.watch(cwd, {
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
    debounce = setTimeout(() => bus.emit("changed", { path, at: Date.now() }), 200)
  }
  watcher.on("add", notify).on("change", notify).on("unlink", notify).on("addDir", notify).on("unlinkDir", notify)
  const entry = { bus, watcher }
  watchers.set(cwd, entry)
  return entry
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-conversation runner — agent loop is detached from the HTTP request
// ─────────────────────────────────────────────────────────────────────────────

type StreamEvent =
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; output: string }
  | { kind: "text"; text: string }

type Runner = {
  conversationId: string
  bus: EventEmitter
  done: boolean
  promise: Promise<void>
}

const runners = new Map<string, Runner>()
const PERSIST_INTERVAL_MS = 800

type AttachmentPayload = {
  filename: string
  mimeType: string
  sizeBytes: number
  base64: string
}

const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"]

async function startRunner(args: {
  conversationId: string
  prompt: string
  attachments?: AttachmentPayload[]
  resumeSessionId?: string
}): Promise<Runner> {
  const { conversationId, prompt, attachments, resumeSessionId } = args
  const bus = new EventEmitter()
  bus.setMaxListeners(50)
  const runner: Runner = {
    conversationId,
    bus,
    done: false,
    promise: Promise.resolve(),
  }
  runners.set(conversationId, runner)

  runner.promise = (async () => {
    const turnId = Math.random().toString(36).slice(2, 8)
    const log = (event: string, payload: Record<string, unknown> = {}) => {
      console.log(`[${turnId} conv=${conversationId.slice(0, 6)}] ${event}`, payload)
    }
    const cwd = await cwdForConversation(conversationId)
    log("turn.start", { prompt: prompt.slice(0, 80), resume: resumeSessionId, cwd })

    let assistantText = ""
    const assistantEvents: StreamEvent[] = []
    let assistantDbId: string | null = null
    let pendingFlush = false
    let lastFlushAt = 0

    const emit = (event: string, data: unknown) => {
      bus.emit("event", { event, data })
    }

    // Insert user + assistant placeholder rows up front so the UI can show
    // them immediately (and any reconnecting client sees them).
    if (sb) {
      try {
        const attachmentMeta = (attachments ?? []).map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
        }))
        await sb.from("messages").insert({
          conversation_id: conversationId,
          role: "user",
          text: prompt,
          events: [],
          attachments: attachmentMeta,
        })
        const { data } = await sb
          .from("messages")
          .insert({
            conversation_id: conversationId,
            role: "assistant",
            text: "",
            events: [],
          })
          .select("id")
          .single()
        assistantDbId = data?.id ?? null
        emit("assistant_row", { id: assistantDbId })
      } catch (err) {
        console.error("insert messages failed", err)
      }
    }

    const flushPersist = async (force = false) => {
      if (!sb || !assistantDbId) return
      const now = Date.now()
      if (!force && now - lastFlushAt < PERSIST_INTERVAL_MS) return
      if (pendingFlush) return
      pendingFlush = true
      lastFlushAt = now
      try {
        await sb
          .from("messages")
          .update({ text: assistantText, events: assistantEvents })
          .eq("id", assistantDbId)
      } catch (err) {
        console.error("flush update failed", err)
      } finally {
        pendingFlush = false
      }
    }

    try {
      // Build the prompt — either a plain string or an AsyncIterable with
      // structured content blocks when file attachments are present.
      let queryPrompt: string | AsyncIterable<SDKUserMessage> = prompt

      if (attachments && attachments.length > 0) {
        const contentBlocks: MessageParam["content"] = []

        for (const att of attachments) {
          if (SUPPORTED_IMAGE_TYPES.includes(att.mimeType)) {
            contentBlocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: att.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: att.base64,
              },
            })
          } else if (att.mimeType === "application/pdf") {
            // PDFs: use DocumentBlockParam with base64 source
            contentBlocks.push({
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: att.base64,
              },
              title: att.filename,
            } as never) // cast needed — agent SDK types lag behind API support
          } else {
            // Text-based files: decode base64 to text
            const textContent = Buffer.from(att.base64, "base64").toString("utf-8")
            contentBlocks.push({
              type: "text",
              text: `[File: ${att.filename}]\n${textContent}`,
            })
          }
        }

        // Add the user's text prompt
        if (prompt) {
          contentBlocks.push({ type: "text", text: prompt })
        }

        async function* singleMessage(): AsyncIterable<SDKUserMessage> {
          yield {
            type: "user",
            message: { role: "user", content: contentBlocks },
            parent_tool_use_id: null,
          }
        }
        queryPrompt = singleMessage()
      }

      const messages = query({
        prompt: queryPrompt,
        options: {
          resume: resumeSessionId,
          cwd,
          permissionMode: "bypassPermissions",
          settingSources: [],
          includePartialMessages: false,
        },
      })

      for await (const msg of messages) {
        if (msg.type === "system" && msg.subtype === "init") {
          log("session", { sessionId: msg.session_id })
          emit("session", { sessionId: msg.session_id, model: msg.model, cwd: msg.cwd })
          if (sb) {
            void sb
              .from("conversations")
              .update({ session_id: msg.session_id })
              .eq("id", conversationId)
              .then(({ error }) => {
                if (error) console.error("update session_id failed", error)
              })
          }
          continue
        }
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") {
              assistantText += block.text
              assistantEvents.push({ kind: "text", text: block.text })
              emit("text", { text: block.text })
            } else if (block.type === "thinking") {
              assistantEvents.push({ kind: "thinking", text: block.thinking })
              emit("thinking", { text: block.thinking })
            } else if (block.type === "tool_use") {
              const ev: StreamEvent = {
                kind: "tool_use",
                id: block.id,
                name: block.name,
                input: block.input,
              }
              assistantEvents.push(ev)
              emit("tool_use", ev)
            }
          }
          void flushPersist()
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
                      ? block.content.map((p) => (p.type === "text" ? p.text : "")).join("")
                      : ""
                const ev: StreamEvent = {
                  kind: "tool_result",
                  toolUseId: block.tool_use_id,
                  isError: Boolean(block.is_error),
                  output: output.slice(0, 4000),
                }
                assistantEvents.push(ev)
                emit("tool_result", ev)
              }
            }
            void flushPersist()
          }
          continue
        }
        if (msg.type === "result") {
          log("done", { durationMs: msg.duration_ms, turns: msg.num_turns })
          emit("done", { durationMs: msg.duration_ms, numTurns: msg.num_turns })
          break
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log("error", { message })
      assistantText += assistantText ? `\n⚠️ ${message}` : `⚠️ ${message}`
      emit("error", { message })
    } finally {
      await flushPersist(true)
      runner.done = true
      runners.delete(conversationId)
      emit("closed", {})
      bus.emit("closed")
    }
  })()

  return runner
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

const app = new Hono()

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    workspace: WORKSPACE_DIR,
    projectsRoot: PROJECTS_ROOT,
    runners: runners.size,
  })
)

// SSE for git changes — scoped to a conversation's project cwd.
app.get("/api/changes/stream", (c) => {
  return streamSSE(c, async (stream) => {
    const conversationId = c.req.query("conversationId")
    if (!conversationId) {
      await stream.writeSSE({ event: "ready", data: "{}" })
      await new Promise<void>((r) => stream.onAbort(r))
      return
    }
    const cwd = await cwdForConversation(conversationId)
    const { bus } = getWatcher(cwd)
    const onChanged = (data: { path: string; at: number }) => {
      void stream.writeSSE({ event: "changed", data: JSON.stringify(data) })
    }
    bus.on("changed", onChanged)
    await stream.writeSSE({ event: "ready", data: "{}" })
    const hb = setInterval(() => {
      void stream.writeSSE({ event: "ping", data: "{}" })
    }, 25_000)
    await new Promise<void>((resolveStream) => {
      stream.onAbort(() => {
        clearInterval(hb)
        bus.off("changed", onChanged)
        resolveStream()
      })
    })
  })
})

app.get("/api/changes", async (c) => {
  try {
    const conversationId = c.req.query("conversationId")
    if (!conversationId) {
      return c.json({ workspace: "", files: [], unpushedCount: 0, branch: "" })
    }
    const cwd = await cwdForConversation(conversationId)
    const { stdout: porcelain } = await execFileP(
      "git",
      ["status", "--porcelain=v1", "-z"],
      { cwd, maxBuffer: 5 * 1024 * 1024 }
    )
    const files = parsePorcelain(porcelain)
    const withDiffs = await Promise.all(
      files.map(async (f) => ({ ...f, diff: await fileDiff(cwd, f) }))
    )
    let unpushedCount = 0
    try {
      const { stdout } = await execFileP("git", ["rev-list", "--count", "@{u}..HEAD"], { cwd })
      unpushedCount = parseInt(stdout.trim(), 10) || 0
    } catch {
      // no upstream
    }
    let branch = ""
    try {
      const { stdout } = await execFileP("git", ["branch", "--show-current"], { cwd })
      branch = stdout.trim()
    } catch {
      // not a git repo or detached HEAD
    }
    return c.json({ workspace: cwd, files: withDiffs, unpushedCount, branch })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// Directory browser — lists subdirectories of `path`. Defaults to PROJECTS_ROOT
// but allows traversal anywhere the server process can read (single-tenant host).
app.get("/api/fs/list", async (c) => {
  try {
    const raw = c.req.query("path") ?? PROJECTS_ROOT
    const target = resolve(raw)
    const entries = await fsp.readdir(target, { withFileTypes: true })
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: resolve(target, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const parent = target === "/" ? null : dirname(target)
    return c.json({
      root: PROJECTS_ROOT,
      path: target,
      name: basename(target) || target,
      parent,
      dirs,
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
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
      oldPath = entries[i + 1]
      i += 1
    } else status = "modified"
    files.push({ path, status, oldPath })
  }
  return files
}

async function fileDiff(cwd: string, f: ChangedFile): Promise<string> {
  try {
    if (f.status === "untracked") {
      const { stdout } = await execFileP("cat", [f.path], {
        cwd,
        maxBuffer: 5 * 1024 * 1024,
      }).catch(() => ({ stdout: "" }))
      return stdout
    }
    const args =
      f.status === "renamed" && f.oldPath
        ? ["diff", "HEAD", "--", f.oldPath, f.path]
        : ["diff", "HEAD", "--", f.path]
    const { stdout } = await execFileP("git", args, {
      cwd,
      maxBuffer: 5 * 1024 * 1024,
    })
    return stdout
  } catch {
    return ""
  }
}

// Status of all running conversations (for live "running" badges in UI later)
app.get("/api/runners", (c) => {
  return c.json({
    runners: Array.from(runners.keys()),
  })
})

// Start a turn. Returns an SSE stream that subscribes to the runner's bus.
// Closing the request does NOT stop the runner.
app.post("/api/chat", async (c) => {
  const body = await c.req.json<{
    conversationId?: string
    prompt?: string
    attachments?: AttachmentPayload[]
    sessionId?: string
  }>()
  const conversationId = body.conversationId
  const prompt = body.prompt
  const attachments = body.attachments
  const sessionId = body.sessionId

  if (!conversationId || typeof conversationId !== "string") {
    return c.json({ error: "conversationId required" }, 400)
  }
  if (!prompt || typeof prompt !== "string") {
    return c.json({ error: "prompt required" }, 400)
  }

  let runner = runners.get(conversationId)
  if (runner && !runner.done) {
    // Wait for the active runner to finish instead of rejecting.
    await runner.promise.catch(() => {})
  }

  runner = await startRunner({
    conversationId,
    prompt,
    attachments,
    resumeSessionId: sessionId,
  })

  return streamSSE(c, async (stream) => {
    const onEvent = ({ event, data }: { event: string; data: unknown }) => {
      void stream.writeSSE({ event, data: JSON.stringify(data) })
    }
    runner.bus.on("event", onEvent)
    await new Promise<void>((resolveStream) => {
      const cleanup = () => {
        runner.bus.off("event", onEvent)
        resolveStream()
      }
      stream.onAbort(cleanup)
      runner.bus.once("closed", cleanup)
    })
  })
})

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist" }))
  app.get("*", serveStatic({ path: "./dist/index.html" }))
}

const port = Number(process.env.PORT ?? 3001)
const hostname = process.env.HOST ?? "127.0.0.1"
serve({ fetch: app.fetch, port, hostname }, ({ address, port }) => {
  console.log(`ai-coder backend listening on ${address}:${port}`)
})
