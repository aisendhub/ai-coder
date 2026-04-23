import { promises as fsp } from "node:fs"
import { join } from "node:path"

export type Stack =
  | "node"
  | "bun"
  | "python"
  | "go"
  | "ruby"
  | "static"
  | "docker"
  | "custom"

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun"

export type Healthcheck = { path: string; timeoutMs: number }

export type RunManifest = {
  stack: Stack
  build?: string
  start: string
  cwd: string
  env: Record<string, string>
  port?: number
  healthcheck?: Healthcheck
  dockerfile?: string
}

export type ManifestOverride = Partial<Omit<RunManifest, "cwd">>

export type RuntimeEvent =
  | "detect.hit"
  | "detect.miss"
  | "detect.failed"
  | "spawn"
  | "spawn.failed"
  | "exit"
  | "stop.signal"
  | "stop.signal.failed"
  | "stop.kill"
  | "shutdown.signal"
  | "runner.registered"
  | "start.failed"
  | "docker.build"
  | "docker.build.failed"
  | "docker.run"
  | "docker.stop"
  | "dockerfile.generate"
  | "dockerfile.cache.hit"
  | "port.inject"
  | "port.detected"

export function logRuntimeEvent(
  event: RuntimeEvent,
  details: Record<string, unknown> = {}
): void {
  const tail = Object.entries(details)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ")
  console.log(`[runtime] ${event}${tail ? " " + tail : ""}`)
}

// Detection ordering matters: Procfile wins over stack-specific detection so
// a user-authored override (any stack) is always respected. Then Node, then
// Python, then static. `dockerfile` is an explicit field on an edited manifest
// rather than a detection target — auto-picking a Dockerfile would be a
// footgun (a repo often has one for prod that shouldn't run locally as-is).
export async function detect(cwd: string): Promise<RunManifest | null> {
  try {
    const detectors: Array<() => Promise<RunManifest | null>> = [
      () => detectProcfile(cwd),
      () => detectNode(cwd),
      () => detectPython(cwd),
      () => detectStatic(cwd),
    ]
    for (const run of detectors) {
      const m = await run()
      if (m) {
        logRuntimeEvent("detect.hit", { cwd, stack: m.stack, start: m.start })
        return m
      }
    }
    logRuntimeEvent("detect.miss", { cwd })
    return null
  } catch (err) {
    logRuntimeEvent("detect.failed", { cwd, error: (err as Error).message })
    throw err
  }
}

export function mergeManifest(
  base: RunManifest,
  override: ManifestOverride | null | undefined
): RunManifest {
  if (!override) return base
  return {
    ...base,
    ...override,
    env: { ...base.env, ...(override.env ?? {}) },
    healthcheck: override.healthcheck ?? base.healthcheck,
  }
}

type PackageJson = {
  scripts?: Record<string, string>
  packageManager?: string
}

async function detectNode(cwd: string): Promise<RunManifest | null> {
  const pkg = await readPackageJson(cwd)
  if (!pkg) return null

  const script = pickScript(pkg.scripts)
  if (!script) return null

  const pm = await detectPackageManager(cwd, pkg)
  return {
    stack: pm === "bun" ? "bun" : "node",
    start: `${pm} run ${script}`,
    cwd,
    env: {},
  }
}

async function readPackageJson(cwd: string): Promise<PackageJson | null> {
  try {
    const raw = await fsp.readFile(join(cwd, "package.json"), "utf8")
    return JSON.parse(raw) as PackageJson
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

function pickScript(scripts: Record<string, string> | undefined): string | null {
  if (!scripts) return null
  if (scripts.dev) return "dev"
  if (scripts.start) return "start"
  return null
}

async function detectPackageManager(
  cwd: string,
  pkg: PackageJson
): Promise<PackageManager> {
  // `packageManager` field (corepack) is authoritative when set.
  if (pkg.packageManager) {
    const name = pkg.packageManager.split("@", 1)[0]
    if (name === "pnpm" || name === "yarn" || name === "bun" || name === "npm") {
      return name
    }
  }

  // Fall back to lockfile detection. Bun first (most specific), then pnpm, yarn, npm.
  const lockfiles: Array<[string, PackageManager]> = [
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ]
  for (const [name, manager] of lockfiles) {
    if (await exists(join(cwd, name))) return manager
  }
  return "npm"
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path)
    return true
  } catch {
    return false
  }
}

// A Procfile takes precedence regardless of stack — it's an explicit user
// declaration of "here's how to start this". We pick `web:` first, then
// `dev:` (not standard but common), otherwise the first process.
async function detectProcfile(cwd: string): Promise<RunManifest | null> {
  let raw: string
  try {
    raw = await fsp.readFile(join(cwd, "Procfile"), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean)
  const processes = new Map<string, string>()
  for (const line of lines) {
    if (line.startsWith("#")) continue
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const name = line.slice(0, idx).trim()
    const cmd = line.slice(idx + 1).trim()
    if (name && cmd) processes.set(name, cmd)
  }
  if (processes.size === 0) return null
  const start =
    processes.get("web") ??
    processes.get("dev") ??
    [...processes.values()][0]
  return {
    stack: "custom",
    start,
    cwd,
    env: {},
  }
}

async function detectPython(cwd: string): Promise<RunManifest | null> {
  const hasPyproject = await exists(join(cwd, "pyproject.toml"))
  const hasRequirements = await exists(join(cwd, "requirements.txt"))
  if (!hasPyproject && !hasRequirements) return null

  // Look for a conventional entry point in a preferred order. We only commit
  // to a start command when we find something concrete — otherwise the user
  // gets a first-run dialog to fill it in, which is better than guessing.
  const entrypoints = [
    { file: "manage.py", cmd: "python manage.py runserver 0.0.0.0:$PORT" },
    { file: "main.py", cmd: "python main.py" },
    { file: "app.py", cmd: "python app.py" },
    { file: "server.py", cmd: "python server.py" },
  ]
  for (const ep of entrypoints) {
    if (await exists(join(cwd, ep.file))) {
      return { stack: "python", start: ep.cmd, cwd, env: {} }
    }
  }

  // Python markers present but no obvious entry: return a partial manifest
  // with empty start. The start endpoint rejects empty-start manifests with
  // a helpful message, and the UI surfaces an edit dialog. Better than
  // returning null, which masks "we know this is Python".
  return { stack: "python", start: "", cwd, env: {} }
}

// Plain static sites. We skip if package.json exists (Node detection covers
// Vite / Next / Astro / etc.) — this is for hand-rolled HTML.
async function detectStatic(cwd: string): Promise<RunManifest | null> {
  if (await exists(join(cwd, "package.json"))) return null
  if (!(await exists(join(cwd, "index.html")))) return null
  return {
    stack: "static",
    start: "npx --yes serve -l $PORT .",
    cwd,
    env: {},
  }
}
