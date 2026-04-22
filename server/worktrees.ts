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
  | "ship.commit"
  | "ship.merge"
  | "ship.pr"
  | "ship.warning"
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
  const isError = event.endsWith(".failed") || event === "ship.warning"
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

/** Ship a worktree. Three modes:
 *  - `commit`: stage + commit pending changes on the branch; leave worktree + branch.
 *  - `merge` : commit + fast-forward baseRef to the branch tip; remove worktree + branch on success.
 *  - `pr`    : commit + push branch to origin + `gh pr create`; leave worktree + branch until the PR closes.
 *  On any failure the worktree is left intact so the user can inspect + retry. */
export type ShipMode = "commit" | "merge" | "pr"

export type ShipResult = {
  mode: ShipMode
  committed: boolean
  commitSha: string | null
  merged: boolean
  baseAdvanced: string | null // new sha for base_ref if we fast-forwarded it
  /** True when the branch diverged and we rebased it onto baseRef as part of
   *  the merge. False = branch was already strictly ahead (classic ff). */
  rebased: boolean
  /** True when we also updated the base checkout's working tree (it was on
   *  baseRef and clean). False = ref-only advance; the user must `git pull`
   *  in the base cwd to see the files. */
  workingTreeUpdated: boolean
  pushed: boolean
  prUrl: string | null
  warning: string | null
  /** When set, the user can hand the conflict to the agent via the existing
   *  rebase endpoint. The UI uses this to decide whether to show the action. */
  needsRebase: boolean
}

export type ShipInput = {
  baseCwd: string
  worktreePath: string
  branch: string
  baseRef: string
  message: string
  /** What to do after the commit step. Defaults to `merge` when omitted. */
  mode?: ShipMode
  /** Body text for PR mode; ignored otherwise. */
  prBody?: string
}

/** True when `git status --porcelain` shows anything — untracked, staged, or
 *  modified. Exported so the ship endpoint can skip the commit-message LLM
 *  call on a clean worktree. */
export async function hasDirtyWorktree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain"], { cwd })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  return hasDirtyWorktree(cwd)
}

async function headSha(cwd: string, ref = "HEAD"): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["rev-parse", ref], { cwd })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileP("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd })
    return true
  } catch {
    return false
  }
}

