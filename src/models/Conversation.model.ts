import { action, computed, observable, runInAction } from "mobx"
import { BaseModel } from "./Base.model"
import { BaseList } from "./BaseList.model"
import { Message, type StreamEvent } from "./Message.model"
import { supabase } from "@/lib/supabase"

class MessageList extends BaseList<typeof Message> {
  get ItemType() {
    return Message
  }
}

export class Conversation extends BaseModel {
  @observable userId = ""
  @observable title = "New chat"
  @observable sessionId: string | null = null
  @observable sandboxId: string | null = null
  @observable repoUrl: string | null = null
  @observable createdAt = new Date().toISOString()
  @observable updatedAt = new Date().toISOString()

  /** True while a runner is in flight FOR THIS CLIENT. Server may also be
   *  running it independently — see Workspace.runningServerIds for that. */
  @observable streaming = false

  /** Prompts queued behind the active runner. */
  @observable queue: string[] = []

  /** Loaded from DB on activation; populated via SSE/realtime as turns run. */
  messages = MessageList.create()

  /** True once we've fetched messages for this conversation. */
  @observable loaded = false

  /** Last error from a turn, if any. */
  @observable lastError: string | null = null

  private abortController: AbortController | null = null
  private realtimeChannel: ReturnType<typeof supabase.channel> | null = null

  @computed get isFirstMessage(): boolean {
    return this.messages.items.length === 0
  }

  // ─── DB sync ──────────────────────────────────────────────────────────────

  @action setFromRow(row: {
    id: string
    user_id: string
    title: string
    session_id: string | null
    sandbox_id: string | null
    repo_url: string | null
    created_at: string
    updated_at: string
  }) {
    this.id = row.id
    this.userId = row.user_id
    this.title = row.title
    this.sessionId = row.session_id
    this.sandboxId = row.sandbox_id
    this.repoUrl = row.repo_url
    this.createdAt = row.created_at
    this.updatedAt = row.updated_at
  }

  async loadMessages() {
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", this.id)
      .order("created_at", { ascending: true })
    if (error) {
      console.error("loadMessages failed", error)
      return
    }
    runInAction(() => {
      const dbMessages = (data ?? []).map((r) =>
        Message.fromProps({
          id: r.id,
          conversationId: this.id,
          role: r.role,
          text: r.text,
          events: Array.isArray(r.events) ? (r.events as StreamEvent[]) : [],
          createdAt: r.created_at,
        })
      )
      // Preserve any optimistic local messages already added by an in-flight
      // runTurn — placing them at the end keeps the order sane until realtime
      // upgrades them to canonical DB rows.
      const optimistic = this.messages.items.filter((m) => m.isOptimistic)
      this.messages.setItems([...dbMessages, ...optimistic])
      this.loaded = true
    })
  }

