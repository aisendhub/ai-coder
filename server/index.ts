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
import { getLlmProvider, type AgentUserMessage as SDKUserMessage } from "./llm/index.ts"
import {
  buildSystemPromptAppend,
  composeSystemPromptAppend,
  loadProjectAddendum,
} from "./llm/system-prompt.ts"
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
  detectManifestWithLLM,
  buildDetectServicesPrompt,
  buildDetectServicesSystemPrompt,
  buildDetectServicesNoticeText,
  extractDetectedManifest,
  extractDetectedServices,
  detectServicesWithLLM,
  buildVerifyRunPrompt,
  buildVerifyRunSystemPrompt,
  buildVerifyRunNoticeText,
  type VerifyRunSnapshot,
  type EvaluatorResult,
} from "./agent-loop"
import {
  detect as detectManifest,
  detectAllServices,
  mergeManifest,
  startService,
  stopService,
  stopServiceAndWait,
  getService,
  getLogHistory,
  listServices,
  subscribeLogs,
  removeService,
  registerExternalService,
  listRunners,
  getRunnersInfo,
  RuntimeError,
  type ManifestOverride,
  type RunnerId,
  type RunManifest,
} from "./runtime/index.ts"
import {
  insertServiceInstance,
  updateServiceInstanceStatus,
  listLiveServiceInstancesForHost,
} from "./instance-store.ts"
import {
  getProjectService,
  listProjectServices,
  upsertProjectService,
  deleteProjectService,
  patchProjectService,
  getConversationServiceOverride,
  setConversationServiceOverride,
  manifestFromRow,
  writeFromManifest,
  type ProjectServiceRow,
  type ProjectServiceWrite,
} from "./services-store.ts"
import { encryptToken, decryptToken } from "./integrations/crypto.ts"
import { fetchMe as railwayFetchMe, RailwayApiError } from "./integrations/railway.ts"

const execFileP = promisify(execFile)

// Default working dir for legacy conversations (project.cwd = '.').
const WORKSPACE_DIR = resolve(process.env.WORKSPACE_DIR ?? process.cwd())

// Everything the directory browser is allowed to traverse. Defaults to the
// parent of the install directory — typically where sibling repos live.
const PROJECTS_ROOT = resolve(
  process.env.PROJECTS_ROOT ?? dirname(process.cwd())
)

// Two Supabase clients:
//   sbSystem  — service-role key, BYPASSES RLS. Only for deliberate system
//     work: agent message persistence during a turn, boot reconcile, reaper,
//     lifecycle logs — code that runs outside a user HTTP request.
//   sbForUser(token) — anon key + user JWT. RLS applies. One is built per
//     authed request by the middleware and placed on the Hono context as
//     `sb`. Use it in route handlers for any user-visible data so ACL is
//     enforced at the DB layer, not in hand-rolled checks.
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
const sbSystem = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null

function sbForUser(accessToken: string) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

if (!sbSystem) console.warn("[warn] Supabase service-role not configured; persistence disabled")
if (!SUPABASE_ANON_KEY) console.warn("[warn] SUPABASE_ANON_KEY not set; user-scoped queries disabled")

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
  if (!sbSystem) return WORKSPACE_DIR
  const { data: conv, error: convErr } = await sbSystem
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
  const { data: proj, error: projErr } = await sbSystem
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
  if (!sbSystem) return null
  const { data, error } = await sbSystem
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
  if (!sbSystem) return
  const { error } = await sbSystem
    .from("conversations")
    .update({ loop_iteration: iteration, loop_cost_usd: costUsd })
    .eq("id", conversationId)
  if (error) console.warn("[loop] persist failed", conversationId.slice(0, 8), error.message)
}

