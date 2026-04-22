import { query } from "@anthropic-ai/claude-agent-sdk"
import { createHash } from "node:crypto"

// ─── Evaluator-optimizer loop helpers ────────────────────────────────────────
// The worker runs in `startRunner` as today (interactive-style, resume session).
// After each worker turn completes, if the conversation is an auto-loop task,
// the orchestrator calls `runEvaluator()` with a *fresh* session and read-only
// tools. The evaluator's job is to compare the worker's output to the goal and
// return structured JSON telling the orchestrator whether to continue.
//
// Prompt vs code split: rubric + output schema live in the evaluator's system
// prompt. Iteration count, budget, and no-progress detection live here.

export type EvaluatorInput = {
  goal: string
  lastAssistantText: string
  toolsUsed: string
  cwd: string
  abort?: AbortController
}

export type EvaluatorStatus = "continue" | "done" | "error"

export type EvaluatorResult = {
  status: EvaluatorStatus
  feedback: string
  nextSteps: string
  costUsd: number
  raw: string // whatever the model returned verbatim, for debugging
}

const SYSTEM_PROMPT = `You are a strict code-task evaluator. You will be given:
  - GOAL: the user's original task
  - LAST_OUTPUT: the worker agent's last assistant message
  - TOOLS_USED: a short summary of what the worker did

You have only read-only tools available (Read, Glob, Grep). Use them to verify
the worker's result against GOAL by inspecting files in the current directory.

Respond with ONLY valid JSON matching this exact schema and nothing else:
{
  "status": "continue" | "done" | "error",
  "feedback": "concise critique; what is missing or wrong",
  "nextSteps": "if continuing, the exact next instruction to give the worker; otherwise empty string"
}

Guidance:
- "continue" if the goal is materially incomplete or incorrect.
- "done" if the goal is met, even if style could be better — do not chase perfection.
- "error" if the situation is unrecoverable (missing deps, broken tree, hostile state).
- Keep feedback short and specific. No preamble, no JSON code fences, no commentary outside the object.`

export async function runEvaluator({
  goal,
  lastAssistantText,
  toolsUsed,
  cwd,
  abort,
}: EvaluatorInput): Promise<EvaluatorResult> {
  const userMessage = [
    `GOAL:\n${goal}`,
    "",
    `LAST_OUTPUT:\n${lastAssistantText.slice(0, 8000)}`,
    "",
    `TOOLS_USED:\n${toolsUsed || "(none)"}`,
  ].join("\n")

  let finalText = ""
  let costUsd = 0

  try {
    const messages = query({
      prompt: userMessage,
      options: {
        cwd,
        permissionMode: "default",
        systemPrompt: SYSTEM_PROMPT,
        allowedTools: ["Read", "Glob", "Grep"],
        settingSources: [],
        includePartialMessages: false,
        abortController: abort,
      },
    })
    for await (const msg of messages) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") finalText += block.text
        }
      } else if (msg.type === "result") {
        costUsd = Number(msg.total_cost_usd ?? 0)
        break
      }
    }
  } catch (err) {
    return {
      status: "error",
      feedback: `evaluator crashed: ${err instanceof Error ? err.message : String(err)}`,
      nextSteps: "",
      costUsd,
      raw: "",
    }
  }

  const parsed = parseEvaluatorJson(finalText)
  return { ...parsed, costUsd, raw: finalText }
}

export function parseEvaluatorJson(raw: string): Omit<EvaluatorResult, "costUsd" | "raw"> {
  const trimmed = raw.trim()
  // Occasionally the model wraps the JSON in ```json fences despite instructions.
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()
  try {
    const obj = JSON.parse(cleaned)
    const status: EvaluatorStatus =
      obj.status === "continue" || obj.status === "done" || obj.status === "error"
        ? obj.status
        : "error"
    return {
      status,
      feedback: typeof obj.feedback === "string" ? obj.feedback : "",
      nextSteps: typeof obj.nextSteps === "string" ? obj.nextSteps : "",
    }
  } catch {
    return {
      status: "error",
      feedback: "evaluator produced unparseable output; stopping loop.",
      nextSteps: "",
    }
  }
}

/** Short summary of which tools the worker invoked this turn — feeds into the
 *  evaluator prompt so the rubric can judge "how" in addition to "what". */
export function summarizeTools(
  events: ReadonlyArray<{ kind: string; name?: string }>,
  max = 12
): string {
  const counts = new Map<string, number>()
  for (const e of events) {
    if (e.kind !== "tool_use" || !e.name) continue
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
  }
  if (counts.size === 0) return ""
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
    .join(", ")
}

