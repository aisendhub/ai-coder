import { observable } from "mobx"
import { BaseModel } from "./Base.model"
import type { AttachmentMeta } from "@/lib/attachment"

export type StreamEvent =
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; output: string }
  | { kind: "text"; text: string }
  | {
      kind: "loop_iteration"
      iteration: number
      maxIterations: number
      status: "continue" | "done" | "error"
      feedback: string
      nextSteps: string
      costUsd: number
    }
  | {
      kind: "loop_stopped"
      reason: "max_iterations" | "max_cost" | "no_progress" | "done" | "evaluator_stop"
      iteration: number
      costUsd: number
    }
  | { kind: "loop_evaluating"; iteration: number }

export type MessageRole = "user" | "assistant" | "notice"

export class Message extends BaseModel {
  @observable conversationId = ""
  @observable role: MessageRole = "assistant"
  @observable text = ""
  @observable events: StreamEvent[] = []
  @observable attachments: AttachmentMeta[] = []
  @observable createdAt = new Date().toISOString()
  /** When the agent actually received this user message. null = nudge sitting
   *  in the queue, waiting for the next canUseTool tool boundary. The server
   *  flips this to a timestamp once the message has been handed off. */
  @observable deliveredAt: string | null = null

  /** True if this is a local-only optimistic row (not yet confirmed by the server). */
  @observable isOptimistic = false
}
