import { getLlmProvider } from "./llm/index.ts"
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
    const messages = getLlmProvider().runAgent({
      prompt: userMessage,
      cwd,
      permissionMode: "default",
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: ["Read", "Glob", "Grep"],
      settingSources: [],
      abortController: abort,
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
    const messages = getLlmProvider().runAgent({
      prompt: userMessage,
      cwd,
      permissionMode: "default",
      systemPrompt: COMMIT_MSG_SYSTEM_PROMPT,
      // Bash is allowed but restricted to git-read operations via the prompt;
      // the agent SDK enforces permissions, we rely on the model following
      // the rubric. Read/Glob/Grep give it a fallback if Bash is blocked.
      allowedTools: ["Bash", "Read", "Glob", "Grep"],
      settingSources: [],
      abortController: abort,
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
  /** Port the app will bind to. Used as a preferred port at run time. */
  port?: number
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
    const messages = getLlmProvider().runAgent({
      prompt: userMessage,
      cwd,
      // Server-side flow with no interactive prompt surface — use
      // bypassPermissions so Bash/Read/etc. don't hang on an approval
      // prompt nobody can answer. Tool surface is already restricted.
      permissionMode: "bypassPermissions",
      systemPrompt: RUN_DETECT_SYSTEM_PROMPT,
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
      settingSources: [],
      abortController: abort,
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
  const port = coercePort(r.port)

  return { stack, start, env, build, port, rationale, confidence }
}

// Accept port as a number OR a numeric string (models sometimes quote it).
// Returns undefined for anything outside the non-privileged / user range.
function coercePort(value: unknown): number | undefined {
  const n =
    typeof value === "number" ? value
      : typeof value === "string" && /^\d+$/.test(value.trim()) ? parseInt(value, 10)
      : NaN
  if (!Number.isFinite(n)) return undefined
  if (n < 1024 || n > 65535) return undefined
  return n
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ─── Multi-service LLM proposer ─────────────────────────────────────────────
// Stateless, synchronous (over one LLM call) — returns an ARRAY of proposed
// services rather than auto-saving like the chat-based detect-services flow.
// The picker calls this when the user clicks "Detect with AI": we want the
// model to inspect the repo, propose every runnable process it sees, and
// hand the list back for the user to pick from.
//
// The existing `extractDetectedServices` parser accepts the `<run-services>`
// block shape, so we ask for that. Falls back to a single-service result
// when the model emits `<run-manifest>` instead.

export type LlmServicesDetectionResult = {
  proposals: LlmServiceProposal[]
  costUsd: number
  raw: string
  error?: string
}

const RUN_DETECT_SERVICES_SYSTEM_PROMPT = `You are a release engineer cataloguing every runnable service in an
unknown codebase. Your job: enumerate EVERY process the user could start
for local development, whether or not it looks "already configured".
The host downstream dedupes by name — your task is thorough enumeration,
not optimization.

You have read-only tools (Read, Glob, Grep, Bash for small read-only
commands like \`ls\`, \`cat\`, \`head\`, \`test -f\`, \`find\`). Do NOT
modify anything.

**You MUST inspect the filesystem before answering.** Do not guess from
context or from lists the user gives you — any list the user provides is
for cross-checking only, NOT a substitute for looking at the tree. At
minimum, before you emit the block:

1. Run \`ls -la\` at the project root to see the actual layout.
2. If \`package.json\` exists at the root, Read it in full. Note every
   entry in \`scripts\` (dev, start, server, worker, etc.) and any
   \`workspaces\` / \`packageManager\` fields.
3. If \`Procfile\`, \`docker-compose.yml\`, \`docker-compose.yaml\`,
   \`pyproject.toml\`, \`requirements.txt\`, \`go.mod\`, \`Gemfile\`, or
   \`Cargo.toml\` exists, Read it.
4. Glob for subdirs with their own project anchors (\`package.json\`,
   \`pyproject.toml\`, \`go.mod\`, \`Cargo.toml\`, \`index.html\`). Each
   one is a candidate service. Common layouts: \`apps/*\`, \`services/*\`,
   \`packages/*\`, \`api/\`, \`web/\`, \`server/\`, \`client/\`,
   \`worker/\`.
5. If README / READ*.md exists, skim it for run instructions.
6. For each server file (Node \`server.js\`/\`server.ts\`, Python
   \`main.py\`/\`app.py\`/\`server.py\`/\`manage.py\`, Go \`main.go\`…)
   Read the top ~30 lines to see what port it binds to and whether it
   reads \`PORT\` env.

Report EVERY runnable process you find — the root service, every
workspace package that runs a server, every subdir with its own entry
point. One entry per service. The host hides duplicates of services
the user already has; you don't skip them yourself.

Start-command rules:
- Keep commands short. The host injects \`PORT\` as an env var AND
  expands \`$PORT\` in the command via its shell. Framework-specific
  aliases are also auto-injected when \`stack\` matches: Vite gets
  \`VITE_PORT\`, Nuxt gets \`NUXT_PORT\` / \`NUXT_PUBLIC_PORT\`, Astro
  gets \`ASTRO_PORT\`, etc. Do NOT set \`PORT\` or these aliases yourself
  in the env block — the host owns them.
- Do NOT set the \`port\` field unless the user must use a specific port
  (rare; e.g. a webhook expecting localhost:3000). Setting it makes the
  host strict-bind that port and fail loudly if it's taken — usually
  not what you want for parallel tasks.
- Node / Express / Fastify / Hono: typically reads \`process.env.PORT\`.
  \`npm run dev\` or \`npm start\` works as-is.
- Next.js: \`npm run dev -- -p $PORT\`.
- Vite: **ignores PORT env** — must use \`npm run dev -- --port $PORT\`.
- Django: \`python manage.py runserver 0.0.0.0:$PORT\`.
- Flask: \`flask run --port $PORT\`.
- FastAPI / uvicorn: \`uvicorn main:app --port $PORT --reload\`.
- Rails: \`rails server -p $PORT\` or \`bin/dev -p $PORT\`.
- If a service lives in a subdir, prefix \`cd <subdir> && \`.

Service-to-service refs: every running sibling auto-injects
\`<NAME>_URL\`, \`<NAME>_HOST\`, \`<NAME>_PORT\` into other services in
the same scope (project + worktree). So if you have \`api\` running, the
\`web\` service automatically gets \`API_URL\`, \`API_HOST\`, \`API_PORT\`
in its env — \`fetch(process.env.API_URL)\` just works. No explicit
reference needed for the common case.

If you need composition (e.g. \`API_URL=https://\${{api.HOST}}:\${{api.PORT}}/v1\`)
use Railway-style \`\${{svc.URL|HOST|PORT}}\` syntax in env values; the
host resolves them at spawn time against the live registry.

If the user has set their own \`API_URL\` (project or worktree env), it
overrides the auto-injected one — discovery is the LOWEST-precedence
layer. So an app pointing at remote staging stays pointing at remote
staging even when a local \`api\` service is running.

Names: short identifier (lowercase letters, digits, \`_\`, \`-\`; max
40 chars). Prefer "default" for the single root service; "web", "api",
"worker", "scheduler" for conventional monorepo roles. Each service
needs its own distinct port.

Respond with ONLY the \`<run-services>\` block — no markdown, no
commentary, no preamble, no code fences. The payload must be EITHER
\`{"services": [...]}\` OR a bare \`[...]\` array. Use an array even for
one service so the host always sees a list:

<run-services>
{
  "services": [
    {
      "name": "web",
      "stack": "node" | "bun" | "python" | "go" | "ruby" | "static" | "docker" | "custom",
      "start": "exact shell command",
      "build": "optional build command — omit when none",
      "env": { "KEY": "value" },
      "port": 3000,
      "enabled": true,
      "rationale": "one sentence citing file:line you read",
      "confidence": "high" | "medium" | "low"
    }
  ]
}
</run-services>

Rules recap:
- Always use \`<run-services>\`. Never emit \`<run-manifest>\`.
- Enumerate every runnable service found. Only emit
  \`{"services":[]}\` when you truly find nothing runnable after the
  inspection steps above.
- "start" must be non-empty on every entry.
- \`rationale\` must cite the file you read (e.g. "package.json line 7:
  scripts.dev" or "server.py:25 port=8000"). This is how the user
  verifies you actually looked.
- No preamble. No code fences. Just the block.`

export async function detectServicesWithLLM({
  cwd,
  existingServices,
  abort,
}: {
  cwd: string
  /** Optional — existing configured services, passed to the model so it
   *  doesn't re-propose the same ones. Shape mirrors the persisted row. */
  existingServices?: Array<{
    name: string
    stack: string
    start: string
    port?: number | null
  }>
  abort?: AbortController
}): Promise<LlmServicesDetectionResult> {
  const lines = [
    `Project root: ${cwd}`,
    "",
    "Run your filesystem inspection (ls + Read package.json / other",
    "anchors + Glob subdir package.json) and list EVERY runnable service",
    "you find. Return the <run-services> block per the schema in your",
    "system prompt.",
  ]
  if (existingServices && existingServices.length > 0) {
    lines.push(
      "",
      "For reference, here are the services the user already has",
      "configured. This is INFORMATIONAL ONLY — it is NOT a list of",
      "services to skip. You must still inspect the filesystem and",
      "report every runnable service you find. The host dedupes by name",
      "automatically; your job is thorough enumeration, not optimization.",
      "If any of these look misconfigured compared to what you read in",
      "the files (wrong port, wrong start command), include a corrected",
      "entry with the same name.",
      "```json",
      JSON.stringify(existingServices, null, 2),
      "```"
    )
  }
  const userMessage = lines.join("\n")

  const log = (event: string, details: Record<string, unknown> = {}) => {
    const tail = Object.entries(details)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ")
    console.log(`[runtime] llm.detect-services.${event}${tail ? " " + tail : ""}`)
  }

  log("start", { cwd })

  let finalText = ""
  let costUsd = 0
  try {
    const messages = getLlmProvider().runAgent({
      prompt: userMessage,
      cwd,
      permissionMode: "bypassPermissions",
      systemPrompt: RUN_DETECT_SERVICES_SYSTEM_PROMPT,
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
      settingSources: [],
      abortController: abort,
    })
    for await (const msg of messages) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") finalText += block.text
        }
      } else if (msg.type === "result") {
        costUsd = Number(msg.total_cost_usd ?? 0)
        const maybeErr = msg as unknown as { is_error?: boolean; subtype?: string }
        if (maybeErr.is_error) {
          const subtype = maybeErr.subtype ?? "unknown"
          log("agent_error", { subtype, costUsd })
          return {
            proposals: [],
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
    return { proposals: [], costUsd, raw: finalText, error: message }
  }

  // Primary path: a `<run-services>` block. Falls back to the single-service
  // `<run-manifest>` form if the model emits the older shape.
  let proposals: LlmServiceProposal[] | null = extractDetectedServices(finalText)
  if (!proposals) {
    const single = extractDetectedManifest(finalText)
    if (single) {
      proposals = [{ ...single, name: "default", enabled: true }]
    }
  }
  if (!proposals) {
    log("parse_failed", {
      finalTextLen: finalText.length,
      head: finalText.slice(0, 120),
    })
    return {
      proposals: [],
      costUsd,
      raw: finalText,
      error: finalText.trim()
        ? `couldn't parse <run-services> block from model output (${finalText.length} chars)`
        : "model returned no text",
    }
  }
  log("ok", { count: proposals.length, costUsd })
  return { proposals, costUsd, raw: finalText }
}

// ─── Chat-driven service detection ───────────────────────────────────────────
// The standalone `detectManifestWithLLM` above runs a fresh session with no
// context. That's wrong for anything the user just built in chat — the agent
// can't see "I just scaffolded an Express app 3 turns ago." This helper is
// used by the merge-flow-style scripted-turn approach: injected into the
// conversation's own runner, so the agent sees the full session history.

const DETECT_SERVICES_SYSTEM_PROMPT = `You are cataloguing every runnable service in this project for local
development. Your job: list EVERY process the user could start — the
root server, every workspace package that runs a server, every subdir
with its own entry point. The host dedupes by name; your task is
thorough enumeration, not optimization.

You have the full conversation history and read/write tools. The chat
history is ADDITIONAL context — it is NOT a substitute for inspecting
the filesystem. Before you emit the block, you MUST at minimum:

1. Run \`ls -la\` at the project root so you see the actual layout.
2. If \`package.json\` exists, Read it in full. Note every entry in
   \`scripts\` and any \`workspaces\` / \`packageManager\` fields.
3. If \`Procfile\`, \`docker-compose.yml\`, \`pyproject.toml\`,
   \`requirements.txt\`, \`go.mod\`, \`Gemfile\`, or \`Cargo.toml\`
   exists, Read it.
4. Glob for subdir project anchors (\`package.json\`, \`pyproject.toml\`,
   \`go.mod\`, \`Cargo.toml\`, \`index.html\`) under \`apps/*\`,
   \`services/*\`, \`packages/*\`, and any conventionally-named subdir
   like \`api/\`, \`web/\`, \`server/\`, \`client/\`, \`worker/\`.
5. For each server entry file you find, Read the top ~30 lines to see
   what port it binds to and whether it reads \`PORT\` env.
6. If README / READ*.md exists, skim it for run instructions.

The user may have ALREADY configured some services — the caller will
tell you which ones in the user message. Treat that list as
INFORMATIONAL, for cross-checking. You must still report every service
you find in the filesystem. Do NOT skip a service just because it's in
the user's existing list; the host handles deduplication.

**Infer the bind port AND make the command actually respect it.** This
matters because many frameworks don't read \`PORT\` env by default. Just
setting \`PORT=N\` is NOT enough for Vite, Django, uvicorn, rails, etc. —
the command itself needs the right flag.

First look in the source for \`app.listen(…)\`, \`server.listen(…)\`,
\`createServer\`, \`uvicorn --port\`, \`runserver 0.0.0.0:N\`, Vite's
\`server.port\`, Next's \`-p\`, environment-fallback patterns like
\`process.env.PORT || 3000\`, \`os.environ.get("PORT", "8000")\`, etc. to
figure out what port the app wants.

Then construct the start command so the host's allocated \`$PORT\` actually
takes effect. Stack-specific patterns:

- **Node / Express / Fastify / Hono / Koa**: typically reads \`process.env.PORT\`.
  Plain \`npm start\` works; no need to append \`$PORT\` to the command.
- **Next.js**: reads \`PORT\` env OR accepts \`-p\`. \`npm run dev -- -p $PORT\`
  is the bulletproof form.
- **Vite**: **IGNORES the \`PORT\` env by default.** Must pass the flag:
  \`npm run dev -- --port $PORT\` (or \`vite --port $PORT\`). Without this,
  Vite binds its config default (5173) and the host's port is ignored.
- **Create React App**: reads \`PORT\` env natively.
- **Django**: \`python manage.py runserver 0.0.0.0:$PORT\` — port is
  positional, not env-read.
- **Flask**: \`flask run --port $PORT\` (or \`FLASK_RUN_PORT=$PORT\` in env).
- **FastAPI / uvicorn**: \`uvicorn main:app --port $PORT --reload\`.
- **Rails**: \`rails server -p $PORT\` or \`bin/dev -p $PORT\`.
- **Go (net/http)**: usually reads \`PORT\` env; if the binary takes a flag,
  include it (\`./server -port $PORT\`).
- **Anything else**: default to \`$PORT\` as an explicit arg — safer than
  assuming the app reads the env.

The host injects \`PORT\` as an env var AND expands \`$PORT\` in the start
command via its shell. In the "port" field of the manifest, report the
number the app will bind to (usually the fallback in the code).

**Always produce a list of services** (even for a single-service repo).
The host shows your proposal to the user as a pick-list — they review,
adjust, and save. Emit a \`<run-services>\` block with an array. For one
service, return a single-entry array. For a monorepo (web + api, web +
worker, etc.), return one entry per runnable process. A build step that
precedes the server is NOT a second service — it's the \`build\` field.

Each service needs its own distinct bind port. Never use
\`<run-manifest>\` from this turn; the host treats it as a legacy
single-service shape.

End your reply with exactly one \`<run-services>\` block and nothing
after it. The payload must be EITHER \`{"services":[...]}\` or a bare
\`[...]\` array:

<run-services>
{
  "services": [
    {
      "name": "web",
      "stack": "node" | "bun" | "python" | "go" | "ruby" | "static" | "docker" | "custom",
      "start": "exact shell command",
      "build": "optional build command — omit when none",
      "env": { "KEY": "value" },
      "port": 5173,
      "enabled": true,
      "rationale": "one short sentence — include which file/line told you the port",
      "confidence": "high" | "medium" | "low"
    },
    {
      "name": "api",
      "stack": "node",
      "start": "cd api && npm run dev",
      "env": {},
      "port": 3001,
      "enabled": true,
      "rationale": "Express API from api/package.json",
      "confidence": "medium"
    }
  ]
}
</run-services>

Rules:
- The block is MANDATORY — the host parses it to show the pick-list.
- Always an array. Single-service → one entry. Nothing runnable → empty
  array (\`{"services":[]}\`).
- "start" must be non-empty on every entry.
- "port" is a JSON number (e.g. 3000, not "3000"). Omit the field only if
  you truly can't find any port reference in the code.
- Each service needs its own distinct bind port — they can't share.
- The host injects \`PORT\` as an env var AND expands \`$PORT\` in the start
  string via its shell. When in doubt, pass \`$PORT\` as an explicit flag.
- "name" must be a short identifier: lowercase letters, digits, \`_\`,
  \`-\`. Conventional: "web", "api", "worker", "scheduler", "default".
- Do NOT start the service yourself. This turn is configuration only.`

export function buildDetectServicesSystemPrompt(): string {
  return DETECT_SERVICES_SYSTEM_PROMPT
}

export function buildDetectServicesPrompt(input: {
  cwd: string
  existingManifest?: { stack: string; start: string; build?: string; env?: Record<string, string> } | null
  existingServices?: Array<{
    name: string
    stack: string
    start: string
    build?: string | null
    env?: Record<string, string>
    port?: number | null
    enabled?: boolean
  }> | null
}): string {
  const lines = [
    "[Host task — catalogue services]",
    "",
    "Run the filesystem inspection described in your system prompt (ls,",
    "Read package.json, Glob subdir anchors, scan server entry files for",
    "port bindings) and list EVERY runnable service you find. The host",
    "will present this list to the user as a pick-list; they approve each",
    "one. Your job is thorough enumeration — the host dedupes by name.",
    "",
    `Working directory: \`${input.cwd}\``,
  ]
  const hasExistingList = input.existingServices && input.existingServices.length > 0
  if (hasExistingList) {
    lines.push(
      "",
      "The user has already configured these services. This is",
      "INFORMATIONAL ONLY — NOT a list of services to skip. Still inspect",
      "the filesystem and report every runnable service you find; include",
      "corrections if any of these look wrong compared to what the code",
      "actually does:",
      "```json",
      JSON.stringify(input.existingServices, null, 2),
      "```"
    )
  } else if (input.existingManifest) {
    lines.push(
      "",
      "A single-service configuration already exists. INFORMATIONAL ONLY",
      "— if you find more services, list them all; if this one looks",
      "wrong compared to the actual code, list a corrected entry with the",
      "same name:",
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
    "When you're done, emit EITHER a `<run-manifest>` (single service) or",
    "`<run-services>` (array) block exactly as described in your system",
    "prompt. The host parses it to save the configuration. Do not start the",
    "service."
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
  const port = coercePort(r.port)
  return { stack, start, env, build, port, rationale, confidence }
}

// Multi-service proposal. Same fields as LlmManifestProposal + a name,
// optional enabled flag, and optional order_index. Used when the agent
// emits a `<run-services>` block for a monorepo / multi-process app.
export type LlmServiceProposal = LlmManifestProposal & {
  name: string
  enabled?: boolean
  order_index?: number
}

const DETECT_SERVICES_BLOCK_RE = /<run-services>\s*([\s\S]*?)\s*<\/run-services>/i
const VALID_SERVICE_NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/

// Parse a `<run-services>` block into one-or-more services. Accepts two
// payload shapes the models actually produce:
//   1. { "services": [ {...}, ... ] }    — spec shape
//   2. [ {...}, ... ]                     — bare array (seen in practice)
// Returns null when the block is missing / malformed / empty, so callers
// can fall back to the single-service `<run-manifest>` extractor.
export function extractDetectedServices(assistantText: string): LlmServiceProposal[] | null {
  const match = DETECT_SERVICES_BLOCK_RE.exec(assistantText)
  if (!match) return null
  const payload = match[1].trim()
  const parsed = tryParse(payload)
  if (!parsed) return null
  let arr: unknown[] | null = null
  if (Array.isArray(parsed)) {
    arr = parsed
  } else if (typeof parsed === "object") {
    const wrapped = (parsed as Record<string, unknown>).services
    if (Array.isArray(wrapped)) arr = wrapped
  }
  if (!arr || arr.length === 0) return null

  const allowedStacks: LlmManifestStack[] = [
    "node", "bun", "python", "go", "ruby", "static", "docker", "custom",
  ]
  const out: LlmServiceProposal[] = []
  const seenNames = new Set<string>()
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const name = typeof r.name === "string" ? r.name.trim() : ""
    if (!name || !VALID_SERVICE_NAME_RE.test(name) || seenNames.has(name)) continue
    const start = typeof r.start === "string" ? r.start.trim() : ""
    if (!start) continue // empty-start entries count as "gave up" — drop
    const stack = allowedStacks.includes(r.stack as LlmManifestStack)
      ? (r.stack as LlmManifestStack)
      : "custom"
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
    const port = coercePort(r.port)
    const enabled = typeof r.enabled === "boolean" ? r.enabled : true
    const order_index = typeof r.order_index === "number" ? r.order_index : undefined
    out.push({
      name,
      stack,
      start,
      env,
      build,
      port,
      rationale,
      confidence,
      enabled,
      order_index,
    })
    seenNames.add(name)
  }
  return out.length === 0 ? null : out
}

// ─── Verify-run: post-Run closed-loop check ─────────────────────────────────
// After starting a service (typically first run after configuration), we feed
// the captured output + final status back to the agent. The agent confirms it
// started cleanly, or diagnoses the crash and proposes a fix. If the fix is a
// config change, the agent emits a new <run-manifest> block and the existing
// post-turn reconcile saves it automatically.

export type VerifyRunSnapshot = {
  /** Which configured service this instance came from (default|api|worker|…). */
  serviceName: string
  stack: string
  start: string
  status: string
  pid: number | null
  port: number
  url: string
  exitCode: number | null
  error: string | null
  startedAt: number
  stoppedAt: number | null
}

export type VerifyRunLogLine = {
  ts: number
  stream: "stdout" | "stderr"
  text: string
}

const VERIFY_RUN_SYSTEM_PROMPT = `You are checking a recently-started local service.
You have the full conversation history and your normal tools.

Your job: read the captured output, then either:
- Confirm the service started cleanly (one short sentence, with the URL).
- Diagnose a failure. If the fix is a small config change (command, env, build
  step, stack mismatch), emit an updated multi-service block targeting ONLY
  this service (by its "name") and the host will save the update in place:

  <run-services>
  {
    "services": [
      {
        "name": "<same service name as the one you just checked>",
        "stack": "...",
        "start": "...",
        "build": "...",
        "env": {...},
        "port": 3000,
        "rationale": "one short sentence",
        "confidence": "high|medium|low"
      }
    ]
  }
  </run-services>

  Other services stay untouched — emitting a single-entry block by name is
  how a targeted update works. If the fix needs the user (install a missing
  package, set a secret env var, pick a free port), explain what and why —
  don't guess silently.

Rules:
- Do NOT start or stop the service yourself. It already ran; the host owns
  lifecycle.
- Do NOT emit a bare \`<run-manifest>\` block from verify-run — always use
  \`<run-services>\` so you don't accidentally overwrite the "default"
  service in a multi-service app.
- Don't declare success unless you see actual evidence (listening-on-port
  log, readiness marker, no errors in the tail).
- **Port mismatch is a common failure mode.** If the "port" field says N
  but the output shows the service listening on a different port, the
  start command is probably ignoring \`$PORT\`. Vite needs \`--port $PORT\`,
  Django needs \`runserver 0.0.0.0:$PORT\`, uvicorn needs \`--port $PORT\`,
  Rails needs \`-p $PORT\`, Next needs \`-p $PORT\` or PORT env. Emit an
  updated block with a corrected start command.
- Keep replies tight. One or two sentences is usually right.`

export function buildVerifyRunSystemPrompt(): string {
  return VERIFY_RUN_SYSTEM_PROMPT
}

const LOG_TAIL_LINES = 200

export function buildVerifyRunPrompt(input: {
  snapshot: VerifyRunSnapshot
  logs: VerifyRunLogLine[]
  watchMs: number
}): string {
  const snap = input.snapshot
  const uptimeSec = Math.max(0, Math.round((Date.now() - snap.startedAt) / 1000))

  const header = [
    "[Host task — verify run]",
    "",
    `I just started service **\`${snap.serviceName}\`** per its saved configuration and watched it for ${Math.round(input.watchMs / 1000)}s.`,
    "",
    `- Service name: \`${snap.serviceName}\`  (use this exact name when you emit a fix block)`,
    `- Stack: ${snap.stack}`,
    `- Command: \`${snap.start}\``,
    `- Status: ${snap.status}${snap.pid != null ? ` (pid ${snap.pid})` : ""}`,
    snap.status === "running" ? `- URL: ${snap.url}` : null,
    snap.status === "crashed" && snap.exitCode != null ? `- Exit code: ${snap.exitCode}` : null,
    snap.error ? `- Error: ${snap.error}` : null,
    `- Uptime at snapshot: ${uptimeSec}s`,
  ].filter(Boolean).join("\n")

  const tail = input.logs.slice(-LOG_TAIL_LINES)
  const logBlock = tail.length
    ? [
        "",
        "Captured output (stderr lines prefixed with `!`):",
        "```",
        ...tail.map((l) => `${l.stream === "stderr" ? "! " : "  "}${l.text}`),
        "```",
      ].join("\n")
    : "\n(No output was captured in the watch window — could be a service that logs nothing on startup, or never started.)"

  const ask =
    snap.status === "crashed"
      ? `\nThe service crashed. Walk me through what the output says and, if you can fix it with a config change, emit an updated \`<run-services>\` block with a single entry named "${snap.serviceName}".`
      : snap.status === "running"
        ? "\nConfirm it looks healthy, or flag anything off (port conflicts, unhandled rejections, warnings that matter)."
        : "\nStatus isn't terminal yet — say what you see and whether it looks on track."

  return header + logBlock + ask
}

export function buildVerifyRunNoticeText(input: {
  snapshot: VerifyRunSnapshot
}): string {
  const s = input.snapshot
  const label = s.serviceName === "default" ? "the service" : `\`${s.serviceName}\``
  if (s.status === "running") {
    return [
      `Verifying ${label} (\`${s.start}\`) at \`${s.url}\`.`,
      "",
      "The agent will read the service's output and confirm it started cleanly — or diagnose if not.",
    ].join("\n")
  }
  if (s.status === "crashed") {
    return [
      `**${s.serviceName === "default" ? "Service" : `\`${s.serviceName}\``} crashed during startup.** Asking the agent to diagnose.`,
      "",
      s.error ? `Reason: \`${s.error}\`` : "See the captured output in chat.",
    ].join("\n")
  }
  return [
    `Checking ${label} (\`${s.status}\`).`,
    "",
    "The agent will review the captured output.",
  ].join("\n")
}