/** Stable short hash of evaluator feedback so the orchestrator can spot the
 *  worker making no progress ("same critique twice in a row → stuck"). */
export function feedbackHash(feedback: string): string {
  return createHash("sha1").update(feedback.trim()).digest("hex").slice(0, 12)
}

// ─── Commit-message generator ────────────────────────────────────────────────
// Called by the ship endpoint when the user didn't supply a message. Uses a
// stateless, short-budget query that inspects the worktree diff and writes a
// conventional commit.

const COMMIT_MSG_SYSTEM_PROMPT = `You write conventional commit messages for a pending commit in the current directory.

Tools available: Bash (restricted to read-only git), Read, Glob, Grep. Use them to inspect what changed.

Rules:
- First line: conventional-commit subject (\`type(scope): imperative summary\`), 72 chars max. Types: feat, fix, docs, refactor, perf, test, chore.
- Blank line, then 1-3 short bullet points describing the changes. Each bullet ≤ 90 chars.
- No preamble, no sign-off, no code fences. Output the message and nothing else.
- If you cannot determine the scope, omit it.`

export type CommitMessageInput = {
  cwd: string
  title: string
  goal?: string | null
  abort?: AbortController
}

export async function generateCommitMessage({
  cwd,
  title,
  goal,
  abort,
}: CommitMessageInput): Promise<string | null> {
  const userMessage = [
    `Title hint: ${title}`,
    goal ? `Goal: ${goal}` : "",
    "",
    "Inspect the pending changes (e.g. `git diff --stat`, `git diff`) and write the commit message.",
  ]
    .filter(Boolean)
    .join("\n")

  let finalText = ""
  try {
    const messages = query({
      prompt: userMessage,
      options: {
        cwd,
        permissionMode: "default",
        systemPrompt: COMMIT_MSG_SYSTEM_PROMPT,
        // Bash is allowed but restricted to git-read operations via the prompt;
        // the agent SDK enforces permissions, we rely on the model following
        // the rubric. Read/Glob/Grep give it a fallback if Bash is blocked.
        allowedTools: ["Bash", "Read", "Glob", "Grep"],
        settingSources: [],
        includePartialMessages: false,
        abortController: abort,
      },
    })
    for await (const msg of messages) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") finalText += block.text
        }
      } else if (msg.type === "result") {
        break
      }
    }
  } catch {
    return null
  }

  const cleaned = finalText
    .trim()
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()
  return cleaned || null
}

// ─── LLM-based run-manifest detector ─────────────────────────────────────────
// The heuristic detector in server/runtime/manifest.ts handles the common
// cases (package.json scripts, Procfile, Python entrypoints). When none of
// those match, or the repo is a framework the heuristics don't know, we ask
// the model to read the tree and propose a start command. Stateless, bounded
// cost, read-only tools.

export type LlmManifestStack =
  | "node"
  | "bun"
  | "python"
  | "go"
  | "ruby"
  | "static"
  | "docker"
  | "custom"

export type LlmManifestProposal = {
  stack: LlmManifestStack
  start: string
  build?: string
  env: Record<string, string>
  rationale: string
  confidence: "high" | "medium" | "low"
}

export type LlmManifestDetectionResult = {
  proposal: LlmManifestProposal | null
  costUsd: number
  raw: string
  error?: string
}

const RUN_DETECT_SYSTEM_PROMPT = `You are a release engineer inspecting an unknown codebase.
Your job: propose how to START this application for local development.

You have read-only tools (Read, Glob, Grep, Bash). Bash is for small read-only
commands like \`cat\`, \`ls\`, \`head\`, \`test -f\`. Do NOT modify anything.

Steps you should take:
1. Look at the repo root for obvious anchors: package.json, Procfile, Dockerfile,
   pyproject.toml, requirements.txt, go.mod, Gemfile, Cargo.toml, index.html.
2. If package.json exists: read it. Prefer scripts.dev, then scripts.start.
   Detect the package manager from the lockfile (bun.lock* → bun, pnpm-lock.yaml
   → pnpm, yarn.lock → yarn, else npm).
3. If Procfile exists: its "web:" process wins over heuristics.
4. If README/READ*.md mentions a run command, read it. It often specifies
   env vars the user must set.
5. Keep the start command short and expect the host to inject PORT via env.
   Use $PORT in the command if the app needs an explicit port argument.

Respond with ONLY valid JSON matching this schema (no markdown fences, no
commentary):
{
  "stack": "node" | "bun" | "python" | "go" | "ruby" | "static" | "docker" | "custom",
  "start": "exact shell command — e.g. 'npm run dev' or 'bun dev'",
  "build": "optional build command, omit when none",
  "env": { "KEY": "value" },
  "rationale": "one to two sentences explaining why you picked this command",
  "confidence": "high" | "medium" | "low"
}

Rules:
- "start" is REQUIRED and must be a non-empty single-line shell command.
- "env" is REQUIRED; use an empty object when you have no suggestions.
- "confidence" is REQUIRED.
- If you cannot find anything runnable, return: {"stack":"custom","start":"","env":{},"rationale":"…","confidence":"low"}.
- No preamble. No JSON code fences. No commentary outside the object.`

