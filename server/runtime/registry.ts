import { EventEmitter } from "node:events"
import { createServer } from "node:net"
import { randomUUID } from "node:crypto"

import type { RunManifest } from "./manifest.ts"
import { logRuntimeEvent } from "./manifest.ts"
import {
  createRingBuffer,
  type LogLine,
  type RingBuffer,
} from "./ring-buffer.ts"
import type { Runner, RunnerHandle, RunnerId } from "./runners/types.ts"
import { injectPortFlag, extractBoundPort } from "./port.ts"
import { portEnvFor } from "../env-resolver.ts"

export type ServiceStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "crashed"

// Scope identifies *which configured service on which filesystem* a running
// instance belongs to. The tuple (ownerId, projectId, serviceName,
// worktreePath) is the unique bucket — two conversations on the same main
// branch (both worktreePath=null) share; two tasks on different worktree
// paths are isolated; two services with different names coexist.
//
// worktreePath is the actual filesystem path (or null for the project's base
// cwd), NOT a conversation id. See docs/MULTI-SERVICE.md § Registry scope.
export type ServiceScope = {
  ownerId: string
  projectId: string
  serviceName: string
  worktreePath?: string | null
  label?: string | null
}

type RunningService = Omit<ServiceScope, "worktreePath"> & {
  id: string
  worktreePath: string | null
  manifest: RunManifest
  runnerId: RunnerId
  handle: RunnerHandle | null
  pid: number | null
  port: number
  status: ServiceStatus
  exitCode: number | null
  error: string | null
  startedAt: number
  stoppedAt: number | null
  logs: RingBuffer
  emitter: EventEmitter
}

export type ServiceSnapshot = {
  id: string
  ownerId: string
  projectId: string
  serviceName: string
  worktreePath: string | null
  label: string | null
  stack: RunManifest["stack"]
  start: string
  cwd: string
  runnerId: RunnerId
  pid: number | null
  port: number
  status: ServiceStatus
  exitCode: number | null
  error: string | null
  startedAt: number
  stoppedAt: number | null
  url: string
}

export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "port_range_exhausted"
      | "port_in_use"
      | "port_invalid"
      | "user_cap_reached"
      | "not_found"
      | "not_owner"
      | "already_stopped"
      | "runner_unavailable"
  ) {
    super(message)
  }
}

const services = new Map<string, RunningService>()
const allocatedPorts = new Set<number>()
const runnersById = new Map<RunnerId, Runner>()

const [PORT_MIN, PORT_MAX] = parsePortRange(
  process.env.RUNTIME_PORT_RANGE ?? "4100-4999"
)
const MAX_PER_USER = Math.max(
  1,
  parseInt(process.env.RUNTIME_MAX_SERVICES_PER_USER ?? "5", 10) || 5
)
const LOG_LINE_CAP = 2000

function parsePortRange(raw: string): [number, number] {
  const [a, b] = raw.split("-").map((n) => parseInt(n.trim(), 10))
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b < a) {
    throw new Error(`Invalid RUNTIME_PORT_RANGE: ${raw}`)
  }
  return [a, b]
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    let settled = false
    const done = (free: boolean) => {
      if (settled) return
      settled = true
      try {
        srv.close()
      } catch {}
      resolve(free)
    }
    srv.once("error", () => done(false))
    srv.once("listening", () => done(true))
    try {
      srv.listen(port, "127.0.0.1")
    } catch {
      done(false)
    }
  })
}

