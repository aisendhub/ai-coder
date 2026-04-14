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

  /** True if this is a local-only optimistic row (not yet confirmed by the server). */
  @observable isOptimistic = false
}
