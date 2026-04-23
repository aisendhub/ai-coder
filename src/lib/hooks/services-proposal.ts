// Services-proposal hook — watches every assistant message for
// `<run-services>` or `<run-manifest>` blocks and, when one appears,
// dispatches `ai-coder:services-proposed` with a pick-list for the panel
// to render. The server no longer auto-saves these blocks; the client
// opens the services panel and the user approves each one.
//
// Parser mirrors `extractDetectedServices` / `extractDetectedManifest` in
// server/agent-loop.ts. We duplicate (rather than share) because the
// client doesn't import server code, the parser is small, and the shape
// we want on this side is `DetectedServiceCandidate` (what the picker
// already consumes) rather than the server's internal LlmServiceProposal.

import { registerAgentResponseHook } from "../agent-response-hooks"
import type { DetectedServiceCandidate } from "@/models/ServiceList.model"

const RUN_SERVICES_RE = /<run-services>\s*([\s\S]*?)\s*<\/run-services>/i
const RUN_MANIFEST_RE = /<run-manifest>\s*([\s\S]*?)\s*<\/run-manifest>/i
const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/
const ALLOWED_STACKS = new Set([
  "node", "bun", "python", "go", "ruby", "static", "docker", "custom",
])

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function coercePort(value: unknown): number | undefined {
  const n =
    typeof value === "number" ? value
      : typeof value === "string" && /^\d+$/.test(value.trim()) ? parseInt(value, 10)
      : NaN
  if (!Number.isFinite(n)) return undefined
  if (n < 1024 || n > 65535) return undefined
  return n
}

// Returns the proposals in the block, or null when the block is missing
// or the JSON is malformed. Accepts both `{"services":[…]}` (spec) and
// bare `[…]` (what the model often emits).
function parseRunServices(text: string): DetectedServiceCandidate[] | null {
  const match = RUN_SERVICES_RE.exec(text)
  if (!match) return null
  const parsed = tryParse(match[1].trim())
  if (!parsed) return null
  let arr: unknown[] | null = null
  if (Array.isArray(parsed)) {
    arr = parsed
  } else if (typeof parsed === "object") {
    const wrapped = (parsed as Record<string, unknown>).services
    if (Array.isArray(wrapped)) arr = wrapped
  }
  if (!arr) return null
  const out: DetectedServiceCandidate[] = []
  const seen = new Set<string>()
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const name = typeof r.name === "string" ? r.name.trim() : ""
    if (!name || !NAME_RE.test(name) || seen.has(name)) continue
    const start = typeof r.start === "string" ? r.start.trim() : ""
    if (!start) continue
    const stack = (ALLOWED_STACKS.has(r.stack as string) ? r.stack : "custom") as string
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
    out.push({
      name,
      stack,
      start,
      build: typeof r.build === "string" && r.build.trim() ? r.build.trim() : undefined,
      env,
      port: coercePort(r.port),
      subdir: "",
      rationale: typeof r.rationale === "string" ? r.rationale : "",
      confidence,
      alreadySaved: false,
      source: "ai",
    })
    seen.add(name)
  }
  return out
}

// Legacy single-service block → one-entry candidate list with name="default".
function parseRunManifest(text: string): DetectedServiceCandidate[] | null {
  const match = RUN_MANIFEST_RE.exec(text)
  if (!match) return null
  const parsed = tryParse(match[1].trim())
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const r = parsed as Record<string, unknown>
  const start = typeof r.start === "string" ? r.start.trim() : ""
  if (!start) return null
  const stack = (ALLOWED_STACKS.has(r.stack as string) ? r.stack : "custom") as string
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
  return [
    {
      name: "default",
      stack,
      start,
      build: typeof r.build === "string" && r.build.trim() ? r.build.trim() : undefined,
      env,
      port: coercePort(r.port),
      subdir: "",
      rationale: typeof r.rationale === "string" ? r.rationale : "",
      confidence,
      alreadySaved: false,
      source: "ai",
    },
  ]
}

export type ServicesProposedEventDetail = {
  conversationId: string
  projectId: string | null
  messageId: string | null
  candidates: DetectedServiceCandidate[]
}

// Exported so the ServicesPanel can use the same literal.
export const SERVICES_PROPOSED_EVENT = "ai-coder:services-proposed"

// Single-slot mailbox. Populated on every dispatch so late-mounting
// listeners (e.g. the ServicesPanel when the event fires while the
// panel is closed) can drain the most recent proposal on mount.
// Keyed by messageId so the same block can be re-delivered on reload
// without accidentally firing an old proposal from last session.
let latest: ServicesProposedEventDetail | null = null

export function consumeLatestServicesProposal(): ServicesProposedEventDetail | null {
  const out = latest
  latest = null
  return out
}

export function peekLatestServicesProposal(): ServicesProposedEventDetail | null {
  return latest
}

// Hook registration — idempotent, safe to call on every module load.
registerAgentResponseHook({
  name: "services-proposal",
  run(text, ctx) {
    // Skip if this block was already present on the previous update:
    // a streaming assistant message fires many UPDATEs and we don't
    // want to re-open the panel every tick.
    if (ctx.priorText && hasBlock(ctx.priorText) && hasBlock(text)) {
      return
    }
    const candidates = parseRunServices(text) ?? parseRunManifest(text)
    if (!candidates || candidates.length === 0) return
    const detail: ServicesProposedEventDetail = {
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      messageId: ctx.messageId,
      candidates,
    }
    latest = detail
    window.dispatchEvent(new CustomEvent(SERVICES_PROPOSED_EVENT, { detail }))
  },
})

function hasBlock(text: string): boolean {
  return RUN_SERVICES_RE.test(text) || RUN_MANIFEST_RE.test(text)
}
