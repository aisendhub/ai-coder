import type { RunManifest } from "../manifest.ts"
import type { LogLine } from "../ring-buffer.ts"

// Narrow, open-by-convention. New runners add to this union without breaking
// callers; the registry rejects unknown ids at start time.
export type RunnerId = "local-process" | "local-docker"

export type RunnerHandle = {
  /** Opaque identifier the runner uses to reference the running instance.
   *  For local-process: the PID (as a string). For local-docker: the
   *  container name. Callers MUST treat this as opaque. */
  id: string
  /** Host-visible PID when one exists. Purely for display — runners may
   *  return null when the concept doesn't apply (e.g. a remote container). */
  pid: number | null
}

export type RunnerExit = {
  code: number | null
  signal: string | null
  /** Set when the runner itself failed before/around the process (spawn
   *  error, docker build failure, etc.). Surfaces as `service.error`. */
  error?: string
}

export type RunnerStartOptions = {
  manifest: RunManifest
  port: number
  /** Opaque id the runner can use for resource naming (e.g. docker container
   *  name). Must be unique across concurrent services. */
  serviceId: string
  /** Called for every line of stdout/stderr as it arrives. */
  onLine: (line: LogLine) => void
  /** Called exactly once when the process exits for any reason, or once
   *  if the runner failed before spawn. */
  onExit: (exit: RunnerExit) => void
}

export interface Runner {
  id: RunnerId
  /** Cheap availability probe — e.g. `which docker`. Registry calls this
   *  before `start()` and surfaces a user-facing "install X" error on miss.
   *  Implementations should memoize. */
  isAvailable(): Promise<boolean>
  /** Human-readable reason when `isAvailable()` returns false. */
  unavailableReason?(): Promise<string>
  /** Spawn the app. Resolves once the underlying process is running (NOT
   *  when the app reports ready — that's `manifest.healthcheck`'s job).
   *  `onLine`/`onExit` fire asynchronously afterward. */
  start(opts: RunnerStartOptions): Promise<RunnerHandle>
  /** Signal graceful shutdown. Runner is responsible for escalating to a
   *  hard kill after its own grace period (typically 5s). Registry will
   *  still call this again on shutdownAll so the call must be idempotent. */
  stop(handle: RunnerHandle): Promise<void>
}