// Allocate a port to bind, with two preference shapes:
//   strict  — user explicitly set this port in the manifest. If it's taken,
//             fail loudly. We will NOT silently swap to a different port —
//             the user asked for 3000 and they get 3000 or an error.
//   sticky  — port we picked in a previous run for this scope (kept stable
//             so localhost:<port> URLs stay valid across restarts). If
//             taken, fall back to auto-allocation.
// At least one of the two flows wins; if neither is set, auto-allocate from
// the sandbox range. Honored regardless of whether the chosen port is inside
// the sandbox range — users routinely want 3000 / 5173 / 8000 / 8080.
async function allocatePort(opts: {
  strict?: number | null
  sticky?: number | null
}): Promise<number> {
  const { strict, sticky } = opts

  if (strict != null) {
    if (strict < 1024 || strict > 65535) {
      throw new RuntimeError(
        `port ${strict} is out of range (1024-65535)`,
        "port_invalid"
      )
    }
    if (allocatedPorts.has(strict) || !(await isPortFree(strict))) {
      throw new RuntimeError(
        `port ${strict} is in use — pick another or unset it to auto-allocate`,
        "port_in_use"
      )
    }
    allocatedPorts.add(strict)
    return strict
  }

  if (
    sticky != null &&
    sticky >= 1024 &&
    sticky <= 65535 &&
    !allocatedPorts.has(sticky) &&
    (await isPortFree(sticky))
  ) {
    allocatedPorts.add(sticky)
    return sticky
  }

  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (allocatedPorts.has(port)) continue
    if (await isPortFree(port)) {
      allocatedPorts.add(port)
      return port
    }
  }
  throw new RuntimeError(
    `No free port in ${PORT_MIN}-${PORT_MAX}`,
    "port_range_exhausted"
  )
}

function snapshot(svc: RunningService): ServiceSnapshot {
  return {
    id: svc.id,
    ownerId: svc.ownerId,
    projectId: svc.projectId,
    serviceName: svc.serviceName,
    worktreePath: svc.worktreePath,
    label: svc.label ?? null,
    stack: svc.manifest.stack,
    start: svc.manifest.start,
    cwd: svc.manifest.cwd,
    runnerId: svc.runnerId,
    pid: svc.pid,
    port: svc.port,
    status: svc.status,
    exitCode: svc.exitCode,
    error: svc.error,
    startedAt: svc.startedAt,
    stoppedAt: svc.stoppedAt,
    url: `http://localhost:${svc.port}`,
  }
}

function countRunningForOwner(ownerId: string): number {
  let n = 0
  for (const svc of services.values()) {
    if (svc.ownerId !== ownerId) continue
    if (svc.status === "starting" || svc.status === "running") n++
  }
  return n
}

export function registerRunner(runner: Runner): void {
  runnersById.set(runner.id, runner)
  logRuntimeEvent("runner.registered", { runner: runner.id })
}

export function listRunners(): RunnerId[] {
  return [...runnersById.keys()]
}

export type RunnerInfo = {
  id: RunnerId
  available: boolean
  reason?: string
}

export async function getRunnersInfo(): Promise<RunnerInfo[]> {
  const out: RunnerInfo[] = []
  for (const r of runnersById.values()) {
    const available = await r.isAvailable()
    const info: RunnerInfo = { id: r.id, available }
    if (!available && r.unavailableReason) {
      info.reason = await r.unavailableReason()
    }
    out.push(info)
  }
  return out
}

export type StartOptions = {
  /** User-set port from the manifest. Strict — fails on conflict. */
  strictPort?: number | null
  /** Sticky port from a prior run. Soft — falls back to auto-allocate. */
  stickyPort?: number | null
  /** Deprecated: same as `stickyPort` for backwards compat. Pass strictPort
   *  separately when the user explicitly set a manifest port. */
  preferredPort?: number | null
  runnerId?: RunnerId
}

