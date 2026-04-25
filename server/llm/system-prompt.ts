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
    "- You're on a dedicated branch. Commit freely; the orchestrator will merge or open a PR when the user ships the task.",
    "- Do not switch branches or run `git worktree` commands — this worktree is managed by the host.",
  ]
  return lines.join("\n")
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