  /** Subscribe to realtime INSERT/UPDATE on this conversation's messages.
   *  Idempotent: re-subscribing replaces the previous channel. */
  subscribe() {
    this.unsubscribe()
    this.realtimeChannel = supabase
      .channel(`messages:${this.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${this.id}`,
        },
        (payload) => this.applyInsert(payload.new as MessageRow)
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${this.id}`,
        },
        (payload) => this.applyUpdate(payload.new as MessageRow)
      )
      .subscribe()
  }

  unsubscribe() {
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
      this.realtimeChannel = null
    }
  }

  @action private applyInsert(row: MessageRow) {
    if (this.messages.find(row.id)) return
    const events = Array.isArray(row.events) ? (row.events as StreamEvent[]) : []
    // Try to upgrade an optimistic local row: same role, matching text (user)
    // or any optimistic assistant (its text may already be populated via SSE).
    const optimistic = this.messages.items.find(
      (m) =>
        m.isOptimistic &&
        m.role === row.role &&
        (row.role === "assistant" || m.text === row.text)
    )
    if (optimistic) {
      optimistic.setProps({ id: row.id, events, isOptimistic: false })
      return
    }
    this.messages.addItem(
      Message.fromProps({
        id: row.id,
        conversationId: this.id,
        role: row.role,
        text: row.text,
        events,
        createdAt: row.created_at,
      })
    )
  }

  @action private applyUpdate(row: MessageRow) {
    const m = this.messages.find(row.id)
    if (!m) return
    m.setProps({
      text: row.text,
      events: Array.isArray(row.events) ? (row.events as StreamEvent[]) : [],
    })
  }

  // ─── Sending ──────────────────────────────────────────────────────────────

  /** Send a user prompt. If a turn is in flight for this conversation,
   *  queue it; otherwise start a new runner. */
  send = async (prompt: string) => {
    if (this.streaming) {
      runInAction(() => this.queue.push(prompt))
      return
    }
    void this.runTurn(prompt)
  }

  @action cancel() {
    this.abortController?.abort()
    this.abortController = null
    this.streaming = false
  }

  private runTurn = async (prompt: string) => {
    runInAction(() => {
      this.streaming = true
      this.lastError = null
      // Optimistic placeholders — server inserts canonical rows, realtime
      // swaps the optimistic ids when they arrive.
      this.messages.addItem(
        Message.fromProps({
          conversationId: this.id,
          role: "user",
          text: prompt,
          events: [],
          isOptimistic: true,
        })
      )
      this.messages.addItem(
        Message.fromProps({
          conversationId: this.id,
          role: "assistant",
          text: "",
          events: [],
          isOptimistic: true,
        })
      )
      // First user prompt becomes the title (still default).
      if (!this.title || this.title === "New chat") {
        const t = prompt.split("\n")[0].slice(0, 60)
        if (t) {
          this.title = t
          void supabase
            .from("conversations")
            .update({ title: t })
            .eq("id", this.id)
            .then(({ error }) => {
              if (error) console.error("title update failed", error)
            })
        }
      }
    })

    const updateAssistant = action((fn: (m: Message) => void) => {
      const m = this.lastAssistant
      if (m) fn(m)
    })

    const controller = new AbortController()
    this.abortController = controller

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: this.id,
          prompt,
          sessionId: this.sessionId ?? undefined,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      if (!res.body) throw new Error("no body")

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split("\n\n")
        buffer = parts.pop() ?? ""
        for (const part of parts) {
          const event = /event: (.+)/.exec(part)?.[1]
          const data = /data: (.+)/.exec(part)?.[1]
          if (!event || !data) continue
          const payload = JSON.parse(data)

          if (event === "session") {
            runInAction(() => {
              this.sessionId = payload.sessionId
            })
          } else if (event === "text") {
            updateAssistant((m) => {
              m.text += payload.text
              m.events.push({ kind: "text", text: payload.text })
            })
          } else if (event === "thinking") {
            updateAssistant((m) => {
              m.events.push({ kind: "thinking", text: payload.text })
            })
          } else if (event === "tool_use") {
            updateAssistant((m) => {
              m.events.push({
                kind: "tool_use",
                id: payload.id,
                name: payload.name,
                input: payload.input,
              })
            })
          } else if (event === "tool_result") {
            updateAssistant((m) => {
              m.events.push({
                kind: "tool_result",
                toolUseId: payload.toolUseId,
                isError: payload.isError,
                output: payload.output,
              })
            })
          } else if (event === "error") {
            runInAction(() => {
              this.lastError = payload.message
            })
            updateAssistant((m) => {
              m.text += `\n⚠️ ${payload.message}`
            })
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        const message = err instanceof Error ? err.message : String(err)
        runInAction(() => {
          this.lastError = message
        })
        updateAssistant((m) => {
          m.text += `\n⚠️ ${message}`
        })
      }
    } finally {
      this.abortController = null
      // Drain queue – if another message is waiting, hand off directly
      // without clearing the streaming flag so listeners know the AI is
      // still actively responding.
      const next = runInAction(() => this.queue.shift())
      if (next) {
        void this.runTurn(next)
      } else {
        runInAction(() => {
          this.streaming = false
        })
        window.dispatchEvent(new CustomEvent("ai-coder:turn-done"))
      }
    }
  }

  @computed get lastAssistant(): Message | undefined {
    for (let i = this.messages.items.length - 1; i >= 0; i--) {
      if (this.messages.items[i].role === "assistant") {
        return this.messages.items[i]
      }
    }
    return undefined
  }
}

type MessageRow = {
  id: string
  conversation_id: string
  role: "user" | "assistant"
  text: string
  events: unknown
  created_at: string
}
