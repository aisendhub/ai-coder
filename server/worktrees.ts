import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { promises as fsp } from "node:fs"
import { dirname, relative, resolve } from "node:path"

const execFileP = promisify(execFile)

/** Single point for all worktree lifecycle events so `grep "\[worktree\]"` is
 *  sufficient to reconstruct what the feature did. `details` is flattened to
 *  a `key=value` tail; keep it short — full object dumps live at console.log. */
export type WorktreeEvent =
  | "create"
  | "create.failed"
  | "symlink.broken"
  | "symlink.repaired"
  | "remove"
  | "remove.failed"
  | "merge.request"
  | "merge.reconciled"
  | "arm"
  | "prune"
  | "reconcile.orphan"
  | "reconcile.missing"
  | "reconcile.auto_removed"
  | "reap.hard_delete"

export function logWorktreeEvent(
  event: WorktreeEvent,
  details: Record<string, unknown> = {}
): void {
  const tail = Object.entries(details)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ")
  const isError = event.endsWith(".failed")
  const log = isError ? console.warn : console.log
  log(`[worktree] ${event}${tail ? " " + tail : ""}`)
}

export const WORKTREES_ROOT = resolve(
  process.env.WORKTREES_ROOT ??
    resolve(process.env.PROJECTS_ROOT ?? dirname(process.cwd()), ".ai-coder-worktrees")
)

// Files/dirs we symlink from the base checkout so worktrees don't have to
// reinstall deps or rebuild caches. All POSIX.
const SYMLINK_TARGETS = [
  "node_modules",
  ".venv",
  "vendor",
  "target",
  "dist",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
]
const SYMLINK_GLOB_PREFIXES = [".env"] // .env, .env.local, .env.production, …

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileP("git", ["rev-parse", "--git-dir"], { cwd })
    return true
  } catch {
    return false
  }
}

export async function detectDefaultBaseRef(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["symbolic-ref", "--short", "HEAD"], { cwd })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Turn a conversation title into a git-safe branch slug. */
export function slugifyTitle(title: string | null | undefined, max = 32): string {
  const raw = (title ?? "").trim().toLowerCase()
  if (!raw) return "chat"
  const cleaned = raw
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max)
    .replace(/^-|-$/g, "")
  return cleaned || "chat"
}

export function branchNameFor(title: string | null | undefined, conversationId: string): string {
  return `ai-coder/${slugifyTitle(title)}-${conversationId.slice(0, 6)}`
}

export function worktreePathFor(projectId: string, conversationId: string): string {
  return resolve(WORKTREES_ROOT, projectId, conversationId)
}

async function listDirSafe(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir)
  } catch {
    return []
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p)
    return true
  } catch {
    return false
  }
}

export type WorktreeCreate = {
  baseCwd: string
  worktreePath: string
  branch: string
  baseRef: string
}

