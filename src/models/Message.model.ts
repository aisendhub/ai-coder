import { observable } from "mobx"
import { BaseModel } from "./Base.model"

export type StreamEvent =
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; output: string }
  | { kind: "text"; text: string }

export type MessageRole = "user" | "assistant"

export class Message extends BaseModel {
  @observable conversationId = ""
  @observable role: MessageRole = "assistant"
  @observable text = ""
  @observable events: StreamEvent[] = []
  @observable createdAt = new Date().toISOString()

  /** True if this is a local-only optimistic row (id not from the server). */
  get isOptimistic(): boolean {
    return !UUID_RE.test(this.id)
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
