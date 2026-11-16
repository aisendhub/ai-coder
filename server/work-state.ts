// Per-turn work-state capture: writes turn_change_sets rows for each
// assistant turn that touched files, and upserts agent-produced commits
// into the commits table with attribution. See docs/WORK-STATE.md.
//
// This module is invoked at the END of each agent-loop iteration in
// startRunner — not via a separate file watcher. The iteration boundary is a
// natural commit horizon: the agent has finished its turn, message persistence
// has flushed, and we know exactly which message_id owns the changes.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  autoSummarize,
  parseTrailers,
  parseWorkSummary,
} from "./git-attribution.js"

const execFileP = promisify(execFile)

const FILES_CAP = 50

export type TurnChangeFile = {
  path: string
  status: "A" | "M" | "D" | "R"
  insertions: number
  deletions: number
}

/** A snapshot of the conversation cwd taken just before a worker iteration
 *  starts running. Compared against the post-iteration state to derive what
 *  the turn changed. */
export type PreTurnSnapshot = {
  headSha: string | null         // null when the cwd has no commits yet
  /** dirty paths at iteration start, used so we don't blame the new turn for
   *  pending edits the user already had. */
  dirtyPaths: Set<string>
}

/** Run before each iteration's worker query() call. Cheap (two git invocations
 *  with --porcelain / rev-parse) so it's safe to run unconditionally. */
export async function snapshotBeforeTurn(cwd: string): Promise<PreTurnSnapshot> {
  const [headSha, dirty] = await Promise.all([
    revParseHead(cwd),
    statusPaths(cwd),
  ])
  return { headSha, dirtyPaths: new Set(dirty) }
}

/** Run after each iteration's worker query() finishes. Inserts/updates the
 *  turn_change_sets row keyed on messageId, then walks any new commits and
 *  upserts them into the commits table with attribution. Best-effort — never
 *  throws; logs failures and returns. */
