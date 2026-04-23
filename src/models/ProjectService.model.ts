import { action, observable } from "mobx"

import { BaseModel } from "./Base.model"
import type { ProjectServiceDto } from "./ServiceList.model"

// A single configured service within a project — one row in project_services.
// Distinct from `Service` (which represents a *running instance*). A project
// can have many ProjectService rows (web, api, worker, …); each one may or
// may not have a live Service at any given moment.
export class ProjectService extends BaseModel {
  @observable projectId = ""
  @observable name = "default"
  @observable description: string | null = null
  @observable stack = "custom"
  @observable start = ""
  @observable build: string | null = null
  @observable env: Record<string, string> = {}
  @observable port: number | null = null
  @observable dockerfile: string | null = null
  @observable healthcheck: { path: string; timeoutMs: number } | null = null
  @observable enabled = true
  @observable orderIndex = 0
  @observable restartPolicy: "always" | "on-failure" | "never" = "on-failure"
  @observable maxRestarts = 5
  @observable assignedPort: number | null = null
  @observable createdAt = ""
  @observable updatedAt = ""

  @action setFromDto(dto: ProjectServiceDto) {
    this.id = dto.id
    this.projectId = dto.project_id
    this.name = dto.name
    this.description = dto.description
    this.stack = dto.stack
    this.start = dto.start
    this.build = dto.build
    this.env = dto.env ?? {}
    this.port = dto.port
    this.dockerfile = dto.dockerfile
    this.healthcheck = dto.healthcheck
    this.enabled = dto.enabled
    this.orderIndex = dto.order_index
    this.restartPolicy = dto.restart_policy
    this.maxRestarts = dto.max_restarts
    this.assignedPort = dto.assigned_port
    this.createdAt = dto.created_at
    this.updatedAt = dto.updated_at
  }
}
