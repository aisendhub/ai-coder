import { action, observable, runInAction } from "mobx"
import { BaseList } from "./BaseList.model"
import { Service, type ServiceDto, type LogLine } from "./Service.model"
import { api, sseUrl } from "@/lib/api"

type StartArgs = {
  userId: string
  projectId: string
  conversationId?: string | null
  serviceName?: string
  label?: string | null
  runnerId?: RunnerId
}

// A row from project_services. Represents a configured service (web, api,
// worker, …) — distinct from a *running instance* (Service / ServiceDto).
// Persistent; the panel renders one card per row.
export type ProjectServiceDto = {
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
  restart_policy: "always" | "on-failure" | "never"
  max_restarts: number
  assigned_port: number | null
  created_at: string
  updated_at: string
}

// A single service proposal shown in the picker. Produced either by the
// heuristic detector (GET /api/projects/:id/services/detect) or by the
// one-shot LLM (POST /api/projects/:id/services/detect-llm). The `source`
// field lets the UI tag rows so users know which proposals to trust more.
export type DetectedServiceCandidate = {
  name: string
  stack: string
  start: string
  build?: string
  env: Record<string, string>
  port?: number
  subdir: string
  rationale: string
  confidence: "high" | "medium" | "low"
  alreadySaved: boolean
  /** "heuristic" for file-tree detection, "ai" for LLM proposals. Panel
   *  tags this client-side after each call; server endpoints don't emit it. */
  source?: "heuristic" | "ai"
}

export type LlmServicesDetectionView = {
  cwd: string
  proposals: DetectedServiceCandidate[]
  costUsd: number
  error: string | null
  rawPreview: string | null
}

export type ProjectServiceWriteDto = {
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
  restart_policy?: "always" | "on-failure" | "never"
  max_restarts?: number
}

export type RunnerId = "local-process" | "local-docker"

export type RunnerInfo = {
  id: RunnerId
  available: boolean
  reason?: string
}

export type RailwayAccount = {
  id: string
  username: string | null
  email: string | null
  name: string | null
}

export type RailwayIntegration =
  | { connected: false }
  | {
      connected: true
      provider: "railway"
      account: RailwayAccount
      connected_at: string
      updated_at: string
    }

export type RunManifestDto = {
  stack: string
  build?: string
  start: string
  cwd?: string
  env: Record<string, string>
  port?: number
  dockerfile?: string
  healthcheck?: { path: string; timeoutMs: number }
}

export type ProjectManifestView = {
  cached: RunManifestDto | null
  detected: RunManifestDto | null
  effective: RunManifestDto | null
  cwd: string
}

export type LlmManifestDetection = {
  cwd: string
  heuristic: RunManifestDto | null
  llm: {
    proposal:
      | (RunManifestDto & {
          rationale: string
          confidence: "high" | "medium" | "low"
        })
      | null
    rationale: string
    confidence: "high" | "medium" | "low" | null
    costUsd: number
    error: string | null
  }
}

export type ConversationManifestView = {
  projectCached: RunManifestDto | null
  override: Partial<RunManifestDto> | null
  detected: RunManifestDto | null
  effective: RunManifestDto | null
  assignedPort: number | null
  cwd: string
}

export class ServiceList extends BaseList<typeof Service> {
  get ItemType() {
    return Service
  }

  @observable loading = false
  @observable lastError: string | null = null
  @observable runners: RunnerInfo[] = []
  @observable railway: RailwayIntegration = { connected: false }

  private logStreams = new Map<string, EventSource>()

  @action setLoading(v: boolean) {
    this.loading = v
  }

  @action setError(msg: string | null) {
    this.lastError = msg
  }

  @action private upsertDto(dto: ServiceDto) {
    const existing = this.find(dto.id)
    if (existing) {
      existing.setFromDto(dto)
    } else {
      const svc = Service.create()
      svc.setFromDto(dto)
      this.addItem(svc)
    }
  }

