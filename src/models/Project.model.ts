import { action, observable } from "mobx"
import { BaseModel } from "./Base.model"

export type WorktreeMode = "shared" | "per_conversation"

export class Project extends BaseModel {
  @observable userId = ""
  @observable name = ""
  @observable cwd = ""
  @observable worktreeMode: WorktreeMode = "shared"
  @observable defaultBaseRef: string | null = null
  @observable createdAt = new Date().toISOString()
  @observable updatedAt = new Date().toISOString()

  @action setFromRow(row: {
    id: string
    user_id: string
    name: string
    cwd: string
    worktree_mode?: WorktreeMode | null
    default_base_ref?: string | null
    created_at: string
    updated_at: string
  }) {
    this.id = row.id
    this.userId = row.user_id
    this.name = row.name
    this.cwd = row.cwd
    this.worktreeMode = (row.worktree_mode ?? "shared") as WorktreeMode
    this.defaultBaseRef = row.default_base_ref ?? null
    this.createdAt = row.created_at
    this.updatedAt = row.updated_at
  }
}
