// Model reference parsing + catalog mapping for OpenCode.

export type OpenCodeModelRef = {
  providerID: string
  id: string
  variant?: string
}

export type AgentModel = {
  providerID: string
  id: string
  modelID: string
  name: string
  family: string | null
  context: number
  input: number | null
  output: number
  cost: unknown
  capabilities: unknown
  variants: string[]
  status: string
  enabled: boolean
}

export const DEFAULT_OPENCODE_MODEL = "deepseek/deepseek-flash"

/** Accepts `provider/model`, `provider/model#variant`, or a bare model id.
 *  Bare ids use OPENCODE_PROVIDER (default `deepseek`). */
export function parseModelRef(
  value?: string | null,
  env: NodeJS.ProcessEnv = process.env
): OpenCodeModelRef {
  const raw =
    (value && value.trim()) ||
    (env.OPENCODE_MODEL && env.OPENCODE_MODEL.trim()) ||
    DEFAULT_OPENCODE_MODEL

  const slash = raw.indexOf("/")
  if (slash === -1) {
    return {
      providerID: (env.OPENCODE_PROVIDER && env.OPENCODE_PROVIDER.trim()) || "deepseek",
      id: raw,
    }
  }

  const providerID = raw.slice(0, slash)
  const rest = raw.slice(slash + 1)
  const hash = rest.indexOf("#")
  if (hash === -1) return { providerID, id: rest }
  const id = rest.slice(0, hash)
  const variant = rest.slice(hash + 1)
  return variant ? { providerID, id, variant } : { providerID, id }
}

export function formatModelRef(ref: OpenCodeModelRef): string {
  const base = `${ref.providerID}/${ref.id}`
  return ref.variant ? `${base}#${ref.variant}` : base
}

export function toAgentModel(info: {
  providerID: string
  modelID?: string
  id: string
  name: string
  family?: string
  limit?: { context?: number; input?: number; output?: number }
  cost?: unknown
  capabilities?: unknown
  variants?: Array<{ id?: string; name?: string } | string>
  status?: string
  enabled?: boolean
}): AgentModel {
  return {
    providerID: info.providerID,
    id: info.id,
    modelID: info.modelID ?? info.id,
    name: info.name,
    family: info.family ?? null,
    context: info.limit?.context ?? 0,
    input: info.limit?.input ?? null,
    output: info.limit?.output ?? 0,
    cost: info.cost ?? [],
    capabilities: info.capabilities ?? {},
    variants: (info.variants ?? [])
      .map((v) => (typeof v === "string" ? v : v.id ?? v.name ?? ""))
      .filter(Boolean),
    status: info.status ?? "active",
    enabled: info.enabled !== false,
  }
}