export async function captureTurnAndCommits(args: {
  sb: SupabaseClient
  cwd: string
  conversationId: string
  projectId: string
  messageId: string                 // assistant message_id for this iteration
  pre: PreTurnSnapshot
  branch: string | null
  assistantText: string
}): Promise<void> {
  try {
    const { sb, cwd, conversationId, projectId, messageId, pre, branch, assistantText } = args
    const headAfter = await revParseHead(cwd)

    // ── Record any new commits HEAD..pre.headSha (oldest → newest) ─────────
    const newCommitShas = await listNewCommits(cwd, pre.headSha, headAfter)
    for (const sha of newCommitShas) {
      await recordCommit({ sb, cwd, sha, conversationId, messageId, projectId, branch })
    }

    // ── Build per-turn change set ─────────────────────────────────────────
    // Files that changed in *this iteration*: the union of (a) commits this
    // iteration produced, and (b) currently-dirty paths that weren't dirty at
    // iteration start. Both come from git directly so we match what the user
    // sees in the changes panel.
    const filesByPath = new Map<string, TurnChangeFile>()

    // (a) commits during the turn
    if (newCommitShas.length > 0) {
      const range = pre.headSha ? `${pre.headSha}..${headAfter}` : headAfter!
      const numstat = await numstatRange(cwd, range)
      for (const f of numstat) filesByPath.set(f.path, f)
    }

    // (b) current-dirty paths that weren't dirty at the start
    const nowDirty = await statusPathsDetailed(cwd)
    for (const f of nowDirty) {
      if (pre.dirtyPaths.has(f.path)) continue   // pre-existing, not this turn
      const existing = filesByPath.get(f.path)
      if (existing) continue                     // already counted via commit numstat
      filesByPath.set(f.path, f)
    }

    if (filesByPath.size === 0) return           // turn touched nothing

    const allFiles = Array.from(filesByPath.values()).sort((a, b) =>
      a.path.localeCompare(b.path)
    )
    const truncated = allFiles.length > FILES_CAP
    const files = truncated ? allFiles.slice(0, FILES_CAP) : allFiles
    const totals = files.reduce(
      (acc, f) => ({
        insertions: acc.insertions + f.insertions,
        deletions: acc.deletions + f.deletions,
      }),
      { insertions: 0, deletions: 0 }
    )

    const summary =
      parseWorkSummary(assistantText) ??
      autoSummarize(allFiles.map((f) => ({ path: f.path, status: f.status })))

    // committed_in_sha: if every changed path was captured by one of the new
    // commits, link the latest one. Otherwise leave null (mixed pending + commit
    // turn, or pure pending turn).
    let committedInSha: string | null = null
    if (newCommitShas.length > 0 && nowDirty.length === 0) {
      committedInSha = newCommitShas[newCommitShas.length - 1]
    }

    const { error } = await sb
      .from("turn_change_sets")
      .upsert(
        {
          message_id: messageId,
          conversation_id: conversationId,
          files: files,
          files_count: allFiles.length,
          truncated,
          insertions: totals.insertions,
          deletions: totals.deletions,
          summary,
          committed_in_sha: committedInSha,
        },
        { onConflict: "message_id" }
      )
    if (error) {
      console.error("[work-state] turn_change_sets upsert failed", error.message)
    }
  } catch (err) {
    console.error("[work-state] captureTurnAndCommits failed", err)
  }
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function recordCommit(args: {
  sb: SupabaseClient
  cwd: string
  sha: string
  conversationId: string
  messageId: string
  projectId: string
  branch: string | null
}): Promise<void> {
  const { sb, cwd, sha, conversationId, messageId, projectId, branch } = args

  // Fetch everything we need in one git invocation to avoid spawning four.
  // Format: %H · %P · %an · %ae · %ct · %s · %b
  const FS = "\x1f"
  const { stdout } = await execFileP(
    "git",
    ["show", "--no-patch", `--pretty=format:%H${FS}%P${FS}%an${FS}%ae${FS}%ct${FS}%s${FS}%B`, sha],
    { cwd, maxBuffer: 5 * 1024 * 1024 }
  )
  const parts = stdout.split(FS)
  const fullSha = parts[0]
  const parentsRaw = parts[1] ?? ""
  const ctimeStr = parts[4] ?? "0"
  const subject = parts[5] ?? ""
  const fullMessage = parts[6] ?? ""
  const parents = parentsRaw.split(" ").filter(Boolean)
  const authoredAt = new Date((parseInt(ctimeStr, 10) || 0) * 1000).toISOString()

  // numstat for stats only (file list also feeds this, but we only need totals)
  const { stdout: numstatOut } = await execFileP(
    "git",
    ["show", "--numstat", "-z", "--pretty=format:", sha],
    { cwd, maxBuffer: 5 * 1024 * 1024 }
  )
  const stats = sumNumstat(numstatOut)

  // Body = full message minus the first line (subject). Trailers we already
  // wrote (or are about to) live in the body's trailer block.
  const subjectLineEnd = fullMessage.indexOf("\n")
  const body = subjectLineEnd === -1 ? "" : fullMessage.slice(subjectLineEnd + 1).trim()

  // Attribution: prefer trailers the agent wrote into the commit itself
  // (durable, survives push/clone). Fall back to the turn's known ids when
  // the agent forgot — the DB row is still correct, just less portable.
  // We deliberately don't amend missing trailers in Phase A: amend rewrites
  // the SHA, which would invalidate this very upsert and complicate the
  // turn_change_sets backfill. Re-add post-commit amend in a later phase if
  // downstream consumers (GitHub PR view, archived repos) need the trailer.
  const trailers = parseTrailers(fullMessage)
  const linkedConversationId = trailers.conversationId ?? conversationId
  const linkedMessageId = trailers.messageId ?? messageId

  const { error } = await sb
    .from("commits")
    .upsert(
      {
        sha: fullSha,
        conversation_id: linkedConversationId,
        message_id: linkedMessageId,
        project_id: projectId,
        branch,
        parent_shas: parents,
        subject,
        body,
        files_changed: stats.files,
        insertions: stats.insertions,
        deletions: stats.deletions,
        authored_at: authoredAt,
        kind: "turn",
      },
      { onConflict: "sha" }
    )
  if (error) {
    console.error("[work-state] commits upsert failed", error.message, "sha=", fullSha.slice(0, 7))
  }
}

async function revParseHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd })
    const sha = stdout.trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch {
    return null  // empty repo or not a repo
  }
}

async function statusPaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain=v1", "-z"], {
      cwd, maxBuffer: 5 * 1024 * 1024,
    })
    return parsePorcelainPaths(stdout)
  } catch {
    return []
  }
}

async function statusPathsDetailed(cwd: string): Promise<TurnChangeFile[]> {
  try {
    // --porcelain=v1 -z → "<XY> <path>\0" per entry; renames "<XY> <new>\0<old>\0"
    const { stdout: status } = await execFileP("git", ["status", "--porcelain=v1", "-z"], {
      cwd, maxBuffer: 5 * 1024 * 1024,
    })
    // numstat for working tree (staged + unstaged combined via two passes)
    const [{ stdout: stagedNum }, { stdout: unstagedNum }] = await Promise.all([
      execFileP("git", ["diff", "--numstat", "-z", "--cached"], { cwd, maxBuffer: 5 * 1024 * 1024 }).catch(() => ({ stdout: "" })),
      execFileP("git", ["diff", "--numstat", "-z"], { cwd, maxBuffer: 5 * 1024 * 1024 }).catch(() => ({ stdout: "" })),
    ])
    const stats = mergeNumstat(parseNumstatZ(stagedNum), parseNumstatZ(unstagedNum))

    const out: TurnChangeFile[] = []
    const tokens = status.split("\0")
    let i = 0
    while (i < tokens.length) {
      const entry = tokens[i]
      if (!entry) { i++; continue }
      const xy = entry.slice(0, 2)
      const path = entry.slice(3)
      const status = mapPorcelainStatus(xy)
      if (xy.startsWith("R") || xy.startsWith("C")) {
        // Next token is the old path; skip it.
        i += 2
      } else {
        i += 1
      }
      const s = stats.get(path) ?? { insertions: 0, deletions: 0 }
      out.push({ path, status, insertions: s.insertions, deletions: s.deletions })
    }
    return out
  } catch {
    return []
  }
}

