import { spawn, type ChildProcess } from "node:child_process"

import { logRuntimeEvent } from "../manifest.ts"
import { createLineFramer } from "../ring-buffer.ts"
import type { Runner, RunnerHandle, RunnerStartOptions } from "./types.ts"

const STOP_GRACE_MS = 5000

// Track active children by their handle id (= PID as string) so stop() can
// escalate to SIGKILL even if the caller no longer has the ChildProcess ref.
// Cleared on exit.
const children = new Map<string, ChildProcess>()
const killTimers = new Map<string, NodeJS.Timeout>()

export const localProcessRunner: Runner = {
  id: "local-process",

  async isAvailable() {
    // We're always able to spawn a shell on any platform Node can run on.
    return true
  },

  async start(opts: RunnerStartOptions): Promise<RunnerHandle> {
    const { manifest, port, onLine, onExit } = opts

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...manifest.env,
      PORT: String(port),
    }

    let child: ChildProcess
    try {
      child = spawn(manifest.start, {
        cwd: manifest.cwd,
        env,
        shell: true,
        // New process group so stop() can signal the whole tree — the shell
        // wrapper usually spawns grandchildren (e.g. `npm run dev` → node).
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      const message = (err as Error).message
      logRuntimeEvent("spawn.failed", { runner: "local-process", error: message })
      // Deliver the failure on the same channel as a normal exit so the
      // registry doesn't need a separate error path.
      queueMicrotask(() => onExit({ code: null, signal: null, error: message }))
      return { id: "0", pid: null }
    }

    const pid = child.pid
    const handleId = pid != null ? String(pid) : "0"
    if (pid != null) children.set(handleId, child)

    // Log which manifest-provided env keys made it into the child's env.
    // Values intentionally omitted — secrets should never hit logs — but the
    // key list tells us whether manifest.env survived the round-trip through
    // UI → DB → runner, which is a common "why isn't FOO set" confusion.
    const manifestEnvKeys = Object.keys(manifest.env ?? {})
    logRuntimeEvent("spawn", {
      runner: "local-process",
      pid: pid ?? "null",
      port,
      cwd: manifest.cwd,
      start: manifest.start,
      manifestEnvKeys: manifestEnvKeys.length
        ? manifestEnvKeys.join(",")
        : "(none)",
    })

    const outFramer = createLineFramer((text) =>
      onLine({ ts: Date.now(), stream: "stdout", text })
    )
    const errFramer = createLineFramer((text) =>
      onLine({ ts: Date.now(), stream: "stderr", text })
    )

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => outFramer.push(chunk))
    child.stderr?.on("data", (chunk: string) => errFramer.push(chunk))

    child.on("error", (err) => {
      onLine({
        ts: Date.now(),
        stream: "stderr",
        text: `[runtime] spawn error: ${err.message}`,
      })
    })

    child.on("exit", (code, signal) => {
      outFramer.flush()
      errFramer.flush()
      children.delete(handleId)
      const timer = killTimers.get(handleId)
      if (timer) {
        clearTimeout(timer)
        killTimers.delete(handleId)
      }
      logRuntimeEvent("exit", {
        runner: "local-process",
        pid: pid ?? "null",
        code: code ?? "null",
        signal: signal ?? "null",
      })
      onExit({ code, signal })
    })

    return { id: handleId, pid: pid ?? null }
  },

  async stop(handle: RunnerHandle): Promise<void> {
    const pid = handle.pid
    if (pid == null) return
    // Already scheduled for kill — treat as idempotent.
    if (killTimers.has(handle.id)) return
    try {
      // Negative PID signals the whole process group (detached: true above).
      process.kill(-pid, "SIGTERM")
      logRuntimeEvent("stop.signal", { runner: "local-process", pid })
    } catch (err) {
      logRuntimeEvent("stop.signal.failed", {
        runner: "local-process",
        error: (err as Error).message,
      })
    }
    const timer = setTimeout(() => {
      killTimers.delete(handle.id)
      // Only escalate if the child is still in our map (i.e. exit hasn't fired).
      if (!children.has(handle.id)) return
      try {
        process.kill(-pid, "SIGKILL")
        logRuntimeEvent("stop.kill", { runner: "local-process", pid })
      } catch {}
    }, STOP_GRACE_MS)
    killTimers.set(handle.id, timer)
  },
}