export async function startService(
  manifest: RunManifest,
  scope: ServiceScope,
  opts: StartOptions = {}
): Promise<ServiceSnapshot> {
  if (countRunningForOwner(scope.ownerId) >= MAX_PER_USER) {
    throw new RuntimeError(
      `Max ${MAX_PER_USER} concurrent services per user`,
      "user_cap_reached"
    )
  }
  if (!manifest.start || !manifest.start.trim()) {
    throw new RuntimeError(
      "manifest has no start command — edit it first",
      "not_found"
    )
  }

  const runnerId: RunnerId = opts.runnerId ?? "local-process"
  const runner = runnersById.get(runnerId)
  if (!runner) {
    throw new RuntimeError(`unknown runner '${runnerId}'`, "not_found")
  }
  if (!(await runner.isAvailable())) {
    const reason = (await runner.unavailableReason?.()) ?? "runner unavailable"
    throw new RuntimeError(reason, "runner_unavailable")
  }

  const port = await allocatePort({
    strict: opts.strictPort ?? null,
    sticky: opts.stickyPort ?? opts.preferredPort ?? null,
  })
  const id = randomUUID()
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  const logs = createRingBuffer(LOG_LINE_CAP)

  // PORT env injection. Always sets PORT + HOST; adds framework-specific
  // aliases (VITE_PORT, NUXT_PORT, etc) per stack so framework configs that
  // read those don't have to be rewritten. User-provided env keys win when
  // they collide — if the user manually set VITE_PORT they get that value.
  const portEnv = portEnvFor(manifest.stack ?? null, port)
  const envWithPort: Record<string, string> = {
    ...portEnv,
    ...(manifest.env ?? {}),
  }

  // Framework-aware command rewrite: if the start command doesn't already
  // pass $PORT or a --port/-p flag, and we recognize the framework (Vite,
  // Django, uvicorn, etc.), append the right flag so our allocated port
  // actually takes effect. No-op for commands that already handle it.
  const inject = injectPortFlag(manifest.start)
  const effectiveManifest: RunManifest = {
    ...manifest,
    ...(inject.injected ? { start: inject.command } : {}),
    env: envWithPort,
  }
  if (inject.injected) {
    logRuntimeEvent("port.inject", {
      id,
      original: manifest.start,
      rewritten: inject.command,
      reason: inject.reason,
    })
  }

  const svc: RunningService = {
    id,
    ownerId: scope.ownerId,
    projectId: scope.projectId,
    serviceName: scope.serviceName,
    worktreePath: scope.worktreePath ?? null,
    label: scope.label ?? null,
    manifest: effectiveManifest,
    runnerId,
    handle: null,
    pid: null,
    port,
    status: "starting",
    exitCode: null,
    error: null,
    startedAt: Date.now(),
    stoppedAt: null,
    logs,
    emitter,
  }
  services.set(id, svc)

  const onLine = (line: LogLine) => {
    logs.push(line)
    emitter.emit("line", line)
    // Sniff the line for a bound-port URL / "listening on port N" message.
    // If the app bound somewhere other than where we allocated (e.g. our
    // injection didn't reach this framework, or Vite stepped to the next
    // free port), update the snapshot so the card + "Open in browser" link
    // reflect reality. Last-detected wins — some apps retry ports at boot.
    const detected = extractBoundPort(line.text)
    if (
      detected != null &&
      detected !== svc.port &&
      (svc.status === "starting" || svc.status === "running")
    ) {
      logRuntimeEvent("port.detected", {
        id,
        from: svc.port,
        to: detected,
      })
      // Release our allocated slot (nothing is listening there) so the
      // next restart doesn't keep preferring a dead number.
      allocatedPorts.delete(svc.port)
      svc.port = detected
      emitter.emit("status", snapshot(svc))
    }
  }

  const onExit = (exit: { code: number | null; signal: string | null; error?: string }) => {
    svc.stoppedAt = Date.now()
    svc.exitCode = exit.code
    if (svc.status === "stopping") {
      svc.status = "stopped"
    } else if (exit.error) {
      svc.status = "crashed"
      svc.error = exit.error
    } else {
      svc.status = exit.code === 0 ? "stopped" : "crashed"
      if (exit.code !== 0) {
        svc.error = exit.signal
          ? `killed by ${exit.signal}`
          : `exited with code ${exit.code}`
      }
    }
    allocatedPorts.delete(svc.port)
    emitter.emit("status", snapshot(svc))
    emitter.emit("end")
  }

  let handle: RunnerHandle
  try {
    handle = await runner.start({
      manifest: effectiveManifest,
      port,
      serviceId: id,
      onLine,
      onExit,
    })
  } catch (err) {
    allocatedPorts.delete(port)
    svc.status = "crashed"
    svc.error = (err as Error).message
    svc.stoppedAt = Date.now()
    logRuntimeEvent("start.failed", {
      id,
      runner: runnerId,
      error: svc.error,
    })
    emitter.emit("status", snapshot(svc))
    emitter.emit("end")
    return snapshot(svc)
  }

  svc.handle = handle
  svc.pid = handle.pid
  // If the runner queued an immediate error exit via onExit (e.g. spawn
  // failed and it delivered via microtask), the status flip happens on that
  // turn. Until then, mark running so callers/UI see progress.
  if (svc.status === "starting") svc.status = "running"
  return snapshot(svc)
}

