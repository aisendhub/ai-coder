import { action, observable, runInAction } from "mobx"
import { BaseList } from "./BaseList.model"
import { Service, type ServiceDto, type LogLine } from "./Service.model"

type StartArgs = {
  userId: string
  projectId: string
  conversationId?: string | null
  label?: string | null
  runnerId?: RunnerId
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

  async refresh(userId: string): Promise<void> {
    this.setLoading(true)
    try {
      const res = await fetch(
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
      this.setLoading(false)
    }
  }

  // ── Integrations (Phase 5) ─────────────────────────────────────────────────

  async refreshRailwayIntegration(userId: string): Promise<void> {
    try {
      const res = await fetch(
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
    const res = await fetch("/api/integrations/railway/connect", {
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
    const res = await fetch(
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
      const res = await fetch("/api/services/runners")
      if (!res.ok) return
      const json = (await res.json()) as { runners: RunnerInfo[] }
      runInAction(() => { this.runners = json.runners })
    } catch {
      /* ignore — runners list is advisory for UI disabling */
    }
  }

  async start(args: StartArgs): Promise<Service> {
    const res = await fetch("/api/services/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: args.userId,
        projectId: args.projectId,
        conversationId: args.conversationId ?? undefined,
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
    const res = await fetch(`/api/services/${id}/stop`, {
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

  async remove(userId: string, id: string): Promise<void> {
    this.closeLogs(id)
    const res = await fetch(
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
    const es = new EventSource(
      `/api/services/${id}/logs?userId=${encodeURIComponent(userId)}`
    )
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

    return () => this.closeLogs(id)
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
    const res = await fetch(`/api/projects/${projectId}/manifest/detect-llm`, {
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
    projectId: string
  ): Promise<ProjectManifestView> {
    const res = await fetch(
      `/api/projects/${projectId}/manifest?userId=${encodeURIComponent(userId)}`
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
    const res = await fetch(`/api/projects/${projectId}/manifest`, {
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
    const res = await fetch(
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
    const res = await fetch(
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
    const res = await fetch(
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
    const res = await fetch(
      `/api/conversations/${conversationId}/manifest-override?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }
}
