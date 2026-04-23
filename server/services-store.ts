// DB access layer for `project_services` + per-conversation service overrides.
// Used by the manifest endpoints + runtime reconcile hooks. Stays thin: a
// single typed row shape, one-row-at-a-time reads, plain upserts. No caching
// — row counts per project are tiny (1-5 typical, ≤20 expected).
//
// Why its own module: every later phase (endpoints, UI, supervisor, detect-
// services) reads through here. Centralizing the SQL means per-phase changes
// touch one file, not five.

import type { SupabaseClient } from "@supabase/supabase-js"

import type { ManifestOverride, RunManifest } from "./runtime/index.ts"

export type RestartPolicy = "always" | "on-failure" | "never"

export type ProjectServiceRow = {
  id: string
  project_id: string
  name: string
  description: string | null
  stack: string
  start: string
  build: string | null
  env: Record<string, string>
  port: number | null
  dockerfile: string | null
  healthcheck: { path: string; timeoutMs: number } | null
  enabled: boolean
  order_index: number
  restart_policy: RestartPolicy
  max_restarts: number
  assigned_port: number | null
  created_at: string
  updated_at: string
}

// What a caller can write via upsert. cwd is intentionally excluded — always
// derived from projects.cwd / conversations.worktree_path at run time.
export type ProjectServiceWrite = {
  name: string
  description?: string | null
  stack: string
  start: string
  build?: string | null
  env?: Record<string, string>
  port?: number | null
  dockerfile?: string | null
  healthcheck?: { path: string; timeoutMs: number } | null
  enabled?: boolean
  order_index?: number
  restart_policy?: RestartPolicy
  max_restarts?: number
  assigned_port?: number | null
}

// Select shape mirrors ProjectServiceRow verbatim. Central constant so every
// read pulls the same columns — if a new column gets added to the schema,
// bump it here once and every caller sees it.
const SERVICE_COLUMNS =
  "id, project_id, name, description, stack, start, build, env, port, " +
  "dockerfile, healthcheck, enabled, order_index, restart_policy, " +
  "max_restarts, assigned_port, created_at, updated_at"

export async function listProjectServices(
  sb: SupabaseClient,
  projectId: string
): Promise<ProjectServiceRow[]> {
  const { data, error } = await sb
    .from("project_services")
    .select(SERVICE_COLUMNS)
    .eq("project_id", projectId)
    .order("order_index", { ascending: true })
    .order("name", { ascending: true })
  if (error) throw new Error(`listProjectServices: ${error.message}`)
  return (data ?? []) as unknown as ProjectServiceRow[]
}

export async function getProjectService(
  sb: SupabaseClient,
  projectId: string,
  name: string
): Promise<ProjectServiceRow | null> {
  const { data, error } = await sb
    .from("project_services")
    .select(SERVICE_COLUMNS)
    .eq("project_id", projectId)
    .eq("name", name)
    .maybeSingle()
  if (error) throw new Error(`getProjectService: ${error.message}`)
  return (data ?? null) as unknown as ProjectServiceRow | null
}

// Upsert keyed by (project_id, name). Idempotent: repeated saves of the same
// config produce the same row. Trigger touches updated_at on every UPDATE.
export async function upsertProjectService(
  sb: SupabaseClient,
  projectId: string,
  write: ProjectServiceWrite
): Promise<ProjectServiceRow> {
  const row: Record<string, unknown> = {
    project_id: projectId,
    name: write.name,
    stack: write.stack,
    start: write.start,
    env: write.env ?? {},
  }
  if (write.description !== undefined) row.description = write.description
  if (write.build !== undefined) row.build = write.build
  if (write.port !== undefined) row.port = write.port
  if (write.dockerfile !== undefined) row.dockerfile = write.dockerfile
  if (write.healthcheck !== undefined) row.healthcheck = write.healthcheck
  if (write.enabled !== undefined) row.enabled = write.enabled
  if (write.order_index !== undefined) row.order_index = write.order_index
  if (write.restart_policy !== undefined) row.restart_policy = write.restart_policy
  if (write.max_restarts !== undefined) row.max_restarts = write.max_restarts
  if (write.assigned_port !== undefined) row.assigned_port = write.assigned_port

  const { data, error } = await sb
    .from("project_services")
    .upsert(row, { onConflict: "project_id,name" })
    .select(SERVICE_COLUMNS)
    .single()
  if (error) throw new Error(`upsertProjectService: ${error.message}`)
  return data as unknown as ProjectServiceRow
}

