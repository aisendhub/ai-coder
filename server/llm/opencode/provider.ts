import os from "node:os"
import path from "node:path"
import { promises as fsp } from "node:fs"
import type {
  AgentMessage,
  AgentRunOptions,
  AgentUserMessage,
  LlmProvider,
} from "../provider.ts"
import {
  OpenCodeEventMapper,
  type DoneReason,
  type OpenCodeEvent,
} from "./events.ts"
import {
  formatModelRef,
  parseModelRef,
  toAgentModel,
  type AgentModel,
  type OpenCodeModelRef,
} from "./models.ts"

// OpenCode provider. Built behind `LLM_PROVIDER=opencode`; it is NOT the
// default. The existing chat runner consumes Claude-SDK-shaped messages, so
// this adapter translates OpenCode's event stream back into that shape. The
// translation lives in events.ts and is unit-tested independently.

export type OpenCodePermissionDecision = "once" | "always" | "reject"

export type OpenCodePermissionRequest = {
  id: string
  sessionID: string
  action: string
  resources: string[]
  message?: string
}

export type OpenCodeRunOptions = AgentRunOptions & {
  onPermission?: (
    request: OpenCodePermissionRequest
  ) => OpenCodePermissionDecision | Promise<OpenCodePermissionDecision>
}

type PermissionRule = {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

type PromptFile = {
  uri: string
  name?: string
  source?: { type: "inline" } | { type: "uri"; uri: string }
}

export type OpenCodeHost = {
  sessions: {
    create(input: Record<string, unknown>): Promise<any>
    get(input: { sessionID: string }): Promise<any>
    prompt(input: Record<string, unknown>): Promise<any>
    switchModel?(input: { sessionID: string; model: OpenCodeModelRef }): Promise<void>
    interrupt?(input: { sessionID: string; resume?: boolean }): Promise<any>
  }
  events: {
    subscribe(options?: Record<string, unknown>): AsyncIterable<OpenCodeEvent>
  }
  permission: {
    reply(input: {
      sessionID: string
      requestID: string
      decision: OpenCodePermissionDecision
      message?: string
    }): Promise<void>
  }
  model: {
    list(input?: { location?: { directory?: string } }): Promise<{ data: any[] }>
  }
  experimental?: {
    session?: {
      instructions?: {
        entry?: {
          put(input: {
            sessionID: string
            key: string
            value: unknown
          }): Promise<void>
        }
      }
    }
  }
  close?(): Promise<void>
}

export type OpenCodeHostFactory = () => Promise<OpenCodeHost>

const DEFAULT_STALL_TIMEOUT_MS = 90_000
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000

function stallTimeoutMs(): number {
  const value = Number(process.env.OPENCODE_STALL_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STALL_TIMEOUT_MS
}

function turnTimeoutMs(): number {
  const value = Number(process.env.OPENCODE_TURN_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TURN_TIMEOUT_MS
}

const EVENT_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.step.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.usage.updated",
  "session.retry.scheduled",
  "permission.asked",
] as const

const EDIT_TOOLS = ["edit", "write", "multiedit", "notebookedit"]
const SHELL_TOOLS = ["bash", "shell"]

function dedupeRules(rules: PermissionRule[]): PermissionRule[] {
  const seen = new Set<string>()
  return rules.filter((r) => {
    const key = `${r.action}:${r.resource}:${r.effect}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Translate Claude-style allowed/disallowed tool lists into OpenCode
 *  permission rules. The evaluator passes Read/Glob/Grep, which must not edit
 *  or run shell commands. */
export function permissionsFor(opts: AgentRunOptions): PermissionRule[] | undefined {
  const allowed = new Set((opts.allowedTools ?? []).map((t) => t.toLowerCase()))
  const denied = new Set((opts.disallowedTools ?? []).map((t) => t.toLowerCase()))
  const rules: PermissionRule[] = []

  const editAllowed =
    EDIT_TOOLS.some((t) => allowed.has(t)) &&
    !EDIT_TOOLS.some((t) => denied.has(t))
  const shellAllowed =
    SHELL_TOOLS.some((t) => allowed.has(t)) &&
    !SHELL_TOOLS.some((t) => denied.has(t))

  if ((opts.allowedTools?.length ?? 0) > 0) {
    if (!editAllowed) rules.push({ action: "edit", resource: "*", effect: "deny" })
    if (!shellAllowed) rules.push({ action: "shell", resource: "*", effect: "deny" })
  }

  if (EDIT_TOOLS.some((t) => denied.has(t))) {
    rules.push({ action: "edit", resource: "*", effect: "deny" })
  }
  if (SHELL_TOOLS.some((t) => denied.has(t))) {
    rules.push({ action: "shell", resource: "*", effect: "deny" })
  }

  if (opts.permissionMode === "plan") {
    rules.push({ action: "edit", resource: "*", effect: "deny" })
    rules.push({ action: "shell", resource: "*", effect: "deny" })
  }

  return rules.length > 0 ? dedupeRules(rules) : undefined
}

export async function normalizePrompt(
  prompt: AgentRunOptions["prompt"]
): Promise<{ text: string; files: PromptFile[] }> {
  if (typeof prompt === "string") return { text: prompt, files: [] }

  const texts: string[] = []
  const files: PromptFile[] = []

  for await (const msg of prompt as AsyncIterable<AgentUserMessage>) {
    const content = msg.message.content
    if (typeof content === "string") {
      texts.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as any[]) {
      if (!block || typeof block !== "object") continue
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text)
      } else if (
        (block.type === "image" || block.type === "document") &&
        block.source?.type === "base64" &&
        typeof block.source.data === "string"
      ) {
        const mime =
          block.source.media_type ??
          (block.type === "document" ? "application/pdf" : "image/png")
        const uri = `data:${mime};base64,${block.source.data}`
        files.push({
          uri,
          name: block.title ?? block.filename ?? (block.type === "image" ? "image" : "document"),
          source: { type: "inline" },
        })
      }
    }
  }

  return { text: texts.join("\n"), files }
}

async function defaultCreateHost(): Promise<OpenCodeHost> {
  // Dynamic import: the provider must not load the OpenCode runtime (or its
  // native deps) unless `LLM_PROVIDER=opencode` is actually selected.
  const { OpenCode } = await import("@opencode/sdk")

  // Every OpenCode client on the machine shares
  // `$XDG_STATE_HOME/opencode/service.json` and therefore the same service
  // process by default. A service started by another app (the CLI/TUI, a
  // previous long-running server) then answers our turns — and when it is
  // wedged we see `spawn EBADF` or turns that never produce an event.
  // Point this process at its own state dir so ai-coder always talks to a
  // service it started, with its own config and database.
  const stateHome =
    process.env.AI_CODER_OPENCODE_STATE_HOME ??
    path.join(os.homedir(), ".local", "state", "ai-coder")
  try {
    await fsp.mkdir(stateHome, { recursive: true })
  } catch {
    /* best effort; the runtime creates it too */
  }
  process.env.XDG_STATE_HOME = stateHome

  const dataDir = process.env.OPENCODE_DATA_DIR
  const configContent =
    process.env.OPENCODE_CONFIG_CONTENT ??
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: process.env.OPENCODE_MODEL ?? "deepseek/deepseek-flash",
      providers: {
        deepseek: { settings: { apiKey: "{env:DEEPSEEK_API_KEY}" } },
      },
      snapshots: false,
    })

  const host = await OpenCode.create({
    config: { content: configContent },
    ...(dataDir ? { database: { path: path.join(dataDir, "opencode.db") } } : {}),
    events: { persist: false },
  })
  return host as unknown as OpenCodeHost
}

async function sessionInfo(host: OpenCodeHost, sessionID: string): Promise<any | null> {
  try {
    return await host.sessions.get({ sessionID })
  } catch {
    return null
  }
}

// Hosts whose event connection has already delivered `server.connected`.
// The marker is per connection, not per subscription, so it must not be
// awaited again on later turns. See runOpenCode.
const primedHosts = new WeakSet<object>()

async function* runOpenCode(
  opts: OpenCodeRunOptions,
  getHost: OpenCodeHostFactory
): AsyncGenerator<AgentMessage, void, unknown> {
  const start = Date.now()
  if (opts.abortController?.signal.aborted) return

  const host = await getHost()
  const modelRef = parseModelRef(opts.model)
  const resume =
    typeof opts.resumeSessionId === "string" && opts.resumeSessionId.startsWith("ses_")
      ? opts.resumeSessionId
      : undefined

  let session: any
  if (resume) {
    session = await host.sessions.get({ sessionID: resume })
    // Only switch when the caller asked for a model; otherwise preserve the
    // session's existing model.
    if (opts.model) {
      await host.sessions.switchModel?.({ sessionID: resume, model: modelRef })
    }
  } else {
    session = await host.sessions.create({
      location: { directory: opts.cwd },
      model: modelRef,
      permissions: permissionsFor(opts),
    })
  }

  const sessionID: string = session.id
  const mapper = new OpenCodeEventMapper({
    sessionId: sessionID,
    model: formatModelRef(modelRef),
    cwd: opts.cwd,
  })

  yield mapper.systemInit()

  // Per-session instructions are additive; they do not leak across sessions.
  const append =
    typeof opts.systemPrompt === "string"
      ? opts.systemPrompt
      : opts.systemPrompt?.append
  if (append) {
    try {
      await host.experimental?.session?.instructions?.entry?.put({
        sessionID,
        key: "ai-coder",
        value: append,
      })
    } catch (err) {
      console.warn("[opencode] instructions.put failed", err)
    }
  }

  const iterator = host.events
    .subscribe({ types: EVENT_TYPES })
    [Symbol.asyncIterator]()

  // Prime the shared event connection before prompting so the first events
  // cannot race the subscription. `server.connected` is the ready marker — but
  // the runtime sends it once per connection, so a reused host never sends it
  // again. Waiting for it on the second turn would block forever, so remember
  // which hosts we have already primed and only wait on a new one.
  const buffered: OpenCodeEvent[] = []
  const firstPromise = iterator.next()
  let pendingFirst: Promise<IteratorResult<OpenCodeEvent>> | null = null
  if (primedHosts.has(host as object)) {
    pendingFirst = firstPromise
  } else {
    const OPENCODE_CONNECT_PRIME_MS = 4_000
    const primed = await Promise.race([
      firstPromise,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), OPENCODE_CONNECT_PRIME_MS)
      ),
    ])
    if (primed === null) {
      // Connection is slow or the marker was already consumed: keep reading
      // in the loop instead of blocking the turn.
      pendingFirst = firstPromise
    } else {
      primedHosts.add(host as object)
      if (!primed.done) {
        const ev = primed.value as OpenCodeEvent
        if (ev.type !== "server.connected") buffered.push(ev)
      }
    }
  }

  const prompt = await normalizePrompt(opts.prompt)
  let promptError: Error | null = null
  const promptPromise = host.sessions
    .prompt({
      sessionID,
      text: prompt.text,
      ...(prompt.files.length > 0 ? { files: prompt.files } : {}),
      delivery: "queue",
    })
    .catch((err: unknown) => {
      promptError = err instanceof Error ? err : new Error(String(err))
    })

  const signal = opts.abortController?.signal
  let aborted = false
  const onAbort = () => {
    aborted = true
    void host.sessions.interrupt?.({ sessionID })
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  const abortPromise = new Promise<"aborted">((resolve) => {
    if (signal?.aborted) resolve("aborted")
    else signal?.addEventListener("abort", () => resolve("aborted"), { once: true })
  })

  let completed = false
  try {
    let pending: OpenCodeEvent | undefined = buffered.shift()
    const turnDeadline = Date.now() + turnTimeoutMs()

    while (true) {
      if (Date.now() > turnDeadline) {
        await host.sessions.interrupt?.({ sessionID })
        throw new Error("OpenCode turn timed out. Try again or start a new chat.")
      }

      // Abort can land between events. Check before waiting for the next one
      // so a finite event stream cannot finish the turn as "success" after the
      // user already pressed Stop.
      if (signal?.aborted) {
        completed = true
        const info = await sessionInfo(host, sessionID)
        yield mapper.resultMessage("aborted", info, Date.now() - start)
        break
      }

      let next: IteratorResult<OpenCodeEvent> | "aborted" | "stalled"
      if (pending) {
        next = { value: pending, done: false } as IteratorResult<OpenCodeEvent>
        pending = undefined
      } else {
        let stallTimer: ReturnType<typeof setTimeout> | undefined
        const stalled = new Promise<"stalled">((resolve) => {
          stallTimer = setTimeout(() => resolve("stalled"), stallTimeoutMs())
        })
        const read = pendingFirst ?? iterator.next()
        pendingFirst = null
        next = await Promise.race([read, abortPromise, stalled])
        if (stallTimer) clearTimeout(stallTimer)
      }

      if (next === "stalled") {
        await host.sessions.interrupt?.({ sessionID })
        throw new Error(
          "OpenCode stopped responding. Try again or start a new chat."
        )
      }

      if (next === "aborted" || signal?.aborted) {
        completed = true
        const info = await sessionInfo(host, sessionID)
        yield mapper.resultMessage("aborted", info, Date.now() - start)
        break
      }
      if (!next || next.done) break

      const event = next.value as OpenCodeEvent
      if (
        event.data?.sessionID &&
        event.data.sessionID !== sessionID
      ) {
        continue
      }

      if (event.type === "permission.asked") {
        const request = event.data ?? {}
        const decision: OpenCodePermissionDecision = opts.onPermission
          ? await opts.onPermission({
              id: String(request.id),
              sessionID,
              action: String(request.action ?? "unknown"),
              resources: Array.isArray(request.resources)
                ? request.resources.map(String)
                : [],
              message: typeof request.message === "string" ? request.message : undefined,
            })
          : "once"
        await host.permission.reply({
          sessionID,
          requestID: String(request.id),
          decision,
        })
        continue
      }

      const out = mapper.handle(event)
      for (const msg of out.messages) yield msg

      if (out.done) {
        completed = true
        if (out.done === "error") {
          throw out.error ?? new Error("OpenCode execution failed")
        }
        if (out.done === "success" && !mapper.hasOutput) {
          throw new Error(
            "OpenCode returned no response. Try again or start a new chat."
          )
        }
        const info = await sessionInfo(host, sessionID)
        yield mapper.resultMessage(out.done, info, Date.now() - start)
        break
      }
    }

    await promptPromise
    if (promptError) throw promptError

    if (!completed && !aborted) {
      // Stream ended without a terminal event. Surface a result so the chat
      // runner does not treat the turn as still running.
      const info = await sessionInfo(host, sessionID)
      yield mapper.resultMessage("error", info, Date.now() - start)
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    try {
      await iterator.return?.()
    } catch {
      /* stream already closed */
    }
  }
}

export type OpenCodeProvider = LlmProvider & {
  close(): Promise<void>
  /** Drop the cached host so the next run spawns a fresh runtime. Used when
   *  the OpenCode service dies or refuses to spawn. */
  resetHost(): void
  listModels(cwd?: string): Promise<AgentModel[]>
}

// Failures that mean "the runtime underneath us broke", not "this turn is
// invalid". A fresh host is worth trying once; anything else surfaces as-is.
const RECOVERABLE_HOST_ERROR =
  /spawn (EBADF|EAGAIN|ENOENT)|EPIPE|ECONNRESET|ECONNREFUSED|socket hang up|OpenCode stopped responding/i

async function* withHostRetry(
  make: () => AsyncGenerator<AgentMessage, void, unknown>,
  resetHost: () => void
): AsyncGenerator<AgentMessage, void, unknown> {
  let yielded = false
  try {
    for await (const message of make()) {
      yielded = true
      yield message
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Only retry when nothing was streamed yet, so the user never sees a
    // half answer followed by a second one.
    if (yielded || !RECOVERABLE_HOST_ERROR.test(message)) throw err
    resetHost()
    yield* make()
  }
}

export function createOpenCodeProvider(deps: {
  createHost?: OpenCodeHostFactory
} = {}): OpenCodeProvider {
  const createHost = deps.createHost ?? defaultCreateHost
  let hostPromise: Promise<OpenCodeHost> | null = null

  const getHost: OpenCodeHostFactory = () => {
    if (!hostPromise) hostPromise = createHost()
    return hostPromise
  }

  const resetHost = () => {
    const pending = hostPromise
    hostPromise = null
    if (!pending) return
    void pending.then((host) => host.close?.()).catch(() => {})
  }

  return {
    id: "opencode",
    label: "OpenCode",
    runAgent(opts: AgentRunOptions): AsyncIterable<AgentMessage> {
      return withHostRetry(
        () => runOpenCode(opts as OpenCodeRunOptions, getHost),
        resetHost
      )
    },
    resetHost,
    async listModels(cwd?: string): Promise<AgentModel[]> {
      const host = await getHost()
      const result = await host.model.list(
        cwd ? { location: { directory: cwd } } : undefined
      )
      return (result.data ?? []).map(toAgentModel)
    },
    async close(): Promise<void> {
      const pending = hostPromise
      hostPromise = null
      if (!pending) return
      const host = await pending.catch(() => null)
      await host?.close?.()
    },
  }
}

export const opencodeProvider = createOpenCodeProvider()