export async function shipWorktree({
  baseCwd,
  worktreePath,
  branch,
  baseRef,
  message,
  mode = "merge",
  prBody,
}: ShipInput): Promise<ShipResult> {
  const result: ShipResult = {
    mode,
    committed: false,
    commitSha: null,
    merged: false,
    baseAdvanced: null,
    rebased: false,
    workingTreeUpdated: false,
    pushed: false,
    prUrl: null,
    warning: null,
    needsRebase: false,
  }

  // 1. Stage + commit anything uncommitted in the worktree. Log the file
  // list + per-file size (post-stage) so empty-file surprises are diagnosable
  // from server logs — we caught a case where a zero-byte commit landed on
  // main because the worker had emptied a file mid-turn.
  if (await hasUncommittedChanges(worktreePath)) {
    await execFileP("git", ["add", "-A"], { cwd: worktreePath })
    try {
      const { stdout } = await execFileP(
        "git",
        ["diff", "--cached", "--numstat"],
        { cwd: worktreePath }
      )
      const lines = stdout.trim().split("\n").filter(Boolean).slice(0, 20)
      if (lines.length) {
        logWorktreeEvent("ship.commit", {
          branch,
          phase: "staged",
          files: lines.length,
          // numstat: "<added>\t<deleted>\t<path>" — surface the ones that
          // netted to zero so we can spot empty writes before they land.
          preview: lines.map((l) => l.replace(/\t/g, ":")).join(" | "),
        })
      }
    } catch {
      // diagnostic only — fall through if git diff fails for any reason
    }
    await execFileP("git", ["commit", "-m", message], { cwd: worktreePath })
    result.committed = true
  }
  result.commitSha = await headSha(worktreePath)

  if (mode === "commit") {
    logWorktreeEvent("ship.commit", { branch, committed: result.committed, sha: result.commitSha?.slice(0, 8) })
    return result
  }

  if (mode === "pr") {
    // Push the branch with upstream tracking so subsequent pushes from the
    // worktree are one-step, then let `gh` open the PR. `gh` picks up its
    // auth from the host (`gh auth login` or GH_TOKEN).
    try {
      await execFileP("git", ["push", "-u", "origin", branch], { cwd: worktreePath })
      result.pushed = true
    } catch (err) {
      result.warning = `push failed: ${err instanceof Error ? err.message : String(err)}`
      logWorktreeEvent("ship.warning", { branch, phase: "push", reason: result.warning })
      return result
    }

    try {
      const args = [
        "pr", "create",
        "--base", baseRef,
        "--head", branch,
        "--title", firstLine(message) || branch,
        "--body", prBody ?? message,
      ]
      const { stdout } = await execFileP("gh", args, { cwd: worktreePath })
      // gh prints the PR URL on the last non-empty line.
      result.prUrl = stdout.trim().split("\n").filter(Boolean).pop() ?? null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.warning = /command not found|ENOENT/i.test(message)
        ? "gh CLI is not installed on the server — install it or run with GH_TOKEN"
        : `gh pr create failed: ${message}`
      logWorktreeEvent("ship.warning", { branch, phase: "gh", reason: result.warning })
      return result
    }

    // PR mode intentionally leaves the worktree + branch intact until the PR
    // closes, matching Kanban's "inspect + steer mid-flight" pattern.
    logWorktreeEvent("ship.pr", { branch, url: result.prUrl ?? "" })
    return result
  }

  // mode === "merge": fast-forward baseRef to the branch tip. If the base
  // checkout is already on baseRef and clean, do a real `git merge --ff-only`
  // from it so the working tree updates too. Otherwise fall back to
  // update-ref (branch pointer only) and warn the user their working tree
  // will be stale until they `git pull`.
  const branchSha = await headSha(baseCwd, `refs/heads/${branch}`)
  const baseSha = await headSha(baseCwd, `refs/heads/${baseRef}`)
  if (!branchSha || !baseSha) {
    result.warning = `could not resolve ${branch} or ${baseRef}`
    return result
  }

  // If the branch and baseRef have diverged (neither is ancestor of the other
  // via the ff path below), try to rebase the branch onto baseRef first.
  // Clean rebase → falls through to the ff-only path. Rebase with conflicts
  // → aborted cleanly, returned as a rebase-needs-attention warning so the UI
  // can offer "Ask agent to rebase".
  let workingBranchSha = branchSha
  if (
    branchSha !== baseSha &&
    !(await isAncestor(baseCwd, baseSha, branchSha))
  ) {
    const rebaseClean = await tryRebaseWorktree(worktreePath, baseRef)
    if (rebaseClean.ok) {
      // Worktree's branch now sits on top of baseRef. Grab the new tip and
      // fall through to the standard ff path.
      workingBranchSha = (await headSha(worktreePath)) ?? workingBranchSha
      result.rebased = true
      logWorktreeEvent("ship.merge", { branch, phase: "rebase.clean" })
    } else {
      result.warning = rebaseClean.message
      result.needsRebase = true
      logWorktreeEvent("ship.warning", { branch, phase: "rebase", reason: result.warning })
      return result
    }
  }

  if (workingBranchSha === baseSha) {
    // Branch had no new commits — nothing to merge, just clean up.
  } else if (await isAncestor(baseCwd, baseSha, workingBranchSha)) {
    // Prefer `git merge --ff-only` from the base cwd so the working tree
    // updates alongside the ref. Git itself will refuse only if dirty files
    // OVERLAP with files we'd update — unrelated untracked/modified files
    // are fine. We try it optimistically and fall back to update-ref on
    // actual refusal.
    const baseOnBaseRef = await currentBranchMatches(baseCwd, baseRef)
    if (baseOnBaseRef) {
      try {
        await execFileP("git", ["merge", "--ff-only", workingBranchSha], { cwd: baseCwd })
        result.baseAdvanced = workingBranchSha
        result.merged = true
        result.workingTreeUpdated = true
      } catch (err) {
        // Git refused — almost always because the base cwd has uncommitted
        // edits on a file the ff would overwrite. Leave the user's work
        // alone and fall through to the ref-only path below.
        const raw = err instanceof Error ? err.message : String(err)
        logWorktreeEvent("ship.warning", {
          branch, phase: "merge-ff", reason: raw.split("\n")[0],
        })
      }
    }
    if (!result.merged) {
      // Either the base cwd isn't on baseRef, or the ff-only refused.
      // Advance the ref without touching the working tree so we don't stomp
      // on in-progress edits; the user must pull to see the files.
      await execFileP(
        "git",
        ["update-ref", `refs/heads/${baseRef}`, workingBranchSha, baseSha],
        { cwd: baseCwd }
      )
      result.baseAdvanced = workingBranchSha
      result.merged = true
      result.workingTreeUpdated = false
      result.warning = !baseOnBaseRef
        ? `${baseRef} advanced on disk, but the base checkout at ${baseCwd} is on a different branch. ` +
          `Check it out and \`git pull\` to see the files.`
        : `${baseRef} advanced on disk, but files you have uncommitted in ${baseCwd} would be overwritten by the ff. ` +
          `Commit or stash there, then \`git pull\` to see the files.`
    }
  } else {
    // This branch *really* can't be merged cleanly — isAncestor check passed
    // only if rebase put it there. Shouldn't happen in practice; keep the
    // rebase-fallback warning for users.
    result.warning = `${baseRef} has commits not in ${branch}; rebase before shipping`
    result.needsRebase = true
    logWorktreeEvent("ship.warning", { branch, phase: "merge", reason: result.warning })
    return result
  }

  // Clean up the worktree + branch now that its contents are in baseRef.
  await removeWorktree({ baseCwd, worktreePath, branch, force: true })
  logWorktreeEvent("ship.merge", {
    branch,
    baseRef,
    advanced: result.baseAdvanced?.slice(0, 8) ?? "noop",
    workingTreeUpdated: result.workingTreeUpdated,
  })
  return result
}

