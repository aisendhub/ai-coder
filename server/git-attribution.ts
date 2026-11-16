// Git-trailer + work-summary helpers used by the work-state capture pipeline.
// See docs/WORK-STATE.md.
//
// Pure functions only — no DB writes, no spawn. The work-state.ts module
// composes these with `git` invocations.

const TRAILER_CONVERSATION = "Ai-Coder-Conversation"
const TRAILER_MESSAGE = "Ai-Coder-Message"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CommitTrailers = {
  conversationId: string | null
  messageId: string | null
}

/** Reads our two trailers off a commit message body. Tolerates extra trailers
 *  (Co-Authored-By, Signed-off-by) and case-insensitive keys. */
export function parseTrailers(commitMessage: string): CommitTrailers {
  const out: CommitTrailers = { conversationId: null, messageId: null }
  // Trailers live in the last paragraph; scan the whole body cheaply since
  // commit messages are small.
  for (const line of commitMessage.split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === TRAILER_CONVERSATION.toLowerCase() && UUID_RE.test(value)) {
      out.conversationId = value.toLowerCase()
    } else if (key === TRAILER_MESSAGE.toLowerCase() && UUID_RE.test(value)) {
      out.messageId = value.toLowerCase()
    }
  }
  return out
}

/** Returns a commit message with our trailers appended in the trailer block.
 *  Preserves an existing trailer block if present (separates with a blank line
 *  iff the body doesn't already end in trailers). Idempotent — calling twice
 *  with the same ids returns the same string. */
export function appendTrailers(
  commitMessage: string,
  ids: { conversationId?: string | null; messageId?: string | null }
): string {
  const { conversationId, messageId } = ids
  if (!conversationId && !messageId) return commitMessage
  const existing = parseTrailers(commitMessage)
  const needConv = conversationId && existing.conversationId !== conversationId.toLowerCase()
  const needMsg = messageId && existing.messageId !== messageId.toLowerCase()
  if (!needConv && !needMsg) return commitMessage

  const additions: string[] = []
  if (needConv) additions.push(`${TRAILER_CONVERSATION}: ${conversationId}`)
  if (needMsg) additions.push(`${TRAILER_MESSAGE}: ${messageId}`)

  // If the body already ends in a trailer block (last non-empty paragraph is
  // all `Key: value` lines), append to it. Otherwise add a blank line then the
  // trailers as a new block.
  const trimmed = commitMessage.replace(/\s+$/, "")
  const lastBlank = trimmed.lastIndexOf("\n\n")
  const lastBlock = lastBlank === -1 ? trimmed : trimmed.slice(lastBlank + 2)
  const lastBlockIsTrailers = lastBlock.length > 0 && lastBlock
    .split(/\r?\n/)
    .every((line) => /^[A-Za-z][A-Za-z0-9-]*:\s+\S/.test(line))
  return lastBlockIsTrailers
    ? `${trimmed}\n${additions.join("\n")}\n`
    : `${trimmed}\n\n${additions.join("\n")}\n`
}

/** Extracts the FIRST <work-summary>...</work-summary> block from assistant
 *  text. Tolerates leading/trailing whitespace, multi-line bodies, and
 *  collapses internal whitespace to single spaces. Returns null if absent or
 *  empty. */
export function parseWorkSummary(assistantText: string): string | null {
  if (!assistantText) return null
  const m = /<work-summary>([\s\S]*?)<\/work-summary>/i.exec(assistantText)
  if (!m) return null
  const cleaned = m[1].replace(/\s+/g, " ").trim()
  return cleaned.length > 0 ? cleaned.slice(0, 500) : null
}

/** Strips <work-summary> tags from text destined for the chat UI — the tag is
 *  metadata, not user-facing prose. */
export function stripWorkSummary(assistantText: string): string {
  return assistantText.replace(/<work-summary>[\s\S]*?<\/work-summary>\s*/gi, "")
}

/** Auto-generates a short summary line from a list of changed paths when the
 *  agent didn't emit a <work-summary>. Heuristic: pick the most common
 *  top-level directory and report path count. */
export function autoSummarize(
  files: Array<{ path: string; status: string }>
): string {
  if (files.length === 0) return ""
  const buckets = new Map<string, number>()
  for (const f of files) {
    const top = f.path.split("/")[0] || "."
    buckets.set(top, (buckets.get(top) ?? 0) + 1)
  }
  const [topDir] = Array.from(buckets.entries()).sort((a, b) => b[1] - a[1])[0]
  const verbs = countVerbs(files)
  const verb = verbs.added > verbs.modified && verbs.added > verbs.deleted
    ? "Added"
    : verbs.deleted > verbs.modified
      ? "Removed"
      : "Updated"
  const noun = files.length === 1 ? files[0].path : `${files.length} files in ${topDir}`
  return `${verb} ${noun}`.slice(0, 200)
}

function countVerbs(files: Array<{ status: string }>): {
  added: number
  modified: number
  deleted: number
} {
  let added = 0
  let modified = 0
  let deleted = 0
  for (const f of files) {
    if (f.status === "A") added++
    else if (f.status === "D") deleted++
    else modified++
  }
  return { added, modified, deleted }
}
