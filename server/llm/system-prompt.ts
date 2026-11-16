import { promises as fs } from "node:fs"
import path from "node:path"

// ─── System-prompt addendum builder ──────────────────────────────────────────
// The Claude Code preset already covers tool use, code style, env, etc. Our
// `append` text adds:
//   1. cwd / branch / base-ref so the agent doesn't hallucinate placeholder
//      paths on bare filenames (the chat path).
//   2. Worktree-mode rules so task runs don't `git worktree remove` themselves
//      (the task path).
//   3. Optional project-specific instructions from
//      `<cwd>/.ai-coder/instructions.md`, layered last so they can override
//      the rest. See docs/SYSTEM-PROMPT.md for the layering model.

export type WorkerPromptContext = {
  cwd: string
  kind: string | null
  branch: string | null
  baseRef: string | null
  worktreePath: string | null
  /** Conversation id for the active run. Surfaced to the agent so it can
   *  attach the Ai-Coder-Conversation trailer when committing. See
   *  docs/WORK-STATE.md. */
  conversationId: string | null
}

/** Builds the host-side append text from the conversation/worktree context.
 *  Critical for tasks: without it, Claude occasionally guesses placeholder
 *  paths like /Users/user/ when asked to create a file with a bare name,
 *  hits EACCES, then recovers via `pwd`. */
export function buildSystemPromptAppend(input: WorkerPromptContext): string {
  const isTaskWorktree = input.kind === "task" && !!input.worktreePath
  if (!isTaskWorktree) {
    return [
      `You are working in: ${input.cwd}`,
      `Use relative paths (e.g. "./src/foo.ts") or absolute paths inside the cwd. Never invent placeholder absolute paths like "/Users/user/...".`,
      "",
      ...noAutoCommitSection(),
      "",
      ...workSummaryAndTrailerSection(input.conversationId),
    ].join("\n")
  }
  const lines = [
    "You are running an autonomous task in an isolated git worktree.",
    "",
    `- Working directory (cwd): ${input.cwd}`,
    `- Branch: ${input.branch ?? "(unknown)"}`,
    `- Base ref: ${input.baseRef ?? "(unknown)"}`,
    "",
    "Rules for file paths:",
    `- ALWAYS write files inside the cwd above. Use relative paths (e.g. "./test.txt") or absolute paths starting with "${input.cwd}".`,
    `- NEVER invent placeholder absolute paths like "/Users/user/" or "/home/user/" — they will fail with permission errors. If unsure, run "pwd" first.`,
    "",
    "Rules for git:",
    "- Do not switch branches or run `git worktree` commands — this worktree is managed by the host.",
    "",
    ...noAutoCommitSection(),
    "",
    ...workSummaryAndTrailerSection(input.conversationId),
  ]
  return lines.join("\n")
}

/** Hard rule: the user reviews each turn's diff before deciding to commit.
 *  Applies to both chat (real cwd) and task worktrees — even though the
 *  worktree is on a dedicated branch, the user still wants per-turn visibility
 *  into what changed before any commit lands. */
function noAutoCommitSection(): string[] {
  return [
    "Commits:",
    "- Do NOT run `git commit`, `git add` followed by `git commit`, or `git push` unless the user explicitly asks for a commit in the current message. Finishing a task is NOT permission to commit.",
    "- Leave changes unstaged at end of turn so the user can review the diff and decide when to commit.",
    "- Authorizing phrases (examples): \"commit this\", \"commit and push\", \"make a commit\", \"ship it\". NOT authorizing: \"finish the task\", \"wrap it up\", \"done\", \"go ahead\". Each new commit needs fresh authorization in the current message — prior approvals do not carry forward.",
  ]
}

/** Two related instructions: emit a one-line work summary at end-of-turn,
 *  and stamp the conversation-id trailer on commits. Both feed the chat ↔
 *  commit attribution surfaces in docs/WORK-STATE.md. */
function workSummaryAndTrailerSection(conversationId: string | null): string[] {
  const lines: string[] = [
    "End-of-turn work summary:",
    "- If you edited, created, or deleted any files this turn, end your reply with a single line wrapped in <work-summary>...</work-summary> describing what you did in <= 12 words. Example: <work-summary>Wired the kanban filter into the sidebar.</work-summary>.",
    "- One summary per turn. Place it on its own line at the very end. Skip the tag entirely on turns that didn't touch files.",
  ]
  if (conversationId) {
    lines.push(
      "",
      "Commit message trailers:",
      `- When you create a commit, append this trailer to the message body so the commit can be linked back to this chat: \`Ai-Coder-Conversation: ${conversationId}\`.`,
      "- Place it in the trailer block (last paragraph, alongside any Co-Authored-By line). Skip the trailer when amending an existing commit that already has it.",
    )
  }
  return lines
}

// ─── Project addendum loader ─────────────────────────────────────────────────
// Per-project text that gets appended after the host append. Lives in
// `<cwd>/.ai-coder/instructions.md` so it travels with the project (commit it
// to share across users; .gitignore it for local-only). 32KB cap is well
// above any reasonable usage and well below SDK limits.

const PROJECT_ADDENDUM_PATH = path.join(".ai-coder", "instructions.md")
const PROJECT_ADDENDUM_MAX_BYTES = 32 * 1024

type CacheEntry = { mtimeMs: number; text: string | null }
const cache = new Map<string, CacheEntry>()

/** Reads `<cwd>/.ai-coder/instructions.md` if present. Returns null when the
 *  file doesn't exist; throws are swallowed (we don't want a stat error to
 *  break the runner). Cached by mtime so we re-read only on edit. */
export async function loadProjectAddendum(cwd: string): Promise<string | null> {
  const file = path.join(cwd, PROJECT_ADDENDUM_PATH)
  let mtimeMs: number
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return null
    mtimeMs = stat.mtimeMs
  } catch {
    cache.delete(file)
    return null
  }
  const cached = cache.get(file)
  if (cached && cached.mtimeMs === mtimeMs) return cached.text
  try {
    const buf = await fs.readFile(file)
    const text = buf
      .subarray(0, PROJECT_ADDENDUM_MAX_BYTES)
      .toString("utf-8")
      .trim()
    const value = text.length > 0 ? text : null
    cache.set(file, { mtimeMs, text: value })
    return value
  } catch {
    cache.delete(file)
    return null
  }
}

/** Composes the host append + (optional) project addendum into the final
 *  string handed to the SDK as `systemPrompt.append`. */
export function composeSystemPromptAppend(
  hostAppend: string,
  projectAddendum: string | null
): string {
  if (!projectAddendum) return hostAppend
  return `${hostAppend}\n\n# Project instructions\n\n${projectAddendum}`
}
