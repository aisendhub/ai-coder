// DB access for `service_instances`. Lets the in-memory registry survive
// server restarts — we persist instance metadata (not logs; those stay in
// the ring buffer) and reconcile on boot by probing PIDs.
//
// Why its own module: parallels services-store.ts. The runtime pieces don't
// import supabase directly; reconcile logic lives in index.ts and calls
// through here.

import { hostname } from "node:os"

import type { SupabaseClient } from "@supabase/supabase-js"

export type ServiceInstanceStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "crashed"

export type ServiceInstanceRow = {
  id: string
  user_id: string
  project_id: string
  service_name: string
  worktree_path: string | null
  runner_id: string
  pid: number | null
  port: number
  status: ServiceInstanceStatus
  exit_code: number | null
  error: string | null
  label: string | null
  host: string | null
  started_at: string
  stopped_at: string | null
  last_seen_at: string
  created_at: string
}

export type ServiceInstanceInsert = {
  id: string
  user_id: string
  project_id: string
  service_name: string
  worktree_path: string | null
  runner_id: string
  pid: number | null
  port: number
  status: ServiceInstanceStatus
  label: string | null
}

const COLUMNS =
  "id, user_id, project_id, service_name, worktree_path, runner_id, pid, " +
  "port, status, exit_code, error, label, host, started_at, stopped_at, " +
  "last_seen_at, created_at"

// Upsert a newly-spawned instance. We key by `id` (UUID from the registry)
// so the registry's instance id round-trips. Idempotent: replaying is safe.
export async function insertServiceInstance(
  sb: SupabaseClient,
  row: ServiceInstanceInsert
): Promise<void> {
  const { error } = await sb.from("service_instances").upsert(
    {
      ...row,
      host: hostname(),
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  )
  if (error) throw new Error(`insertServiceInstance: ${error.message}`)
}

// Mark status transitions. Stopped/crashed stamps stopped_at.
export async function updateServiceInstanceStatus(
  sb: SupabaseClient,
  id: string,
  patch: {
    status: ServiceInstanceStatus
    exit_code?: number | null
    error?: string | null
    port?: number | null
  }
): Promise<void> {
  const body: Record<string, unknown> = {
    status: patch.status,
    last_seen_at: new Date().toISOString(),
  }
  if (patch.exit_code !== undefined) body.exit_code = patch.exit_code
  if (patch.error !== undefined) body.error = patch.error
  if (patch.port !== undefined) body.port = patch.port
  if (patch.status === "stopped" || patch.status === "crashed") {
    body.stopped_at = new Date().toISOString()
  }
  const { error } = await sb.from("service_instances").update(body).eq("id", id)
  if (error) throw new Error(`updateServiceInstanceStatus: ${error.message}`)
}

// Heartbeat. Not strictly required — boot reconcile checks pid liveness
// directly — but useful for a future "stale row reaper" cron.
export async function touchServiceInstance(
  sb: SupabaseClient,
  id: string
): Promise<void> {
  const { error } = await sb
    .from("service_instances")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", id)
  if (error) throw new Error(`touchServiceInstance: ${error.message}`)
}

// All rows that think they're live on this host. Used at boot to probe
// and either reattach (still running) or mark stopped (process gone).
// Scoped to the current hostname so a dev laptop doesn't reap prod rows.
export async function listLiveServiceInstancesForHost(
  sb: SupabaseClient
): Promise<ServiceInstanceRow[]> {
  const host = hostname()
  const { data, error } = await sb
    .from("service_instances")
    .select(COLUMNS)
    .eq("host", host)
    .in("status", ["starting", "running", "stopping"])
  if (error) throw new Error(`listLiveServiceInstancesForHost: ${error.message}`)
  return (data ?? []) as unknown as ServiceInstanceRow[]
}
