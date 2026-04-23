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

// ─── Multi-service detection ────────────────────────────────────────────────
// Unlike `detect` which returns the FIRST match for a single cwd, this
// surveys the project root + its immediate subdirectories and returns every
// candidate it finds. Used by the "+ Add service" picker so monorepos
// (web + api, frontend + backend, apps/* layouts) get all their services
// presented at once.
//
// Scope: depth 1 from the project root, plus two common monorepo layouts
// (`apps/*` and `services/*`) at depth 2. Anything deeper or more exotic
// stays the agent's job.

export type DetectedServiceCandidate = {
  /** Proposed service name — inferred from the subdir basename or "default"
   *  at the root. Validates against the registered-service name regex. */
  name: string
  stack: Stack
  /** Start command, already prefixed with `cd <subdir> && ` when subdir is
   *  non-empty so the project-level cwd can run it directly. */
  start: string
  build?: string
  env: Record<string, string>
  port?: number
  /** Relative to the project root. "" means "run from root cwd". */
  subdir: string
  /** One-sentence "why we picked this", e.g. "`package.json` dev script". */
  rationale: string
  confidence: "high" | "medium" | "low"
}

const DETECT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".parcel-cache",
  ".cache",
  "coverage",
  "tmp",
  "temp",
  "public",
  "static",
  "assets",
  "images",
  "docs",
  "test",
  "tests",
  "__tests__",
  "spec",
  "types",
  "scripts",
])

// Names that signal "this is a library, not a runnable service" — we skip
// these even when they have a package.json. Heuristic; users can still add
// them manually if we guess wrong.
const DETECT_LIB_NAME_HINTS = new Set([
  "shared",
  "common",
  "utils",
  "lib",
  "ui",
  "config",
  "types",
  "eslint-config",
  "tsconfig",
])

// Directory basename → canonical service name. Keeps things tidy so a
// monorepo with `apps/frontend` and `apps/backend` gets `web` + `api`
// names without the user having to rename.
const NAME_NORMALIZE: Record<string, string> = {
  frontend: "web",
  client: "web",
  ui: "web",
  app: "web",
  backend: "api",
  server: "api",
  service: "api",
}

function normalizeServiceName(raw: string): string {
  const n = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
  return NAME_NORMALIZE[n] ?? n
}

// Detect every plausible runnable service under the project root.
// Results are de-duplicated by name (first match wins, root first so a
// root-level "default" always beats a subdir guess of the same name).
export async function detectAllServices(
  rootCwd: string
): Promise<DetectedServiceCandidate[]> {
  const out: DetectedServiceCandidate[] = []
  const seenNames = new Set<string>()

  const pushCandidate = async (cwd: string, subdir: string, proposedName: string) => {
    const m = await detect(cwd)
    if (!m || !m.start) return
    const name = seenNames.has(proposedName)
      ? dedupeName(proposedName, seenNames)
      : proposedName
    seenNames.add(name)
    const prefixed = subdir ? `cd ${shellQuote(subdir)} && ${m.start}` : m.start
    out.push({
      name,
      stack: m.stack,
      start: prefixed,
      build: m.build,
      env: m.env ?? {},
      port: m.port,
      subdir,
      rationale: subdir
        ? `Detected in \`${subdir}/\` (${m.stack})`
        : `Detected in the project root (${m.stack})`,
      // Root hits and package.json hits are high; anything we had to guess
      // at (static site, partial python with no entry) is medium.
      confidence: m.start ? "high" : "medium",
    })
  }

  // Root candidate → "default" (matches the legacy single-service name).
  await pushCandidate(rootCwd, "", "default")

  // Depth-1 subdirs. Skip library-ish dirs and known junk.
  let entries: string[] = []
  try {
    entries = await fsp.readdir(rootCwd)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    if (DETECT_SKIP_DIRS.has(entry)) continue
    if (DETECT_LIB_NAME_HINTS.has(entry)) continue
    const fullPath = join(rootCwd, entry)
    const s = await safeStat(fullPath)
    if (!s?.isDirectory()) continue
    await pushCandidate(fullPath, entry, normalizeServiceName(entry))
  }

  // Common monorepo layouts: apps/* and services/*. Depth-2; same rules.
  for (const holder of ["apps", "services", "packages"]) {
    const holderPath = join(rootCwd, holder)
    const s = await safeStat(holderPath)
    if (!s?.isDirectory()) continue
    let children: string[] = []
    try {
      children = await fsp.readdir(holderPath)
    } catch {
      continue
    }
    for (const child of children) {
      if (child.startsWith(".")) continue
      if (DETECT_SKIP_DIRS.has(child)) continue
      // `packages/*` is conventionally for libs — only surface a package
      // when it has a recognizable dev script entry, skip pure libs via
      // DETECT_LIB_NAME_HINTS.
      if (holder === "packages" && DETECT_LIB_NAME_HINTS.has(child)) continue
      const full = join(holderPath, child)
      const st = await safeStat(full)
      if (!st?.isDirectory()) continue
      await pushCandidate(full, `${holder}/${child}`, normalizeServiceName(child))
    }
  }

  return out
}

async function safeStat(path: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fsp.stat(path)
  } catch {
    return null
  }
}

// Append -2, -3, ... until unique. Rare in practice (would take two subdirs
// collapsing to the same normalized name) but cheap to handle.
function dedupeName(base: string, seen: Set<string>): string {
  let i = 2
  while (seen.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

// Minimal shell-quote for directory names. We only use it on directory
// basenames from readdir, so the set of unusual characters is small, but
// spaces + apostrophes need handling.
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}