export async function deleteProjectService(
  sb: SupabaseClient,
  projectId: string,
  name: string
): Promise<void> {
  const { error } = await sb
    .from("project_services")
    .delete()
    .eq("project_id", projectId)
    .eq("name", name)
  if (error) throw new Error(`deleteProjectService: ${error.message}`)
}

// Update a single column without touching the rest. Used by the runtime
// reconcile when port detection updates the assigned_port.
export async function patchProjectService(
  sb: SupabaseClient,
  projectId: string,
  name: string,
  patch: Partial<
    Pick<
      ProjectServiceRow,
      "assigned_port" | "enabled" | "order_index" | "restart_policy" | "max_restarts"
    >
  >
): Promise<void> {
  if (Object.keys(patch).length === 0) return
  const { error } = await sb
    .from("project_services")
    .update(patch)
    .eq("project_id", projectId)
    .eq("name", name)
  if (error) throw new Error(`patchProjectService: ${error.message}`)
}

// ─── Conversation overrides ────────────────────────────────────────────────

export async function getConversationServiceOverride(
  sb: SupabaseClient,
  conversationId: string,
  serviceName: string
): Promise<ManifestOverride | null> {
  const { data, error } = await sb
    .from("conversations")
    .select("service_overrides")
    .eq("id", conversationId)
    .maybeSingle()
  if (error) throw new Error(`getConversationServiceOverride: ${error.message}`)
  const map = (data?.service_overrides ?? null) as
    | Record<string, ManifestOverride>
    | null
  return map?.[serviceName] ?? null
}

export async function setConversationServiceOverride(
  sb: SupabaseClient,
  conversationId: string,
  serviceName: string,
  override: ManifestOverride | null
): Promise<void> {
  const { data } = await sb
    .from("conversations")
    .select("service_overrides")
    .eq("id", conversationId)
    .maybeSingle()
  const existing = (data?.service_overrides ?? {}) as Record<
    string,
    ManifestOverride
  >
  const next = { ...existing }
  if (override === null) delete next[serviceName]
  else next[serviceName] = override
  const value = Object.keys(next).length === 0 ? null : next

  const { error } = await sb
    .from("conversations")
    .update({ service_overrides: value })
    .eq("id", conversationId)
  if (error) throw new Error(`setConversationServiceOverride: ${error.message}`)
}

// ─── Row ↔ RunManifest adapters ────────────────────────────────────────────
// Callers get the full runtime RunManifest from the row so the registry can
// consume it unchanged. cwd is filled in at runtime by the start endpoint.

export function manifestFromRow(row: ProjectServiceRow): Omit<RunManifest, "cwd"> {
  const out: Omit<RunManifest, "cwd"> = {
    stack: row.stack as RunManifest["stack"],
    start: row.start,
    env: row.env ?? {},
  }
  if (row.build) out.build = row.build
  if (row.port != null) out.port = row.port
  if (row.dockerfile) out.dockerfile = row.dockerfile
  if (row.healthcheck) out.healthcheck = row.healthcheck
  return out
}

// Reverse — used when the agent emits a manifest via the `<run-manifest>` or
// `<run-services>` blocks and we need to persist it.
export function writeFromManifest(
  name: string,
  m: Partial<RunManifest>
): ProjectServiceWrite {
  return {
    name,
    stack: typeof m.stack === "string" ? m.stack : "custom",
    start: typeof m.start === "string" ? m.start : "",
    env: m.env ?? {},
    ...(m.build !== undefined ? { build: m.build } : {}),
    ...(m.port !== undefined ? { port: m.port } : {}),
    ...(m.dockerfile !== undefined ? { dockerfile: m.dockerfile } : {}),
    ...(m.healthcheck !== undefined ? { healthcheck: m.healthcheck } : {}),
  }
}
