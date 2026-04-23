import { action, observable, runInAction } from "mobx"

import { BaseList } from "./BaseList.model"
import { ProjectService } from "./ProjectService.model"
import type { ProjectServiceDto, ProjectServiceWriteDto } from "./ServiceList.model"

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

// Per-project configured services. Scoped to one project at a time — the UI
// refreshes when the active project changes. Not a cache across projects:
// keeping state small avoids the "which project was this for?" bug class.
export class ProjectServiceList extends BaseList<typeof ProjectService> {
  get ItemType() {
    return ProjectService
  }

  @observable loading = false
  @observable lastError: string | null = null
  @observable loadedProjectId: string | null = null

  @action private upsertDto(dto: ProjectServiceDto) {
    const existing = this.items.find((i) => i.name === dto.name)
    if (existing) {
      existing.setFromDto(dto)
    } else {
      const m = ProjectService.create()
      m.setFromDto(dto)
      this.addItem(m)
    }
  }

  @action clearAll() {
    this.items.splice(0, this.items.length)
    this.loadedProjectId = null
  }

  findByName(name: string): ProjectService | undefined {
    return this.items.find((s) => s.name === name)
  }

  get sortedServices(): ProjectService[] {
    return [...this.items].sort((a, b) => {
      if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex
      return a.name.localeCompare(b.name)
    })
  }

  async refresh(userId: string, projectId: string): Promise<void> {
    this.loading = true
    this.lastError = null
    try {
      const res = await fetch(
        `/api/projects/${projectId}/services?userId=${encodeURIComponent(userId)}`
      )
      const json = await unwrap<{ services: ProjectServiceDto[] }>(res)
      runInAction(() => {
        const incoming = new Set(json.services.map((s) => s.name))
        for (const item of [...this.items]) {
          if (!incoming.has(item.name)) this.removeItem(item.id)
        }
        for (const dto of json.services) this.upsertDto(dto)
        this.loadedProjectId = projectId
      })
    } catch (err) {
      runInAction(() => {
        this.lastError = (err as Error).message
      })
      throw err
    } finally {
      runInAction(() => { this.loading = false })
    }
  }

  async create(
    userId: string,
    projectId: string,
    write: ProjectServiceWriteDto
  ): Promise<ProjectService> {
    const res = await fetch(`/api/projects/${projectId}/services`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, service: write }),
    })
    const dto = await unwrap<ProjectServiceDto>(res)
    runInAction(() => this.upsertDto(dto))
    return this.findByName(dto.name)!
  }

  async update(
    userId: string,
    projectId: string,
    name: string,
    write: ProjectServiceWriteDto
  ): Promise<ProjectService> {
    const res = await fetch(
      `/api/projects/${projectId}/services/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, service: write }),
      }
    )
    const dto = await unwrap<ProjectServiceDto>(res)
    runInAction(() => this.upsertDto(dto))
    return this.findByName(dto.name)!
  }

  async remove(userId: string, projectId: string, name: string): Promise<void> {
    const res = await fetch(
      `/api/projects/${projectId}/services/${encodeURIComponent(name)}?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    )
    if (!res.ok && res.status !== 404) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    runInAction(() => {
      const existing = this.findByName(name)
      if (existing) this.removeItem(existing.id)
    })
  }
}
