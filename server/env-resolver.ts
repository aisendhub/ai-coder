// Env resolution pipeline for service spawn. Merges the four persisted
// layers, resolves Railway-style ${{svc.VAR}} references, and emits the
// auto-injected service-discovery vars (WORKTREES_SVC_<NAME>_*) plus system
// metadata (WORKTREES_PROJECT_ID, WORKTREES_CONVERSATION_ID, etc).
//
// Resolution order (earlier overrides later when keys collide):
//   1. Service env (project_services.env JSONB)
//   2. Conversation env (conversation_env_vars table) — only if conversationId set
//   3. Project env (project_env_vars table)
//   4. System metadata (auto-set; cannot be overridden by user)
//   5. Service discovery vars (auto-set; cannot be overridden)
//
// See docs/ENV-AND-SERVICES.md for the design.

import type { SupabaseClient } from "@supabase/supabase-js"
import { decryptToken } from "./integrations/crypto.ts"
import { listServices } from "./runtime/index.ts"

export type EnvLayers = {
  service: Record<string, string>           // from project_services.env
  conversation: Map<string, EnvVar>         // from conversation_env_vars
  project: Map<string, EnvVar>              // from project_env_vars
  system: Record<string, string>            // computed metadata
  /** Live sibling running services in this scope, keyed by service name.
   *  Used to resolve ${{svc.URL|HOST|PORT}} references at spawn time.
   *  NOT auto-injected as env vars — the app's env stays exactly what the
   *  user set (plus system metadata + PORT), no invented names like
   *  API_URL polluting the env. To wire one service to another, the user
   *  (or LLM) writes API_URL=${{api.URL}} explicitly. */
  siblings: Map<string, { host: string; port: number }>
}

export type EnvVar = {
  value: string         // plaintext for non-secrets, encrypted blob for secrets
  is_secret: boolean
}

export type EnvResolveContext = {
  ownerId: string
  projectId: string
  serviceName: string
  conversationId: string | null
  worktreePath: string | null
  branch: string | null
  baseRef: string | null
}

export type EnvResolveResult = {
  /** Final flat env to pass to child_process.spawn. Secrets decrypted. */
  env: Record<string, string>
  /** Per-key provenance (which layer set each key). For UI/debug. */
  provenance: Record<string, "service" | "conversation" | "project" | "system">
  /** ${{svc.VAR}} references that couldn't be resolved. Empty on success. */
  unresolvedRefs: string[]
}

const REF_RE = /\$\{\{([^}]+)\}\}/g
const VALID_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const VALID_SERVICE_NAME_RE = /^[a-zA-Z0-9_-]+$/

/** Build the PORT-related env block to inject at spawn time. Always sets
 *  PORT and HOST; adds framework aliases (VITE_PORT, NUXT_PORT, etc.) per
 *  stack. Called by the runtime registry — env-resolver doesn't know the
 *  bound port. */
export function portEnvFor(
  stack: string | null,
  boundPort: number,
): Record<string, string> {
  const out: Record<string, string> = {
    PORT: String(boundPort),
    HOST: "localhost",
  }
  for (const alias of portAliasesForStack(stack)) {
    out[alias] = String(boundPort)
  }
  return out
}

/** Framework-specific PORT env var aliases by stack. PORT itself is always
 *  injected (universal convention); these are EXTRA aliases the framework
 *  or its config files commonly read. Liberal on purpose — extra env vars
 *  are free, and users frequently write `vite.config.ts` that reads
 *  `process.env.VITE_PORT`. Stacks not listed here just get PORT.
 *
 *  Treats the stack string as a hint, not a strict enum — substring matches
 *  catch user-typed variations like "vite-react", "next.js", "react-vite". */
export function portAliasesForStack(stack: string | null): string[] {
  if (!stack) return []
  const s = stack.toLowerCase()
  const aliases: string[] = []
  if (s.includes("vite")) aliases.push("VITE_PORT")
  if (s.includes("next")) aliases.push("NEXT_PUBLIC_PORT")
  if (s.includes("nuxt")) aliases.push("NUXT_PORT", "NUXT_PUBLIC_PORT")
  if (s.includes("astro")) aliases.push("ASTRO_PORT")
  if (s.includes("svelte")) aliases.push("SVELTEKIT_PORT")
  if (s.includes("remix")) aliases.push("REMIX_PORT")
  if (s.includes("django")) aliases.push("DJANGO_PORT")
  if (s.includes("rails")) aliases.push("RAILS_PORT")
  if (s.includes("flask")) aliases.push("FLASK_RUN_PORT")
  return aliases
}

/** Load env layers from the database. Service-scoped env comes from the
 *  caller (already-fetched ProjectServiceRow) so we don't re-read it. */
