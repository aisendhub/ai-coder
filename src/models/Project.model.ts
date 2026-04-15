import { action, observable } from "mobx"
import { BaseModel } from "./Base.model"

export class Project extends BaseModel {
  @observable userId = ""
  @observable name = ""
  @observable cwd = ""
  @observable createdAt = new Date().toISOString()
  @observable updatedAt = new Date().toISOString()

  @action setFromRow(row: {
    id: string
    user_id: string
    name: string
    cwd: string
    created_at: string
    updated_at: string
  }) {
    this.id = row.id
    this.userId = row.user_id
    this.name = row.name
    this.cwd = row.cwd
    this.createdAt = row.created_at
    this.updatedAt = row.updated_at
  }
}