  // `opts.silent` skips the loading flag toggle. Background polls use it
  // so header spinners don't flash on the 5s cadence. Explicit user-
  // initiated refreshes (none today) would omit the flag.
  async refresh(userId: string, opts: { silent?: boolean } = {}): Promise<void> {
    if (!opts.silent) this.setLoading(true)
    try {
      const res = await api(
        `/api/services?userId=${encodeURIComponent(userId)}`
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const json = (await res.json()) as { services: ServiceDto[] }
      runInAction(() => {
        // Replace the set — drops services that no longer exist server-side.
        const incoming = new Set(json.services.map((s) => s.id))
        for (const item of [...this.items]) {
          if (!incoming.has(item.id)) this.removeItem(item.id)
        }
        for (const dto of json.services) this.upsertDto(dto)
      })
    } finally {
      if (!opts.silent) this.setLoading(false)
    }
  }

  // ── Integrations (Phase 5) ─────────────────────────────────────────────────

  async refreshRailwayIntegration(userId: string): Promise<void> {
    try {
      const res = await api(
        `/api/integrations/railway?userId=${encodeURIComponent(userId)}`
      )
      if (!res.ok) return
      const body = (await res.json()) as RailwayIntegration
      runInAction(() => { this.railway = body })
    } catch {
      /* advisory */
    }
  }

  async connectRailway(userId: string, token: string): Promise<void> {
    const res = await api("/api/integrations/railway/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, token }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    const fresh = (await res.json()) as {
      provider: "railway"
      account: RailwayAccount
      connected_at: string
    }
    runInAction(() => {
      this.railway = {
        connected: true,
        provider: "railway",
        account: fresh.account,
        connected_at: fresh.connected_at,
        updated_at: fresh.connected_at,
      }
    })
  }

  async disconnectRailway(userId: string): Promise<void> {
    const res = await api(
      `/api/integrations/railway?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    runInAction(() => { this.railway = { connected: false } })
  }

  async refreshRunners(): Promise<void> {
    try {
      const res = await api("/api/services/runners")
      if (!res.ok) return
      const json = (await res.json()) as { runners: RunnerInfo[] }
      runInAction(() => { this.runners = json.runners })
    } catch {
      /* ignore — runners list is advisory for UI disabling */
    }
  }

  async start(args: StartArgs): Promise<Service> {
    const res = await api("/api/services/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: args.userId,
        projectId: args.projectId,
        conversationId: args.conversationId ?? undefined,
        serviceName: args.serviceName ?? undefined,
        label: args.label ?? undefined,
        runnerId: args.runnerId ?? undefined,
      }),
    })
    const body = (await res.json().catch(() => ({}))) as
      | ServiceDto
      | { error?: string; code?: string }
    if (!res.ok) {
      const err = (body as { error?: string }).error ?? `HTTP ${res.status}`
      throw new Error(err)
    }
    const dto = body as ServiceDto
    runInAction(() => this.upsertDto(dto))
    return this.find(dto.id)!
  }

  async stop(userId: string, id: string): Promise<void> {
    const res = await api(`/api/services/${id}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    const dto = (await res.json()) as ServiceDto
    runInAction(() => this.upsertDto(dto))
  }

  // Feed a service's captured output back to the conversation agent so it
  // can confirm the service started cleanly, or diagnose a crash and
  // propose a fix. Server handles the watch-and-inject asynchronously; this
  // resolves as soon as the background task is queued.
  async verifyRun(
    userId: string,
    conversationId: string,
    serviceId: string,
    opts: { watchMs?: number } = {}
  ): Promise<void> {
    const res = await api(`/api/conversations/${conversationId}/verify-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, serviceId, watchMs: opts.watchMs }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    this.closeLogs(id)
    const res = await api(
      `/api/services/${id}?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    )
    if (!res.ok && res.status !== 404) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    runInAction(() => this.removeItem(id))
  }

  subscribeLogs(
    userId: string,
    id: string,
    onLine: (line: LogLine) => void,
    onStatus?: (dto: ServiceDto) => void
  ): () => void {
    this.closeLogs(id)
    // Async URL resolve (need to inject JWT), but keep the public signature
    // sync so callers get an immediate cleanup function. If cancelled before
    // the EventSource is constructed, the abort flag short-circuits setup.
    let aborted = false
    void (async () => {
      const url = await sseUrl(`/api/services/${id}/logs?userId=${encodeURIComponent(userId)}`)
      if (aborted) return
      const es = new EventSource(url)
      this.logStreams.set(id, es)

      es.addEventListener("log", (ev) => {
        const msg = ev as MessageEvent<string>
        try {
          onLine(JSON.parse(msg.data) as LogLine)
        } catch {
          /* ignore malformed */
        }
      })
      es.addEventListener("status", (ev) => {
        const msg = ev as MessageEvent<string>
        try {
          const dto = JSON.parse(msg.data) as ServiceDto
          runInAction(() => this.upsertDto(dto))
          onStatus?.(dto)
        } catch {
          /* ignore */
        }
      })
      es.addEventListener("end", () => {
        this.closeLogs(id)
      })
      es.onerror = () => {
        // Browser will auto-reconnect while the service exists; on close, the
        // "end" event (above) will have already torn us down. Nothing to do.
      }
    })()

    return () => {
      aborted = true
      this.closeLogs(id)
    }
  }

  closeLogs(id: string): void {
    const es = this.logStreams.get(id)
    if (es) {
      es.close()
      this.logStreams.delete(id)
    }
  }

  closeAllLogs(): void {
    for (const es of this.logStreams.values()) es.close()
    this.logStreams.clear()
  }

  // ── Manifest CRUD ──────────────────────────────────────────────────────────

  async detectLlmManifest(
    userId: string,
    projectId: string
  ): Promise<LlmManifestDetection> {
    const res = await api(`/api/projects/${projectId}/manifest/detect-llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    return (await res.json()) as LlmManifestDetection
  }

  async fetchProjectManifest(
    userId: string,
    projectId: string,
    conversationId?: string | null
  ): Promise<ProjectManifestView> {
    // Pass conversationId so the server's heuristic detect runs in the
    // worktree (not the base project cwd) — otherwise anything the agent
    // built inside the worktree is invisible to the detector.
    const params = new URLSearchParams({ userId })
    if (conversationId) params.set("conversationId", conversationId)
    const res = await api(
      `/api/projects/${projectId}/manifest?${params.toString()}`
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    return (await res.json()) as ProjectManifestView
  }

  async saveProjectManifest(
    userId: string,
    projectId: string,
    manifest: RunManifestDto
  ): Promise<void> {
    const res = await api(`/api/projects/${projectId}/manifest`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, manifest }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  async clearProjectManifest(userId: string, projectId: string): Promise<void> {
    const res = await api(
      `/api/projects/${projectId}/manifest?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  async fetchConversationManifest(
    userId: string,
    conversationId: string
  ): Promise<ConversationManifestView> {
    const res = await api(
      `/api/conversations/${conversationId}/manifest?userId=${encodeURIComponent(userId)}`
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    return (await res.json()) as ConversationManifestView
  }

  async saveConversationOverride(
    userId: string,
    conversationId: string,
    override: Partial<RunManifestDto>
  ): Promise<void> {
    const res = await api(
      `/api/conversations/${conversationId}/manifest-override`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, override }),
      }
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  async clearConversationOverride(
    userId: string,
    conversationId: string
  ): Promise<void> {
    const res = await api(
      `/api/conversations/${conversationId}/manifest-override?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  // ── Project services (configured, persistent) ─────────────────────────────
  // These sit alongside the running-instance APIs above. A project_service
  // row is what the user configures; a Service/ServiceDto is a live process.
  // Server mirrors a single "default" row to the legacy run_manifest column
  // during rollout, so existing panel paths still work.

  async listProjectServices(
    userId: string,
    projectId: string
  ): Promise<ProjectServiceDto[]> {
    const res = await api(
      `/api/projects/${projectId}/services?userId=${encodeURIComponent(userId)}`
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    const json = (await res.json()) as { services: ProjectServiceDto[] }
    return json.services
  }

  async createProjectService(
    userId: string,
    projectId: string,
    service: ProjectServiceWriteDto
  ): Promise<ProjectServiceDto> {
    const res = await api(`/api/projects/${projectId}/services`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, service }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    return (await res.json()) as ProjectServiceDto
  }

  async updateProjectService(
    userId: string,
    projectId: string,
    name: string,
    service: ProjectServiceWriteDto
  ): Promise<ProjectServiceDto> {
    const res = await api(
      `/api/projects/${projectId}/services/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, service }),
      }
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    return (await res.json()) as ProjectServiceDto
  }

  async detectProjectServices(
    userId: string,
    projectId: string,
    conversationId?: string | null
  ): Promise<{ cwd: string; candidates: DetectedServiceCandidate[] }> {
    const params = new URLSearchParams({ userId })
    if (conversationId) params.set("conversationId", conversationId)
    const res = await api(
      `/api/projects/${projectId}/services/detect?${params.toString()}`
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    return (await res.json()) as { cwd: string; candidates: DetectedServiceCandidate[] }
  }

  async detectServicesWithLLM(
    userId: string,
    projectId: string,
    conversationId?: string | null
  ): Promise<LlmServicesDetectionView> {
    const res = await api(`/api/projects/${projectId}/services/detect-llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        conversationId: conversationId ?? undefined,
      }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    return (await res.json()) as LlmServicesDetectionView
  }

  async deleteProjectServiceRow(
    userId: string,
    projectId: string,
    name: string
  ): Promise<void> {
    const res = await api(
      `/api/projects/${projectId}/services/${encodeURIComponent(name)}?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  // Per-conversation, per-service manifest overrides. Sparse — null when
  // the task has no override for this service.
  async fetchServiceOverride(
    userId: string,
    conversationId: string,
    serviceName: string
  ): Promise<Partial<RunManifestDto> | null> {
    const res = await api(
      `/api/conversations/${conversationId}/services/${encodeURIComponent(serviceName)}/override?userId=${encodeURIComponent(userId)}`
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    const json = (await res.json()) as { override: Partial<RunManifestDto> | null }
    return json.override
  }

  async saveServiceOverride(
    userId: string,
    conversationId: string,
    serviceName: string,
    override: Partial<RunManifestDto>
  ): Promise<void> {
    const res = await api(
      `/api/conversations/${conversationId}/services/${encodeURIComponent(serviceName)}/override`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, override }),
      }
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  async clearServiceOverride(
    userId: string,
    conversationId: string,
    serviceName: string
  ): Promise<void> {
    const res = await api(
      `/api/conversations/${conversationId}/services/${encodeURIComponent(serviceName)}/override?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    )
    if (!res.ok && res.status !== 404) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }
}
