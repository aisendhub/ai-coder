import { action, observable } from "mobx"
import { BaseModel } from "./Base.model"

export type ServiceStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "crashed"

export type ServiceDto = {
  id: string
  ownerId: string
  projectId: string
  serviceName: string
  worktreePath: string | null
  label: string | null
  stack: string
  start: string
  cwd: string
  /** "local-process" | "local-docker" | "external" (reattached at boot). */
  runnerId: string
  pid: number | null
  port: number
  status: ServiceStatus
  exitCode: number | null
  error: string | null
  startedAt: number
  stoppedAt: number | null
  url: string
}

export type LogLine = {
  ts: number
  stream: "stdout" | "stderr"
  text: string
}

export class Service extends BaseModel {
  @observable projectId = ""
  @observable serviceName = "default"
  @observable worktreePath: string | null = null
  @observable label: string | null = null
  @observable stack = ""
  @observable start = ""
  @observable cwd = ""
  @observable runnerId = "local-process"
  @observable pid: number | null = null
  @observable port = 0
  @observable status: ServiceStatus = "starting"
  @observable exitCode: number | null = null
  @observable error: string | null = null
  @observable startedAt = 0
  @observable stoppedAt: number | null = null
  @observable url = ""

  @action setFromDto(dto: ServiceDto) {
    this.id = dto.id
    this.projectId = dto.projectId
    this.serviceName = dto.serviceName
    this.worktreePath = dto.worktreePath
    this.label = dto.label
    this.stack = dto.stack
    this.start = dto.start
    this.cwd = dto.cwd
    this.runnerId = dto.runnerId
    this.pid = dto.pid
    this.port = dto.port
    this.status = dto.status
    this.exitCode = dto.exitCode
    this.error = dto.error
    this.startedAt = dto.startedAt
    this.stoppedAt = dto.stoppedAt
    this.url = dto.url
  }

  /** Reattached from a previous server session — can stop, can't stream logs. */
  get isReattached(): boolean {
    return this.runnerId === "external"
  }

  get isLive(): boolean {
    return this.status === "running" || this.status === "starting"
  }
}