export async function detectManifestWithLLM({
  cwd,
  abort,
}: {
  cwd: string
  abort?: AbortController
}): Promise<LlmManifestDetectionResult> {
  const userMessage = [
    `Worktree: ${cwd}`,
    "",
    "Inspect this directory and propose how to start the app locally.",
    "Return JSON per the schema in your system prompt.",
  ].join("\n")

  const log = (event: string, details: Record<string, unknown> = {}) => {
    const tail = Object.entries(details)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ")
    console.log(`[runtime] llm.detect.${event}${tail ? " " + tail : ""}`)
  }

  log("start", { cwd })

  let finalText = ""
  let costUsd = 0
  try {
    const messages = query({
      prompt: userMessage,
      options: {
        cwd,
        // Server-side flow with no interactive prompt surface — use
        // bypassPermissions so Bash/Read/etc. don't hang on an approval
        // prompt nobody can answer. Tool surface is already restricted.
        permissionMode: "bypassPermissions",
        systemPrompt: RUN_DETECT_SYSTEM_PROMPT,
        allowedTools: ["Read", "Glob", "Grep", "Bash"],
        settingSources: [],
        includePartialMessages: false,
        abortController: abort,
      },
    })
    for await (const msg of messages) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") finalText += block.text
        }
      } else if (msg.type === "result") {
        costUsd = Number(msg.total_cost_usd ?? 0)
        // SDK signals agent-side failures via `is_error`. Surface them
        // instead of silently returning empty finalText.
        const maybeErr = msg as unknown as { is_error?: boolean; subtype?: string }
        if (maybeErr.is_error) {
          const subtype = maybeErr.subtype ?? "unknown"
          log("agent_error", { subtype, costUsd })
          return {
            proposal: null,
            costUsd,
            raw: finalText,
            error: `agent-sdk returned is_error (${subtype})`,
          }
        }
        break
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("exception", { message })
    return { proposal: null, costUsd, raw: finalText, error: message }
  }

  const proposal = parseRunDetectJson(finalText)
  if (!proposal) {
    log("parse_failed", {
      finalTextLen: finalText.length,
      head: finalText.slice(0, 120),
    })
    return {
      proposal: null,
      costUsd,
      raw: finalText,
      error: finalText.trim()
        ? `couldn't parse JSON from model output (${finalText.length} chars)`
        : "model returned no text",
    }
  }
  log("ok", { stack: proposal.stack, start: proposal.start, costUsd })
  return { proposal, costUsd, raw: finalText }
}

function parseRunDetectJson(raw: string): LlmManifestProposal | null {
  // First pass: strip markdown fences. Handles ```json { ... } ``` and bare
  // JSON responses. Common "I'll inspect the repo… here's the config:" prose
  // preambles are handled by the second pass.
  const fenceStripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()
  if (!fenceStripped) return null

  let obj: unknown = tryParse(fenceStripped)
  if (!obj) {
    // Second pass: locate the outermost balanced `{…}` substring. Works when
    // the model adds commentary before/after the JSON block.
    const start = fenceStripped.indexOf("{")
    const end = fenceStripped.lastIndexOf("}")
    if (start !== -1 && end > start) {
      obj = tryParse(fenceStripped.slice(start, end + 1))
    }
  }
  if (!obj || typeof obj !== "object") return null
  const r = obj as Record<string, unknown>

  const allowedStacks: LlmManifestStack[] = [
    "node",
    "bun",
    "python",
    "go",
    "ruby",
    "static",
    "docker",
    "custom",
  ]
  const stack = allowedStacks.includes(r.stack as LlmManifestStack)
    ? (r.stack as LlmManifestStack)
    : "custom"
  const start = typeof r.start === "string" ? r.start.trim() : ""
  const build = typeof r.build === "string" && r.build.trim() ? r.build.trim() : undefined
  const env: Record<string, string> = {}
  if (r.env && typeof r.env === "object") {
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof v === "string") env[k] = v
    }
  }
  const confidence =
    r.confidence === "high" || r.confidence === "medium" || r.confidence === "low"
      ? r.confidence
      : "low"
  const rationale = typeof r.rationale === "string" ? r.rationale : ""

  return { stack, start, env, build, rationale, confidence }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ─── Chat-driven service detection ───────────────────────────────────────────
