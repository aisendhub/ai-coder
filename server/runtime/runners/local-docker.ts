import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"

import { logRuntimeEvent } from "../manifest.ts"
import { createLineFramer } from "../ring-buffer.ts"
import { generateDockerfile } from "../dockerfile.ts"
import type { Runner, RunnerHandle, RunnerStartOptions } from "./types.ts"

const execFileP = promisify(execFile)

// Works with any Docker-CLI-compatible runtime: Docker Desktop, OrbStack,
// Podman (via `alias docker=podman` or Podman's own docker wrapper),
// Colima, Rancher Desktop. We only call `docker …` — never the engine API.
const DOCKER_BIN = "docker"

// Fixed container-side port. All containers expose 3000; we map the host's
// allocated port to 3000 on each `docker run`. Keeps the Dockerfile generic.
const CONTAINER_PORT = 3000

let availabilityCache: { ok: boolean; reason?: string; at: number } | null = null
const AVAILABILITY_TTL_MS = 60_000

export const localDockerRunner: Runner = {
  id: "local-docker",

  async isAvailable(): Promise<boolean> {
    const now = Date.now()
    if (availabilityCache && now - availabilityCache.at < AVAILABILITY_TTL_MS) {
      return availabilityCache.ok
    }
    try {
      // `docker version` both proves the binary exists AND that the daemon
      // is responsive — a CLI without a running engine is as useful as none.
      await execFileP(DOCKER_BIN, ["version", "--format", "{{.Server.Version}}"], {
        timeout: 5000,
      })
      availabilityCache = { ok: true, at: now }
      return true
    } catch (err) {
      const msg = (err as Error).message
      const reason = /ENOENT|not found/i.test(msg)
        ? "Docker CLI not found on PATH. Install Docker Desktop, OrbStack, Podman, or Colima."
        : /daemon|Cannot connect/i.test(msg)
          ? "Docker CLI is installed but the engine isn't running. Start your Docker runtime and try again."
          : `Docker unavailable: ${msg}`
      availabilityCache = { ok: false, reason, at: now }
      return false
    }
  },

  async unavailableReason(): Promise<string> {
    await this.isAvailable()
    return availabilityCache?.reason ?? "Docker unavailable"
  },

  async start(opts: RunnerStartOptions): Promise<RunnerHandle> {
    const { manifest, port, serviceId, onLine, onExit } = opts
    const containerName = `ai-coder-${serviceId.slice(0, 12)}`

    // 1. Ensure a Dockerfile exists in the worktree.
    let dockerfile
    try {
      dockerfile = await generateDockerfile(manifest)
    } catch (err) {
      const error = `dockerfile generation failed: ${(err as Error).message}`
      queueMicrotask(() => onExit({ code: null, signal: null, error }))
      return { id: containerName, pid: null }
    }

    // 2. Build. Stream build output into the log buffer too — users want to
    //    see "pulling node:22-alpine" when it's slow, not a frozen spinner.
    const buildLine = (stream: "stdout" | "stderr", text: string) =>
      onLine({ ts: Date.now(), stream, text: `[build] ${text}` })

    try {
      await runStreaming(
        DOCKER_BIN,
        [
          "build",
          "-f",
          dockerfile.path,
          "-t",
          dockerfile.imageTag,
          ".",
        ],
        manifest.cwd,
        buildLine
      )
    } catch (err) {
      const error = `docker build failed: ${(err as Error).message}`
      logRuntimeEvent("docker.build.failed", { image: dockerfile.imageTag, error })
      queueMicrotask(() => onExit({ code: null, signal: null, error }))
      return { id: containerName, pid: null }
    }
    logRuntimeEvent("docker.build", { image: dockerfile.imageTag })

    // 3. Run detached. `--rm` so stopped containers don't accumulate.
    const envArgs: string[] = []
    envArgs.push("-e", `PORT=${CONTAINER_PORT}`)
    for (const [k, v] of Object.entries(manifest.env ?? {})) {
      envArgs.push("-e", `${k}=${v}`)
    }
    const runArgs = [
      "run",
      "--rm",
      "-d",
      "--name",
      containerName,
      "-p",
      `${port}:${CONTAINER_PORT}`,
      ...envArgs,
      dockerfile.imageTag,
    ]
    try {
      const { stdout } = await execFileP(DOCKER_BIN, runArgs, { cwd: manifest.cwd })
      const containerId = stdout.trim().slice(0, 12)
      logRuntimeEvent("docker.run", { name: containerName, cid: containerId, port })
    } catch (err) {
      const error = `docker run failed: ${(err as Error).message}`
      queueMicrotask(() => onExit({ code: null, signal: null, error }))
      return { id: containerName, pid: null }
    }

    // 4. Follow logs. `docker logs -f` streams stdout+stderr until the
    //    container exits — we use it as our primary "is it alive" signal.
    const logsChild = spawn(DOCKER_BIN, ["logs", "-f", containerName], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const outFramer = createLineFramer((text) =>
      onLine({ ts: Date.now(), stream: "stdout", text })
    )
    const errFramer = createLineFramer((text) =>
      onLine({ ts: Date.now(), stream: "stderr", text })
    )
    logsChild.stdout?.setEncoding("utf8")
    logsChild.stderr?.setEncoding("utf8")
    logsChild.stdout?.on("data", (c: string) => outFramer.push(c))
    logsChild.stderr?.on("data", (c: string) => errFramer.push(c))

    logsChild.on("exit", () => {
      outFramer.flush()
      errFramer.flush()
      // `docker logs -f` exits when the container stops. We need to find out
      // why — inspect before the `--rm` pulls the row, but since --rm races,
      // fall back to "stopped" on race.
      void waitForContainerExit(containerName).then((exit) => {
        logRuntimeEvent("exit", {
          runner: "local-docker",
          name: containerName,
          code: exit.code ?? "null",
        })
        onExit(exit)
      })
    })

    return { id: containerName, pid: null }
  },

  async stop(handle: RunnerHandle): Promise<void> {
    const containerName = handle.id
    logRuntimeEvent("docker.stop", { name: containerName })
    try {
      // -t 5 gives the container 5s to respond to SIGTERM before SIGKILL.
      await execFileP(DOCKER_BIN, ["stop", "-t", "5", containerName], {
        timeout: 15_000,
      })
    } catch (err) {
      // If the container is already gone, that's fine — idempotent stop.
      const msg = (err as Error).message
      if (!/No such container/i.test(msg)) {
        logRuntimeEvent("stop.signal.failed", {
          runner: "local-docker",
          error: msg,
        })
      }
    }
  },
}

async function waitForContainerExit(
  name: string
): Promise<{ code: number | null; signal: string | null; error?: string }> {
  // Best-effort inspect. Container is likely gone already (--rm), in which
  // case we report a clean stop — we can't distinguish user-stopped vs
  // app-exited-cleanly once the record is gone.
  try {
    const { stdout } = await execFileP(
      DOCKER_BIN,
      ["inspect", "--format", "{{.State.ExitCode}}|{{.State.Error}}", name],
      { timeout: 5000 }
    )
    const [codeStr, error] = stdout.trim().split("|")
    const code = codeStr ? parseInt(codeStr, 10) : null
    return {
      code: Number.isFinite(code) ? code : null,
      signal: null,
      error: error && error !== "<no value>" ? error : undefined,
    }
  } catch {
    return { code: 0, signal: null }
  }
}

// Run a docker command and stream its stdout/stderr line-by-line into
// the supplied emitter. Resolves on exit 0, rejects on non-zero.
function runStreaming(
  bin: string,
  args: string[],
  cwd: string,
  emit: (stream: "stdout" | "stderr", text: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    const outFramer = createLineFramer((text) => emit("stdout", text))
    const errFramer = createLineFramer((text) => emit("stderr", text))
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (c: string) => outFramer.push(c))
    child.stderr?.on("data", (c: string) => errFramer.push(c))
    child.on("error", reject)
    child.on("exit", (code) => {
      outFramer.flush()
      errFramer.flush()
      if (code === 0) resolve()
      else reject(new Error(`${bin} ${args.join(" ")} exited ${code}`))
    })
  })
}