export async function loadEnvLayers(
  sb: SupabaseClient,
  ctx: EnvResolveContext,
  serviceEnv: Record<string, string>,
): Promise<EnvLayers> {
  const projectRows = await sb
    .from("project_env_vars")
    .select("key, value, is_secret")
    .eq("project_id", ctx.projectId)
  const project = new Map<string, EnvVar>()
  for (const r of projectRows.data ?? []) {
    project.set(r.key as string, {
      value: r.value as string,
      is_secret: !!r.is_secret,
    })
  }

  const conversation = new Map<string, EnvVar>()
  if (ctx.conversationId) {
    const convRows = await sb
      .from("conversation_env_vars")
      .select("key, value, is_secret")
      .eq("conversation_id", ctx.conversationId)
    for (const r of convRows.data ?? []) {
      conversation.set(r.key as string, {
        value: r.value as string,
        is_secret: !!r.is_secret,
      })
    }
  }

  // System metadata — cheap, eliminates "how do I tell what env I'm in?" code
  // in user services. Reserved namespace; cannot be overridden.
  const system: Record<string, string> = {
    WORKTREES_PROJECT_ID: ctx.projectId,
    WORKTREES_SERVICE_NAME: ctx.serviceName,
  }
  if (ctx.conversationId) system.WORKTREES_CONVERSATION_ID = ctx.conversationId
  if (ctx.worktreePath) system.WORKTREES_WORKTREE_PATH = ctx.worktreePath
  if (ctx.branch) system.WORKTREES_BRANCH = ctx.branch
  if (ctx.baseRef) system.WORKTREES_BASE_REF = ctx.baseRef

  // Note: PORT / HOST / framework aliases are injected by the runtime
  // registry at spawn time, not here. The registry owns port allocation
  // and is the only thing that knows the bound port. See
  // portEnvFor(stack, port) below — registry calls it with the allocated
  // port and merges the result on top of manifest.env.

  // Sibling running services in the same scope (project + worktree). Used
  // to resolve ${{svc.URL|HOST|PORT}} references — NOT injected into the
  // env. Apps see exactly what the user set, plus PORT and system metadata.
  // Excludes self so a service can't reference its own previous instance.
  const siblings = new Map<string, { host: string; port: number }>()
  const running = listServices({
    ownerId: ctx.ownerId,
    projectId: ctx.projectId,
    worktreePath: ctx.worktreePath,
  })
  for (const sib of running) {
    if (sib.serviceName === ctx.serviceName) continue
    if (!sib.port) continue
    if (sib.status !== "running" && sib.status !== "starting") continue
    siblings.set(sib.serviceName, { host: "localhost", port: sib.port })
  }

  return { service: serviceEnv, conversation, project, system, siblings }
}

/** Merge layers in precedence order, decrypt secrets, and resolve ${{}}
 *  references. Returns the final flat env + provenance + any unresolved
 *  references (caller decides whether to fail on them). */
export function resolveEnv(layers: EnvLayers): EnvResolveResult {
  const out: Record<string, string> = {}
  const provenance: EnvResolveResult["provenance"] = {}

  // Precedence (lowest first; later writes override earlier):
  //   project → conversation → service → system
  //
  // No "discovery" layer — sibling URLs/ports are resolved on-demand by the
  // ${{svc.URL|HOST|PORT}} reference syntax, not auto-injected. The app's
  // env is exactly what the user set + system metadata + PORT (handled by
  // the registry on top of this).
  for (const [k, v] of layers.project) {
    out[k] = decryptIfSecret(v)
    provenance[k] = "project"
  }
  for (const [k, v] of layers.conversation) {
    out[k] = decryptIfSecret(v)
    provenance[k] = "conversation"
  }
  for (const [k, v] of Object.entries(layers.service)) {
    out[k] = v
    provenance[k] = "service"
  }
  for (const [k, v] of Object.entries(layers.system)) {
    out[k] = v
    provenance[k] = "system"
  }

  // Resolve ${{svc.VAR}} — pass over every value, substitute references.
  // Cycle detection: each value is resolved against the FROZEN map (we don't
  // re-resolve the substitutions), which prevents infinite recursion. To
  // chain references (`API_URL=https://${{api.HOST}}` then
  // `FULL=${{self.API_URL}}/v1`) the user would need a second pass — not
  // worth the complexity vs. just having them write the full thing.
  const unresolvedRefs: string[] = []
  for (const k of Object.keys(out)) {
    const original = out[k]
    let changed = original
    let m: RegExpExecArray | null
    REF_RE.lastIndex = 0
    while ((m = REF_RE.exec(original)) !== null) {
      const expr = m[1].trim()
      const dot = expr.indexOf(".")
      if (dot === -1) {
        unresolvedRefs.push(`${k}: malformed reference \${{${expr}}}`)
        continue
      }
      const refSvc = expr.slice(0, dot).trim()
      const refKey = expr.slice(dot + 1).trim()
      if (!VALID_SERVICE_NAME_RE.test(refSvc) || !VALID_KEY_RE.test(refKey)) {
        unresolvedRefs.push(`${k}: invalid reference \${{${expr}}}`)
        continue
      }
      const subst = lookupReference(refSvc, refKey, layers, out)
      if (subst === null) {
        unresolvedRefs.push(`${k}: \${{${expr}}} → no running service '${refSvc}' or key '${refKey}'`)
        continue
      }
      changed = changed.replaceAll(`\${{${m[1]}}}`, subst)
    }
    if (changed !== original) out[k] = changed
  }

  return { env: out, provenance, unresolvedRefs }
}

function decryptIfSecret(v: EnvVar): string {
  if (!v.is_secret) return v.value
  try {
    return decryptToken(v.value)
  } catch {
    // If decryption fails (rotated key, corrupt blob), surface the secret as
    // empty — better than leaking the encrypted blob into the child env.
    return ""
  }
}

function lookupReference(
  svc: string,
  key: string,
  layers: EnvLayers,
  resolved: Record<string, string>,
): string | null {
  // ${{self.VAR}} = look up in current service's resolved env
  if (svc === "self") {
    return resolved[key] ?? null
  }
  // ${{svc.URL|HOST|PORT}} = look up directly in the live sibling registry
  // captured in layers.siblings. We only expose URL/HOST/PORT — looking up
  // arbitrary env keys on another service is out of scope (race conditions,
  // ordering, leakage of sibling secrets).
  const sib = layers.siblings.get(svc)
  if (!sib) return null
  switch (key) {
    case "URL":  return `http://${sib.host}:${sib.port}`
    case "HOST": return sib.host
    case "PORT": return String(sib.port)
    default:     return null
  }
}