export async function stopService(id: string, ownerId: string): Promise<void> {
  const svc = services.get(id)
  if (!svc) throw new RuntimeError("service not found", "not_found")
  if (svc.ownerId !== ownerId) throw new RuntimeError("forbidden", "not_owner")
  if (svc.status === "stopped" || svc.status === "crashed") {
    throw new RuntimeError("already stopped", "already_stopped")
  }
  await killSvc(svc)
}

// Stops a service and awaits the terminal `end` event (process exit + port
// release), with a hard timeout so a wedged runner can't block a restart.
// Idempotent: already-stopped services resolve immediately.
export async function stopServiceAndWait(
  id: string,
  ownerId: string,
  timeoutMs = 6000
): Promise<void> {
  const svc = services.get(id)
  if (!svc || svc.ownerId !== ownerId) return
  if (svc.status === "stopped" || svc.status === "crashed") return

  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      svc.emitter.off("end", finish)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    svc.emitter.once("end", finish)
    void killSvc(svc).catch(() => finish())
  })
}

async function killSvc(svc: RunningService): Promise<void> {
  if (svc.status === "stopping") return
  if (!svc.handle) return
  svc.status = "stopping"
  svc.emitter.emit("status", snapshot(svc))
  const runner = runnersById.get(svc.runnerId)
  if (!runner) {
    logRuntimeEvent("stop.signal.failed", {
      id: svc.id,
      error: `runner '${svc.runnerId}' not registered`,
    })
    return
  }
  try {
    await runner.stop(svc.handle)
  } catch (err) {
    logRuntimeEvent("stop.signal.failed", {
      id: svc.id,
      runner: svc.runnerId,
      error: (err as Error).message,
    })
  }
}

export function getService(id: string, ownerId: string): ServiceSnapshot | null {
  const svc = services.get(id)
  if (!svc) return null
  if (svc.ownerId !== ownerId) return null
  return snapshot(svc)
}

// Filter semantics:
//   - undefined    → don't filter on that dimension
//   - null (for worktreePath) → only match instances with worktreePath === null
//   - string       → exact match
export function listServices(filter: {
  ownerId: string
  projectId?: string
  serviceName?: string
  worktreePath?: string | null
}): ServiceSnapshot[] {
  const out: ServiceSnapshot[] = []
  for (const svc of services.values()) {
    if (svc.ownerId !== filter.ownerId) continue
    if (filter.projectId && svc.projectId !== filter.projectId) continue
    if (filter.serviceName && svc.serviceName !== filter.serviceName) continue
    if (filter.worktreePath !== undefined && svc.worktreePath !== filter.worktreePath) {
      continue
    }
    out.push(snapshot(svc))
  }
  out.sort((a, b) => b.startedAt - a.startedAt)
  return out
}

export function getLogHistory(id: string, ownerId: string): LogLine[] {
  const svc = services.get(id)
  if (!svc || svc.ownerId !== ownerId) return []
  return svc.logs.snapshot()
}

export type LogSubscription = {
  history: LogLine[]
  onLine(handler: (line: LogLine) => void): void
  onStatus(handler: (snap: ServiceSnapshot) => void): void
  onEnd(handler: () => void): void
  unsubscribe(): void
}