// Returns the combined text of any pending user nudges (delivered_at IS NULL)
// after marking them delivered. Returns null if there are none. Called from
// `canUseTool` (early boundary) and at end-of-turn (safety net).
async function flushPendingNudges(conversationId: string): Promise<string | null> {
  if (!sbSystem) return null
  const { data, error } = await sbSystem
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
  const { error: upErr } = await sbSystem
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
  /** Client-generated id for the FIRST-iteration user message row, when the
   *  caller doesn't set `skipFirstUserInsert`. Lets the client's optimistic
   *  row upgrade by id match in applyInsert without role+text fuzzy matching.
   *  See docs/ARCHITECTURE-CLIENT-IDS.md. */
  firstUserMessageId?: string
  /** Client-generated id for the FIRST-iteration assistant placeholder row.
   *  Same purpose: deterministic optimistic→canonical upgrade. */
  firstAssistantMessageId?: string
}): Promise<Runner> {
  const { conversationId, prompt, attachments, resumeSessionId } = args
  const skipFirstUserInsert = args.skipFirstUserInsert ?? false
  const oneShot = args.oneShot ?? false
  const displayTextOverride = args.displayText ?? null
  const displayRole = args.displayRole ?? "user"
  const firstUserMessageId = args.firstUserMessageId
  const firstAssistantMessageId = args.firstAssistantMessageId
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
    if (sbSystem) {
      const { data } = await sbSystem
        .from("conversations")
        .select("kind, branch, base_ref, worktree_path")
        .eq("id", conversationId)
        .single()
      if (data) convMeta = data as typeof convMeta
    }
    const hostAppend = args.systemPromptOverride ?? buildSystemPromptAppend({
      cwd,
      kind: convMeta.kind,
      branch: convMeta.branch,
      baseRef: convMeta.base_ref,
      worktreePath: convMeta.worktree_path,
    })
    // Layer per-project instructions from `<cwd>/.ai-coder/instructions.md`
    // after the host append so they can refine (or override) generic rules.
    // See docs/SYSTEM-PROMPT.md for the layering model.
    const projectAddendum = await loadProjectAddendum(cwd)
    const systemPromptAppend = composeSystemPromptAppend(hostAppend, projectAddendum)

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
    // Hoisted so the outer finally's reconcile hooks (merge / detect-services)
    // can read the LAST iteration's assistant output after the while exits.
    // Gets reset at the top of each iteration.
    let assistantText = ""

    try {
      while (true) {
        iterationIndex += 1
        const isFirstIteration = iterationIndex === 1
        erroredThisTurn = false

        // Per-iteration state. The flushPersist closure captures these by
        // reference so it always writes the current iteration's transcript.
        assistantText = ""
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
        if (sbSystem) {
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
              // Client-provided id only applies to the first user-role insert
              // (not to server-authored notice rows). See
              // docs/ARCHITECTURE-CLIENT-IDS.md.
              const userRowId =
                isFirstIteration && !useNotice && firstUserMessageId
                  ? firstUserMessageId
                  : undefined
              await sbSystem.from("messages").insert({
                ...(userRowId ? { id: userRowId } : {}),
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
            // Client-provided assistant id only for the first iteration;
            // subsequent auto-loop iterations get server UUIDs because the
            // client isn't pre-creating optimistic placeholders for them.
            const assistantRowId =
              isFirstIteration && firstAssistantMessageId
                ? firstAssistantMessageId
                : undefined
            const { data } = await sbSystem
              .from("messages")
              .insert({
                ...(assistantRowId ? { id: assistantRowId } : {}),
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
          if (!sbSystem || !assistantDbId) return
          const now = Date.now()
          if (!force && now - lastFlushAt < PERSIST_INTERVAL_MS) return
          if (pendingFlush) return
          pendingFlush = true
          lastFlushAt = now
          try {
            await sbSystem
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

          const messages = getLlmProvider().runAgent({
            prompt: queryPrompt,
            resumeSessionId: currentResume,
            cwd,
            permissionMode: "bypassPermissions",
            // Load the user's project CLAUDE.md, skills, and `.claude/`
            // settings. Headless flows (evaluator, commit-msg,
            // detect-services) intentionally pass `[]` and stay isolated.
            // See docs/SYSTEM-PROMPT.md.
            settingSources: ["project"],
            abortController: abort,
            systemPrompt: {
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
          })

          for await (const msg of messages) {
            if (msg.type === "system" && msg.subtype === "init") {
              workerSessionId = msg.session_id
              log("session", { sessionId: msg.session_id })
              emit("session", { sessionId: msg.session_id, model: msg.model, cwd: msg.cwd })
              if (sbSystem) {
                void sbSystem
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
      // Services reconcile: if the assistant dropped a <run-manifest> block in
      // its reply (because a detect-services turn ran, or because the user
      // asked the agent to tweak the config), parse it and save. Idempotent —
      // runs on every turn; does nothing if no block is present.
      await reconcileDetectedServicesIfAny(conversationId, assistantText, emit).catch((err) => {
        console.error("services reconcile failed", err)
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

// Runs after every turn. We DO NOT auto-save anymore — the assistant's
// `<run-services>` / `<run-manifest>` block stays in the message text,
// and the client (see src/lib/agent-response-hooks.ts) parses it from
// the message text, opens the services panel, and presents the services
// as a pick-list. This keeps a single propose-then-approve flow for both
// heuristic + AI + chat-driven detection.
//
// What's left for the server to do: log parse failures so we notice when
// models drift off-spec, and emit an advisory SSE event so any client
// that's already open can react without waiting for Supabase realtime.
async function reconcileDetectedServicesIfAny(
  conversationId: string,
  assistantText: string,
  emit: (event: string, data: unknown) => void
): Promise<void> {
  const textLen = assistantText?.length ?? 0
  const hasMulti = typeof assistantText === "string" && assistantText.includes("<run-services")
  const hasSingle = typeof assistantText === "string" && assistantText.includes("<run-manifest")
  if (!hasMulti && !hasSingle) return

  const multi = hasMulti ? extractDetectedServices(assistantText) : null
  const single = !multi && hasSingle ? extractDetectedManifest(assistantText) : null

  if (!multi && !single) {
    console.warn(
      `[services.proposed] block present but parse failed ` +
      `(len=${textLen}, tail="${assistantText.slice(-200).replace(/\n/g, " ")}")`
    )
    return
  }

  const count = multi?.length ?? (single ? 1 : 0)
  console.log(
    `[services.proposed] assistant proposed ${count} service(s); auto-persisting`
  )

  // Auto-persist proposals into project_services so the panel doesn't force
  // the user to click Save N times. Persisted with enabled=false so nothing
  // auto-starts; the user reviews, optionally edits, and clicks Run when
  // ready (or deletes the row to dismiss). See SERVICES.md.
  let persisted = 0
  let persistFailed = 0
  if (sbSystem && conversationId) {
    try {
      const { data: conv } = await sbSystem
        .from("conversations")
        .select("project_id")
        .eq("id", conversationId)
        .single()
      const projectId = conv?.project_id as string | undefined
      if (projectId) {
        const candidates: Array<{ name: string; manifest: Partial<RunManifest>; order: number }> = []
        if (multi) {
          multi.forEach((p, i) => {
            // Drop proposals with no usable name or start command — saving
            // them would create dead rows the user can't run anyway.
            if (!p.name || !p.start) return
            candidates.push({
              name: p.name,
              manifest: p,
              order: typeof p.order_index === "number" ? p.order_index : i,
            })
          })
        } else if (single) {
          if (single.start) candidates.push({ name: "default", manifest: single, order: 0 })
        }

        for (const c of candidates) {
          try {
            // Don't clobber a service the user has already configured. The
            // upsert would overwrite their edits otherwise.
            const existing = await getProjectService(sbSystem, projectId, c.name)
            if (existing) continue
            const write: ProjectServiceWrite = {
              ...writeFromManifest(c.name, c.manifest),
              enabled: false,
              order_index: c.order,
            }
            await upsertProjectService(sbSystem, projectId, write)
            persisted++
          } catch (err) {
            persistFailed++
            console.warn(
              `[services.proposed] persist failed for "${c.name}":`,
              (err as Error).message
            )
          }
        }
      }
    } catch (err) {
      console.warn(
        "[services.proposed] auto-persist lookup failed:",
        (err as Error).message
      )
    }
  }

  emit("services.proposed", {
    count,
    multi: !!multi,
    persisted,
    persistFailed,
  })
}

async function reconcileMergeIfCompleted(conversationId: string): Promise<void> {
  if (!sbSystem) return
  const { data: conv } = await sbSystem
    .from("conversations")
    .select("merge_requested_at, worktree_path, shipped_at, branch, base_ref, project_id")
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

  // Capture the base-branch HEAD SHA so a later Revert knows where the merge
  // landed. Best-effort: if the base checkout is unreadable, ship anyway
  // with sha = null (Revert will then refuse with an actionable message).
  let shippedSha: string | null = null
  try {
    const { data: project } = await sbSystem
      .from("projects")
      .select("cwd")
      .eq("id", conv.project_id)
      .single()
    if (project?.cwd && conv.base_ref) {
      const baseCwd = resolveProjectCwd(project.cwd)
      const { stdout } = await execFileP(
        "git",
        ["rev-parse", `refs/heads/${conv.base_ref}`],
        { cwd: baseCwd }
      )
      shippedSha = stdout.trim() || null
    }
  } catch (err) {
    console.warn("[merge.reconciled] could not read shipped sha:", err)
  }

  await sbSystem
    .from("conversations")
    .update({
      shipped_at: new Date().toISOString(),
      shipped_commit_sha: shippedSha,
      worktree_path: null,
      // Keep branch + base_ref around for the Revert prompt; null them on
      // actual revert or when the task is trashed.
    })
    .eq("id", conversationId)
  logWorktreeEvent("merge.reconciled", {
    conv: conversationId.slice(0, 8),
    branch: conv.branch,
    baseRef: conv.base_ref,
    sha: shippedSha?.slice(0, 8) ?? "unknown",
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

type UserSb = NonNullable<ReturnType<typeof sbForUser>>
type AuthEnv = { Variables: { userId: string; sb: UserSb } }

const app = new Hono<AuthEnv>()

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    workspace: WORKSPACE_DIR,
    projectsRoot: PROJECTS_ROOT,
    runners: runners.size,
  })
)

// Require a valid Supabase JWT on every /api/* route except /api/health.
// Token can arrive as Authorization: Bearer <jwt> (preferred) or as
// ?access_token=<jwt> in the query string — the latter is the standard
// workaround for EventSource, which can't set request headers.
// JWT-in-URL leaks to access logs and browser history; Supabase access
// tokens are ~1h TTL so blast radius is small, but anything more sensitive
// should move to fetch-based SSE so it can use the header path.
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next()
  if (!sbSystem) return c.json({ error: "persistence disabled" }, 503)

  const auth = c.req.header("Authorization") ?? ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  const token = bearer || c.req.query("access_token") || ""
  if (!token) return c.json({ error: "unauthorized" }, 401)

  const { data, error } = await sbSystem.auth.getUser(token)
  if (error || !data.user) return c.json({ error: "unauthorized" }, 401)

  // User-scoped client forwards this JWT on every query, so Postgres sees
  // auth.uid() = user.id and RLS filters rows automatically. This is the
  // primary ACL layer — route handlers should use c.get("sb") for anything
  // user-visible and reserve sbSystem for deliberate cross-user work.
  const userSb = sbForUser(token)
  if (!userSb) return c.json({ error: "persistence disabled" }, 503)

  c.set("userId", data.user.id)
  c.set("sb", userSb)
  await next()
})

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
  const sb = c.get("sb")
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

// Batched diff summaries for the kanban board. One round-trip returns
// {filesChanged, additions, deletions} for every task that has a worktree
// and a base ref — running/review tasks. Backlog (no worktree), shipped
// (already merged), and trashed conversations are returned as null so the
// caller can skip rendering them.
//
// Body: { ids: string[] }  (max 100; UUIDs validated)
// Response: { summaries: { [id]: { filesChanged, additions, deletions } | null } }
app.post("/api/conversations/diff-summary", async (c) => {
  const sb = c.get("sb")
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({}))
  const rawIds = Array.isArray(body.ids) ? body.ids : []
  const ids = rawIds
    .filter((v): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v))
    .slice(0, 100)
  if (ids.length === 0) return c.json({ summaries: {} })

  // RLS filters to conversations the caller owns; non-owned ids drop out.
  const { data: convs } = await sb
    .from("conversations")
    .select("id, worktree_path, base_ref, shipped_at, deleted_at")
    .in("id", ids)
  if (!convs) return c.json({ summaries: {} })

  type Summary = { filesChanged: number; additions: number; deletions: number }
  const summaries: Record<string, Summary | null> = {}
  await Promise.all(
    convs.map(async (conv) => {
      summaries[conv.id] = null
      if (conv.shipped_at || conv.deleted_at) return
      if (!conv.worktree_path || !conv.base_ref) return
      summaries[conv.id] = await diffShortstat(conv.worktree_path, conv.base_ref)
    })
  )
  return c.json({ summaries })
})

// Recent commits for the conversation's cwd. Uses ASCII unit/record separators
// so we don't fight subject lines that contain arbitrary punctuation.
app.get("/api/git/log", async (c) => {
  try {
    const conversationId = c.req.query("conversationId")
    if (!conversationId) return c.json({ commits: [], branch: "" })
    const cwd = await cwdForConversation(conversationId)
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 500)
    const FS = "\x1f"
    const RS = "\x1e"
    const { stdout } = await execFileP(
      "git",
      ["log", `--pretty=format:%H${FS}%h${FS}%an${FS}%ae${FS}%ct${FS}%s${RS}`, "-n", String(limit)],
      { cwd, maxBuffer: 5 * 1024 * 1024 }
    )
    const commits = stdout
      .split(RS)
      .map((s) => s.replace(/^\n/, ""))
      .filter(Boolean)
      .map((line) => {
        const [sha, shortSha, authorName, authorEmail, committerTime, subject] = line.split(FS)
        return {
          sha,
          shortSha,
          authorName,
          authorEmail,
          committerTime: (parseInt(committerTime, 10) || 0) * 1000,
          subject: subject ?? "",
        }
      })
    let branch = ""
    try {
      const { stdout: b } = await execFileP("git", ["branch", "--show-current"], { cwd })
      branch = b.trim()
    } catch {
      // detached HEAD or not a git repo
    }
    return c.json({ commits, branch })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// Commit detail: subject + body + parents + per-file status & numstat. Used
// by the git-log expand-on-click view (see docs/GIT-LOG.md). Subject/body
// are returned for later phases — phase 1 only renders the file list.
app.get("/api/git/commit", async (c) => {
  try {
    const conversationId = c.req.query("conversationId")
    const sha = c.req.query("sha")
    if (!conversationId || !sha) {
      return c.json({ error: "conversationId and sha required" }, 400)
    }
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) {
      return c.json({ error: "invalid sha" }, 400)
    }
    const cwd = await cwdForConversation(conversationId)
    const FS = "\x1f"
    // %H sha · %h shortSha · %P parents · %an author · %ae email · %ct ctime · %s subject · %b body
    const { stdout: meta } = await execFileP(
      "git",
      ["show", "--no-patch", `--pretty=format:%H${FS}%h${FS}%P${FS}%an${FS}%ae${FS}%ct${FS}%s${FS}%b`, sha],
      { cwd, maxBuffer: 5 * 1024 * 1024 }
    )
    const [fullSha, shortSha, parentsRaw, authorName, authorEmail, ctime, subject, ...bodyParts] =
      meta.split(FS)
    const body = bodyParts.join(FS).replace(/\n+$/, "")
    const parents = parentsRaw ? parentsRaw.split(" ").filter(Boolean) : []

    // --raw gives us status AND file modes in one parse, which lets us flag
    // gitlink entries (mode 160000 = submodule pointers). Without this the
    // git-log file list would render submodules as regular files and clicking
    // them would 500 with `git show <sha>:<submodulePath>` failing because
    // the path resolves to a commit pointer, not a blob.
    type CommitFile = {
      path: string
      oldPath?: string
      status: "A" | "M" | "D" | "R" | "C" | "T"
      insertions: number
      deletions: number
      isBinary: boolean
      isSubmodule: boolean
      submoduleFromSha?: string
      submoduleToSha?: string
    }
    const files = new Map<string, CommitFile>()

    const { stdout: rawDiff } = await execFileP(
      "git",
      ["show", "--raw", "-z", "-M", "-C", "--pretty=format:", sha],
      { cwd, maxBuffer: 5 * 1024 * 1024 }
    )
    // Format with -z (single-parent commits):
    //   :<srcMode> <dstMode> <srcSha> <dstSha> <status>\0<path>\0
    // Renames/copies:
    //   :<srcMode> <dstMode> <srcSha> <dstSha> R<score>\0<oldPath>\0<newPath>\0
    // Combined diffs (merge commits) prefix with `::` and have extra columns;
    // we skip those — phase 1 doesn't render merge commits specially.
    const rawTokens = rawDiff.split("\0").filter((t) => t.length > 0)
    let i = 0
    while (i < rawTokens.length) {
      const meta = rawTokens[i]
      if (!meta.startsWith(":") || meta.startsWith("::")) {
        i++
        continue
      }
      const fields = meta.replace(/^:+/, "").split(" ").filter(Boolean)
      if (fields.length < 5) {
        i++
        continue
      }
      const [srcMode, dstMode, srcSha, dstSha, statusCode] = fields
      const letter = statusCode[0] as CommitFile["status"]
      // Submodule = gitlink mode on either side. Deleted submodules carry
      // mode on srcMode; added on dstMode; modified on both.
      const isSubmodule = srcMode === "160000" || dstMode === "160000"
      const submoduleFromSha = isSubmodule && srcSha !== "0".repeat(srcSha.length) ? srcSha : undefined
      const submoduleToSha = isSubmodule && dstSha !== "0".repeat(dstSha.length) ? dstSha : undefined
      if (letter === "R" || letter === "C") {
        const oldPath = rawTokens[i + 1]
        const newPath = rawTokens[i + 2]
        files.set(newPath, {
          path: newPath, oldPath, status: letter,
          insertions: 0, deletions: 0, isBinary: false,
          isSubmodule, submoduleFromSha, submoduleToSha,
        })
        i += 3
      } else {
        const path = rawTokens[i + 1]
        files.set(path, {
          path, status: letter,
          insertions: 0, deletions: 0, isBinary: false,
          isSubmodule, submoduleFromSha, submoduleToSha,
        })
        i += 2
      }
    }

    const { stdout: numstat } = await execFileP(
      "git",
      ["show", "--numstat", "-z", "--pretty=format:", sha],
      { cwd, maxBuffer: 5 * 1024 * 1024 }
    )
    // -z numstat format is `<add>\t<del>\t<path>\0` for normal files and
    // `<add>\t<del>\t\0<oldPath>\0<newPath>\0` for renames. Binary rows
    // report `-\t-\t…`.
    const tokens = numstat.split("\0")
    let j = 0
    while (j < tokens.length) {
      const row = tokens[j]
      if (!row) { j++; continue }
      const tabs = row.split("\t")
      if (tabs.length < 3) { j++; continue }
      const [addStr, delStr, maybePath] = tabs
      const isBinary = addStr === "-" && delStr === "-"
      const insertions = isBinary ? 0 : parseInt(addStr, 10) || 0
      const deletions = isBinary ? 0 : parseInt(delStr, 10) || 0
      let path = maybePath
      if (!path) {
        // rename: next two NUL-separated tokens are oldPath, newPath
        path = tokens[j + 2] ?? ""
        j += 3
      } else {
        j += 1
      }
      const existing = files.get(path)
      if (existing) {
        existing.insertions = insertions
        existing.deletions = deletions
        existing.isBinary = isBinary
      }
    }

    const totals = Array.from(files.values()).reduce(
      (acc, f) => ({
        insertions: acc.insertions + f.insertions,
        deletions: acc.deletions + f.deletions,
      }),
      { insertions: 0, deletions: 0 }
    )

    return c.json({
      sha: fullSha,
      shortSha,
      parents,
      authorName,
      authorEmail,
      committerTime: (parseInt(ctime, 10) || 0) * 1000,
      subject: subject ?? "",
      body,
      stats: { files: files.size, ...totals },
      files: Array.from(files.values()),
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// File content + diff at a specific commit. Used by the file panel in
// commit-pinned mode (clicking a file in the git-log expanded view). Same
// response shape as /api/changes/file plus a `diff` field, so the panel
// can swap fetch sources without restructuring its render path.
app.get("/api/git/show", async (c) => {
  try {
    const conversationId = c.req.query("conversationId")
    const sha = c.req.query("sha")
    const path = c.req.query("path")
    if (!conversationId || !sha || !path) {
      return c.json({ error: "conversationId, sha and path required" }, 400)
    }
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) {
      return c.json({ error: "invalid sha" }, 400)
    }
    const cwd = await cwdForConversation(conversationId)
    // Reject paths that would escape the cwd via sandbox check on the resolved
    // absolute. `git show` itself respects the repo, but the path string still
    // gets logged — keep parity with /api/changes/file.
    const abs = resolve(cwd, path)
    if (!abs.startsWith(cwd + "/") && abs !== cwd) {
      return c.json({ error: "path escapes project root" }, 400)
    }
    let content = ""
    let isBinary = false
    try {
      const { stdout } = await execFileP("git", ["show", `${sha}:${path}`], {
        cwd, maxBuffer: 5 * 1024 * 1024, encoding: "utf8",
      })
      content = stdout
    } catch (err) {
      // File didn't exist at this commit (e.g., deleted commits) — return
      // empty content with a marker. The panel renders the diff regardless.
      const msg = err instanceof Error ? err.message : String(err)
      if (!/does not exist|exists on disk/i.test(msg)) throw err
    }
    let diff = ""
    try {
      const { stdout } = await execFileP(
        "git",
        ["diff", `${sha}^!`, "--", path],
        { cwd, maxBuffer: 5 * 1024 * 1024 }
      )
      diff = stdout
    } catch {
      // Initial commit (no parent) — diff against the empty tree.
      try {
        const { stdout } = await execFileP(
          "git",
          ["diff", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha, "--", path],
          { cwd, maxBuffer: 5 * 1024 * 1024 }
        )
        diff = stdout
      } catch {
        diff = ""
      }
    }
    // Cheap binary heuristic — `git show` will already have warned if the
    // blob is binary, but we don't see that signal in stdout. Detect by NUL.
    if (content.includes("\0")) {
      isBinary = true
      content = ""
    }
    return c.json({
      sha,
      path,
      content,
      diff,
      truncated: false,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      isBinary,
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// `git blame` per-line authorship for the file panel's blame rail.
// Scoped to a conversation's cwd (worktree-aware via cwdForConversation).
// Response is cached in-memory keyed by (cwd, path); the chokidar watcher
// invalidates cache entries when the file changes. Uncommitted lines get
// isUncommitted=true (git reports all-zero SHA for working-tree changes).
// ─────────────────────────────────────────────────────────────────────────────

type BlameLine = {
  line: number
  sha: string
  shortSha: string
  author: string
  authorMail: string
  committerTime: number // ms since epoch
  summary: string
  isUncommitted: boolean
}
type BlameResult = { cwd: string; path: string; lines: BlameLine[] }

const BLAME_CACHE_MAX = 200
const blameCache = new Map<string, BlameResult>()
const blameWatchedCwds = new Set<string>()

function blameCacheKey(cwd: string, path: string): string {
  return `${cwd}\0${path}`
}

function invalidateBlameForCwd(cwd: string, relPath: string) {
  blameCache.delete(blameCacheKey(cwd, relPath))
}

// Subscribe the per-cwd watcher bus once, so "changed" events clear blame cache
// entries for the matching file. Idempotent — safe to call on every request.
function ensureBlameWatcher(cwd: string) {
  if (blameWatchedCwds.has(cwd)) return
  const { bus } = getWatcher(cwd)
  bus.on("changed", ({ path: changedPath }: { path: string; at: number }) => {
    // chokidar emits absolute paths; blame is keyed by path relative to cwd.
    const rel = changedPath.startsWith(cwd + "/") ? changedPath.slice(cwd.length + 1) : changedPath
    invalidateBlameForCwd(cwd, rel)
  })
  blameWatchedCwds.add(cwd)
}

function parseBlamePorcelain(stdout: string): BlameLine[] {
  // Porcelain format: each line produces a block starting with
  //   `<sha> <origLine> <finalLine> [<groupSize>]`
  // followed by optional header lines (author, author-mail, committer-time,
  // summary, etc.) and a final `\t<code content>` line. Subsequent blocks
  // from the same commit omit the header lines.
  const out: BlameLine[] = []
  const commits = new Map<
    string,
    { author: string; authorMail: string; committerTime: number; summary: string }
  >()
  const lines = stdout.split("\n")
  let i = 0
  while (i < lines.length) {
    const header = lines[i]
    if (!/^[0-9a-f]{40} /.test(header)) {
      i++
      continue
    }
    const [sha, , finalStr] = header.split(" ")
    const finalLine = parseInt(finalStr, 10)
    const isUncommitted = /^0{40}$/.test(sha)
    let author = commits.get(sha)?.author ?? ""
    let authorMail = commits.get(sha)?.authorMail ?? ""
    let committerTime = commits.get(sha)?.committerTime ?? 0
    let summary = commits.get(sha)?.summary ?? ""
    i++
    while (i < lines.length && !lines[i].startsWith("\t")) {
      const line = lines[i]
      if (line.startsWith("author ")) author = line.slice(7)
      else if (line.startsWith("author-mail ")) authorMail = line.slice(12).replace(/^<|>$/g, "")
      else if (line.startsWith("committer-time ")) committerTime = parseInt(line.slice(15), 10) * 1000
      else if (line.startsWith("summary ")) summary = line.slice(8)
      i++
    }
    // Skip the `\t<content>` line — we don't need content here.
    if (i < lines.length && lines[i].startsWith("\t")) i++
    if (!commits.has(sha) && !isUncommitted) {
      commits.set(sha, { author, authorMail, committerTime, summary })
    }
    out.push({
      line: finalLine,
      sha,
      shortSha: sha.slice(0, 7),
      author: isUncommitted ? "Not committed" : author,
      authorMail,
      committerTime,
      summary: isUncommitted ? "(uncommitted working tree)" : summary,
      isUncommitted,
    })
  }
  return out
}

app.get("/api/blame", async (c) => {
  try {
    const conversationId = c.req.query("conversationId")
    const path = c.req.query("path")
    if (!conversationId || !path) {
      return c.json({ error: "conversationId and path required" }, 400)
    }
    const cwd = await cwdForConversation(conversationId)
    ensureBlameWatcher(cwd)
    const key = blameCacheKey(cwd, path)
    const cached = blameCache.get(key)
    if (cached) return c.json(cached)

    const { stdout } = await execFileP(
      "git",
      ["blame", "--porcelain", "--", path],
      { cwd, maxBuffer: 20 * 1024 * 1024 }
    )
    const result: BlameResult = { cwd, path, lines: parseBlamePorcelain(stdout) }
    // Simple cap — delete oldest insertion when full (Map keeps insertion order).
    if (blameCache.size >= BLAME_CACHE_MAX) {
      const first = blameCache.keys().next().value
      if (first) blameCache.delete(first)
    }
    blameCache.set(key, result)
    return c.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // git blame fails for untracked/new files or non-git cwds — return empty.
    if (/not in a git repository|no such path|does not have any commits yet/i.test(msg)) {
      return c.json({ cwd: "", path: c.req.query("path") ?? "", lines: [] })
    }
    return c.json({ error: msg }, 500)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// File comments — line-anchored, per-project, snapshot+diff re-anchored.
// Scope: comments are owned by `projects.id`, but reads/writes both need a
// conversationId so we can read current file content from the conversation's
// cwd (task worktrees have their own content). See docs/FILE-ANNOTATIONS.md.
// ─────────────────────────────────────────────────────────────────────────────

type FileCommentRow = {
  id: string
  project_id: string
  file_path: string
  body: string
  status: "open" | "resolved" | "outdated"
  anchor_start_line: number
  anchor_block_length: number
  anchor_snapshot: string
  resolved_line: number | null
  resolved_at: string | null
  resolved_confidence: "exact" | "shifted" | "outdated" | null
  conversation_id: string | null
  message_id: string | null
  created_by: string
  created_at: string
  updated_at: string
}

/** Shape returned to the client — omits `anchor_snapshot` (large, server-only). */
type FileCommentDTO = Omit<FileCommentRow, "anchor_snapshot"> & {
  anchor_preview: string // the snapshot line at anchor_start_line, for the drawer
}

function dtoFromRow(row: FileCommentRow): FileCommentDTO {
  const lines = row.anchor_snapshot.split("\n")
  const preview = lines[row.anchor_start_line - 1] ?? ""
  const { anchor_snapshot: _snapshot, ...rest } = row
  return { ...rest, anchor_preview: preview }
}

// Capture file content at insert + re-resolve on every GET. Read uses
// `cwdForConversation` so task-worktree-scoped reads work out of the box.
async function readFileForConversation(
  conversationId: string,
  relPath: string,
): Promise<string | null> {
  try {
    const cwd = await cwdForConversation(conversationId)
    const abs = resolve(cwd, relPath)
    if (!abs.startsWith(cwd + "/") && abs !== cwd) return null
    return await fsp.readFile(abs, "utf8")
  } catch {
    return null
  }
}

app.get("/api/file-comments", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.query("projectId")
  const filePath = c.req.query("filePath")
  const conversationId = c.req.query("conversationId")
  if (!projectId || !filePath || !conversationId) {
    return c.json({ error: "projectId, filePath, conversationId required" }, 400)
  }
  const { data: rows, error } = await sb
    .from("file_comments")
    .select("*")
    .eq("project_id", projectId)
    .eq("file_path", filePath)
    .order("created_at", { ascending: true })
  if (error) return c.json({ error: error.message }, 500)
  const current = (await readFileForConversation(conversationId, filePath)) ?? ""

  const { resolveAnchor } = await import("./file-comments-resolver.ts")
  const dtos: FileCommentDTO[] = []
  const statusUpdates: { id: string; status: FileCommentRow["status"]; line: number | null; conf: string | null }[] = []
  for (const r of (rows ?? []) as FileCommentRow[]) {
    const res = resolveAnchor(
      r.anchor_snapshot,
      current,
      r.anchor_start_line,
      r.anchor_block_length,
    )
    // New status: auto-shift open<->outdated based on resolution. Keep
    // `resolved` sticky — user already marked it handled.
    let nextStatus: FileCommentRow["status"] = r.status
    if (r.status !== "resolved") {
      nextStatus = res.confidence === "outdated" ? "outdated" : "open"
    }
    const next: FileCommentRow = {
      ...r,
      resolved_line: res.resolvedLine,
      resolved_confidence: res.confidence,
      status: nextStatus,
    }
    dtos.push(dtoFromRow(next))
    if (
      r.resolved_line !== res.resolvedLine ||
      r.resolved_confidence !== res.confidence ||
      r.status !== nextStatus
    ) {
      statusUpdates.push({
        id: r.id,
        status: nextStatus,
        line: res.resolvedLine,
        conf: res.confidence,
      })
    }
  }
  // Fire-and-forget cache update of resolved_* fields. Not awaited — the
  // returned DTOs already have the fresh values.
  if (statusUpdates.length > 0) {
    void (async () => {
      for (const u of statusUpdates) {
        await sb
          .from("file_comments")
          .update({
            status: u.status,
            resolved_line: u.line,
            resolved_confidence: u.conf,
            resolved_at: new Date().toISOString(),
          })
          .eq("id", u.id)
      }
    })()
  }
  return c.json({ comments: dtos })
})

app.post("/api/file-comments", async (c) => {
  const sb = c.get("sb")
  const body = await c.req.json<{
    userId?: string
    projectId?: string
    conversationId?: string
    filePath?: string
    anchorStartLine?: number
    body?: string
    /** Client-generated UUID used as the chat message row's id and as
     *  file_comments.message_id. Enables deterministic optimistic→canonical
     *  swap without waiting for a server round-trip. Generated server-side
     *  if omitted. */
    messageId?: string
  }>().catch(() => ({}))
  const userId = c.get("userId")
  const projectId = body.projectId
  const conversationId = body.conversationId
  const filePath = body.filePath
  const anchorStartLine = body.anchorStartLine
  const text = body.body?.trim()
  const messageId = body.messageId ?? crypto.randomUUID()
  if (!userId || !projectId || !conversationId || !filePath || !anchorStartLine || !text) {
    return c.json(
      { error: "userId, projectId, conversationId, filePath, anchorStartLine, body required" },
      400,
    )
  }

  const { normalizeContent } = await import("./file-comments-resolver.ts")
  const fileContent = await readFileForConversation(conversationId, filePath)
  if (fileContent === null) return c.json({ error: "file not readable" }, 404)
  const snapshot = normalizeContent(fileContent)
  const lineCount = snapshot.split("\n").length
  if (anchorStartLine < 1 || anchorStartLine > lineCount) {
    return c.json({ error: "anchorStartLine out of range" }, 400)
  }
  // Block = target + up to 1 line before + 1 line after, clamped to file bounds.
  const blockStart = Math.max(1, anchorStartLine - 1)
  const blockEnd = Math.min(lineCount, anchorStartLine + 1)
  const blockLength = blockEnd - blockStart + 1

  // 1) Insert the chat message row with the client-provided id so the
  //    file_comments FK below resolves AND the client's optimistic row
  //    can be upgraded by id match. `delivered_at = null` while a runner
  //    is active (canUseTool sweeps it); `now()` otherwise so the row
  //    isn't stuck pending if we never start a runner.
  const runner = runners.get(conversationId)
  const runnerActive = runner && !runner.done
  const anchoredLine = snapshot.split("\n")[anchorStartLine - 1] ?? ""
  const chatText = `[comment on ${filePath}:${anchorStartLine}]\n> ${anchoredLine}\n\n${text}`
  const { error: msgErr } = await sb.from("messages").insert({
    id: messageId,
    conversation_id: conversationId,
    role: "user",
    text: chatText,
    events: [],
    attachments: [],
    delivered_at: runnerActive ? null : new Date().toISOString(),
  })
  if (msgErr) return c.json({ error: msgErr.message }, 500)

  // 2) Insert the comment row now that the FK target exists.
  const { data, error } = await sb
    .from("file_comments")
    .insert({
      project_id: projectId,
      file_path: filePath,
      body: text,
      status: "open",
      anchor_start_line: blockStart,
      anchor_block_length: blockLength,
      anchor_snapshot: snapshot,
      resolved_line: anchorStartLine,
      resolved_at: new Date().toISOString(),
      resolved_confidence: "exact",
      conversation_id: conversationId,
      message_id: messageId,
      created_by: userId,
    })
    .select()
    .single()
  if (error || !data) return c.json({ error: error?.message ?? "insert failed" }, 500)

  // 3) Kick off a runner when none is active. `skipFirstUserInsert` because
  //    we already wrote the user message above. When a runner IS active, the
  //    nudge sweep in canUseTool picks up our `delivered_at=null` row.
  if (!runnerActive) {
    const { data: conv } = await sb
      .from("conversations")
      .select("session_id")
      .eq("id", conversationId)
      .single()
    void startRunner({
      conversationId,
      prompt: chatText,
      resumeSessionId: conv?.session_id ?? undefined,
      skipFirstUserInsert: true,
    })
  }

  return c.json({ comment: dtoFromRow(data as FileCommentRow), messageId })
})

app.patch("/api/file-comments/:id", async (c) => {
  const sb = c.get("sb")
  const id = c.req.param("id")
  if (!id) return c.json({ error: "id required" }, 400)
  const body = await c.req.json<{ status?: string; body?: string }>().catch(() => ({}))
  const patch: { status?: string; body?: string } = {}
  if (body.status) {
    if (!["open", "resolved", "outdated"].includes(body.status)) {
      return c.json({ error: "invalid status" }, 400)
    }
    patch.status = body.status
  }
  if (typeof body.body === "string") patch.body = body.body.trim()
  if (Object.keys(patch).length === 0) return c.json({ error: "nothing to update" }, 400)
  const { data, error } = await sb
    .from("file_comments")
    .update(patch)
    .eq("id", id)
    .select()
    .single()
  if (error || !data) return c.json({ error: error?.message ?? "update failed" }, 500)
  return c.json({ comment: dtoFromRow(data as FileCommentRow) })
})

// Directory listing scoped to the conversation's cwd. Used by the file-tree
// panel. Hides the usual heavyweights (.git, node_modules) and skips dotfiles
// behind a flag so the default view isn't noisy.
app.get("/api/tree", async (c) => {
  try {
    const conversationId = c.req.query("conversationId")
    if (!conversationId) return c.json({ path: "", entries: [] })
    const cwd = await cwdForConversation(conversationId)
    const rel = c.req.query("path") ?? ""
    const showHidden = c.req.query("hidden") === "1"
    const abs = resolve(cwd, rel)
    if (!abs.startsWith(cwd + "/") && abs !== cwd) {
      return c.json({ error: "path escapes project root" }, 400)
    }
    const dirents = await fsp.readdir(abs, { withFileTypes: true })
    const SKIP = new Set([".git", "node_modules"])
    const entries = dirents
      .filter((d) => !SKIP.has(d.name))
      .filter((d) => showHidden || !d.name.startsWith("."))
      .map((d) => ({
        name: d.name,
        type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other",
      }))
      .sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name)
        return a.type === "dir" ? -1 : 1
      })
    return c.json({ path: rel, entries })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === "ENOENT") return c.json({ error: "not found" }, 404)
    if (code === "ENOTDIR") return c.json({ error: "not a directory" }, 400)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// Aggregate diff stats vs a base ref. Used by the kanban board to render a
// per-card "12 files · +234 / -56" hint without pulling the full file list.
// Returns null if git isn't usable in this cwd.
async function diffShortstat(
  cwd: string,
  baseRef: string,
): Promise<{ filesChanged: number; additions: number; deletions: number } | null> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["diff", "--shortstat", baseRef, "--"],
      { cwd, maxBuffer: 1024 * 1024 },
    )
    // Match shapes:
    //   "1 file changed, 2 insertions(+), 3 deletions(-)"
    //   "5 files changed, 10 insertions(+)"  (no deletions section)
    //   "5 files changed, 10 deletions(-)"   (no insertions section)
    const m = stdout.match(
      /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
    )
    if (!m) return { filesChanged: 0, additions: 0, deletions: 0 }
    return {
      filesChanged: parseInt(m[1], 10),
      additions: parseInt(m[2] ?? "0", 10),
      deletions: parseInt(m[3] ?? "0", 10),
    }
  } catch {
    return null
  }
}

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
  const sb = c.get("sb")
  const body = await c.req.json<{
    userId?: string
    name?: string
    cwd?: string
    worktreeMode?: "shared" | "per_conversation"
  }>().catch(() => ({}))
  const { name, cwd } = body
  const userId = c.get("userId")
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
  const sb = c.get("sb")
  const body = await c.req.json<{
    userId?: string
    projectId?: string
    title?: string
    kind?: "chat" | "task"
    autoLoopGoal?: string | null
    maxIterations?: number
    maxCostUsd?: number
    /** Client-generated UUID. See docs/ARCHITECTURE-CLIENT-IDS.md. Optional
     *  for backwards compat — we generate one if missing. */
    id?: string
  }>().catch(() => ({}))
  const { projectId } = body
  const userId = c.get("userId")
  const kind: "chat" | "task" = body.kind === "task" ? "task" : "chat"
  const fallbackTitle = kind === "task" ? "New task" : "New chat"
  const title = body.title ?? fallbackTitle
  const id = body.id && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : crypto.randomUUID()
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

  const insertRow: Record<string, unknown> = {
    id,
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
    // 23505 is Postgres' unique_violation — most likely an idempotent retry
    // of a create we already completed. Return the existing row so the
    // client's optimistic insert gets confirmed.
    if ((convErr as { code?: string })?.code === "23505") {
      const { data: existing } = await sb
        .from("conversations")
        .select("*")
        .eq("id", id)
        .single()
      if (existing) return c.json(existing)
    }
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
  const sb = c.get("sb")
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
  const sb = c.get("sb")
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

// Ask the conversation's agent to configure the project's run command. Same
// shape as /merge: inject a scripted one-shot turn with systemPromptOverride,
// chat sees a concise `role: 'notice'` row (displayText), agent reply ends
// with a <run-manifest>{…}</run-manifest> block that the post-turn reconcile
// parses and saves to projects.run_manifest. See docs/RUNTIME-PROGRESS.md.
app.post("/api/conversations/:id/detect-services", async (c) => {
  const sb = c.get("sb")
  const conversationId = c.req.param("id")
  const body = await c.req.json<{ userId?: string }>().catch(() => ({}))
  const userId = c.get("userId")

  const { data: conv } = await sb
    .from("conversations")
    .select("id, user_id, project_id, session_id, worktree_path")
    .eq("id", conversationId)
    .single()
  if (!conv) return c.json({ error: "conversation not found" }, 404)

  const { data: project } = await sb
    .from("projects")
    .select("cwd, run_manifest")
    .eq("id", conv.project_id)
    .single()
  if (!project) return c.json({ error: "project not found" }, 404)

  const cwd = conv.worktree_path
    ? resolve(conv.worktree_path)
    : resolveProjectCwd(project.cwd)

  const existingManifest = project.run_manifest as
    | { stack: string; start: string; build?: string; env?: Record<string, string> }
    | null
    | undefined

  // Pass whatever services are already configured so the agent can refine
  // rather than overwrite. Single-service projects look the same to the
  // agent regardless of whether they came in via <run-manifest> or a lone
  // `<run-services>` with one entry — the list drives.
  let existingServices: Array<{
    name: string
    stack: string
    start: string
    build?: string | null
    env?: Record<string, string>
    port?: number | null
    enabled?: boolean
  }> | null = null
  try {
    const rows = await listProjectServices(sb, conv.project_id as string)
    if (rows.length > 0) {
      existingServices = rows.map((r) => ({
        name: r.name,
        stack: r.stack,
        start: r.start,
        build: r.build ?? null,
        env: r.env ?? {},
        port: r.port ?? null,
        enabled: r.enabled,
      }))
    }
  } catch {
    /* optional context; ignore */
  }

  const prompt = buildDetectServicesPrompt({
    cwd,
    existingManifest: existingManifest ?? null,
    existingServices,
  })
  const displayText = buildDetectServicesNoticeText({
    cwd,
    refining: !!existingManifest || !!existingServices,
  })

  // If a runner is mid-turn, let it finish — unlike merge, detect is
  // non-destructive, so interrupting active chat work is the wrong trade.
  // Await then kick.
  const existing = runners.get(conversationId)
  if (existing && !existing.done) {
    await existing.promise.catch(() => {})
  }

  void startRunner({
    conversationId,
    prompt,
    resumeSessionId: conv.session_id ?? undefined,
    oneShot: true,
    systemPromptOverride: buildDetectServicesSystemPrompt(),
    displayText,
    displayRole: "notice",
  })

  return c.json({ started: true })
})

// Feed a service's captured output back to the conversation agent. Used on
// first run after configuration (closes the loop: agent configures → host
// runs → agent verifies/troubleshoots). HTTP returns immediately; a
// background watcher waits up to `watchMs` for the service to settle (or
// exit early on crash), snapshots logs + status, and injects a scripted
// oneShot `role: "notice"` turn. Same pattern as /merge and /detect-services.
app.post("/api/conversations/:id/verify-run", async (c) => {
  const sb = c.get("sb")
  const conversationId = c.req.param("id")
  const body = await c.req.json<{
    userId?: string
    serviceId?: string
    watchMs?: number
  }>().catch(() => ({}))
  const userId = c.get("userId")
  const serviceId = body.serviceId
  const watchMs = Math.min(Math.max(body.watchMs ?? 8000, 2000), 30_000)
  if (!serviceId) return c.json({ error: "serviceId required" }, 400)

  const { data: conv } = await sb
    .from("conversations")
    .select("id, user_id, session_id")
    .eq("id", conversationId)
    .single()
  if (!conv) return c.json({ error: "conversation not found" }, 404)

  const initial = getService(serviceId, userId)
  if (!initial) return c.json({ error: "service not found" }, 404)

  // Fire-and-forget. HTTP returns right away; the chat fills in once the
  // watcher settles and the agent turn actually runs.
  void (async () => {
    try {
      // Wait for the service to settle. Early-exit on terminal state so we
      // don't sit on a 30s deadline for a service that crashed 2s in.
      const deadline = Date.now() + watchMs
      while (Date.now() < deadline) {
        const now = getService(serviceId, userId)
        if (!now) break
        if (now.status === "stopped" || now.status === "crashed") break
        await new Promise((r) => setTimeout(r, 500))
      }

      const final = getService(serviceId, userId) ?? initial
      const history = getLogHistory(serviceId, userId)
      const snapshot: VerifyRunSnapshot = {
        serviceName: final.serviceName,
        stack: final.stack,
        start: final.start,
        status: final.status,
        pid: final.pid,
        port: final.port,
        url: final.url,
        exitCode: final.exitCode,
        error: final.error,
        startedAt: final.startedAt,
        stoppedAt: final.stoppedAt,
      }

      // Let any active runner finish first so we don't race an in-flight turn.
      const existing = runners.get(conversationId)
      if (existing && !existing.done) {
        await existing.promise.catch(() => {})
      }

      const prompt = buildVerifyRunPrompt({
        snapshot,
        logs: history,
        watchMs,
      })
      const displayText = buildVerifyRunNoticeText({ snapshot })

      void startRunner({
        conversationId,
        prompt,
        resumeSessionId: conv.session_id ?? undefined,
        oneShot: true,
        systemPromptOverride: buildVerifyRunSystemPrompt(),
        displayText,
        displayRole: "notice",
      })
    } catch (err) {
      console.error("[verify-run] background task failed:", err)
    }
  })()

  return c.json({ started: true, watchMs })
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

// Revert a shipped task: undo the squash commit on the base branch and put
// the work back into a new worktree on the same branch name, so the user can
// continue where they left off. Destructive (git reset --hard), but safeguarded:
// the agent refuses if the base HEAD has moved past the shipped commit or if
// the shipped commit has been pushed. See docs/MERGE-FLOW.md § Revert.
app.post("/api/conversations/:id/revert", async (c) => {
  const sb = c.get("sb")
  const conversationId = c.req.param("id")
  const { data: conv } = await sb
    .from("conversations")
    .select("id, title, kind, project_id, branch, base_ref, shipped_at, shipped_commit_sha, worktree_path")
    .eq("id", conversationId)
    .single()
  if (!conv) return c.json({ error: "conversation not found" }, 404)
  if (conv.kind !== "task") return c.json({ error: "only tasks can be reverted" }, 400)
  if (!conv.shipped_at) return c.json({ error: "task is not shipped" }, 400)
  if (conv.worktree_path) return c.json({ error: "task still has a worktree — not in a revertible state" }, 400)

  const { data: project } = await sb
    .from("projects")
    .select("cwd, default_base_ref")
    .eq("id", conv.project_id)
    .single()
  if (!project) return c.json({ error: "project not found" }, 404)

  const baseCwd = resolveProjectCwd(project.cwd)
  const worktreePath = worktreePathFor(conv.project_id, conv.id)

  // Legacy rows: before reconcile preserved branch/base_ref, shipping nulled
  // them. branchNameFor is deterministic over (title, id), and base_ref falls
  // back to the project's default or the current repo HEAD. The agent's
  // step-2 check will catch mismatches.
  const branch = conv.branch ?? branchNameFor(conv.title, conv.id)
  const baseRef =
    conv.base_ref ??
    project.default_base_ref ??
    (await detectDefaultBaseRef(baseCwd)) ??
    "main"

  // Legacy tasks that shipped before migration 0013 don't have a recorded
  // SHA. Fall back to the current HEAD of the base branch: for a fresh merge
  // that's the squash commit, which is what we want to revert. If the user
  // has committed anything else since the ship, the agent's safety checks
  // (step 2 in buildRevertPrompt) will catch the mismatch and STOP.
  let shippedSha = conv.shipped_commit_sha
  let legacy = false
  if (!shippedSha) {
    try {
      const { stdout } = await execFileP(
        "git",
        ["rev-parse", `refs/heads/${baseRef}`],
        { cwd: baseCwd }
      )
      shippedSha = stdout.trim() || null
      legacy = true
    } catch (err) {
      return c.json({
        error: `no shipped commit SHA recorded and could not read ${baseRef} HEAD: ${err instanceof Error ? err.message : String(err)}`,
      }, 400)
    }
    if (!shippedSha) {
      return c.json({ error: `could not resolve ${baseRef} HEAD` }, 400)
    }
  }

  const prompt = buildRevertPrompt({
    baseCwd,
    worktreePath,
    branch,
    baseRef,
    shippedSha,
    legacy,
  })

  // Optimistically flip the row out of shipped state so the UI re-enables the
  // chat composer immediately. Also (re)populate branch + base_ref in case
  // they were nulled by a pre-0013 reconcile — the revert will create the
  // worktree at these values. If the agent refuses (unsafe state), the row
  // stays in this "worktree back, not shipped" shape and the user can see
  // the refusal in chat.
  await sb
    .from("conversations")
    .update({
      shipped_at: null,
      shipped_commit_sha: null,
      merge_requested_at: null,
      worktree_path: worktreePath,
      branch,
      base_ref: baseRef,
      auto_loop_enabled: false,
    })
    .eq("id", conversationId)
  logWorktreeEvent("merge.request", {
    conv: conversationId.slice(0, 8),
    revert: true,
    branch,
    baseRef,
  })

  const existing = runners.get(conversationId)
  if (existing && !existing.done) existing.abort.abort()
  console.log("[revert]", conversationId.slice(0, 8), "→ starting runner at cwd", baseCwd)
  void startRunner({
    conversationId,
    prompt,
    resumeSessionId: undefined,
    cwdOverride: baseCwd,
    oneShot: true,
    systemPromptOverride: buildRevertSystemPrompt({
      baseCwd,
      worktreePath,
      branch,
      baseRef,
      shippedSha,
    }),
    displayText: buildRevertNoticeText({
      branch,
      baseRef,
      shippedSha,
      legacy,
    }),
    displayRole: "notice",
  })

  return c.json({ started: true })
})

function buildRevertPrompt(input: {
  baseCwd: string
  worktreePath: string
  branch: string
  baseRef: string
  shippedSha: string
  /** True when we derived the SHA from the current base HEAD because the task
   *  shipped before we started recording shipped_commit_sha. Adds a legacy
   *  warning line so the agent can surface it to the user. */
  legacy: boolean
}): string {
  const legacyNote = input.legacy
    ? [
        "⚠️ This task shipped before the merge tracker started recording the squash SHA, so we're using the current HEAD of `" + input.baseRef + "` as our best guess.",
        "If another commit landed after the squash, Step 2 will catch the mismatch and you should STOP.",
        "",
      ]
    : []
  return [
    "[Host task — revert merge]",
    "",
    ...legacyNote,
    `Undo the squash commit \`${input.shippedSha.slice(0, 12)}\` on \`${input.baseRef}\` and put the task work back into a fresh worktree.`,
    "",
    `- Base checkout: \`${input.baseCwd}\``,
    `- Base branch: \`${input.baseRef}\``,
    `- Shipped commit SHA: \`${input.shippedSha}\``,
    `- Restored branch name: \`${input.branch}\``,
    `- New worktree path: \`${input.worktreePath}\``,
    "",
    "This is destructive (uses `git reset --hard`). Run the checks first and STOP if any fail.",
    "",
    `1. Verify base checkout is clean: \`git -C ${shq(input.baseCwd)} status --porcelain\`. If non-empty, STOP — ask the user to commit or stash.`,
    "",
    `2. Verify the shipped commit is still the current HEAD of \`${input.baseRef}\`: \`git -C ${shq(input.baseCwd)} rev-parse ${input.baseRef}\` must equal \`${input.shippedSha}\`. If different, \`${input.baseRef}\` has moved — STOP and report what's on top. Do NOT rewrite history in that case.`,
    "",
    `3. Check if the commit has been pushed: \`git -C ${shq(input.baseCwd)} branch -r --contains ${input.shippedSha}\`. If that prints any remote refs, STOP — reverting locally would require a force-push. Report to the user and let them decide.`,
    "",
    `4. Get the parent SHA: \`git -C ${shq(input.baseCwd)} rev-parse ${input.shippedSha}^\`. Save as PARENT.`,
    "",
    `5. If the base checkout is currently on \`${input.baseRef}\`, hard-reset it: \`git -C ${shq(input.baseCwd)} reset --hard <PARENT>\`. If it's on a different branch, update the ref only: \`git -C ${shq(input.baseCwd)} update-ref refs/heads/${input.baseRef} <PARENT> ${input.shippedSha}\`.`,
    "",
    `6. Recreate the branch at the shipped SHA (so the work isn't lost): \`git -C ${shq(input.baseCwd)} branch ${input.branch} ${input.shippedSha}\`. If the branch already exists, STOP.`,
    "",
    `7. Create the worktree: \`git -C ${shq(input.baseCwd)} worktree add ${shq(input.worktreePath)} ${input.branch}\`.`,
    "",
    `8. Report: base is back at PARENT, branch \`${input.branch}\` points at \`${input.shippedSha.slice(0, 12)}\`, worktree is at \`${input.worktreePath}\`. Stop.`,
  ].join("\n")
}

function buildRevertSystemPrompt(input: {
  baseCwd: string
  worktreePath: string
  branch: string
  baseRef: string
  shippedSha: string
}): string {
  return [
    "You are performing a REVERT operation for the host. This undoes a prior merge.",
    "",
    `- Working directory (cwd): ${input.baseCwd}`,
    `- Restoring worktree at: ${input.worktreePath}`,
    `- Restoring branch: ${input.branch}`,
    `- Base branch: ${input.baseRef}`,
    `- Shipped commit (to undo): ${input.shippedSha}`,
    "",
    "This uses `git reset --hard`, which is destructive. Follow the numbered steps exactly. STOP immediately at any safety check failure (dirty base, base moved past the SHA, commit has been pushed). Do NOT force-push. Do NOT attempt clever recovery.",
  ].join("\n")
}

function buildRevertNoticeText(input: {
  branch: string
  baseRef: string
  shippedSha: string
  legacy: boolean
}): string {
  const lines = [
    `Reverting merge of **\`${input.branch}\`** from **\`${input.baseRef}\`**.`,
    "",
    "The agent will:",
    `- Hard-reset \`${input.baseRef}\` to the commit before the squash (\`${input.shippedSha.slice(0, 8)}\`)`,
    `- Recreate branch \`${input.branch}\` pointing at the task's work`,
    "- Recreate the worktree so you can continue",
    "",
    "If the base branch has moved or the commit was pushed, the agent will stop and ask you how to proceed.",
  ]
  if (input.legacy) {
    lines.push(
      "",
      `ℹ️ Using the current HEAD of \`${input.baseRef}\` as the commit to revert (this task shipped before we started recording the SHA).`,
    )
  }
  return lines.join("\n")
}

/** Shell-quote helper for embedding paths in agent-facing command strings. */
function shq(value: string): string {
  if (/^[\w./@=:+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

// Quick probe used by the sidebar's delete confirm to warn before discarding
// a task whose worktree has uncommitted changes or whose branch has commits
// the remote doesn't know about. Worktree-less rows return all-zero.
app.get("/api/conversations/:id/discard-status", async (c) => {
  const sb = c.get("sb")
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
  const sb = c.get("sb")
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
  const sb = c.get("sb")
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
  const sb = c.get("sb")
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
  const sb = c.get("sb")
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
  const sb = c.get("sb")
  const body = await c.req.json<{
    conversationId?: string
    text?: string
    attachments?: AttachmentPayload[]
    /** Client-generated id — see docs/ARCHITECTURE-CLIENT-IDS.md. */
    messageId?: string
  }>().catch(() => ({}))
  const conversationId = body.conversationId
  const text = body.text
  const uuidRe = /^[0-9a-f-]{36}$/i
  const messageId =
    body.messageId && uuidRe.test(body.messageId) ? body.messageId : crypto.randomUUID()
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
      id: messageId,
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
  if (error) {
    // Idempotent retry — return the existing row so the client's optimistic
    // row gets confirmed instead of orphaned.
    if ((error as { code?: string }).code === "23505") {
      const { data: existing } = await sb
        .from("messages")
        .select()
        .eq("id", messageId)
        .single()
      if (existing) return c.json(existing)
    }
    return c.json({ error: error.message }, 500)
  }
  if (!data) return c.json({ error: "insert failed" }, 500)

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
    /** Client-generated ids for the first-iteration user + assistant rows.
     *  See docs/ARCHITECTURE-CLIENT-IDS.md. */
    userMessageId?: string
    assistantMessageId?: string
  }>()
  const conversationId = body.conversationId
  const prompt = body.prompt
  const attachments = body.attachments
  const sessionId = body.sessionId
  const uuidRe = /^[0-9a-f-]{36}$/i
  const userMessageId =
    body.userMessageId && uuidRe.test(body.userMessageId) ? body.userMessageId : undefined
  const assistantMessageId =
    body.assistantMessageId && uuidRe.test(body.assistantMessageId)
      ? body.assistantMessageId
      : undefined

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
    firstUserMessageId: userMessageId,
    firstAssistantMessageId: assistantMessageId,
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
  if (!sbSystem) return
  const threshold = new Date(Date.now() - REAPER_GRACE_MS).toISOString()
  const { data: rows, error } = await sbSystem
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
    const { data: projs } = await sbSystem
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
      await sbSystem.from("conversations").delete().eq("id", row.id)
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

// ─── Worktree disk usage + manual prune ─────────────────────────────────────
// Operational surfaces for the kanban board: a per-project usage report so
// users see how much disk the worktrees are eating, and a manual prune that
// reaps soft-trashed conversations regardless of the 7-day grace window.

async function diskUsageBytes(path: string): Promise<number> {
  try {
    // -k forces 1024-byte blocks (POSIX); -s gives the directory total only.
    const { stdout } = await execFileP("du", ["-sk", path], { maxBuffer: 1024 * 1024 })
    const k = parseInt(stdout.split(/\s+/)[0], 10) || 0
    return k * 1024
  } catch {
    // Path missing or unreadable — treat as zero, don't fail the report.
    return 0
  }
}

// GET /api/projects/:id/usage
// RLS scopes the project lookup; non-owned projects return 404. Worktree
// rows come from `conversations` filtered by project_id, also RLS-scoped.
app.get("/api/projects/:id/usage", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const { data: project } = await sb
    .from("projects")
    .select("id, cwd")
    .eq("id", projectId)
    .single()
  if (!project) return c.json({ error: "project not found" }, 404)

  const { data: convs } = await sb
    .from("conversations")
    .select("id, branch, worktree_path, deleted_at, shipped_at")
    .eq("project_id", projectId)
    .not("worktree_path", "is", null)
  const worktrees = await Promise.all(
    (convs ?? []).map(async (conv) => {
      const path = conv.worktree_path as string
      const bytes = await diskUsageBytes(path)
      const status: "active" | "trashed" | "shipped" =
        conv.deleted_at ? "trashed" : conv.shipped_at ? "shipped" : "active"
      return {
        conversationId: conv.id,
        branch: conv.branch as string | null,
        path,
        bytes,
        status,
      }
    })
  )
  const totalBytes = worktrees.reduce((sum, w) => sum + w.bytes, 0)
  const trashedBytes = worktrees
    .filter((w) => w.status === "trashed")
    .reduce((sum, w) => sum + w.bytes, 0)
  return c.json({
    project: { cwd: resolveProjectCwd(project.cwd as string), totalBytes, trashedBytes },
    worktrees,
  })
})

// POST /api/projects/:id/prune-trashed
// Hard-deletes every soft-trashed conversation in this project right now,
// regardless of the reaper's grace window. Returns the count freed and the
// total bytes reclaimed (best-effort; computed from `du` before removal).
app.post("/api/projects/:id/prune-trashed", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  if (!sbSystem) return c.json({ error: "persistence disabled" }, 503)

  // Ownership: read the project user-scoped so RLS gates this endpoint.
  const { data: project } = await sb
    .from("projects")
    .select("id, cwd")
    .eq("id", projectId)
    .single()
  if (!project) return c.json({ error: "project not found" }, 404)

  // Trashed conversations to reap (also user-scoped via RLS).
  const { data: rows } = await sb
    .from("conversations")
    .select("id, worktree_path, branch")
    .eq("project_id", projectId)
    .not("deleted_at", "is", null)
  const trashed = rows ?? []
  if (trashed.length === 0) return c.json({ count: 0, bytesFreed: 0 })

  const baseCwd = resolveProjectCwd(project.cwd as string)
  let bytesFreed = 0
  let count = 0
  for (const row of trashed) {
    try {
      if (row.worktree_path) {
        bytesFreed += await diskUsageBytes(row.worktree_path as string)
        await removeWorktree({
          baseCwd,
          worktreePath: row.worktree_path as string,
          branch: (row.branch as string | null) ?? undefined,
          force: true,
        })
      }
      // Hard-delete via service-role; RLS would also allow but service-role
      // matches the reaper's path so logs read identically.
      await sbSystem.from("conversations").delete().eq("id", row.id)
      logWorktreeEvent("reap.manual_prune", {
        conv: (row.id as string).slice(0, 8),
        branch: (row.branch as string | null) ?? "",
      })
      count++
    } catch (err) {
      console.warn(
        "[prune] failed for", (row.id as string).slice(0, 8),
        err instanceof Error ? err.message : err,
      )
    }
  }
  return c.json({ count, bytesFreed })
})

// ─── Local runtime: /api/services/* ─────────────────────────────────────────
// Spawns the user's app from a project or worktree cwd, captures logs,
// and lists/streams. See docs/RUNTIME.md; runner code lives in
// server/runtime/. Chat/agent code must not import runtime internals.

// ─── Instance persistence ───────────────────────────────────────────────────
// Every spawn writes a row to service_instances; every status transition
// updates it. At boot, reconcileServiceInstances() probes persisted rows
// and either re-registers the instance (process still alive) or marks it
// stopped. See docs/MULTI-SERVICE.md § Phase 9.9.

function attachInstancePersistence(snap: ServiceSnapshotLike, label: string | null): void {
  if (!sbSystem) return
  // Use upsert-on-id so a reconciled external instance's row stays keyed by
  // the same registry id (set by registerExternalService).
  void insertServiceInstance(sbSystem, {
    id: snap.id,
    user_id: snap.ownerId,
    project_id: snap.projectId,
    service_name: snap.serviceName,
    worktree_path: snap.worktreePath ?? null,
    runner_id: snap.runnerId,
    pid: snap.pid,
    port: snap.port,
    status: snap.status,
    label,
  }).catch((err) => {
    console.warn("[instance-persist] insert failed:", (err as Error).message)
  })

  const sub = subscribeLogs(snap.id, snap.ownerId)
  if (!sub) return
  sub.onStatus((s) => {
    if (!sbSystem) return
    void updateServiceInstanceStatus(sbSystem, s.id, {
      status: s.status,
      exit_code: s.exitCode ?? null,
      error: s.error ?? null,
      port: s.port,
    }).catch((err) => {
      console.warn("[instance-persist] status update failed:", (err as Error).message)
    })
  })
  sub.onEnd(() => sub.unsubscribe())
}

// Narrower shape than ServiceSnapshot so test seams + the external-registered
// variant can both pass through without importing the full type here.
type ServiceSnapshotLike = {
  id: string
  ownerId: string
  projectId: string
  serviceName: string
  worktreePath: string | null
  runnerId: RunnerId
  pid: number | null
  port: number
  status: "starting" | "running" | "stopping" | "stopped" | "crashed"
}

// Boot-time reconcile. Walks every persisted row that thinks it's live on
// this host, probes the pid (signal 0), and either re-registers via the
// external runner or flips the row to "stopped". Safe to run multiple times.
async function reconcileServiceInstances(): Promise<void> {
  if (!sbSystem) return
  let rows: Awaited<ReturnType<typeof listLiveServiceInstancesForHost>>
  try {
    rows = await listLiveServiceInstancesForHost(sbSystem)
  } catch (err) {
    console.warn("[reconcile] list failed:", (err as Error).message)
    return
  }
  if (rows.length === 0) return

  const reaped: string[] = []
  const kept: string[] = []
  for (const row of rows) {
    const pid = row.pid
    const alive = pid != null && isPidAlive(pid)
    if (!alive) {
      try {
        await updateServiceInstanceStatus(sbSystem, row.id, {
          status: "stopped",
          error: "process gone at boot reconcile",
        })
      } catch {
        /* best-effort */
      }
      reaped.push(row.id.slice(0, 8))
      continue
    }
    // Re-register in the in-memory registry so the panel shows it. The
    // original manifest isn't recoverable from this table (we didn't
    // persist it), so we fabricate a minimal one from the stack/start-less
    // snapshot — the panel's start command text will be blank for external
    // instances; users see the live pid/port, can stop via the panel.
    try {
      registerExternalService({
        id: row.id,
        scope: {
          ownerId: row.user_id,
          projectId: row.project_id,
          serviceName: row.service_name,
          worktreePath: row.worktree_path,
          label: row.label,
        },
        manifest: {
          stack: "custom",
          start: "(started in a previous server session — restart for live logs)",
          cwd: "",
          env: {},
        },
        runnerId: (row.runner_id as RunnerId) ?? "external",
        pid: pid!,
        port: row.port,
        startedAt: new Date(row.started_at).getTime(),
      })
      kept.push(row.id.slice(0, 8))
    } catch (err) {
      console.warn(
        `[reconcile] re-register of ${row.id.slice(0, 8)} failed:`,
        (err as Error).message
      )
    }
  }
  console.log(
    `[reconcile] service_instances: kept=${kept.length} reaped=${reaped.length}`
  )
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      // We know it exists but can't signal it; treat as alive. Happens on
      // processes owned by a different uid — unusual in local dev but not
      // impossible (sudo-started server).
      return true
    }
    return false
  }
}

// ─── Supervisor ─────────────────────────────────────────────────────────────
// PM2-style auto-restart. Keyed by scope so counters survive instance churn.
// Policy is per-service-row (project_services.restart_policy). We treat an
// instance that stayed up past GRACE_MS as "healthy" and reset the counter;
// anything that crashes faster is burning retries. Exponential backoff
// (1s, 2s, 4s, …) capped at 30s so a truly broken service doesn't busy-loop.

const SUPERVISOR_GRACE_MS = 10_000
const SUPERVISOR_MAX_DELAY_MS = 30_000

type SupervisorScope = {
  userId: string
  projectId: string
  serviceName: string
  worktreePath: string | null
}

function supervisorKey(s: SupervisorScope): string {
  return `${s.userId}:${s.projectId}:${s.serviceName}:${s.worktreePath ?? "null"}`
}

type SupervisorState = {
  restarts: number
  pending: ReturnType<typeof setTimeout> | null
  // Instance id that most recently called attachSupervisor. We ignore end
  // events from earlier instances to avoid double-scheduling when the user
  // manually restarted (stop+start) between a crash and its supervisor fire.
  latestInstanceId: string | null
}

const supervisorState = new Map<string, SupervisorState>()

function getSupervisorState(scope: SupervisorScope): SupervisorState {
  const key = supervisorKey(scope)
  let state = supervisorState.get(key)
  if (!state) {
    state = { restarts: 0, pending: null, latestInstanceId: null }
    supervisorState.set(key, state)
  }
  return state
}

type SupervisorCtx = SupervisorScope & {
  conversationId: string | null
  label: string | null
  runnerId?: RunnerId
  manifest: RunManifest
  snap: { id: string; port: number }
  policy: "always" | "on-failure" | "never"
  maxRestarts: number
}

function attachSupervisor(ctx: SupervisorCtx): void {
  const scope: SupervisorScope = {
    userId: ctx.userId,
    projectId: ctx.projectId,
    serviceName: ctx.serviceName,
    worktreePath: ctx.worktreePath,
  }
  const state = getSupervisorState(scope)
  state.latestInstanceId = ctx.snap.id

  const sub = subscribeLogs(ctx.snap.id, ctx.userId)
  if (!sub) return

  sub.onEnd(() => {
    try {
      // Defer the decision a tick so the terminal status is settled.
      queueMicrotask(() => handleSupervisorExit(ctx, state))
    } finally {
      sub.unsubscribe()
    }
  })
}

function handleSupervisorExit(ctx: SupervisorCtx, state: SupervisorState): void {
  // Ignore stale `end` events from earlier instances of the same scope —
  // a user-triggered restart (stop+start) replaces `latestInstanceId` and
  // the outgoing one's end event must not double-schedule.
  if (state.latestInstanceId !== ctx.snap.id) return

  const snap = getService(ctx.snap.id, ctx.userId)
  if (!snap) return
  const crashed = snap.status === "crashed"
  const cleanExit = snap.status === "stopped" && (snap.exitCode === 0 || snap.exitCode === null)

  // `never` never restarts; `on-failure` restarts only on non-zero exit;
  // `always` restarts even on clean stop. A user-triggered stop via
  // /stop sets status=stopped — we still restart on `always` which may
  // be surprising; tradeoff matches PM2 docs.
  const wantRestart =
    ctx.policy === "always" ||
    (ctx.policy === "on-failure" && crashed)
  if (!wantRestart) return
  if (ctx.policy === "on-failure" && cleanExit) return

  // Reset counter if the instance was healthy long enough. Protects
  // against "one flaky restart locks us out forever" while keeping the
  // cap meaningful for tight crash loops.
  const uptime = Date.now() - (snap.startedAt ?? Date.now())
  if (uptime > SUPERVISOR_GRACE_MS) state.restarts = 0

  if (state.restarts >= ctx.maxRestarts) {
    console.warn(
      `[supervisor] exhausted retries for ${supervisorKey(ctx)}:`,
      `${state.restarts}/${ctx.maxRestarts}`
    )
    void emitSupervisorExhaustedNotice(ctx, state.restarts)
    state.restarts = 0
    return
  }

  const delay = Math.min(1000 * 2 ** state.restarts, SUPERVISOR_MAX_DELAY_MS)
  state.restarts++
  state.pending = setTimeout(() => {
    state.pending = null
    void restartViaSupervisor(ctx)
  }, delay)

  console.log(
    `[supervisor] scheduling restart of ${ctx.serviceName} in ${delay}ms ` +
    `(attempt ${state.restarts}/${ctx.maxRestarts})`
  )
}

async function restartViaSupervisor(ctx: SupervisorCtx): Promise<void> {
  try {
    const snap = await startService(
      { ...ctx.manifest },
      {
        ownerId: ctx.userId,
        projectId: ctx.projectId,
        serviceName: ctx.serviceName,
        worktreePath: ctx.worktreePath,
        label: ctx.label,
      },
      { preferredPort: ctx.snap.port, runnerId: ctx.runnerId }
    )
    // Re-arm the supervisor for the new instance.
    attachSupervisor({ ...ctx, snap: { id: snap.id, port: snap.port } })
  } catch (err) {
    console.error(`[supervisor] restart failed:`, (err as Error).message)
  }
}

// Inject a single chat notice when a service blows through its retry cap.
// The conversation shown is whichever one the user last started the service
// from — fine as a nudge, even if they've since moved chats.
async function emitSupervisorExhaustedNotice(
  ctx: SupervisorCtx,
  attempts: number
): Promise<void> {
  if (!ctx.conversationId) return
  if (!sbSystem) return
  const text = [
    `**\`${ctx.serviceName}\` exhausted its restart budget** (${attempts} attempts).`,
    "",
    "The supervisor won't keep retrying — inspect the logs and either fix the",
    "config or ask the agent to check via the ⬡ button on the service card.",
  ].join("\n")
  try {
    // Same shape as merge / detect-services notices — see the `role === "notice"`
    // path in startRunner (insert block uses `text` + `events: []`).
    await sbSystem.from("messages").insert({
      conversation_id: ctx.conversationId,
      role: "notice",
      text,
      events: [],
      delivered_at: new Date().toISOString(),
    })
  } catch (err) {
    console.warn("[supervisor] couldn't inject notice:", (err as Error).message)
  }
}

function runtimeErrorStatus(code: RuntimeError["code"]): 400 | 403 | 404 | 409 | 429 | 500 | 503 {
  switch (code) {
    case "user_cap_reached": return 429
    case "port_range_exhausted": return 503
    case "port_in_use": return 409
    case "port_invalid": return 400
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
  serviceName: string
  // The resolved config for the requested service (defaults to "default"),
  // shaped like the legacy RunManifest so existing endpoints keep working.
  cachedProjectManifest: RunManifest | null
  // Raw DB row for the requested service, when one exists. Start-endpoint
  // uses it to write assigned_port directly on the service row.
  serviceRow: ProjectServiceRow | null
  override: ManifestOverride | null
  // Preferred port: per-conversation (legacy assigned_port) first, then the
  // service row's assigned_port. Phase 9.2+ pushes everyone toward the
  // service-level field; conv-level stays as a fallback for one release.
  assignedPort: number | null
  conversationId: string | null
  worktreePath: string | null
}

// Read the current effective manifest for the given scope. Reads through
// project_services (backfilled during migration 0014) and falls back to the
// legacy projects.run_manifest column only as a safety net. `serviceName`
// selects which service row to look up — callers that don't care pass
// "default" and keep the single-service behaviour.
async function loadManifestContext(
  userId: string,
  projectId: string,
  conversationId: string | undefined,
  serviceName = "default"
): Promise<
  | ManifestContext
  | { ok: false; status: 403 | 404 | 503; error: string }
> {
  if (!sbSystem) return { ok: false, status: 503, error: "persistence disabled" }
  const { data: project } = await sbSystem
    .from("projects")
    .select("id, user_id, cwd, run_manifest")
    .eq("id", projectId)
    .single()
  if (!project) return { ok: false, status: 404, error: "project not found" }
  if (project.user_id !== userId) return { ok: false, status: 403, error: "forbidden" }

  const projectCwd = resolveProjectCwd(project.cwd)

  // Prefer project_services row → fall back to legacy run_manifest when the
  // requested service is the default and no row exists yet (e.g. a project
  // created after the migration but before the first save).
  let cached: RunManifest | null = null
  let serviceRow: ProjectServiceRow | null = null
  let serviceAssignedPort: number | null = null
  try {
    serviceRow = await getProjectService(sbSystem, projectId, serviceName)
    if (serviceRow && serviceRow.start) {
      const m = manifestFromRow(serviceRow)
      cached = { ...m, cwd: "" } as RunManifest
      serviceAssignedPort = serviceRow.assigned_port
    }
  } catch (err) {
    console.warn("[manifest] project_services read failed, falling back to legacy column:", err)
  }
  if (!cached && serviceName === "default") {
    cached = (project.run_manifest ?? null) as RunManifest | null
  }

  if (!conversationId) {
    return {
      ok: true,
      projectCwd,
      effectiveCwd: projectCwd,
      serviceName,
      cachedProjectManifest: cached,
      serviceRow,
      override: null,
      assignedPort: serviceAssignedPort,
      conversationId: null,
      worktreePath: null,
    }
  }

  const { data: conv } = await sbSystem
    .from("conversations")
    .select("id, project_id, worktree_path, run_manifest_override, assigned_port, service_overrides")
    .eq("id", conversationId)
    .single()
  if (!conv || conv.project_id !== projectId) {
    return { ok: false, status: 404, error: "conversation not found" }
  }

  // Prefer per-service override keyed by serviceName → legacy
  // run_manifest_override (only when serviceName === "default").
  const serviceOverridesMap = (conv.service_overrides ?? null) as
    | Record<string, ManifestOverride>
    | null
  const override: ManifestOverride | null =
    (serviceOverridesMap?.[serviceName] ?? null) ||
    (serviceName === "default"
      ? ((conv.run_manifest_override ?? null) as ManifestOverride | null)
      : null)

  const assignedPort =
    (conv.assigned_port as number | null) ?? serviceAssignedPort

  return {
    ok: true,
    projectCwd,
    effectiveCwd: conv.worktree_path ? resolve(conv.worktree_path) : projectCwd,
    serviceName,
    cachedProjectManifest: cached,
    serviceRow,
    override,
    assignedPort,
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

// Per-scope serialization for /api/services/start. Concurrent starts on the
// same (user, project, service, worktree) tuple race: both calls list
// existing instances, both stop them, both spawn — the second spawn either
// hits a port collision or leaks a zombie. Funneling through a per-scope
// promise queue means restart-spam can't fork the registry.
const serviceStartLocks = new Map<string, Promise<unknown>>()

function withStartLock<T>(scopeKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = serviceStartLocks.get(scopeKey) ?? Promise.resolve()
  const next = prev.then(fn, fn) // run regardless of prior outcome
  serviceStartLocks.set(scopeKey, next)
  // Drop the entry once the chain settles so the map doesn't grow unbounded.
  void next.finally(() => {
    if (serviceStartLocks.get(scopeKey) === next) {
      serviceStartLocks.delete(scopeKey)
    }
  })
  return next as Promise<T>
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
  const sb = c.get("sb")
  const body = await c.req.json<{
    userId?: string
    projectId?: string
    conversationId?: string
    serviceName?: string
    label?: string
    overrides?: ManifestOverride
    runnerId?: RunnerId
  }>().catch(() => ({}))
  const { projectId, conversationId } = body
  const userId = c.get("userId")
  const serviceName = body.serviceName || "default"
  if (!projectId) return c.json({ error: "projectId required" }, 400)

  const ctx = await loadManifestContext(userId, projectId, conversationId, serviceName)
  if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status)

  // Scope-level serialization: see serviceStartLocks comment above. We key
  // on the same 4-tuple the registry uses so concurrent starts on the same
  // scope queue, while different scopes run in parallel.
  const scopeKey = `${userId}:${projectId}:${serviceName}:${ctx.worktreePath ?? "null"}`
  return withStartLock(scopeKey, () => doStart())
  async function doStart(): Promise<Response> {
    if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status)

  // Prefer cached service config; fall back to on-the-fly detection only for
  // the default service (non-default services must be explicitly configured
  // via the CRUD endpoints — we don't guess what a "worker" service should
  // run). The first-run UX caches the manifest before calling start, so on
  // well-behaved flows `cached` is always set.
  let base: RunManifest | null = ctx.cachedProjectManifest
  if (!base && serviceName === "default") {
    try {
      base = await detectManifest(ctx.effectiveCwd)
    } catch (err) {
      return c.json({ error: `detection failed: ${(err as Error).message}` }, 500)
    }
  }
  if (!base) {
    return c.json(
      {
        error:
          serviceName === "default"
            ? "no runnable manifest — project has no cached start command and detection found nothing"
            : `service '${serviceName}' not configured — create it first`,
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

  // Restart semantics: if an instance for this exact scope (user + project +
  // serviceName + worktreePath) is still live, stop it first and wait for
  // the process group to exit so its port releases. Common after a page
  // reload — the in-memory registry survives the client disconnect, so the
  // next Run would otherwise spawn a duplicate and the old process would
  // keep its port. Also drops any previously-stopped entries for the same
  // scope so the registry doesn't accumulate stale rows. Scope keys on the
  // worktree path (chats share, tasks are isolated), not the conv id.
  const scopeWorktreePath = ctx.worktreePath
  const scopedExisting = listServices({
    ownerId: userId,
    projectId,
    serviceName,
    worktreePath: scopeWorktreePath,
  })
  for (const prev of scopedExisting) {
    const isLive =
      prev.status === "running" ||
      prev.status === "starting" ||
      prev.status === "stopping"
    if (isLive) {
      try {
        await stopServiceAndWait(prev.id, userId)
        console.log(
          `[services.start] stopped previous ${prev.id.slice(0, 8)} (was ${prev.status}) before restart`
        )
      } catch (err) {
        console.warn(
          `[services.start] failed to stop previous ${prev.id.slice(0, 8)}:`,
          (err as Error).message
        )
      }
    }
    try {
      removeService(prev.id, userId)
    } catch {
      /* entry may have been GC'd already; ignore */
    }
  }

  try {
    // Port preference is split in two:
    //   strictPort = the user (or their per-task override) explicitly set
    //                this in the manifest. Strictly enforced — fails with a
    //                clear error if the port is taken. We will NOT silently
    //                swap to a different port; users who hardcode 3000 want
    //                3000 (or to know it's busy), not a magic substitution.
    //   stickyPort = sticky from a previous run (project_services.assigned_port
    //                or the legacy conversations.assigned_port). Tried first
    //                so localhost:<port> URLs stay stable across restarts;
    //                falls back to auto-allocate from the sandbox range if
    //                taken. body.overrides.port also counts as "the user just
    //                set this port" if present.
    const userSetPort = body.overrides?.port ?? ctx.override?.port ?? ctx.serviceRow?.port ?? null
    const stickyPort = ctx.assignedPort ?? null
    const snap = await startService(
      effective,
      {
        ownerId: userId,
        projectId,
        serviceName,
        worktreePath: scopeWorktreePath,
        label: body.label ?? null,
      },
      { strictPort: userSetPort, stickyPort, runnerId: body.runnerId }
    )
    // Persist assigned_port so localhost:<port> stays stable across restarts.
    // Write to the service row (forward path); also mirror to conversations
    // for one release so existing readers of conv.assigned_port don't regress.
    if (sb && snap.port && ctx.serviceRow && ctx.serviceRow.assigned_port !== snap.port) {
      try {
        await patchProjectService(sb, projectId, serviceName, {
          assigned_port: snap.port,
        })
      } catch (err) {
        console.warn("[services.start] failed to persist assigned_port on service row:", err)
      }
    }
    if (conversationId && sb && ctx.assignedPort !== snap.port) {
      await sb
        .from("conversations")
        .update({ assigned_port: snap.port })
        .eq("id", conversationId)
    }

    // Persist instance metadata so a server restart can reconcile (either
    // reattach the live process or mark the row stopped). Logs stay in
    // memory — reattached instances show a placeholder line.
    attachInstancePersistence(snap, body.label ?? null)

    // Attach the supervisor (auto-restart on crash) if the service row
    // asks for it. Survives crashes of individual instances; resets the
    // restart counter when an instance stays up past a grace period.
    if (ctx.serviceRow && ctx.serviceRow.restart_policy !== "never") {
      attachSupervisor({
        userId,
        projectId,
        serviceName,
        worktreePath: scopeWorktreePath,
        conversationId: conversationId ?? null,
        label: body.label ?? null,
        runnerId: body.runnerId,
        manifest: effective,
        snap,
        policy: ctx.serviceRow.restart_policy,
        maxRestarts: ctx.serviceRow.max_restarts,
      })
    }

    return c.json(snap)
  } catch (err) {
    if (err instanceof RuntimeError) {
      return c.json({ error: err.message, code: err.code }, runtimeErrorStatus(err.code))
    }
    return c.json({ error: (err as Error).message }, 500)
  }
  } // end doStart()
})

// Read the project's manifest state: what's cached (stored default), what
// detection currently proposes, and what would actually run. The UI calls
// this on Run-click when there's no cached row, to drive the confirm dialog.
// Optional `conversationId` query: when set, the heuristic detect runs in
// the conversation's worktree (`conversations.worktree_path`) instead of the
// project base cwd. Without it, a task-conversation's detect would miss
// anything the agent built inside the worktree.
app.get("/api/projects/:id/manifest", async (c) => {
  const projectId = c.req.param("id")
  const userId = c.get("userId")
  const conversationId = c.req.query("conversationId") || undefined

  const ctx = await loadManifestContext(userId, projectId, conversationId)
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
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const body = await c.req.json<{ userId?: string; manifest?: unknown }>().catch(() => ({}))
  const userId = c.get("userId")

  const manifest = sanitizeManifest(body.manifest)
  if (!manifest) return c.json({ error: "invalid manifest — need at least { start: string }" }, 400)

  const { data: project } = await sb
    .from("projects")
    .select("id, user_id")
    .eq("id", projectId)
    .single()
  if (!project) return c.json({ error: "project not found" }, 404)

  const toStore: Record<string, unknown> = { ...manifest }
  delete toStore.cwd // never store cwd; always derived at run time

  // Forward path: write to project_services[default]. Mirror to the legacy
  // projects.run_manifest column for one release so rollback is safe.
  try {
    await upsertProjectService(sb, projectId, writeFromManifest("default", manifest))
  } catch (err) {
    return c.json({ error: `failed to save service: ${(err as Error).message}` }, 500)
  }
  const { error } = await sb
    .from("projects")
    .update({ run_manifest: toStore })
    .eq("id", projectId)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true, manifest: toStore })
})

app.delete("/api/projects/:id/manifest", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const userId = c.get("userId")

  const { data: project } = await sb
    .from("projects")
    .select("id, user_id")
    .eq("id", projectId)
    .single()
  if (!project) return c.json({ error: "project not found" }, 404)

  // Delete the default service row and clear the legacy column together.
  try {
    await deleteProjectService(sb, projectId, "default")
  } catch (err) {
    console.warn("[manifest] delete default service row failed:", err)
  }
  const { error } = await sb
    .from("projects")
    .update({ run_manifest: null })
    .eq("id", projectId)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})

// ─── Plural service CRUD ────────────────────────────────────────────────────
// Per-project service configurations (web, api, worker, …). One row per
// service. The legacy /api/projects/:id/manifest endpoints keep working and
// read/write the default service row; these endpoints are the new surface
// for multi-service setups.

function sanitizeServiceWrite(raw: unknown, fallbackName?: string): ProjectServiceWrite | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : fallbackName
  if (!name) return null
  if (typeof r.start !== "string" || !r.start.trim()) return null
  const out: ProjectServiceWrite = {
    name,
    stack: typeof r.stack === "string" && r.stack ? r.stack : "custom",
    start: r.start,
  }
  if (typeof r.description === "string" || r.description === null) out.description = r.description as string | null
  if (typeof r.build === "string" || r.build === null) out.build = r.build as string | null
  if (r.env && typeof r.env === "object") out.env = r.env as Record<string, string>
  if (typeof r.port === "number" || r.port === null) out.port = r.port as number | null
  if (typeof r.dockerfile === "string" || r.dockerfile === null) out.dockerfile = r.dockerfile as string | null
  if (
    r.healthcheck &&
    typeof r.healthcheck === "object" &&
    typeof (r.healthcheck as Record<string, unknown>).path === "string" &&
    typeof (r.healthcheck as Record<string, unknown>).timeoutMs === "number"
  ) {
    out.healthcheck = r.healthcheck as ProjectServiceWrite["healthcheck"]
  } else if (r.healthcheck === null) {
    out.healthcheck = null
  }
  if (typeof r.enabled === "boolean") out.enabled = r.enabled
  if (typeof r.order_index === "number") out.order_index = r.order_index
  if (
    r.restart_policy === "always" ||
    r.restart_policy === "on-failure" ||
    r.restart_policy === "never"
  ) {
    out.restart_policy = r.restart_policy
  }
  if (typeof r.max_restarts === "number") out.max_restarts = r.max_restarts
  if (typeof r.assigned_port === "number" || r.assigned_port === null) {
    out.assigned_port = r.assigned_port as number | null
  }
  return out
}

app.get("/api/projects/:id/services", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const userId = c.get("userId")
  const { data: project } = await sb.from("projects").select("id").eq("id", projectId).single()
  if (!project) return c.json({ error: "project not found" }, 404)
  const rows = await listProjectServices(sb, projectId)
  return c.json({ services: rows })
})

app.post("/api/projects/:id/services", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const body = await c.req.json<{ userId?: string; service?: unknown }>().catch(() => ({}))
  const userId = c.get("userId")
  const { data: project } = await sb.from("projects").select("id").eq("id", projectId).single()
  if (!project) return c.json({ error: "project not found" }, 404)

  const write = sanitizeServiceWrite(body.service)
  if (!write) return c.json({ error: "invalid service — need at least { name, start }" }, 400)

  // Reject collisions — POST is strictly create; use PUT to update.
  const existing = await getProjectService(sb, projectId, write.name)
  if (existing) return c.json({ error: `service '${write.name}' already exists` }, 409)
  try {
    const row = await upsertProjectService(sb, projectId, write)
    return c.json(row)
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})

// Multi-service heuristic detect. Scans the project cwd (or the active
// conversation's worktree) and returns every plausible runnable service —
// root + one-level subdirs + apps/*, services/*, packages/* on common
// monorepo layouts. Each candidate carries an `alreadySaved` flag so the
// picker UI can dim rows that match an existing project_services row.
//
// REGISTRATION ORDER MATTERS: this must come BEFORE the `:name` routes
// below — otherwise Hono matches "detect" as a service name and 404s with
// "service not found". Same reason /api/services/runners sits before
// /api/services/:id further down.
app.get("/api/projects/:id/services/detect", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const userId = c.get("userId")
  const conversationId = c.req.query("conversationId") || undefined
  // Resolve cwd: prefer the conversation's worktree when present so a task's
  // monorepo view shows what the user has actually built in it.
  const { data: project } = await sb
    .from("projects")
    .select("id, cwd")
    .eq("id", projectId)
    .single()
  if (!project) return c.json({ error: "project not found" }, 404)
  let cwd = resolveProjectCwd(project.cwd)
  if (conversationId) {
    const { data: conv } = await sb
      .from("conversations")
      .select("worktree_path, project_id")
      .eq("id", conversationId)
      .single()
    if (conv && conv.project_id === projectId && conv.worktree_path) {
      cwd = resolve(conv.worktree_path)
    }
  }

  const [candidates, existing] = await Promise.all([
    detectAllServices(cwd).catch(() => [] as Awaited<ReturnType<typeof detectAllServices>>),
    listProjectServices(sb, projectId).catch(() => [] as ProjectServiceRow[]),
  ])
  const existingByName = new Set(existing.map((r) => r.name))

  return c.json({
    cwd,
    candidates: candidates.map((cand) => ({
      ...cand,
      alreadySaved: existingByName.has(cand.name),
    })),
  })
})

// AI (LLM) multi-service detect. Synchronous single-shot LLM call — the
// model inspects the tree with read-only tools and returns every service
// it thinks is runnable, via a `<run-services>` block. Returns the
// proposals to the caller rather than auto-saving; the picker decides
// which ones to persist.
//
// For the conversation-aware "configure via chat" path, see
// POST /api/conversations/:id/detect-services — that one runs inside the
// chat's runner and reconcile auto-saves after the turn.
app.post("/api/projects/:id/services/detect-llm", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const body = await c.req.json<{ userId?: string; conversationId?: string }>().catch(() => ({}))
  const userId = c.get("userId")
  const { data: project } = await sb
    .from("projects")
    .select("id, cwd")
    .eq("id", projectId)
    .single()
  if (!project) return c.json({ error: "project not found" }, 404)
  let cwd = resolveProjectCwd(project.cwd)
  if (body.conversationId) {
    const { data: conv } = await sb
      .from("conversations")
      .select("worktree_path, project_id")
      .eq("id", body.conversationId)
      .single()
    if (conv && conv.project_id === projectId && conv.worktree_path) {
      cwd = resolve(conv.worktree_path)
    }
  }

  // Existing rows inform the model so it proposes ADDITIONS / refinements
  // rather than duplicates. Empty list = first-time setup.
  let existing: Array<{ name: string; stack: string; start: string; port?: number | null }> = []
  try {
    const rows = await listProjectServices(sb, projectId)
    existing = rows.map((r) => ({
      name: r.name,
      stack: r.stack,
      start: r.start,
      port: r.port,
    }))
  } catch {
    /* advisory */
  }

  const result = await detectServicesWithLLM({ cwd, existingServices: existing })
  const existingByName = new Set(existing.map((r) => r.name))
  return c.json({
    cwd,
    proposals: result.proposals.map((p) => ({
      name: p.name,
      stack: p.stack,
      start: p.start,
      build: p.build,
      env: p.env ?? {},
      port: p.port,
      subdir: "",                // LLM embeds any `cd <subdir>` in `start`
      rationale: p.rationale,
      confidence: p.confidence,
      alreadySaved: existingByName.has(p.name),
    })),
    costUsd: result.costUsd,
    error: result.error ?? null,
    rawPreview: result.error && result.raw ? result.raw.slice(0, 400) : null,
  })
})

app.get("/api/projects/:id/services/:name", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const name = c.req.param("name")
  const userId = c.get("userId")
  const { data: project } = await sb.from("projects").select("id").eq("id", projectId).single()
  if (!project) return c.json({ error: "project not found" }, 404)
  const row = await getProjectService(sb, projectId, name)
  if (!row) return c.json({ error: "service not found" }, 404)
  return c.json(row)
})

app.put("/api/projects/:id/services/:name", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const name = c.req.param("name")
  const body = await c.req.json<{ userId?: string; service?: unknown }>().catch(() => ({}))
  const userId = c.get("userId")
  const { data: project } = await sb.from("projects").select("id").eq("id", projectId).single()
  if (!project) return c.json({ error: "project not found" }, 404)

  // URL path wins on name — clients renaming a service do it via DELETE+POST.
  const write = sanitizeServiceWrite(body.service, name)
  if (!write) return c.json({ error: "invalid service — need at least { start }" }, 400)
  write.name = name

  try {
    const row = await upsertProjectService(sb, projectId, write)
    // Keep legacy column mirrored for the default service during rollout so
    // downstream readers we haven't migrated yet see the same data.
    if (name === "default") {
      const manifestShape: Record<string, unknown> = {
        stack: row.stack,
        start: row.start,
        env: row.env ?? {},
      }
      if (row.build) manifestShape.build = row.build
      if (row.port != null) manifestShape.port = row.port
      if (row.dockerfile) manifestShape.dockerfile = row.dockerfile
      if (row.healthcheck) manifestShape.healthcheck = row.healthcheck
      await sb
        .from("projects")
        .update({ run_manifest: manifestShape })
        .eq("id", projectId)
    }
    return c.json(row)
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})

app.delete("/api/projects/:id/services/:name", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const name = c.req.param("name")
  const userId = c.get("userId")
  const { data: project } = await sb.from("projects").select("id").eq("id", projectId).single()
  if (!project) return c.json({ error: "project not found" }, 404)

  try {
    await deleteProjectService(sb, projectId, name)
    if (name === "default") {
      await sb.from("projects").update({ run_manifest: null }).eq("id", projectId)
    }
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})

// Ask the LLM to inspect the project cwd and propose a run manifest. Used by
// the UI to pre-fill the first-run editor with a smart suggestion when the
// heuristic detector can't see the whole picture (README-only configs, custom
// framework conventions, etc.). Does NOT persist — caller saves via PUT after
// the user confirms.
app.post("/api/projects/:id/manifest/detect-llm", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const body = await c.req.json<{ userId?: string }>().catch(() => ({}))
  const userId = c.get("userId")

  const { data: project } = await sb
    .from("projects")
    .select("id, user_id, cwd")
    .eq("id", projectId)
    .single()
  if (!project) return c.json({ error: "project not found" }, 404)

  const cwd = resolveProjectCwd(project.cwd)

  // Run the heuristic detector in parallel as a fallback — cheaper and
  // instant, so if the LLM comes back empty the client still has something.
  const [heuristic, llm] = await Promise.all([
    detectManifest(cwd).catch(() => null),
    detectManifestWithLLM({ cwd }),
  ])

  return c.json({
    cwd,
    heuristic,
    llm: {
      proposal: llm.proposal,
      rationale: llm.proposal?.rationale ?? "",
      confidence: llm.proposal?.confidence ?? null,
      costUsd: llm.costUsd,
      error: llm.error ?? null,
      // Surface truncated raw output when parsing failed so the UI can show
      // something more actionable than "it failed". Capped at 400 chars so we
      // don't pipe huge model dumps through the wire.
      rawPreview: llm.error && llm.raw ? llm.raw.slice(0, 400) : null,
    },
  })
})

app.get("/api/conversations/:id/manifest", async (c) => {
  const sb = c.get("sb")
  const conversationId = c.req.param("id")
  const userId = c.get("userId")

  const { data: conv } = await sb
    .from("conversations")
    .select("id, user_id, project_id, worktree_path, run_manifest_override, assigned_port")
    .eq("id", conversationId)
    .single()
  if (!conv) return c.json({ error: "conversation not found" }, 404)

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
  const sb = c.get("sb")
  const conversationId = c.req.param("id")
  const body = await c.req.json<{ userId?: string; override?: unknown }>().catch(() => ({}))
  const userId = c.get("userId")

  const override = sanitizeOverride(body.override)
  if (!override) return c.json({ error: "invalid override — need at least one manifest field" }, 400)

  const { data: conv } = await sb
    .from("conversations")
    .select("id, user_id")
    .eq("id", conversationId)
    .single()
  if (!conv) return c.json({ error: "conversation not found" }, 404)

  const { error } = await sb
    .from("conversations")
    .update({ run_manifest_override: override })
    .eq("id", conversationId)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true, override })
})

app.delete("/api/conversations/:id/manifest-override", async (c) => {
  const sb = c.get("sb")
  const conversationId = c.req.param("id")
  const userId = c.get("userId")

  const { data: conv } = await sb
    .from("conversations")
    .select("id, user_id")
    .eq("id", conversationId)
    .single()
  if (!conv) return c.json({ error: "conversation not found" }, 404)

  const { error } = await sb
    .from("conversations")
    .update({ run_manifest_override: null })
    .eq("id", conversationId)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})

// ─── Plural conversation overrides (per-service) ────────────────────────────
// Per-conversation, per-service manifest override. Sparse — most tasks
// don't have any overrides. The column is `conversations.service_overrides`
// (jsonb map keyed by service name). See docs/MULTI-SERVICE.md.

app.get("/api/conversations/:id/services/:name/override", async (c) => {
  const sb = c.get("sb")
  const conversationId = c.req.param("id")
  const serviceName = c.req.param("name")
  const userId = c.get("userId")
  const { data: conv } = await sb.from("conversations").select("id").eq("id", conversationId).single()
  if (!conv) return c.json({ error: "conversation not found" }, 404)
  const override = await getConversationServiceOverride(sb, conversationId, serviceName)
  return c.json({ override })
})

app.put("/api/conversations/:id/services/:name/override", async (c) => {
  const sb = c.get("sb")
  const conversationId = c.req.param("id")
  const serviceName = c.req.param("name")
  const body = await c.req.json<{ userId?: string; override?: unknown }>().catch(() => ({}))
  const userId = c.get("userId")
  const { data: conv } = await sb
    .from("conversations")
    .select("id, project_id")
    .eq("id", conversationId)
    .single()
  if (!conv) return c.json({ error: "conversation not found" }, 404)

  // Non-default services MUST have a project_services row before overrides
  // can be written. Without this guard the override gets persisted to a
  // service that doesn't exist — silent data corruption (the override
  // either sits dead in JSONB or applies to a future service of the same
  // name). The "default" service has the legacy run_manifest fallback so
  // it's allowed to receive overrides without an explicit row.
  if (serviceName !== "default") {
    if (!conv.project_id) {
      return c.json({ error: "conversation has no project" }, 422)
    }
    const existing = await getProjectService(sb, conv.project_id as string, serviceName)
    if (!existing) {
      return c.json(
        {
          error: `service '${serviceName}' is not configured for this project — create it before saving an override`,
        },
        404
      )
    }
  }

  const override = sanitizeOverride(body.override)
  if (!override) return c.json({ error: "invalid override — need at least one manifest field" }, 400)

  try {
    await setConversationServiceOverride(sb, conversationId, serviceName, override)
    return c.json({ ok: true, override })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})

app.delete("/api/conversations/:id/services/:name/override", async (c) => {
  const sb = c.get("sb")
  const conversationId = c.req.param("id")
  const serviceName = c.req.param("name")
  const userId = c.get("userId")
  const { data: conv } = await sb.from("conversations").select("id").eq("id", conversationId).single()
  if (!conv) return c.json({ error: "conversation not found" }, 404)
  try {
    await setConversationServiceOverride(sb, conversationId, serviceName, null)
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})

// ─── Env vars: project + conversation layers ────────────────────────────────
// See docs/ENV-AND-SERVICES.md. Three persisted layers in resolution order:
//   1. project_env_vars       — shared across all chats and tasks in a project
//   2. conversation_env_vars  — per-task overrides; FK CASCADE on conversation delete
//   3. project_services.env   — per-service overrides (already covered by services CRUD)
// Plus runtime layers (system metadata, auto-injected service-discovery
// vars, framework-specific PORT aliases) — populated at process spawn,
// not editable here.

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

type EnvVarBody = {
  key?: string
  value?: string
  is_secret?: boolean
  description?: string | null
}

function maskSecret(v: { value: string; is_secret: boolean }): { value: string; is_secret: boolean } {
  return v.is_secret ? { value: "", is_secret: true } : { value: v.value, is_secret: false }
}

// Project-shared env. Ownership flows via projects.user_id under RLS.
app.get("/api/projects/:id/env", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const { data, error } = await sb
    .from("project_env_vars")
    .select("id, key, value, is_secret, description, updated_at")
    .eq("project_id", projectId)
    .order("key", { ascending: true })
  if (error) return c.json({ error: error.message }, 500)
  // Mask secret values on the wire — once saved, they're never re-emitted.
  const rows = (data ?? []).map((r) => ({
    ...r,
    ...maskSecret({ value: r.value as string, is_secret: !!r.is_secret }),
  }))
  return c.json({ env: rows })
})

app.put("/api/projects/:id/env/:key", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const key = c.req.param("key")
  if (!ENV_KEY_RE.test(key)) {
    return c.json({ error: "invalid env var name (POSIX: letters/digits/underscore, no leading digit)" }, 400)
  }
  const body = await c.req.json<EnvVarBody>().catch(() => ({}))
  if (typeof body.value !== "string") return c.json({ error: "value required" }, 400)
  const isSecret = !!body.is_secret
  // Encrypt at rest if secret. For non-secrets we still pass the raw string;
  // RLS + service-role split prevents leakage to other users.
  const storedValue = isSecret ? encryptToken(body.value) : body.value
  const { data, error } = await sb
    .from("project_env_vars")
    .upsert(
      {
        project_id: projectId,
        key,
        value: storedValue,
        is_secret: isSecret,
        description: body.description ?? null,
      },
      { onConflict: "project_id,key" }
    )
    .select("id, key, is_secret, description, updated_at")
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ env: data })
})

app.delete("/api/projects/:id/env/:key", async (c) => {
  const sb = c.get("sb")
  const projectId = c.req.param("id")
  const key = c.req.param("key")
  const { error } = await sb
    .from("project_env_vars")
    .delete()
    .eq("project_id", projectId)
    .eq("key", key)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})

// Per-conversation (worktree) env overrides. Same shape, scoped to a
// conversation. RLS ownership flows via conversations.user_id.
app.get("/api/conversations/:id/env", async (c) => {
  const sb = c.get("sb")
  const conversationId = c.req.param("id")
  const { data, error } = await sb
    .from("conversation_env_vars")
    .select("id, key, value, is_secret, description, updated_at")
    .eq("conversation_id", conversationId)
    .order("key", { ascending: true })
  if (error) return c.json({ error: error.message }, 500)
  const rows = (data ?? []).map((r) => ({
    ...r,
    ...maskSecret({ value: r.value as string, is_secret: !!r.is_secret }),
  }))
  return c.json({ env: rows })
})

app.put("/api/conversations/:id/env/:key", async (c) => {
  const sb = c.get("sb")
  const conversationId = c.req.param("id")
  const key = c.req.param("key")
  if (!ENV_KEY_RE.test(key)) {
    return c.json({ error: "invalid env var name" }, 400)
  }
  const body = await c.req.json<EnvVarBody>().catch(() => ({}))
  if (typeof body.value !== "string") return c.json({ error: "value required" }, 400)
  const isSecret = !!body.is_secret
  const storedValue = isSecret ? encryptToken(body.value) : body.value
  const { data, error } = await sb
    .from("conversation_env_vars")
    .upsert(
      {
        conversation_id: conversationId,
        key,
        value: storedValue,
        is_secret: isSecret,
        description: body.description ?? null,
      },
      { onConflict: "conversation_id,key" }
    )
    .select("id, key, is_secret, description, updated_at")
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ env: data })
})

app.delete("/api/conversations/:id/env/:key", async (c) => {
  const sb = c.get("sb")
  const conversationId = c.req.param("id")
  const key = c.req.param("key")
  const { error } = await sb
    .from("conversation_env_vars")
    .delete()
    .eq("conversation_id", conversationId)
    .eq("key", key)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})

app.post("/api/services/:id/stop", async (c) => {
  const id = c.req.param("id")
  const body = await c.req.json<{ userId?: string }>().catch(() => ({}))
  const userId = c.get("userId")
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
  const userId = c.get("userId")
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

// Cross-project listing for the global running-services drawer. Returns
// services for the user across every project + worktree, plus a small
// metadata side-channel so the client can group by Project → Worktree
// without N extra lookups. Used by the top-bar chip + drawer.
app.get("/api/services/all", async (c) => {
  const sb = c.get("sb")
  const userId = c.get("userId")
  const services = listServices({ ownerId: userId })

  // Side-channel: project names + conversation titles for the ids actually
  // present in the running set. RLS filters; non-owned ids drop out.
  const projectIds = Array.from(new Set(services.map((s) => s.projectId).filter(Boolean)))
  const conversationIds = Array.from(
    new Set(
      services
        .map((s) => s.worktreePath ? s.worktreePath : null)
        .filter((p): p is string => !!p)
    )
  )
  const [projects, conversations] = await Promise.all([
    projectIds.length
      ? sb.from("projects").select("id, name, cwd").in("id", projectIds)
      : Promise.resolve({ data: [] }),
    conversationIds.length
      ? sb
          .from("conversations")
          .select("id, title, kind, worktree_path, branch")
          .in("worktree_path", conversationIds)
      : Promise.resolve({ data: [] }),
  ])
  return c.json({
    services,
    projects: projects.data ?? [],
    conversations: conversations.data ?? [],
  })
})

// Stop services in bulk by scope. Confirms are the client's job; the server
// just enumerates instances matching the filter and stops each. Returns the
// count actually stopped (which may be less than matched if some were
// already stopping). Idempotent.
//
// Body: { scope, projectId?, worktreePath?, instanceIds? }
//   scope: "user" — every instance for the calling user
//        : "project" — every instance for one project (across worktrees)
//        : "project-chats" — instances on the project cwd (worktreePath = null)
//        : "worktree" — one worktree's instances (project + worktreePath)
app.post("/api/services/stop-scope", async (c) => {
  const userId = c.get("userId")
  const body = await c.req.json<{
    scope?: string
    projectId?: string
    worktreePath?: string | null
  }>().catch(() => ({}))
  const scope = body.scope
  if (!scope) return c.json({ error: "scope required" }, 400)

  // Build the listServices filter for each scope variant. The runtime's
  // existing 4-tuple is enough — we don't need new filter primitives.
  let toStop: ReturnType<typeof listServices>
  if (scope === "user") {
    toStop = listServices({ ownerId: userId })
  } else if (scope === "project") {
    if (!body.projectId) return c.json({ error: "projectId required for project scope" }, 400)
    toStop = listServices({ ownerId: userId, projectId: body.projectId })
  } else if (scope === "project-chats") {
    if (!body.projectId) return c.json({ error: "projectId required" }, 400)
    toStop = listServices({ ownerId: userId, projectId: body.projectId, worktreePath: null })
  } else if (scope === "worktree") {
    if (!body.projectId || !body.worktreePath) {
      return c.json({ error: "projectId + worktreePath required for worktree scope" }, 400)
    }
    toStop = listServices({
      ownerId: userId,
      projectId: body.projectId,
      worktreePath: body.worktreePath,
    })
  } else {
    return c.json({ error: `unknown scope: ${scope}` }, 400)
  }

  // Settle all stops in parallel; tolerate per-instance failure (an instance
  // may have already exited between list and stop).
  const results = await Promise.allSettled(
    toStop.map((s) => stopServiceAndWait(s.id, userId))
  )
  const stopped = results.filter((r) => r.status === "fulfilled").length
  return c.json({ matched: toStop.length, stopped })
})

app.get("/api/services", (c) => {
  const userId = c.get("userId")
  const projectId = c.req.query("projectId") ?? undefined
  const serviceName = c.req.query("serviceName") ?? undefined
  // `worktreePath` is the authoritative scope discriminator. Accept:
  //   - absent / "undefined" → no filter (legacy list-all-in-project)
  //   - "null"               → only the null bucket (chats on main cwd)
  //   - any other string     → exact path match (task worktrees)
  const wpRaw = c.req.query("worktreePath")
  let worktreePath: string | null | undefined
  if (wpRaw === undefined || wpRaw === "undefined") worktreePath = undefined
  else if (wpRaw === "null" || wpRaw === "") worktreePath = null
  else worktreePath = wpRaw
  return c.json({
    services: listServices({
      ownerId: userId,
      projectId,
      serviceName,
      worktreePath,
    }),
  })
})

app.get("/api/services/:id", (c) => {
  const id = c.req.param("id")
  const userId = c.get("userId")
  const snap = getService(id, userId)
  if (!snap) return c.json({ error: "service not found" }, 404)
  return c.json(snap)
})

app.get("/api/services/:id/logs", (c) => {
  const id = c.req.param("id")
  const userId = c.get("userId")
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

// ─── Integrations: per-user provider tokens ─────────────────────────────────
// Phase 5 Slice 1. One row per (user, provider) in user_integrations; tokens
// are AES-GCM encrypted at rest. Each provider gets its own connect/status/
// disconnect endpoint under /api/integrations/:provider/* — keeps provider-
// specific validation (e.g. Railway's `me` GraphQL probe) out of the schema
// layer.

type IntegrationProvider = "railway"

type PublicIntegrationRow = {
  provider: IntegrationProvider
  account: Record<string, unknown> | null
  connected_at: string
  updated_at: string
}

async function loadIntegrationToken(
  userId: string,
  provider: IntegrationProvider
): Promise<string | null> {
  if (!sbSystem) return null
  const { data } = await sbSystem
    .from("user_integrations")
    .select("token_ciphertext")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle()
  if (!data?.token_ciphertext) return null
  try {
    return decryptToken(data.token_ciphertext as string)
  } catch (err) {
    console.error("[integrations] decrypt failed", provider, (err as Error).message)
    return null
  }
}

app.post("/api/integrations/railway/connect", async (c) => {
  const sb = c.get("sb")
  const body = await c.req.json<{ userId?: string; token?: string }>().catch(() => ({}))
  const userId = c.get("userId")
  const token = body.token?.trim()
  if (!token) return c.json({ error: "token required" }, 400)

  let me
  try {
    me = await railwayFetchMe(token)
  } catch (err) {
    if (err instanceof RailwayApiError) {
      return c.json({ error: err.message }, err.status === 401 || err.status === 403 ? 401 : 502)
    }
    return c.json({ error: `Railway unreachable: ${(err as Error).message}` }, 502)
  }

  let ciphertext: string
  try {
    ciphertext = encryptToken(token)
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }

  const account = {
    id: me.id,
    username: me.username,
    email: me.email,
    name: me.name,
  }
  const { error } = await sb
    .from("user_integrations")
    .upsert(
      {
        user_id: userId,
        provider: "railway",
        token_ciphertext: ciphertext,
        account,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider" }
    )
  if (error) return c.json({ error: error.message }, 500)

  return c.json({
    provider: "railway",
    account,
    connected_at: new Date().toISOString(),
  })
})

app.get("/api/integrations/railway", async (c) => {
  const sb = c.get("sb")
  const userId = c.get("userId")
  const { data } = await sb
    .from("user_integrations")
    .select("provider, account, connected_at, updated_at")
    .eq("user_id", userId)
    .eq("provider", "railway")
    .maybeSingle<PublicIntegrationRow>()
  if (!data) return c.json({ connected: false })
  return c.json({ connected: true, ...data })
})

app.delete("/api/integrations/railway", async (c) => {
  const sb = c.get("sb")
  const userId = c.get("userId")
  const { error } = await sb
    .from("user_integrations")
    .delete()
    .eq("user_id", userId)
    .eq("provider", "railway")
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
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
  if (!sbSystem) return
  const { data: projects, error } = await sbSystem
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
    const { data: rows } = await sbSystem
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
  // Fire-and-forget: reattach or reap service instances that outlived the
  // last process. Safe to run on every boot — idempotent. Errors are
  // logged inside the helper; nothing else waits on this.
  void reconcileServiceInstances()
})

// ── Terminal PTY over WebSocket ──────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true })

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`)
  if (url.pathname !== "/api/terminal") {
    socket.destroy()
    return
  }
  // Gate WS upgrade on a valid Supabase JWT, delivered in ?access_token=
  // (WebSocket has no way to set Authorization on the handshake request).
  const token = url.searchParams.get("access_token") ?? ""
  if (!token || !sbSystem) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
    socket.destroy()
    return
  }
  const conversationId = url.searchParams.get("conversationId") ?? ""
  if (!conversationId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n")
    socket.destroy()
    return
  }

  void (async () => {
    const sbClient = sbSystem
    if (!sbClient) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n")
      socket.destroy()
      return
    }

    const { data, error } = await sbClient.auth.getUser(token)
    if (error || !data.user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }
    const userId = data.user.id

    // Ownership check: the conversation must belong to the authed user.
    // Derives cwd from the conversation (worktree for tasks, project cwd
    // for chats) so the PTY is sandboxed to the user's own workspace.
    const { data: conv } = await sbClient
      .from("conversations")
      .select("id, user_id")
      .eq("id", conversationId)
      .single()
    if (!conv || conv.user_id !== userId) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n")
      socket.destroy()
      return
    }

    const cwd = await cwdForConversation(conversationId)

    wss.handleUpgrade(req, socket, head, (ws) => {
      const r = req as unknown as { userId?: string; cwd?: string }
      r.userId = userId
      r.cwd = cwd
      wss.emit("connection", ws, req)
    })
  })()
})

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`)
  // cwd is set by the upgrade handler after validating conversation ownership;
  // never trust a URL-supplied cwd (that's how terminals end up in /etc).
  const cwd = (req as unknown as { cwd?: string }).cwd ?? WORKSPACE_DIR
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
