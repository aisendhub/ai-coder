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
import * as pty from "node-pty"
import { WebSocketServer } from "ws"
import {
  addWorktree,
  branchNameFor,
  buildMergePrompt,
  detectDefaultBaseRef,
  isGitRepo,
  listWorktrees,
  logWorktreeEvent,
  pruneWorktreeMetadata,
  removeWorktree,
  repairSymlinks,
  worktreePathFor,
} from "./worktrees"
import {
  feedbackHash,
  runEvaluator,
  summarizeTools,
  type EvaluatorResult,
} from "./agent-loop"
import {
  detect as detectManifest,
  mergeManifest,
  startService,
  stopService,
  getService,
  listServices,
  subscribeLogs,
  removeService,
  listRunners,
  getRunnersInfo,
  RuntimeError,
  type ManifestOverride,
  type RunnerId,
} from "./runtime/index.ts"

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
    .select("project_id, worktree_path")
    .eq("id", conversationId)
    .single()
  if (convErr || !conv?.project_id) {
    console.warn("[cwd] no project_id for conv", conversationId, convErr?.message)
    return WORKSPACE_DIR
  }
  // Per-conversation worktree wins when set; falls back to the project cwd.
  if (conv.worktree_path) {
    const resolved = resolve(conv.worktree_path)
    console.log("[cwd]", conversationId.slice(0, 8), "→", resolved, "(worktree)")
    return resolved
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
// Loop state — evaluator-optimizer orchestrator reads/writes these
// ─────────────────────────────────────────────────────────────────────────────

type LoopState = {
  autoLoopEnabled: boolean
  autoLoopGoal: string | null
  loopIteration: number
  loopCostUsd: number
  maxIterations: number
  maxCostUsd: number
}

async function loadLoopState(conversationId: string): Promise<LoopState | null> {
  if (!sb) return null
  const { data, error } = await sb
    .from("conversations")
    .select("auto_loop_enabled, auto_loop_goal, loop_iteration, loop_cost_usd, max_iterations, max_cost_usd")
    .eq("id", conversationId)
    .single()
  if (error || !data) {
    if (error) console.warn("[loop] load failed", conversationId.slice(0, 8), error.message)
    return null
  }
  return {
    autoLoopEnabled: Boolean(data.auto_loop_enabled),
    autoLoopGoal: data.auto_loop_goal ?? null,
    loopIteration: Number(data.loop_iteration ?? 0),
    loopCostUsd: Number(data.loop_cost_usd ?? 0),
    maxIterations: Number(data.max_iterations ?? 5),
    maxCostUsd: Number(data.max_cost_usd ?? 1),
  }
}

async function persistLoopState(
  conversationId: string,
  iteration: number,
  costUsd: number
): Promise<void> {
  if (!sb) return
  const { error } = await sb
    .from("conversations")
    .update({ loop_iteration: iteration, loop_cost_usd: costUsd })
    .eq("id", conversationId)
  if (error) console.warn("[loop] persist failed", conversationId.slice(0, 8), error.message)
}

// Returns the combined text of any pending user nudges (delivered_at IS NULL)
// after marking them delivered. Returns null if there are none. Called from
// `canUseTool` (early boundary) and at end-of-turn (safety net).
async function flushPendingNudges(conversationId: string): Promise<string | null> {
  if (!sb) return null
  const { data, error } = await sb
    .from("messages")
    .select("id, text")
    .eq("conversation_id", conversationId)
    .eq("role", "user")
    .is("delivered_at", null)
    .order("created_at", { ascending: true })
  if (error) {
    console.warn("[nudge] fetch failed", error.message)
    return null
  }
  if (!data || data.length === 0) return null
  const ids = data.map((r) => r.id as string)
  const { error: upErr } = await sb
    .from("messages")
    .update({ delivered_at: new Date().toISOString() })
    .in("id", ids)
  if (upErr) console.warn("[nudge] mark-delivered failed", upErr.message)
  // Multiple nudges: present as separate paragraphs so the agent reads them in
  // order. The LLM treats these as the user's combined steering message.
  return data.map((r) => (r.text as string).trim()).filter(Boolean).join("\n\n")
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
  abort: AbortController
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

/** Builds text appended to Claude Code's default system prompt so the worker
 *  knows where it's running. Critical for tasks: without it, Claude
 *  occasionally guesses placeholder paths like /Users/user/ when asked to
 *  create a file with a bare name, hits EACCES, then recovers via `pwd`. */
function buildSystemPromptAppend(input: {
  cwd: string
  kind: string | null
  branch: string | null
  baseRef: string | null
  worktreePath: string | null
}): string {
  const isTaskWorktree = input.kind === "task" && !!input.worktreePath
  if (!isTaskWorktree) {
    // Chats: one short line to prevent placeholder-path hallucinations.
    return [
      `You are working in: ${input.cwd}`,
      `Use relative paths (e.g. "./src/foo.ts") or absolute paths inside the cwd. Never invent placeholder absolute paths like "/Users/user/...".`,
    ].join("\n")
  }
  const lines = [
    "You are running an autonomous task in an isolated git worktree.",
    "",
    `- Working directory (cwd): ${input.cwd}`,
    `- Branch: ${input.branch ?? "(unknown)"}`,
    `- Base ref: ${input.baseRef ?? "(unknown)"}`,
    "",
    "Rules for file paths:",
    `- ALWAYS write files inside the cwd above. Use relative paths (e.g. "./test.txt") or absolute paths starting with "${input.cwd}".`,
    `- NEVER invent placeholder absolute paths like "/Users/user/" or "/home/user/" — they will fail with permission errors. If unsure, run "pwd" first.`,
    "",
    "Rules for git:",
    "- You're on a dedicated branch. Commit freely; the orchestrator will merge or open a PR when the user ships the task.",
    "- Do not switch branches or run `git worktree` commands — this worktree is managed by the host.",
  ]
  return lines.join("\n")
}

async function startRunner(args: {
  conversationId: string
  prompt: string
  attachments?: AttachmentPayload[]
  resumeSessionId?: string
  /** When true, skip inserting the user message row for the FIRST iteration —
   *  the caller already wrote it (e.g. nudge sweep on /api/chat). */
  skipFirstUserInsert?: boolean
  /** Force a specific cwd for the agent, ignoring conversations.worktree_path.
   *  Used by the merge flow: the agent runs in the base checkout so it can
   *  `git worktree remove <worktreePath>` without killing its own cwd. */
  cwdOverride?: string
  /** When true, run exactly one iteration and break, regardless of the
   *  auto-loop flag. Used by the merge flow. */
  oneShot?: boolean
  /** When set, replaces the default system-prompt append. Used by the merge
   *  flow so the agent sees merge-specific context instead of the task rules
   *  that say "don't run git worktree commands". */
  systemPromptOverride?: string
  /** When set, the inserted row uses this shorter text (and `displayRole`)
   *  for the UI, while the agent still sees the full `prompt` via query().
   *  Used by the merge flow so the chat shows a concise notice instead of
   *  a wall of numbered steps. */
  displayText?: string
  /** Role to use for the inserted row. Defaults to 'user'. The merge flow
   *  passes 'notice' so the row renders as an app-generated badge. */
  displayRole?: "user" | "notice"
}): Promise<Runner> {
  const { conversationId, prompt, attachments, resumeSessionId } = args
  const skipFirstUserInsert = args.skipFirstUserInsert ?? false
  const oneShot = args.oneShot ?? false
  const displayTextOverride = args.displayText ?? null
  const displayRole = args.displayRole ?? "user"
  const bus = new EventEmitter()
  bus.setMaxListeners(50)
  const abort = new AbortController()
  const runner: Runner = {
    conversationId,
    bus,
    done: false,
    promise: Promise.resolve(),
    abort,
  }
  runners.set(conversationId, runner)

  runner.promise = (async () => {
    const turnId = Math.random().toString(36).slice(2, 8)
    const log = (event: string, payload: Record<string, unknown> = {}) => {
      console.log(`[${turnId} conv=${conversationId.slice(0, 6)}] ${event}`, payload)
    }
    const cwd = args.cwdOverride ?? (await cwdForConversation(conversationId))

    // Pull worktree metadata once so the worker's system-prompt append can
    // tell the agent where it's working. Keeps Claude from guessing
    // placeholder paths like /Users/user/ for underspecified filenames.
    let convMeta: { kind: string | null; branch: string | null; base_ref: string | null; worktree_path: string | null } = {
      kind: null, branch: null, base_ref: null, worktree_path: null,
    }
    if (sb) {
      const { data } = await sb
        .from("conversations")
        .select("kind, branch, base_ref, worktree_path")
        .eq("id", conversationId)
        .single()
      if (data) convMeta = data as typeof convMeta
    }
    const systemPromptAppend = args.systemPromptOverride ?? buildSystemPromptAppend({
      cwd,
      kind: convMeta.kind,
      branch: convMeta.branch,
      baseRef: convMeta.base_ref,
      worktreePath: convMeta.worktree_path,
    })

    log("turn.start", { prompt: prompt.slice(0, 80), resume: resumeSessionId, cwd })

    const emit = (event: string, data: unknown) => {
      bus.emit("event", { event, data })
    }

    // ── Loop state (evaluator-optimizer) ────────────────────────────────────
    // Shared across iterations. The worker turn runs once per iteration; the
    // evaluator fires between iterations with a fresh session + read-only
    // tools. Stop conditions live here, not in the prompt.
    let loopState = await loadLoopState(conversationId)
    let currentPrompt = prompt
    let currentResume = resumeSessionId
    let iterationAttachments = attachments
    let prevFeedbackHash: string | null = null
    let iterationIndex = 0
    let erroredThisTurn = false
    // If the FIRST iteration's user row was already inserted by the caller
    // (nudge sweep on /api/chat), don't write a duplicate. Subsequent
    // iterations always need their own row (auto-loop nextSteps; nudge
    // re-entry handles its skip via the same flag flipped per iteration).
    let skipUserInsertThisIteration = skipFirstUserInsert

    try {
      while (true) {
        iterationIndex += 1
        const isFirstIteration = iterationIndex === 1
        erroredThisTurn = false

        // Per-iteration state. The flushPersist closure captures these by
        // reference so it always writes the current iteration's transcript.
        let assistantText = ""
        const assistantEvents: StreamEvent[] = []
        let assistantDbId: string | null = null
        let pendingFlush = false
        let lastFlushAt = 0
        let workerCostUsd = 0
        let workerSessionId: string | null = currentResume ?? null
        // Set by the canUseTool callback (or end-of-turn safety net) when a
        // user nudge has been flushed. Triggers immediate re-entry below.
        let nudgeInterruptText: string | null = null

        // Insert user + assistant placeholder rows up front so the UI can show
        // them immediately (and any reconnecting client sees them). Skip the
        // user row when the caller already wrote it (nudge-flush sweep, or
        // nudge interrupt re-entry where the row was inserted via
        // /api/messages/nudge and just got marked delivered).
        if (sb) {
          try {
            if (!skipUserInsertThisIteration) {
              const attachmentMeta = (iterationAttachments ?? []).map((a) => ({
                filename: a.filename,
                mimeType: a.mimeType,
                sizeBytes: a.sizeBytes,
              }))
              // First iteration of a merge (or future service-driven turn)
              // writes a shorter display row with role='notice' so the chat
              // shows a centered badge, not a wall of scripted text. The
              // agent still sees the full prompt via query() below.
              const useNotice =
                isFirstIteration && displayTextOverride !== null
              await sb.from("messages").insert({
                conversation_id: conversationId,
                role: useNotice ? displayRole : "user",
                text: useNotice ? displayTextOverride : currentPrompt,
                events: [],
                attachments: useNotice ? [] : attachmentMeta,
                // First-class delivery: this prompt is being handed to the
                // agent right now, so the row never sits in the queue.
                delivered_at: new Date().toISOString(),
              })
            }
            const { data } = await sb
              .from("messages")
              .insert({
                conversation_id: conversationId,
                role: "assistant",
                text: "",
                events: [],
                delivered_at: new Date().toISOString(),
              })
              .select("id")
              .single()
            assistantDbId = data?.id ?? null
            emit("assistant_row", { id: assistantDbId })
          } catch (err) {
            console.error("insert messages failed", err)
          }
        }
        // Reset for the next iteration; nudge interrupts opt back in below.
        skipUserInsertThisIteration = false

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
          // structured content blocks when file attachments are present. Only
          // the first iteration honors attachments; subsequent loop turns are
          // driven by the evaluator's text-only nextSteps.
          let queryPrompt: string | AsyncIterable<SDKUserMessage> = currentPrompt

          if (isFirstIteration && iterationAttachments && iterationAttachments.length > 0) {
            const contentBlocks: MessageParam["content"] = []

            for (const att of iterationAttachments) {
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

            if (currentPrompt) {
              contentBlocks.push({ type: "text", text: currentPrompt })
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
              resume: currentResume,
              cwd,
              permissionMode: "bypassPermissions",
              settingSources: [],
              includePartialMessages: false,
              abortController: abort,
              systemPrompt: {
                type: "preset",
                preset: "claude_code",
                append: systemPromptAppend,
              },
              // Earliest natural injection boundary. Before each tool runs we
              // sweep any pending nudges; if there are any, deny the tool and
              // interrupt the turn so we can re-enter with the nudge as the
              // next prompt. See docs/WORKTREES.md § Mid-turn nudges.
              canUseTool: async () => {
                const flushed = await flushPendingNudges(conversationId)
                if (flushed) {
                  nudgeInterruptText = flushed
                  emit("nudge_flushed", { iteration: iterationIndex })
                  return {
                    behavior: "deny",
                    message: "User nudged the agent — re-entering with new instructions.",
                    interrupt: true,
                  }
                }
                return { behavior: "allow" }
              },
            },
          })

          for await (const msg of messages) {
            if (msg.type === "system" && msg.subtype === "init") {
              workerSessionId = msg.session_id
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
              workerCostUsd = Number(msg.total_cost_usd ?? 0)
              log("done", { durationMs: msg.duration_ms, turns: msg.num_turns, costUsd: workerCostUsd })
              emit("done", { durationMs: msg.duration_ms, numTurns: msg.num_turns })
              break
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log("error", { message })
          assistantText += assistantText ? `\n⚠️ ${message}` : `⚠️ ${message}`
          emit("error", { message })
          erroredThisTurn = true
        } finally {
          await flushPersist(true)
        }

        // ── Nudge interrupt: highest priority re-entry ─────────────────────
        // If the canUseTool callback set this OR the end-of-turn safety net
        // catches a nudge that arrived after the last tool call, re-enter
        // immediately with the combined nudge text as the next prompt. The
        // user row(s) are already in the DB and already marked delivered, so
        // skip the user-insert on re-entry.
        if (!nudgeInterruptText && !erroredThisTurn) {
          nudgeInterruptText = await flushPendingNudges(conversationId)
          if (nudgeInterruptText) emit("nudge_flushed", { iteration: iterationIndex, lateBoundary: true })
        }
        if (nudgeInterruptText) {
          currentPrompt = nudgeInterruptText
          currentResume = workerSessionId ?? undefined
          iterationAttachments = undefined
          skipUserInsertThisIteration = true
          continue
        }

        // ── Decide whether to iterate ─────────────────────────────────────
        // One-shot runs (e.g. the merge flow) break here unconditionally.
        if (oneShot) break
        // Refresh loop state at each boundary so UI edits to limits or goal
        // take effect on the next iteration without restarting.
        loopState = await loadLoopState(conversationId)
        const shouldLoop =
          !erroredThisTurn &&
          !abort.signal.aborted &&
          loopState?.autoLoopEnabled === true &&
          !!loopState.autoLoopGoal
        if (!shouldLoop) break

        const nextIteration = loopState.loopIteration + 1
        const runningCostUsd = loopState.loopCostUsd + workerCostUsd

        // Hard stops that the evaluator cannot override.
        if (nextIteration > loopState.maxIterations) {
          emit("auto_loop_stopped", { reason: "max_iterations", iteration: nextIteration - 1, costUsd: runningCostUsd })
          log("loop.stop", { reason: "max_iterations" })
          await persistLoopState(conversationId, loopState.loopIteration, runningCostUsd)
          break
        }
        if (runningCostUsd >= loopState.maxCostUsd) {
          emit("auto_loop_stopped", { reason: "max_cost", iteration: loopState.loopIteration, costUsd: runningCostUsd })
          log("loop.stop", { reason: "max_cost" })
          await persistLoopState(conversationId, loopState.loopIteration, runningCostUsd)
          break
        }

        // Fire the evaluator — fresh session, read-only tools, same cwd so it
        // can Read/Glob/Grep the files the worker just edited.
        emit("auto_loop_evaluating", { iteration: nextIteration })
        const evalResult: EvaluatorResult = await runEvaluator({
          goal: loopState.autoLoopGoal ?? "",
          lastAssistantText: assistantText,
          toolsUsed: summarizeTools(assistantEvents),
          cwd,
          abort,
        })
        const totalCostUsd = runningCostUsd + evalResult.costUsd
        log("loop.eval", { status: evalResult.status, costUsd: evalResult.costUsd })

        emit("auto_loop_iteration", {
          iteration: nextIteration,
          maxIterations: loopState.maxIterations,
          status: evalResult.status,
          feedback: evalResult.feedback,
          nextSteps: evalResult.nextSteps,
          costUsd: totalCostUsd,
        })
        await persistLoopState(conversationId, nextIteration, totalCostUsd)

        if (evalResult.status !== "continue" || !evalResult.nextSteps.trim()) {
          emit("auto_loop_stopped", {
            reason: evalResult.status === "done" ? "done" : "evaluator_stop",
            iteration: nextIteration,
            costUsd: totalCostUsd,
          })
          break
        }

        const hash = feedbackHash(evalResult.feedback)
        if (hash === prevFeedbackHash) {
          emit("auto_loop_stopped", { reason: "no_progress", iteration: nextIteration, costUsd: totalCostUsd })
          log("loop.stop", { reason: "no_progress" })
          break
        }
        prevFeedbackHash = hash

        // Prepare next worker turn. Session resumes to keep the worker's own
        // context intact; only the evaluator runs stateless.
        currentPrompt = evalResult.nextSteps
        currentResume = workerSessionId ?? undefined
        iterationAttachments = undefined
        loopState = {
          ...loopState,
          loopIteration: nextIteration,
          loopCostUsd: totalCostUsd,
        }
      }
    } finally {
      // Merge reconcile: if this conversation had a merge requested and the
      // worktree directory is now missing on disk, the agent completed the
      // merge — clear worktree fields and mark shipped. If the directory
      // still exists, the merge either didn't finish or stopped for user
      // input; leave state alone so the UI keeps showing the "merging" pill.
      await reconcileMergeIfCompleted(conversationId).catch((err) => {
        console.error("merge reconcile failed", err)
      })
      runner.done = true
      // Only clear the map slot if it still points at US — otherwise a newer
      // runner (e.g. merge aborting this one) has taken our place.
      if (runners.get(conversationId) === runner) {
        runners.delete(conversationId)
      }
      emit("closed", {})
      bus.emit("closed")
    }
  })()

  return runner
}

async function reconcileMergeIfCompleted(conversationId: string): Promise<void> {
  if (!sb) return
  const { data: conv } = await sb
    .from("conversations")
    .select("merge_requested_at, worktree_path, shipped_at, branch, base_ref")
    .eq("id", conversationId)
    .single()
  if (!conv?.merge_requested_at) return
  if (conv.shipped_at) return
  if (!conv.worktree_path) return
  let worktreeExists = true
  try {
    await fsp.stat(conv.worktree_path)
  } catch {
    worktreeExists = false
  }
  if (worktreeExists) return
  await sb
    .from("conversations")
    .update({
      shipped_at: new Date().toISOString(),
      worktree_path: null,
      branch: null,
      base_ref: null,
    })
    .eq("id", conversationId)
  logWorktreeEvent("merge.reconciled", {
    conv: conversationId.slice(0, 8),
    branch: conv.branch,
    baseRef: conv.base_ref,
  })
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

// Read the working-tree content of a file scoped to a conversation's project cwd.
// Used by the file panel to render the full file with a diff gutter overlay.
app.get("/api/changes/file", async (c) => {
  try {
    const conversationId = c.req.query("conversationId")
    const path = c.req.query("path")
    if (!conversationId || !path) {
      return c.json({ error: "conversationId and path required" }, 400)
    }
    const cwd = await cwdForConversation(conversationId)
    const abs = resolve(cwd, path)
    // Sandbox: never serve files outside the project cwd.
    if (!abs.startsWith(cwd + "/") && abs !== cwd) {
      return c.json({ error: "path escapes project root" }, 400)
    }
    const stat = await fsp.stat(abs)
    const MAX_BYTES = 1_000_000 // 1 MB
    if (stat.size > MAX_BYTES) {
      const fh = await fsp.open(abs, "r")
      try {
        const buf = Buffer.alloc(MAX_BYTES)
        await fh.read(buf, 0, MAX_BYTES, 0)
        return c.json({
          path,
          content: buf.toString("utf8"),
          truncated: true,
          sizeBytes: stat.size,
        })
      } finally {
        await fh.close()
      }
    }
    const content = await fsp.readFile(abs, "utf8")
    return c.json({ path, content, truncated: false, sizeBytes: stat.size })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === "ENOENT") return c.json({ error: "file not found" }, 404)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.get("/api/changes", async (c) => {
  try {
    const conversationId = c.req.query("conversationId")
    if (!conversationId) {
      return c.json({ workspace: "", files: [], unpushedCount: 0, branch: "" })
    }
    const cwd = await cwdForConversation(conversationId)
    // Worktree-backed conversations (tasks) show *everything that would ship*:
    // committed-ahead-of-base + staged + uncommitted + untracked, all diffed
    // against base_ref. Chats show only uncommitted (today's behavior).
    let baseRef: string | null = null
    if (sb) {
      const { data } = await sb
        .from("conversations")
        .select("worktree_path, base_ref")
        .eq("id", conversationId)
        .single()
      if (data?.worktree_path && data.base_ref) baseRef = data.base_ref
    }

    const files = baseRef
      ? await listChangesSinceRef(cwd, baseRef)
      : parsePorcelain(
          (await execFileP("git", ["status", "--porcelain=v1", "-z"], {
            cwd, maxBuffer: 5 * 1024 * 1024,
          })).stdout
        )
    const withDiffs = await Promise.all(
      files.map(async (f) => ({ ...f, diff: await fileDiff(cwd, f, baseRef) }))
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
    return c.json({ workspace: cwd, files: withDiffs, unpushedCount, branch, baseRef })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// For worktree-backed conversations: union of
//   1. `git diff --name-status <baseRef>` — committed + staged + modified
//   2. `git ls-files --others --exclude-standard` — untracked (diff doesn't see these)
// Yields one ChangedFile per real path. Renames are collapsed into a single
// entry with oldPath populated.
async function listChangesSinceRef(cwd: string, baseRef: string): Promise<ChangedFile[]> {
  const files = new Map<string, ChangedFile>()

  try {
    const { stdout } = await execFileP(
      "git",
      ["diff", "--name-status", "-z", baseRef, "--"],
      { cwd, maxBuffer: 5 * 1024 * 1024 }
    )
    // Format: "M\0<path>\0" or "R<score>\0<oldPath>\0<newPath>\0"
    const parts = stdout.split("\0").filter(Boolean)
    let i = 0
    while (i < parts.length) {
      const code = parts[i]
      if (code.startsWith("R")) {
        const oldPath = parts[i + 1]
        const newPath = parts[i + 2]
        files.set(newPath, { path: newPath, status: "renamed", oldPath })
        i += 3
        continue
      }
      const path = parts[i + 1]
      const letter = code[0]
      let status: ChangedFile["status"] = "modified"
      if (letter === "A") status = "added"
      else if (letter === "D") status = "deleted"
      files.set(path, { path, status })
      i += 2
    }
  } catch {
    // Fall through — list will be empty if diff failed.
  }

  try {
    const { stdout } = await execFileP(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd, maxBuffer: 5 * 1024 * 1024 }
    )
    for (const path of stdout.split("\0").filter(Boolean)) {
      if (!files.has(path)) files.set(path, { path, status: "untracked" })
    }
  } catch {
    // ignore — untracked list optional
  }

  return Array.from(files.values())
}

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

async function fileDiff(cwd: string, f: ChangedFile, baseRef: string | null = null): Promise<string> {
  try {
    if (f.status === "untracked") {
      const { stdout } = await execFileP("cat", [f.path], {
        cwd,
        maxBuffer: 5 * 1024 * 1024,
      }).catch(() => ({ stdout: "" }))
      return stdout
    }
    // Worktree (task): diff against base_ref so committed-ahead-of-base
    // changes show up. Shared cwd (chat): diff against HEAD (uncommitted only).
    const left = baseRef ?? "HEAD"
    const args =
      f.status === "renamed" && f.oldPath
        ? ["diff", left, "--", f.oldPath, f.path]
        : ["diff", left, "--", f.path]
    const { stdout } = await execFileP("git", args, {
      cwd,
      maxBuffer: 5 * 1024 * 1024,
    })
    return stdout
  } catch {
    return ""
  }
}

// Create a project. Captures default_base_ref from git HEAD if the cwd is a
// git repo, which is used later as the base for per-conversation worktrees.
// Falls back to worktree_mode = "shared" automatically for non-git dirs.
app.post("/api/projects", async (c) => {
  if (!sb) return c.json({ error: "persistence disabled" }, 503)
  const body = await c.req.json<{
    userId?: string
    name?: string
    cwd?: string
    worktreeMode?: "shared" | "per_conversation"
  }>().catch(() => ({}))
  const { userId, name, cwd } = body
  if (!userId) return c.json({ error: "userId required" }, 400)
  if (!name) return c.json({ error: "name required" }, 400)
  if (!cwd) return c.json({ error: "cwd required" }, 400)

  const absCwd = resolve(cwd)
  const git = await isGitRepo(absCwd)
  // Non-git dirs can never be per-conversation. Respect user choice otherwise.
  const worktreeMode = git && body.worktreeMode === "per_conversation"
    ? "per_conversation"
    : "shared"
  const defaultBaseRef = git ? await detectDefaultBaseRef(absCwd) : null

  const { data, error } = await sb
    .from("projects")
    .insert({
      user_id: userId,
      name,
      cwd: absCwd,
      worktree_mode: worktreeMode,
      default_base_ref: defaultBaseRef,
    })
    .select()
    .single()
  if (error || !data) return c.json({ error: error?.message ?? "insert failed" }, 500)
  return c.json(data)
})

// Quick "is this path a git repo?" probe for the new-project dialog — lets
// the UI enable/disable the per-conversation worktree toggle accurately.
app.get("/api/fs/git-info", async (c) => {
  const path = c.req.query("path")
  if (!path) return c.json({ isGitRepo: false, defaultBaseRef: null })
  const absPath = resolve(path)
  const git = await isGitRepo(absPath)
  const defaultBaseRef = git ? await detectDefaultBaseRef(absPath) : null
  return c.json({ isGitRepo: git, defaultBaseRef })
})

// Create a conversation. For projects in per_conversation worktree mode,
// provision a worktree + branch on a git repo and store them on the row.
// Falls back to shared mode (no worktree) if the project isn't a git repo or
// if worktree creation fails — the conversation is always usable.
app.post("/api/conversations", async (c) => {
  if (!sb) return c.json({ error: "persistence disabled" }, 503)
  const body = await c.req.json<{
    userId?: string
    projectId?: string
    title?: string
    kind?: "chat" | "task"
    autoLoopGoal?: string | null
    maxIterations?: number
    maxCostUsd?: number
  }>().catch(() => ({}))
  const { userId, projectId } = body
  const kind: "chat" | "task" = body.kind === "task" ? "task" : "chat"
  const fallbackTitle = kind === "task" ? "New task" : "New chat"
  const title = body.title ?? fallbackTitle
  if (!userId) return c.json({ error: "userId required" }, 400)
  if (!projectId) return c.json({ error: "projectId required" }, 400)
  // Tasks are drafts at creation: goal optional, no worktree, no worker fire.
  // The empty-state form in the UI collects the goal/caps and calls
  // POST /api/conversations/:id/arm to provision the worktree and kick off
  // the first worker turn.

  const { data: project, error: projErr } = await sb
    .from("projects")
    .select("id, user_id, cwd, worktree_mode, default_base_ref")
    .eq("id", projectId)
    .single()
  if (projErr || !project) return c.json({ error: "project not found" }, 404)
  if (project.user_id !== userId) return c.json({ error: "forbidden" }, 403)

  const insertRow: Record<string, unknown> = {
    user_id: userId,
    project_id: projectId,
    title,
    kind,
  }
  if (kind === "task") {
    // Drafts start with the loop off; arm later via /arm. If a goal came
    // along (e.g. Spin off from chat), store it so the empty-state form
    // renders pre-filled.
    insertRow.auto_loop_enabled = false
    if (body.autoLoopGoal?.trim()) insertRow.auto_loop_goal = body.autoLoopGoal.trim()
    if (typeof body.maxIterations === "number") insertRow.max_iterations = body.maxIterations
    if (typeof body.maxCostUsd === "number") insertRow.max_cost_usd = body.maxCostUsd
  }

  const { data: conv, error: convErr } = await sb
    .from("conversations")
    .insert(insertRow)
    .select()
    .single()
  if (convErr || !conv) {
    return c.json({ error: convErr?.message ?? "insert failed" }, 500)
  }

  // Chats (and draft tasks) don't get a worktree. Tasks get theirs when
  // armed — see POST /api/conversations/:id/arm.
  return c.json(conv)
})

// Arm a draft task: persist the goal + caps, provision the worktree, and
// kick off the first worker turn. Called by the fresh-task empty-state form
// once the user types a goal and hits Start.
app.post("/api/conversations/:id/arm", async (c) => {
  if (!sb) return c.json({ error: "persistence disabled" }, 503)
  const conversationId = c.req.param("id")
  const body = await c.req.json<{
    goal?: string
    maxIterations?: number
    maxCostUsd?: number
  }>().catch(() => ({}))
  const goal = body.goal?.trim()
  if (!goal) return c.json({ error: "goal required" }, 400)

  const { data: conv, error: convErr } = await sb
    .from("conversations")
    .select("id, kind, project_id, title, worktree_path")
    .eq("id", conversationId)
    .single()
  if (convErr || !conv) return c.json({ error: "conversation not found" }, 404)
  if (conv.kind !== "task") return c.json({ error: "only tasks can be armed" }, 400)

  const { data: project } = await sb
    .from("projects")
    .select("cwd, worktree_mode, default_base_ref")
    .eq("id", conv.project_id)
    .single()
  if (!project) return c.json({ error: "project not found" }, 404)

  // Persist goal + caps up front. Worker turn fires below uses the live row.
  const updates: Record<string, unknown> = {
    auto_loop_enabled: true,
    auto_loop_goal: goal,
    // If the first line of the goal looks usable and the user hasn't picked
    // a custom title yet, upgrade the title so it's easier to find in the
    // sidebar/board.
  }
  if (typeof body.maxIterations === "number") updates.max_iterations = body.maxIterations
  if (typeof body.maxCostUsd === "number") updates.max_cost_usd = body.maxCostUsd
  if (conv.title === "New task") {
    const derived = goal.split("\n")[0].slice(0, 60).trim()
    if (derived) updates.title = derived
  }

  // Provision a worktree if the project cwd is a git repo and we don't
  // already have one (guards against double-arming). We don't gate on
  // project.worktree_mode anymore: tasks are the ship-able unit and always
  // benefit from their own branch. The column is preserved for manual
  // opt-out / future scheduling flags.
  const baseCwd = resolveProjectCwd(project.cwd)
  const wantWorktree = !conv.worktree_path
  const canWorktree = wantWorktree && (await isGitRepo(baseCwd))
  if (canWorktree) {
    const baseRef =
      project.default_base_ref ?? (await detectDefaultBaseRef(baseCwd)) ?? "main"
    const branch = branchNameFor((updates.title as string) ?? conv.title, conv.id)
    const worktreePath = worktreePathFor(conv.project_id, conv.id)
    try {
      await addWorktree({ baseCwd, worktreePath, branch, baseRef })
      updates.worktree_path = worktreePath
      updates.branch = branch
      updates.base_ref = baseRef
      logWorktreeEvent("arm", {
        conv: conv.id.slice(0, 8),
        branch,
        baseRef,
        path: worktreePath,
      })
    } catch (err) {
      logWorktreeEvent("create.failed", {
        conv: conv.id.slice(0, 8),
        phase: "arm",
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const { data: updated, error: updErr } = await sb
    .from("conversations")
    .update(updates)
    .eq("id", conversationId)
    .select()
    .single()
  if (updErr || !updated) {
    return c.json({ error: updErr?.message ?? "update failed" }, 500)
  }

  // Kick the first worker turn with the goal as the prompt. Don't await —
  // return immediately so the UI transitions fast; the SSE streams the rest.
  void startRunner({
    conversationId,
    prompt: goal,
    resumeSessionId: undefined,
  })

  return c.json(updated)
})

// Merge a task's worktree back into its base branch, AI-driven. The server
// does no git work itself — it records intent (merge_requested_at), builds a
// scripted prompt, and injects it as the next turn for the agent. The agent
// runs with cwd = baseCwd (not the worktree, which it will delete) and walks
// the numbered steps. On conflict or dirty base, the agent STOPs and the
// conversation becomes a normal back-and-forth until the user resolves it.
// See docs/MERGE-FLOW.md.
app.post("/api/conversations/:id/merge", async (c) => {
  if (!sb) return c.json({ error: "persistence disabled" }, 503)
  const conversationId = c.req.param("id")

  const { data: conv } = await sb
    .from("conversations")
    .select("id, title, kind, project_id, worktree_path, branch, base_ref, auto_loop_goal, session_id")
    .eq("id", conversationId)
    .single()
  if (!conv) return c.json({ error: "conversation not found" }, 404)
  if (conv.kind !== "task") {
    return c.json({ error: "only tasks can be merged" }, 400)
  }
  if (!conv.worktree_path || !conv.branch || !conv.base_ref) {
    return c.json({ error: "conversation has no worktree to merge" }, 400)
  }

  const { data: project } = await sb
    .from("projects")
    .select("cwd")
    .eq("id", conv.project_id)
    .single()
  if (!project) return c.json({ error: "project not found" }, 404)

  const baseCwd = resolveProjectCwd(project.cwd)
  const prompt = buildMergePrompt({
    worktreePath: conv.worktree_path,
    baseCwd,
    branch: conv.branch,
    baseRef: conv.base_ref,
    title: conv.title,
    goal: conv.auto_loop_goal,
  })

  // Record intent first so the UI can reflect the pending state even if the
  // runner takes a moment to start. shipped_at flipping is still what marks
  // success — merge_requested_at just means "we asked".
  await sb
    .from("conversations")
    .update({
      merge_requested_at: new Date().toISOString(),
      // Stop the evaluator loop from chasing the original goal after merge.
      // The user can resume a task by opening a new one if needed.
      auto_loop_enabled: false,
    })
    .eq("id", conversationId)
  logWorktreeEvent("merge.request", {
    conv: conversationId.slice(0, 8),
    branch: conv.branch,
    baseRef: conv.base_ref,
  })

  // If the task's runner is still in flight (auto-loop mid-iteration,
  // earlier chat still streaming), abort it so the merge can start now.
  // Waiting for it to finish could take minutes and confuses the UI. The
  // aborted runner's finally block removes it from the map; startRunner
  // will overwrite the map slot when it sets up the merge runner.
  const existing = runners.get(conversationId)
  if (existing && !existing.done) {
    existing.abort.abort()
    logWorktreeEvent("merge.request", {
      conv: conversationId.slice(0, 8),
      aborted_existing: true,
    })
  }
  // Fire the merge turn fresh (no resume) — the scripted prompt is
  // self-contained, and resuming a session that was created with
  // cwd=worktreePath against a new cwd=baseCwd has been flaky. The agent gets
  // all the context it needs from buildMergePrompt + buildMergeSystemPrompt.
  //
  // The chat sees a short `role: 'notice'` row (displayText). The agent sees
  // the full scripted prompt via query() — not via the DB row.
  console.log("[merge]", conversationId.slice(0, 8), "→ starting runner at cwd", baseCwd)
  void startRunner({
    conversationId,
    prompt,
    resumeSessionId: undefined,
    cwdOverride: baseCwd,
    oneShot: true,
    systemPromptOverride: buildMergeSystemPrompt({
      baseCwd,
      branch: conv.branch,
      baseRef: conv.base_ref,
      worktreePath: conv.worktree_path,
    }),
    displayText: buildMergeNoticeText({
      branch: conv.branch,
      baseRef: conv.base_ref,
    }),
    displayRole: "notice",
  })

  return c.json({ started: true })
})

function buildMergeNoticeText(input: { branch: string; baseRef: string }): string {
  return [
    `Merging **\`${input.branch}\`** into **\`${input.baseRef}\`**.`,
    "",
    "The agent will:",
    "- Commit any pending work on the branch",
    `- Squash-merge into \`${input.baseRef}\``,
    "- Remove the worktree and delete the branch",
    "",
    "If the base repo is dirty or there's a merge conflict, the agent will stop and ask you how to proceed.",
  ].join("\n")
}

function buildMergeSystemPrompt(input: {
  baseCwd: string
  worktreePath: string
  branch: string
  baseRef: string
}): string {
  return [
    "You are performing a merge operation for the host.",
    "",
    `- Working directory (cwd): ${input.baseCwd}`,
    `- Task worktree: ${input.worktreePath}`,
    `- Task branch: ${input.branch}`,
    `- Base branch: ${input.baseRef}`,
    "",
    "Use `git -C <path>` to direct commands at a specific repo path. Follow the numbered steps in the user message exactly. If any step reveals a problem (dirty base repo, branch mismatch, merge conflict), STOP immediately and describe the situation — do not attempt to fix it on your own unless the user asks.",
  ].join("\n")
}

// Quick probe used by the sidebar's delete confirm to warn before discarding
// a task whose worktree has uncommitted changes or whose branch has commits
// the remote doesn't know about. Worktree-less rows return all-zero.
app.get("/api/conversations/:id/discard-status", async (c) => {
  if (!sb) return c.json({ error: "persistence disabled" }, 503)
  const conversationId = c.req.param("id")
  const { data: conv } = await sb
    .from("conversations")
    .select("worktree_path, branch")
    .eq("id", conversationId)
    .single()
  if (!conv?.worktree_path) {
    return c.json({ uncommittedFiles: 0, unpushedCommits: 0, hasUpstream: true, hasWorktree: false })
  }

  let uncommittedFiles = 0
  let unpushedCommits = 0
  let hasUpstream = true
  try {
    const { stdout } = await execFileP(
      "git",
      ["status", "--porcelain"],
      { cwd: conv.worktree_path }
    )
    uncommittedFiles = stdout.split("\n").filter(Boolean).length
  } catch {
    // worktree path missing — treat as zero (reconcile will surface this)
  }
  try {
    const { stdout } = await execFileP(
      "git",
      ["rev-list", "--count", "@{u}..HEAD"],
      { cwd: conv.worktree_path }
    )
    unpushedCommits = parseInt(stdout.trim(), 10) || 0
  } catch {
    // No upstream configured — branch exists only locally. Count all commits
    // since base_ref as "unpushed" so the user is warned before discard.
    hasUpstream = false
    try {
      const { data: convFull } = await sb
        .from("conversations")
        .select("base_ref")
        .eq("id", conversationId)
        .single()
      if (convFull?.base_ref) {
        const { stdout } = await execFileP(
          "git",
          ["rev-list", "--count", `${convFull.base_ref}..HEAD`],
          { cwd: conv.worktree_path }
        )
        unpushedCommits = parseInt(stdout.trim(), 10) || 0
      }
    } catch {
      // give up — leave at 0
    }
  }
  return c.json({
    uncommittedFiles,
    unpushedCommits,
    hasUpstream,
    hasWorktree: true,
  })
})

// Soft-delete: flag the row; the reaper tears down the worktree + branch once
// the grace window expires. DELETE on the row itself is reserved for the
// reaper's hard cleanup.
app.delete("/api/conversations/:id", async (c) => {
  if (!sb) return c.json({ error: "persistence disabled" }, 503)
  const conversationId = c.req.param("id")
  const { data, error } = await sb
    .from("conversations")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", conversationId)
    .select()
    .single()
  if (error || !data) return c.json({ error: error?.message ?? "not found" }, 404)
  return c.json(data)
})

// Pause a task: flip auto_loop_enabled off. The loop checks this at each
// iteration boundary and will break cleanly after the current worker turn.
app.post("/api/conversations/:id/pause", async (c) => {
  if (!sb) return c.json({ error: "persistence disabled" }, 503)
  const conversationId = c.req.param("id")
  const { data, error } = await sb
    .from("conversations")
    .update({ auto_loop_enabled: false })
    .eq("id", conversationId)
    .select()
    .single()
  if (error || !data) return c.json({ error: error?.message ?? "not found" }, 404)
  return c.json(data)
})

// Resume a paused task: flip auto_loop_enabled back on AND kick a new worker
// turn with a generic "continue" prompt so the evaluator drives next steps.
// Worker session resumes via conversations.session_id, so context is intact.
app.post("/api/conversations/:id/resume", async (c) => {
  if (!sb) return c.json({ error: "persistence disabled" }, 503)
  const conversationId = c.req.param("id")
  const { data: conv, error } = await sb
    .from("conversations")
    .update({ auto_loop_enabled: true })
    .eq("id", conversationId)
    .select("id, session_id, auto_loop_goal")
    .single()
  if (error || !conv) return c.json({ error: error?.message ?? "not found" }, 404)

  // Don't stomp on an already-running turn.
  const existing = runners.get(conversationId)
  if (existing && !existing.done) return c.json({ started: false, reason: "already-running" })

  const prompt = conv.auto_loop_goal
    ? `Continuing the task. Goal: ${conv.auto_loop_goal}`
    : "Continuing the task."
  await startRunner({
    conversationId,
    prompt,
    resumeSessionId: conv.session_id ?? undefined,
  })
  return c.json({ started: true })
})

app.post("/api/conversations/:id/restore", async (c) => {
  if (!sb) return c.json({ error: "persistence disabled" }, 503)
  const conversationId = c.req.param("id")
  const { data, error } = await sb
    .from("conversations")
    .update({ deleted_at: null })
    .eq("id", conversationId)
    .select()
    .single()
  if (error || !data) return c.json({ error: error?.message ?? "not found" }, 404)
  return c.json(data)
})

// Insert a user message during an active turn. Stays `delivered_at = null`
// in the DB and shows a clock icon client-side. The runner's canUseTool
// callback flushes pending nudges at the next tool boundary, marks them
// delivered, and re-enters the turn with the combined nudge as the prompt.
//
// If no runner is currently active for this conversation, the message is
// inserted as immediately-delivered and a fresh runner is started — this
// covers the race where a user "nudges" right as the previous turn ended.
app.post("/api/messages/nudge", async (c) => {
  if (!sb) return c.json({ error: "persistence disabled" }, 503)
  const body = await c.req.json<{
    conversationId?: string
    text?: string
    attachments?: AttachmentPayload[]
  }>().catch(() => ({}))
  const conversationId = body.conversationId
  const text = body.text
  if (!conversationId) return c.json({ error: "conversationId required" }, 400)
  if (!text || !text.trim()) return c.json({ error: "text required" }, 400)

  const runner = runners.get(conversationId)
  const runnerActive = runner && !runner.done

  const attachmentMeta = (body.attachments ?? []).map((a) => ({
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
  }))

  const { data, error } = await sb
    .from("messages")
    .insert({
      conversation_id: conversationId,
      role: "user",
      text,
      events: [],
      attachments: attachmentMeta,
      // null while a turn is running → canUseTool sweeps it. now() when there's
      // no runner so it doesn't sit pending forever; the runner we kick below
      // already gets the prompt directly.
      delivered_at: runnerActive ? null : new Date().toISOString(),
    })
    .select()
    .single()
  if (error || !data) return c.json({ error: error?.message ?? "insert failed" }, 500)

  if (!runnerActive) {
    // No turn in flight — promote to a normal turn.
    const { data: conv } = await sb
      .from("conversations")
      .select("session_id")
      .eq("id", conversationId)
      .single()
    void startRunner({
      conversationId,
      prompt: text,
      attachments: body.attachments,
      resumeSessionId: conv?.session_id ?? undefined,
      // The user row above is already in the DB and marked delivered, so the
      // runner's first iteration must skip the duplicate insert.
      skipFirstUserInsert: true,
    })
    return c.json({ ...data, queued: false, started: true })
  }

  // Runner active: nudge sits pending; canUseTool will flush it.
  return c.json({ ...data, queued: true })
})

// Status of all running conversations (for live "running" badges in UI later)
app.get("/api/runners", (c) => {
  return c.json({
    runners: Array.from(runners.keys()),
  })
})

// Abort an in-flight runner for a conversation.
app.post("/api/chat/stop", async (c) => {
  const body = await c.req.json<{ conversationId?: string }>().catch(() => ({}))
  const conversationId = body.conversationId
  if (!conversationId) return c.json({ error: "conversationId required" }, 400)
  const runner = runners.get(conversationId)
  if (!runner || runner.done) return c.json({ stopped: false, reason: "no-runner" })
  runner.abort.abort()
  return c.json({ stopped: true })
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

  // Sweep any nudges the user posted between the previous turn ending and
  // this /api/chat call. Their rows already exist in `messages`; we mark them
  // delivered and prepend their text to this turn's prompt so Claude sees the
  // user's full thread.
  const pendingFlushed = await flushPendingNudges(conversationId)
  const effectivePrompt = pendingFlushed
    ? `${pendingFlushed}\n\n${prompt}`
    : prompt

  runner = await startRunner({
    conversationId,
    prompt: effectivePrompt,
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

// ─── Worktree reaper ─────────────────────────────────────────────────────────
// Conversations are soft-trashed via DELETE /api/conversations/:id (sets
// deleted_at). After GRACE_MS has passed, this tears down the worktree +
// branch and hard-deletes the row. Runs on boot and every REAPER_INTERVAL_MS.

const REAPER_GRACE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const REAPER_INTERVAL_MS = 60 * 60 * 1000 // hourly

async function reapTrashedConversations(): Promise<void> {
  if (!sb) return
  const threshold = new Date(Date.now() - REAPER_GRACE_MS).toISOString()
  const { data: rows, error } = await sb
    .from("conversations")
    .select("id, project_id, worktree_path, branch")
    .not("deleted_at", "is", null)
    .lt("deleted_at", threshold)
    .limit(100)
  if (error) {
    console.warn("[reaper] query failed:", error.message)
    return
  }
  if (!rows?.length) return
  console.log(`[reaper] hard-deleting ${rows.length} expired conversation(s)`)

  // Group by project so we only look up each project cwd once.
  const projectIds = Array.from(new Set(rows.map((r) => r.project_id).filter(Boolean)))
  const projectCwds = new Map<string, string>()
  if (projectIds.length) {
    const { data: projs } = await sb
      .from("projects")
      .select("id, cwd")
      .in("id", projectIds)
    for (const p of projs ?? []) projectCwds.set(p.id, resolveProjectCwd(p.cwd))
  }

  for (const row of rows) {
    try {
      if (row.worktree_path && row.project_id) {
        const baseCwd = projectCwds.get(row.project_id)
        if (baseCwd) {
          await removeWorktree({
            baseCwd,
            worktreePath: row.worktree_path,
            branch: row.branch,
            force: true,
          })
        }
      }
      await sb.from("conversations").delete().eq("id", row.id)
      logWorktreeEvent("reap.hard_delete", {
        conv: row.id.slice(0, 8),
        branch: row.branch ?? "",
      })
    } catch (err) {
      console.warn("[reaper] failed for", row.id.slice(0, 8), err instanceof Error ? err.message : err)
    }
  }
}

// Kick the reaper after a small delay so server startup logs stay clean, and
// again on an interval. Errors are swallowed — the next tick will retry.
setTimeout(() => { void reapTrashedConversations() }, 30_000)
setInterval(() => { void reapTrashedConversations() }, REAPER_INTERVAL_MS)

// ─── Local runtime: /api/services/* ─────────────────────────────────────────
// Spawns the user's app from a project or worktree cwd, captures logs,
// and lists/streams. See docs/RUNTIME.md; runner code lives in
// server/runtime/. Chat/agent code must not import runtime internals.

function runtimeErrorStatus(code: RuntimeError["code"]): 403 | 404 | 409 | 429 | 500 | 503 {
  switch (code) {
    case "user_cap_reached": return 429
    case "port_range_exhausted": return 503
    case "runner_unavailable": return 503
    case "not_found": return 404
    case "not_owner": return 403
    case "already_stopped": return 409
  }
}

type ManifestContext = {
  ok: true
  projectCwd: string
  effectiveCwd: string
  cachedProjectManifest: RunManifest | null
  override: ManifestOverride | null
  assignedPort: number | null
  conversationId: string | null
  worktreePath: string | null
}

async function loadManifestContext(
  userId: string,
  projectId: string,
  conversationId: string | undefined
): Promise<
  | ManifestContext
  | { ok: false; status: 403 | 404 | 503; error: string }
> {
  if (!sb) return { ok: false, status: 503, error: "persistence disabled" }
  const { data: project } = await sb
    .from("projects")
    .select("id, user_id, cwd, run_manifest")
    .eq("id", projectId)
    .single()
  if (!project) return { ok: false, status: 404, error: "project not found" }
  if (project.user_id !== userId) return { ok: false, status: 403, error: "forbidden" }

  const projectCwd = resolveProjectCwd(project.cwd)
  const cached = (project.run_manifest ?? null) as RunManifest | null

  if (!conversationId) {
    return {
      ok: true,
      projectCwd,
      effectiveCwd: projectCwd,
      cachedProjectManifest: cached,
      override: null,
      assignedPort: null,
      conversationId: null,
      worktreePath: null,
    }
  }

  const { data: conv } = await sb
    .from("conversations")
    .select("id, project_id, worktree_path, run_manifest_override, assigned_port")
    .eq("id", conversationId)
    .single()
  if (!conv || conv.project_id !== projectId) {
    return { ok: false, status: 404, error: "conversation not found" }
  }

  return {
    ok: true,
    projectCwd,
    effectiveCwd: conv.worktree_path ? resolve(conv.worktree_path) : projectCwd,
    cachedProjectManifest: cached,
    override: (conv.run_manifest_override ?? null) as ManifestOverride | null,
    assignedPort: (conv.assigned_port ?? null) as number | null,
    conversationId: conv.id as string,
    worktreePath: (conv.worktree_path ?? null) as string | null,
  }
}

// Whitelist the fields we're willing to persist into run_manifest / override.
// Keeps users (and future bugs) from stashing arbitrary JSON on a shared row.
function sanitizeManifest(raw: unknown): RunManifest | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (typeof r.start !== "string") return null
  const stack = typeof r.stack === "string" ? r.stack : "custom"
  const env = r.env && typeof r.env === "object" ? (r.env as Record<string, string>) : {}
  const out: RunManifest = {
    stack: stack as RunManifest["stack"],
    start: r.start,
    cwd: "", // server-side only; always re-anchored at start time
    env,
  }
  if (typeof r.build === "string") out.build = r.build
  if (typeof r.port === "number") out.port = r.port
  if (typeof r.dockerfile === "string") out.dockerfile = r.dockerfile
  if (
    r.healthcheck &&
    typeof r.healthcheck === "object" &&
    typeof (r.healthcheck as Record<string, unknown>).path === "string" &&
    typeof (r.healthcheck as Record<string, unknown>).timeoutMs === "number"
  ) {
    out.healthcheck = r.healthcheck as RunManifest["healthcheck"]
  }
  return out
}

function sanitizeOverride(raw: unknown): ManifestOverride | null {
  const full = sanitizeManifest({ ...(raw as object), start: (raw as { start?: string })?.start ?? "x" })
  if (!full) return null
  const out: ManifestOverride = {}
  const r = raw as Record<string, unknown>
  if (typeof r.stack === "string") out.stack = r.stack as RunManifest["stack"]
  if (typeof r.start === "string") out.start = r.start
  if (typeof r.build === "string") out.build = r.build
  if (typeof r.port === "number") out.port = r.port
  if (typeof r.dockerfile === "string") out.dockerfile = r.dockerfile
  if (r.env && typeof r.env === "object") out.env = r.env as Record<string, string>
  if (full.healthcheck) out.healthcheck = full.healthcheck
  return out
}

app.post("/api/services/start", async (c) => {
  const body = await c.req.json<{
    userId?: string
    projectId?: string
    conversationId?: string
    label?: string
    overrides?: ManifestOverride
    runnerId?: RunnerId
  }>().catch(() => ({}))
  const { userId, projectId, conversationId } = body
  if (!userId) return c.json({ error: "userId required" }, 400)
  if (!projectId) return c.json({ error: "projectId required" }, 400)

  const ctx = await loadManifestContext(userId, projectId, conversationId)
  if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status)

  // Prefer cached project manifest; fall back to on-the-fly detection. The
  // first-run UX caches the detected manifest via PUT /api/projects/:id/manifest
  // before calling start, so on well-behaved flows `cached` is always set.
  let base: RunManifest | null = ctx.cachedProjectManifest
  if (!base) {
    try {
      base = await detectManifest(ctx.effectiveCwd)
    } catch (err) {
      return c.json({ error: `detection failed: ${(err as Error).message}` }, 500)
    }
  }
  if (!base) {
    return c.json(
      {
        error: "no runnable manifest — project has no cached start command and detection found nothing",
        cwd: ctx.effectiveCwd,
      },
      422
    )
  }

  // Re-anchor cwd to the effective worktree. The stored manifest's cwd is
  // server-only and may be stale.
  let effective: RunManifest = { ...base, cwd: ctx.effectiveCwd }
  if (ctx.override) effective = mergeManifest(effective, ctx.override)
  if (body.overrides) effective = mergeManifest(effective, body.overrides)

  if (!effective.start || !effective.start.trim()) {
    return c.json(
      { error: "manifest has no start command — edit it before running", cwd: ctx.effectiveCwd },
      422
    )
  }

  try {
    const snap = await startService(
      effective,
      {
        ownerId: userId,
        projectId,
        worktreeId: conversationId ?? null,
        label: body.label ?? null,
      },
      { preferredPort: ctx.assignedPort, runnerId: body.runnerId }
    )
    // Persist assigned_port on the conversation so localhost:<port> stays
    // stable across restarts. Write what we actually bound to; if the
    // preferred port was taken, we picked a new one.
    if (conversationId && sb && ctx.assignedPort !== snap.port) {
      await sb
        .from("conversations")
        .update({ assigned_port: snap.port })
        .eq("id", conversationId)
    }
    return c.json(snap)
  } catch (err) {
    if (err instanceof RuntimeError) {
      return c.json({ error: err.message, code: err.code }, runtimeErrorStatus(err.code))
    }
    return c.json({ error: (err as Error).message }, 500)
  }
})

// Read the project's manifest state: what's cached (stored default), what
// detection currently proposes, and what would actually run. The UI calls
// this on Run-click when there's no cached row, to drive the confirm dialog.
app.get("/api/projects/:id/manifest", async (c) => {
  const projectId = c.req.param("id")
  const userId = c.req.query("userId")
  if (!userId) return c.json({ error: "userId required" }, 400)

  const ctx = await loadManifestContext(userId, projectId, undefined)
  if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status)

  let detected: RunManifest | null = null
  try {
    detected = await detectManifest(ctx.effectiveCwd)
  } catch {
    detected = null
  }

  return c.json({
    cached: ctx.cachedProjectManifest,
    detected,
    effective: ctx.cachedProjectManifest ?? detected,
    cwd: ctx.effectiveCwd,
  })
})

app.put("/api/projects/:id/manifest", async (c) => {
  const projectId = c.req.param("id")
  const body = await c.req.json<{ userId?: string; manifest?: unknown }>().catch(() => ({}))
  const { userId } = body
  if (!userId) return c.json({ error: "userId required" }, 400)
  if (!sb) return c.json({ error: "persistence disabled" }, 503)

  const manifest = sanitizeManifest(body.manifest)
  if (!manifest) return c.json({ error: "invalid manifest — need at least { start: string }" }, 400)

  const { data: project } = await sb
    .from("projects")
    .select("id, user_id")
    .eq("id", projectId)
    .single()
  if (!project) return c.json({ error: "project not found" }, 404)
  if (project.user_id !== userId) return c.json({ error: "forbidden" }, 403)

  const toStore: Record<string, unknown> = { ...manifest }
  delete toStore.cwd // never store cwd; always derived at run time

  const { error } = await sb
    .from("projects")
    .update({ run_manifest: toStore })
    .eq("id", projectId)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true, manifest: toStore })
})

app.delete("/api/projects/:id/manifest", async (c) => {
  const projectId = c.req.param("id")
  const userId = c.req.query("userId")
  if (!userId) return c.json({ error: "userId required" }, 400)
  if (!sb) return c.json({ error: "persistence disabled" }, 503)

  const { data: project } = await sb
    .from("projects")
    .select("id, user_id")
    .eq("id", projectId)
    .single()
  if (!project) return c.json({ error: "project not found" }, 404)
  if (project.user_id !== userId) return c.json({ error: "forbidden" }, 403)

  const { error } = await sb
    .from("projects")
    .update({ run_manifest: null })
    .eq("id", projectId)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})

app.get("/api/conversations/:id/manifest", async (c) => {
  const conversationId = c.req.param("id")
  const userId = c.req.query("userId")
  if (!userId) return c.json({ error: "userId required" }, 400)
  if (!sb) return c.json({ error: "persistence disabled" }, 503)

  const { data: conv } = await sb
    .from("conversations")
    .select("id, user_id, project_id, worktree_path, run_manifest_override, assigned_port")
    .eq("id", conversationId)
    .single()
  if (!conv) return c.json({ error: "conversation not found" }, 404)
  if (conv.user_id !== userId) return c.json({ error: "forbidden" }, 403)

  const ctx = await loadManifestContext(userId, conv.project_id as string, conversationId)
  if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status)

  let detected: RunManifest | null = null
  try {
    detected = await detectManifest(ctx.effectiveCwd)
  } catch {
    detected = null
  }

  const base = ctx.cachedProjectManifest ?? detected
  const effective = base
    ? (ctx.override ? mergeManifest({ ...base, cwd: ctx.effectiveCwd }, ctx.override) : { ...base, cwd: ctx.effectiveCwd })
    : null

  return c.json({
    projectCached: ctx.cachedProjectManifest,
    override: ctx.override,
    detected,
    effective,
    assignedPort: ctx.assignedPort,
    cwd: ctx.effectiveCwd,
  })
})

app.put("/api/conversations/:id/manifest-override", async (c) => {
  const conversationId = c.req.param("id")
  const body = await c.req.json<{ userId?: string; override?: unknown }>().catch(() => ({}))
  const { userId } = body
  if (!userId) return c.json({ error: "userId required" }, 400)
  if (!sb) return c.json({ error: "persistence disabled" }, 503)

  const override = sanitizeOverride(body.override)
  if (!override) return c.json({ error: "invalid override — need at least one manifest field" }, 400)

  const { data: conv } = await sb
    .from("conversations")
    .select("id, user_id")
    .eq("id", conversationId)
    .single()
  if (!conv) return c.json({ error: "conversation not found" }, 404)
  if (conv.user_id !== userId) return c.json({ error: "forbidden" }, 403)

  const { error } = await sb
    .from("conversations")
    .update({ run_manifest_override: override })
    .eq("id", conversationId)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true, override })
})

app.delete("/api/conversations/:id/manifest-override", async (c) => {
  const conversationId = c.req.param("id")
  const userId = c.req.query("userId")
  if (!userId) return c.json({ error: "userId required" }, 400)
  if (!sb) return c.json({ error: "persistence disabled" }, 503)

  const { data: conv } = await sb
    .from("conversations")
    .select("id, user_id")
    .eq("id", conversationId)
    .single()
  if (!conv) return c.json({ error: "conversation not found" }, 404)
  if (conv.user_id !== userId) return c.json({ error: "forbidden" }, 403)

  const { error } = await sb
    .from("conversations")
    .update({ run_manifest_override: null })
    .eq("id", conversationId)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})

app.post("/api/services/:id/stop", async (c) => {
  const id = c.req.param("id")
  const body = await c.req.json<{ userId?: string }>().catch(() => ({}))
  const userId = body.userId
  if (!userId) return c.json({ error: "userId required" }, 400)
  try {
    await stopService(id, userId)
    const snap = getService(id, userId)
    return c.json(snap ?? { id, status: "stopped" })
  } catch (err) {
    if (err instanceof RuntimeError) {
      return c.json({ error: err.message, code: err.code }, runtimeErrorStatus(err.code))
    }
    return c.json({ error: (err as Error).message }, 500)
  }
})

app.delete("/api/services/:id", async (c) => {
  const id = c.req.param("id")
  const userId = c.req.query("userId")
  if (!userId) return c.json({ error: "userId required" }, 400)
  const svc = getService(id, userId)
  if (!svc) return c.json({ error: "service not found" }, 404)
  if (svc.status === "running" || svc.status === "starting" || svc.status === "stopping") {
    try {
      await stopService(id, userId)
    } catch (err) {
      if (err instanceof RuntimeError && err.code !== "already_stopped") {
        return c.json({ error: err.message, code: err.code }, runtimeErrorStatus(err.code))
      }
    }
  }
  try {
    removeService(id, userId)
  } catch {
    // Still running after stop attempt — leave the row, client can retry.
  }
  return c.json({ ok: true })
})

// Which runners are registered and usable right now. UI calls this to decide
// whether to grey out "Docker" (and surface the install hint as a tooltip).
// Registered before the `/:id` route so Hono doesn't match "runners" as an id.
app.get("/api/services/runners", async (c) => {
  const runners = await getRunnersInfo()
  return c.json({ runners })
})

app.get("/api/services", (c) => {
  const userId = c.req.query("userId")
  if (!userId) return c.json({ error: "userId required" }, 400)
  const projectId = c.req.query("projectId") ?? undefined
  const conversationId = c.req.query("conversationId")
  const worktreeId =
    conversationId === "null" ? null : conversationId ?? undefined
  return c.json({
    services: listServices({ ownerId: userId, projectId, worktreeId }),
  })
})

app.get("/api/services/:id", (c) => {
  const id = c.req.param("id")
  const userId = c.req.query("userId")
  if (!userId) return c.json({ error: "userId required" }, 400)
  const snap = getService(id, userId)
  if (!snap) return c.json({ error: "service not found" }, 404)
  return c.json(snap)
})

app.get("/api/services/:id/logs", (c) => {
  const id = c.req.param("id")
  const userId = c.req.query("userId")
  if (!userId) return c.json({ error: "userId required" }, 400)
  const sub = subscribeLogs(id, userId)
  if (!sub) return c.json({ error: "service not found" }, 404)

  return streamSSE(c, async (stream) => {
    for (const line of sub.history) {
      await stream.writeSSE({ event: "log", data: JSON.stringify(line) })
    }
    const snap = getService(id, userId)
    if (snap) {
      await stream.writeSSE({ event: "status", data: JSON.stringify(snap) })
    }
    await new Promise<void>((resolveStream) => {
      const finish = () => {
        sub.unsubscribe()
        resolveStream()
      }
      sub.onLine((line) => {
        void stream.writeSSE({ event: "log", data: JSON.stringify(line) })
      })
      sub.onStatus((s) => {
        void stream.writeSSE({ event: "status", data: JSON.stringify(s) })
      })
      sub.onEnd(() => {
        void stream.writeSSE({ event: "end", data: "{}" })
        finish()
      })
      stream.onAbort(finish)
    })
  })
})

// ─── Worktree reconciliation ─────────────────────────────────────────────────
// Runs once at boot. Compares per-project `git worktree list` against the
// rows we have in `conversations.worktree_path` and logs three kinds of drift:
//   1. DB row points at a path that's no longer a worktree on disk
//   2. Worktree exists on disk but no DB row references it (orphan)
//   3. Symlinks (node_modules etc.) inside a tracked worktree are broken
// Repairs symlinks automatically. Orphans + missing rows are logged only —
// destruction is reserved for the soft-trash reaper. This is a safety net,
// not an enforcer.

async function reconcileWorktrees(): Promise<void> {
  if (!sb) return
  const { data: projects, error } = await sb
    .from("projects")
    .select("id, cwd")
  if (error || !projects?.length) return

  let scanned = 0
  let symlinksRepaired = 0
  let orphans = 0
  let orphansRemoved = 0
  let missingPaths = 0
  let pruned = 0

  for (const project of projects) {
    const baseCwd = resolveProjectCwd(project.cwd)
    if (!(await isGitRepo(baseCwd))) continue

    const onDisk = await listWorktrees(baseCwd)
    // The base cwd itself appears in `git worktree list` — drop it; we only
    // care about ai-coder/* branched worktrees.
    const aiCoderOnDisk = onDisk.filter(
      (w) => w.branch?.startsWith("ai-coder/")
    )

    // Pull BOTH live and trashed rows so we don't auto-remove a worktree the
    // user trashed but hasn't been reaped yet (7-day grace window).
    const { data: rows } = await sb
      .from("conversations")
      .select("id, worktree_path, branch, deleted_at")
      .eq("project_id", project.id)
      .not("worktree_path", "is", null)
    const dbByPath = new Map<string, { id: string; branch: string | null; deleted_at: string | null }>()
    for (const r of rows ?? []) {
      if (r.worktree_path) {
        dbByPath.set(r.worktree_path, {
          id: r.id,
          branch: r.branch,
          deleted_at: r.deleted_at,
        })
      }
    }
    const diskByPath = new Map(aiCoderOnDisk.map((w) => [w.path, w]))

    // Orphans: on disk, no DB row (live or trashed) references them. Safe to
    // auto-remove because the branch is within our `ai-coder/` namespace, the
    // path is under our worktrees root, and nothing in the DB points at it.
    // If the worktree has uncommitted changes, `git worktree remove` without
    // --force fails and we leave it alone (log only) so nothing is lost.
    for (const w of aiCoderOnDisk) {
      if (dbByPath.has(w.path)) continue
      orphans++
      const inOurRoot = w.path.includes(".ai-coder-worktrees/")
      const branchIsOurs = (w.branch ?? "").startsWith("ai-coder/")
      if (!inOurRoot || !branchIsOurs) {
        logWorktreeEvent("reconcile.orphan", {
          path: w.path,
          branch: w.branch ?? "",
          action: "skipped-outside-scope",
        })
        continue
      }
      try {
        await removeWorktree({
          baseCwd,
          worktreePath: w.path,
          branch: w.branch,
          force: false, // non-force so dirty worktrees survive
        })
        orphansRemoved++
        logWorktreeEvent("reconcile.auto_removed", {
          path: w.path,
          branch: w.branch ?? "",
        })
      } catch {
        logWorktreeEvent("reconcile.orphan", {
          path: w.path,
          branch: w.branch ?? "",
          action: "skipped-dirty",
        })
      }
    }

    // Missing-on-disk + symlink repair.
    for (const [path, row] of dbByPath) {
      // Don't scan trashed rows — the reaper will clean them up on schedule.
      if (row.deleted_at) continue
      scanned++
      if (!diskByPath.has(path)) {
        missingPaths++
        logWorktreeEvent("reconcile.missing", {
          conv: row.id.slice(0, 8),
          branch: row.branch ?? "",
          path,
        })
        continue
      }
      try {
        const repaired = await repairSymlinks(baseCwd, path)
        if (repaired > 0) symlinksRepaired += repaired
      } catch (err) {
        console.warn(`[reconcile] symlink repair failed for ${path}:`, err instanceof Error ? err.message : err)
      }
    }

    // After orphan/missing logging, prune git's internal bookkeeping so
    // `git worktree list` matches disk. Safe: metadata only.
    const prunedOutput = await pruneWorktreeMetadata(baseCwd)
    if (prunedOutput) {
      pruned += prunedOutput.split("\n").filter(Boolean).length
      logWorktreeEvent("prune", {
        project: project.id.slice(0, 8),
        entries: prunedOutput.split("\n").filter(Boolean).length,
      })
    }
  }

  if (scanned + orphans + missingPaths + symlinksRepaired + pruned > 0) {
    console.log(
      `[reconcile] scanned ${scanned} live worktrees; ${orphans} orphan(s) (${orphansRemoved} auto-removed), ` +
      `${missingPaths} missing on disk, ${symlinksRepaired} symlink(s) repaired, ${pruned} metadata entries pruned`
    )
  }
}

// Run once after startup logs settle. Idle thereafter — boot is the only
// trigger we need today.
setTimeout(() => { void reconcileWorktrees() }, 5_000)

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist" }))
  app.get("*", serveStatic({ path: "./dist/index.html" }))
}

const port = Number(process.env.PORT ?? 3001)
const hostname = process.env.HOST ?? "127.0.0.1"
const server = serve({ fetch: app.fetch, port, hostname }, ({ address, port }) => {
  console.log(`ai-coder backend listening on ${address}:${port}`)
})

// ── Terminal PTY over WebSocket ──────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true })

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`)
  if (url.pathname !== "/api/terminal") {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req)
  })
})

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`)
  const cwd = url.searchParams.get("cwd") || WORKSPACE_DIR
  const cols = parseInt(url.searchParams.get("cols") ?? "80", 10)
  const rows = parseInt(url.searchParams.get("rows") ?? "24", 10)
  const shell = process.env.SHELL || "/bin/bash"

  let term: pty.IPty
  try {
    term = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: process.env as Record<string, string>,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[terminal] pty.spawn failed:", message)
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[31m[terminal] failed to spawn shell: ${message}\x1b[0m\r\n`)
      ws.close()
    }
    return
  }

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data)
  })

  term.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close()
  })

  ws.on("message", (msg) => {
    const str = msg.toString()
    // Resize messages are JSON: {"type":"resize","cols":N,"rows":N}
    if (str.startsWith("{")) {
      try {
        const parsed = JSON.parse(str)
        if (parsed.type === "resize") {
          term.resize(parsed.cols, parsed.rows)
          return
        }
      } catch { /* not JSON, treat as input */ }
    }
    term.write(str)
  })

  ws.on("close", () => {
    try { term.kill() } catch { /* already exited */ }
  })
})