export function subscribeLogs(
  id: string,
  ownerId: string
): LogSubscription | null {
  const svc = services.get(id)
  if (!svc || svc.ownerId !== ownerId) return null
  const handlers: Array<() => void> = []
  const sub: LogSubscription = {
    history: svc.logs.snapshot(),
    onLine(h) {
      svc.emitter.on("line", h)
      handlers.push(() => svc.emitter.off("line", h))
    },
    onStatus(h) {
      svc.emitter.on("status", h)
      handlers.push(() => svc.emitter.off("status", h))
    },
    onEnd(h) {
      svc.emitter.once("end", h)
      handlers.push(() => svc.emitter.off("end", h))
    },
    unsubscribe() {
      for (const off of handlers.splice(0)) off()
    },
  }
  return sub
}

// Re-register an instance that was spawned by a previous server process.
// Used during boot reconcile (see server/index.ts): we persisted the pid+
// port, the OS process is still alive (caller verified via kill(pid, 0)),
// and we want the panel to show it again. We can't recover stdout/stderr
// (those streams closed when the parent process exited), so logs stay
// empty until the user restarts. Stop works via signal to the pid/pgid.
export function registerExternalService(input: {
  id: string
  scope: ServiceScope & { worktreePath: string | null }
  manifest: RunManifest
  runnerId: RunnerId
  pid: number
  port: number
  startedAt: number
}): ServiceSnapshot {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  const logs = createRingBuffer(LOG_LINE_CAP)
  // Seed a single advisory log line so the UI doesn't show a blank pane.
  logs.push({
    ts: Date.now(),
    stream: "stdout",
    text:
      "[reattached] This service was started in a previous server session. " +
      "Live logs aren't available here — stop and re-run to capture output.",
  })

  const svc: RunningService = {
    id: input.id,
    ownerId: input.scope.ownerId,
    projectId: input.scope.projectId,
    serviceName: input.scope.serviceName,
    worktreePath: input.scope.worktreePath,
    label: input.scope.label ?? null,
    manifest: input.manifest,
    // Always "external" — the registered external runner's stop() signals
    // the pgid. The input.runnerId on the stored row tells us what ORIGINAL
    // runner spawned it, but once reattached there's only one way to stop.
    runnerId: "external" as RunnerId,
    handle: { id: String(input.pid), pid: input.pid },
    pid: input.pid,
    port: input.port,
    status: "running",
    exitCode: null,
    error: null,
    startedAt: input.startedAt,
    stoppedAt: null,
    logs,
    emitter,
  }
  services.set(svc.id, svc)
  allocatedPorts.add(input.port)
  return snapshot(svc)
}

export function removeService(id: string, ownerId: string): boolean {
  const svc = services.get(id)
  if (!svc) return false
  if (svc.ownerId !== ownerId) throw new RuntimeError("forbidden", "not_owner")
  if (svc.status === "starting" || svc.status === "running" || svc.status === "stopping") {
    throw new RuntimeError("still running", "already_stopped")
  }
  services.delete(id)
  svc.emitter.removeAllListeners()
  return true
}

// ─── Lifecycle safety ──────────────────────────────────────────────────────

export async function shutdownAll(): Promise<void> {
  const pending: Array<Promise<void>> = []
  for (const svc of services.values()) {
    if (svc.status !== "running" && svc.status !== "starting") continue
    pending.push(
      new Promise<void>((resolve) => {
        svc.emitter.once("end", () => resolve())
        void killSvc(svc)
        // Absolute deadline — don't hang the process on a stuck runner.
        setTimeout(resolve, 8000).unref()
      })
    )
  }
  await Promise.allSettled(pending)
}

let shutdownInstalled = false
export function installShutdownHook(): void {
  if (shutdownInstalled) return
  shutdownInstalled = true
  const handler = (signal: string) => {
    logRuntimeEvent("shutdown.signal", { signal })
    void shutdownAll().then(() => {
      process.kill(process.pid, signal as NodeJS.Signals)
    })
  }
  process.once("SIGINT", () => handler("SIGINT"))
  process.once("SIGTERM", () => handler("SIGTERM"))
}

installShutdownHook()