/** Rebase the worktree's branch onto `baseRef`. Returns ok=true if the rebase
 *  completed without conflicts; otherwise `git rebase --abort` is run so the
 *  worktree is left in its pre-rebase state and the caller can surface a
 *  user-friendly conflict warning. */
async function tryRebaseWorktree(
  worktreePath: string,
  baseRef: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await execFileP("git", ["rebase", baseRef], { cwd: worktreePath })
    return { ok: true }
  } catch (err) {
    // Abort so the branch state is restored. Ignore errors from abort itself.
    try {
      await execFileP("git", ["rebase", "--abort"], { cwd: worktreePath })
    } catch {
      /* best effort */
    }
    const raw = err instanceof Error ? err.message : String(err)
    const conflict = /conflict|could not apply|Merge conflict/i.test(raw)
    return {
      ok: false,
      message: conflict
        ? `Rebasing onto ${baseRef} hit conflicts. Click "Ask agent to rebase" to have the worker resolve them, then retry Merge.`
        : `Rebase onto ${baseRef} failed: ${raw.split("\n")[0]}`,
    }
  }
}

async function currentBranchMatches(cwd: string, branch: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("git", ["symbolic-ref", "--short", "HEAD"], { cwd })
    return stdout.trim() === branch
  } catch {
    return false
  }
}

function firstLine(s: string): string {
  return s.split("\n")[0].trim()
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