// The standalone `detectManifestWithLLM` above runs a fresh session with no
// context. That's wrong for anything the user just built in chat — the agent
// can't see "I just scaffolded an Express app 3 turns ago." This helper is
// used by the merge-flow-style scripted-turn approach: injected into the
// conversation's own runner, so the agent sees the full session history.

const DETECT_SERVICES_SYSTEM_PROMPT = `You are configuring how to start this project locally.
You have the full conversation history + read/write tools. Use that context —
if the user just built something, you already know what.

Inspect the project (package.json, Procfile, README, entry files, etc.) and
propose ONE start command suitable for local development. Keep it short.

End your reply with exactly this block (and nothing after it):

<run-manifest>
{
  "stack": "node" | "bun" | "python" | "go" | "ruby" | "static" | "docker" | "custom",
  "start": "exact shell command",
  "build": "optional build command — omit when none",
  "env": { "KEY": "value" },
  "rationale": "one short sentence",
  "confidence": "high" | "medium" | "low"
}
</run-manifest>

Rules:
- The block is MANDATORY — the host parses it to save the config.
- "start" must be non-empty. If you genuinely can't figure it out, explain
  why in your reply and still emit the block with "start": "".
- The host will inject $PORT at runtime — use $PORT in the command when
  the app needs an explicit port.
- Do NOT start the service yourself. This turn is configuration only.`

export function buildDetectServicesSystemPrompt(): string {
  return DETECT_SERVICES_SYSTEM_PROMPT
}

export function buildDetectServicesPrompt(input: {
  cwd: string
  existingManifest?: { stack: string; start: string; build?: string; env?: Record<string, string> } | null
}): string {
  const lines = [
    "[Host task — configure services]",
    "",
    "The user wants to configure how to run this project locally. Inspect the",
    "codebase and, drawing on the full conversation history, propose the best",
    "start command.",
    "",
    `Working directory: \`${input.cwd}\``,
  ]
  if (input.existingManifest) {
    lines.push(
      "",
      "A configuration already exists — treat this as a refinement pass.",
      "Propose an updated manifest that reflects any changes the user has made",
      "in this conversation since it was saved:",
      "```json",
      JSON.stringify(input.existingManifest, null, 2),
      "```"
    )
  } else {
    lines.push(
      "",
      "No configuration exists yet — this is the first-run setup.",
    )
  }
  lines.push(
    "",
    "When you're done, emit the `<run-manifest>` block exactly as described in",
    "your system prompt. The host parses it to save the configuration. Do not",
    "start the service."
  )
  return lines.join("\n")
}

export function buildDetectServicesNoticeText(input: {
  cwd: string
  refining?: boolean
}): string {
  const title = input.refining
    ? "Refining the run configuration for this project."
    : "Configuring services for this project."
  return [
    title,
    "",
    "The agent will inspect the codebase and propose a start command.",
    `cwd: \`${input.cwd}\``,
  ].join("\n")
}

const DETECT_MANIFEST_BLOCK_RE = /<run-manifest>\s*([\s\S]*?)\s*<\/run-manifest>/i

// Extract and validate a manifest from an assistant message. Used by the
// post-turn reconcile hook in startRunner's `finally` block. Returns null
// if no block is present or the JSON is malformed — idempotent and safe
// to run on every turn.
export function extractDetectedManifest(assistantText: string): LlmManifestProposal | null {
  const match = DETECT_MANIFEST_BLOCK_RE.exec(assistantText)
  if (!match) return null
  const payload = match[1].trim()
  const obj = tryParse(payload)
  if (!obj || typeof obj !== "object") return null
  const r = obj as Record<string, unknown>

  const allowedStacks: LlmManifestStack[] = [
    "node", "bun", "python", "go", "ruby", "static", "docker", "custom",
  ]
  const stack = allowedStacks.includes(r.stack as LlmManifestStack)
    ? (r.stack as LlmManifestStack)
    : "custom"
  const start = typeof r.start === "string" ? r.start.trim() : ""
  if (!start) return null // empty-start block counts as "model gave up"
  const build = typeof r.build === "string" && r.build.trim() ? r.build.trim() : undefined
  const env: Record<string, string> = {}
  if (r.env && typeof r.env === "object") {
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof v === "string") env[k] = v
    }
  }
  const confidence =
    r.confidence === "high" || r.confidence === "medium" || r.confidence === "low"
      ? r.confidence
      : "low"
  const rationale = typeof r.rationale === "string" ? r.rationale : ""
  return { stack, start, env, build, rationale, confidence }
}