/** `git worktree add -b <branch> <path> <baseRef>` then symlink gitignored dirs. */
export async function addWorktree({
  baseCwd,
  worktreePath,
  branch,
  baseRef,
}: WorktreeCreate): Promise<void> {
  await fsp.mkdir(dirname(worktreePath), { recursive: true })
  try {
    await execFileP(
      "git",
      ["worktree", "add", "-b", branch, worktreePath, baseRef],
      { cwd: baseCwd }
    )
  } catch (err) {
    logWorktreeEvent("create.failed", {
      branch,
      baseRef,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
  await linkGitignored(baseCwd, worktreePath)
  logWorktreeEvent("create", { branch, baseRef, path: worktreePath })
}

/** Symlink heavy gitignored dirs/files from the base into the worktree. */
export async function linkGitignored(baseCwd: string, worktreePath: string): Promise<void> {
  const tasks: Promise<void>[] = []

  for (const name of SYMLINK_TARGETS) {
    tasks.push(tryLink(baseCwd, worktreePath, name))
  }

  // dotfiles matching .env*
  const entries = await listDirSafe(baseCwd)
  for (const name of entries) {
    if (SYMLINK_GLOB_PREFIXES.some((p) => name.startsWith(p))) {
      tasks.push(tryLink(baseCwd, worktreePath, name))
    }
  }

  await Promise.all(tasks)
}

async function tryLink(baseCwd: string, worktreePath: string, name: string): Promise<void> {
  const source = resolve(baseCwd, name)
  const target = resolve(worktreePath, name)
  try {
    const stat = await fsp.lstat(source)
    if (!stat) return
    // skip if the worktree already has a real file/dir here (git checkout created it)
    if (await pathExists(target)) return
    // symlink relative so the pair survives the worktree being moved.
    const rel = relative(dirname(target), source)
    await fsp.symlink(rel, target, stat.isDirectory() ? "dir" : "file")
  } catch {
    // source doesn't exist — nothing to link. Not an error.
  }
}

export type WorktreeRemove = {
  baseCwd: string
  worktreePath: string
  branch?: string | null
  /** Force even if worktree has uncommitted changes or branch has unpushed commits. */
  force?: boolean
}

export async function removeWorktree({
  baseCwd,
  worktreePath,
  branch,
  force = false,
}: WorktreeRemove): Promise<void> {
  let removedOk = true
  // worktree remove handles the directory + metadata. Use --force to skip safety
  // checks if caller opted in.
  try {
    await execFileP(
      "git",
      ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath],
      { cwd: baseCwd }
    )
  } catch (err) {
    removedOk = false
    logWorktreeEvent("remove.failed", {
      branch,
      path: worktreePath,
      reason: err instanceof Error ? err.message : String(err),
    })
    // fall through — caller may still want branch deleted even if path is gone
  }
  // Belt-and-braces: if the directory still exists (e.g. git said it's not a
  // worktree anymore), nuke it.
  if (await pathExists(worktreePath)) {
    await fsp.rm(worktreePath, { recursive: true, force: true })
  }
  if (branch) {
    try {
      await execFileP("git", ["branch", force ? "-D" : "-d", branch], { cwd: baseCwd })
    } catch {
      // branch may not exist or may have unpushed commits; caller decides.
    }
  }
  if (removedOk) logWorktreeEvent("remove", { branch, path: worktreePath })
}

/** Build the scripted prompt that drives the AI-led merge. The agent runs
 *  with cwd = baseCwd, uses `git -C` for worktree-side commands, and is told
 *  explicitly when to STOP and surface problems to the user (dirty base, merge
 *  conflicts, branch mismatch). Keep the steps narrow and numbered — merges
 *  are not the place for agent creativity. See docs/MERGE-FLOW.md. */
export function buildMergePrompt(input: {
  worktreePath: string
  baseCwd: string
  branch: string
  baseRef: string
  title: string
  goal: string | null
}): string {
  const commitSubject = input.title.trim() || `Merge ${input.branch}`
  const commitBody = input.goal?.trim() ? `\n\n${input.goal.trim()}` : ""
  return [
    "[Host task — merge]",
    "",
    `Merge branch \`${input.branch}\` into \`${input.baseRef}\` and clean up the worktree.`,
    "",
    `- Worktree path: \`${input.worktreePath}\``,
    `- Base checkout: \`${input.baseCwd}\``,
    `- Base branch: \`${input.baseRef}\``,
    "",
    "Run these steps **in order**. If any step fails or requires judgement, STOP and report what you see — do not retry or improvise.",
    "",
    `1. Verify the worktree is still on its branch: \`git -C ${sh(input.worktreePath)} rev-parse --abbrev-ref HEAD\` must print \`${input.branch}\`. If not, STOP and explain.`,
    "",
    `2. Commit any pending work in the worktree. Check \`git -C ${sh(input.worktreePath)} status --porcelain\`. If output is non-empty, run:`,
    `   \`git -C ${sh(input.worktreePath)} add -A\``,
    `   \`git -C ${sh(input.worktreePath)} commit -m "<concise message>"\``,
    "",
    `3. Verify the base checkout is clean: \`git -C ${sh(input.baseCwd)} status --porcelain\`. If non-empty, STOP — ask the user to commit or stash in the base repo before retrying. Do NOT run git stash yourself.`,
    "",
    `4. Remember the current branch in the base checkout: \`git -C ${sh(input.baseCwd)} rev-parse --abbrev-ref HEAD\`. Save it as ORIG_BRANCH.`,
    "",
    `5. Check out the base branch: \`git -C ${sh(input.baseCwd)} checkout ${input.baseRef}\`.`,
    "",
    `6. Squash-merge the task branch:`,
    `   \`git -C ${sh(input.baseCwd)} merge --squash -- ${input.branch}\``,
    `   If git reports a conflict, STOP. Report the conflicting files (\`git -C ${sh(input.baseCwd)} status --short\`) and wait for the user's instructions. Do NOT attempt to resolve conflicts on your own unless the user asks you to.`,
    "",
    `7. Commit the squash with a message summarizing the task:`,
    `   \`git -C ${sh(input.baseCwd)} commit -m ${sh(commitSubject + commitBody)}\``,
    "",
    `8. Remove the worktree and delete the branch:`,
    `   \`git -C ${sh(input.baseCwd)} worktree remove --force ${sh(input.worktreePath)}\``,
    `   \`git -C ${sh(input.baseCwd)} branch -D ${input.branch}\``,
    "",
    `9. If ORIG_BRANCH is different from \`${input.baseRef}\`, restore it:`,
    `   \`git -C ${sh(input.baseCwd)} checkout <ORIG_BRANCH>\``,
    "",
    "10. Report the final state: the new commit SHA on the base branch and a one-line summary. Then stop.",
  ].join("\n")
}

/** Shell-quote a path/string for inclusion in a command the agent will run.
 *  We're generating prose, not executing — this is a hint to the agent to use
 *  the quoted form, not a real shell quote. */
function sh(value: string): string {
  if (/^[\w./@=:+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Repair a single worktree's symlinks if any have been broken (e.g. user
 *  removed `node_modules` from the base). Returns count of links restored. */
export async function repairSymlinks(baseCwd: string, worktreePath: string): Promise<number> {
  let repaired = 0
  const broken: string[] = []
  for (const name of [...SYMLINK_TARGETS]) {
    const target = resolve(worktreePath, name)
    try {
      const stat = await fsp.lstat(target)
      if (stat.isSymbolicLink()) {
        // Check it still points at something readable.
        try {
          await fsp.stat(target)
          continue // intact
        } catch {
          await fsp.unlink(target)
          broken.push(name)
        }
      } else {
        continue // a real dir/file lives here, leave it alone
      }
    } catch {
      // target doesn't exist — fall through to recreate
    }
    await tryLink(baseCwd, worktreePath, name)
    if (await pathExists(target)) repaired++
  }
  if (broken.length) {
    logWorktreeEvent("symlink.broken", { path: worktreePath, names: broken.join(",") })
  }
  if (repaired > 0) {
    logWorktreeEvent("symlink.repaired", { path: worktreePath, count: repaired })
  }
  return repaired
}

/** `git worktree prune --verbose` — removes metadata for worktrees whose
 *  directory has vanished. Safe: only touches git's internal bookkeeping,
 *  never files or branches. Returns the trimmed output, or an empty string
 *  if there was nothing to prune. */
export async function pruneWorktreeMetadata(baseCwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["worktree", "prune", "--verbose"], { cwd: baseCwd })
    return stdout.trim()
  } catch (err) {
    logWorktreeEvent("remove.failed", {
      phase: "prune",
      reason: err instanceof Error ? err.message : String(err),
    })
    return ""
  }
}

export type WorktreeEntry = { path: string; branch: string | null; head: string | null }

/** Parse `git worktree list --porcelain` into structured entries. */
export async function listWorktrees(baseCwd: string): Promise<WorktreeEntry[]> {
  try {
    const { stdout } = await execFileP("git", ["worktree", "list", "--porcelain"], { cwd: baseCwd })
    const out: WorktreeEntry[] = []
    let current: Partial<WorktreeEntry> = {}
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) out.push({ path: current.path, branch: current.branch ?? null, head: current.head ?? null })
        current = { path: line.slice("worktree ".length).trim() }
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice("HEAD ".length).trim()
      } else if (line.startsWith("branch ")) {
        // "refs/heads/<branch>"
        current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "")
      }
    }
    if (current.path) out.push({ path: current.path, branch: current.branch ?? null, head: current.head ?? null })
    return out
  } catch {
    return []
  }
}