function parsePorcelainPaths(stdout: string): string[] {
  const out: string[] = []
  const tokens = stdout.split("\0")
  let i = 0
  while (i < tokens.length) {
    const entry = tokens[i]
    if (!entry) { i++; continue }
    const xy = entry.slice(0, 2)
    out.push(entry.slice(3))
    if (xy.startsWith("R") || xy.startsWith("C")) i += 2
    else i += 1
  }
  return out
}

function mapPorcelainStatus(xy: string): TurnChangeFile["status"] {
  // Either column non-space marks the file. Prefer the strongest signal.
  if (xy.includes("D")) return "D"
  if (xy.includes("A") || xy.includes("?")) return "A"
  if (xy.includes("R")) return "R"
  return "M"
}

async function listNewCommits(
  cwd: string,
  fromSha: string | null,
  toSha: string | null
): Promise<string[]> {
  if (!toSha) return []
  if (fromSha && fromSha === toSha) return []
  try {
    const range = fromSha ? `${fromSha}..${toSha}` : toSha
    const { stdout } = await execFileP("git", ["rev-list", "--reverse", range], {
      cwd, maxBuffer: 5 * 1024 * 1024,
    })
    return stdout.trim().split("\n").filter((s) => /^[0-9a-f]{40}$/.test(s))
  } catch {
    return []
  }
}

async function numstatRange(cwd: string, range: string): Promise<TurnChangeFile[]> {
  try {
    // --name-status to get A/M/D/R; --numstat for line counts. Two passes
    // matched by path.
    const [{ stdout: ns }, { stdout: nstat }] = await Promise.all([
      execFileP("git", ["diff", "--name-status", "-z", "-M", "-C", range], {
        cwd, maxBuffer: 5 * 1024 * 1024,
      }),
      execFileP("git", ["diff", "--numstat", "-z", range], {
        cwd, maxBuffer: 5 * 1024 * 1024,
      }),
    ])
    const stats = parseNumstatZ(nstat)
    const out: TurnChangeFile[] = []
    const tokens = ns.split("\0")
    let i = 0
    while (i < tokens.length) {
      const entry = tokens[i]
      if (!entry || entry.length === 0) { i++; continue }
      const code = entry[0]
      if (code === "R" || code === "C") {
        const _oldPath = tokens[i + 1]
        const newPath = tokens[i + 2]
        if (newPath) {
          const s = stats.get(newPath) ?? { insertions: 0, deletions: 0 }
          out.push({ path: newPath, status: "R", insertions: s.insertions, deletions: s.deletions })
        }
        i += 3
      } else {
        const path = tokens[i + 1]
        if (path) {
          const status: TurnChangeFile["status"] =
            code === "A" ? "A" : code === "D" ? "D" : "M"
          const s = stats.get(path) ?? { insertions: 0, deletions: 0 }
          out.push({ path, status, insertions: s.insertions, deletions: s.deletions })
        }
        i += 2
      }
    }
    return out
  } catch {
    return []
  }
}

function parseNumstatZ(stdout: string): Map<string, { insertions: number; deletions: number }> {
  const out = new Map<string, { insertions: number; deletions: number }>()
  const tokens = stdout.split("\0")
  let i = 0
  while (i < tokens.length) {
    const row = tokens[i]
    if (!row) { i++; continue }
    const tabs = row.split("\t")
    if (tabs.length < 3) { i++; continue }
    const [addStr, delStr, maybePath] = tabs
    const insertions = addStr === "-" ? 0 : parseInt(addStr, 10) || 0
    const deletions = delStr === "-" ? 0 : parseInt(delStr, 10) || 0
    let path = maybePath
    if (!path) {
      // Rename row: empty path field, then \0<old>\0<new>
      path = tokens[i + 2] ?? ""
      i += 3
    } else {
      i += 1
    }
    if (path) out.set(path, { insertions, deletions })
  }
  return out
}

function sumNumstat(stdout: string): { files: number; insertions: number; deletions: number } {
  const m = parseNumstatZ(stdout)
  let insertions = 0
  let deletions = 0
  for (const v of m.values()) {
    insertions += v.insertions
    deletions += v.deletions
  }
  return { files: m.size, insertions, deletions }
}

function mergeNumstat(
  a: Map<string, { insertions: number; deletions: number }>,
  b: Map<string, { insertions: number; deletions: number }>
): Map<string, { insertions: number; deletions: number }> {
  const out = new Map(a)
  for (const [k, v] of b) {
    const existing = out.get(k)
    if (existing) {
      out.set(k, {
        insertions: existing.insertions + v.insertions,
        deletions: existing.deletions + v.deletions,
      })
    } else {
      out.set(k, v)
    }
  }
  return out
}
