import { action, computed, observable, runInAction } from "mobx"
import { BaseList } from "./BaseList.model"
import { BaseModel } from "./Base.model"
import { Conversation } from "./Conversation.model"
import { supabase } from "@/lib/supabase"

class ConversationList extends BaseList<typeof Conversation> {
  get ItemType() {
    return Conversation
  }
}

export class Workspace extends BaseModel {
  @observable userId: string | null = null
  @observable activeId: string | null = null
  /** Conversation ids the SERVER reports as having an in-flight runner. */
  @observable runningServerIds = new Set<string>()
  @observable loading = false

  conversations = ConversationList.create()

  private convChannel: ReturnType<typeof supabase.channel> | null = null
  private runnersTimer: ReturnType<typeof setInterval> | null = null

  @computed get active(): Conversation | null {
    return this.activeId ? this.conversations.find(this.activeId) ?? null : null
  }

  @computed get sortedConversations(): Conversation[] {
    return [...this.conversations.items].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    )
  }

  @action setActive(id: string | null) {
    if (id === this.activeId) return
    // Unsubscribe the previous active conv's realtime
    const prev = this.active
    prev?.unsubscribe()
    this.activeId = id
    const next = this.active
    if (next) {
      if (!next.loaded) void next.loadMessages()
      next.subscribe()
    }
  }

  /** Start tracking. Call once user is signed in. */
  async signIn(userId: string) {
    if (this.userId === userId) return
    this.signOut()
    runInAction(() => {
      this.userId = userId
    })
    await this.refresh()
    this.subscribeConversations()
    this.startRunnersPoll()
  }

  signOut() {
    this.active?.unsubscribe()
    if (this.convChannel) {
      void supabase.removeChannel(this.convChannel)
      this.convChannel = null
    }
    if (this.runnersTimer) {
      clearInterval(this.runnersTimer)
      this.runnersTimer = null
    }
    runInAction(() => {
      this.userId = null
      this.activeId = null
      this.conversations.setItems([])
      this.runningServerIds = new Set()
    })
  }

  async refresh() {
    if (!this.userId) return
    runInAction(() => {
      this.loading = true
    })
    try {
      const { data, error } = await supabase
        .from("conversations")
        .select("*")
        .eq("user_id", this.userId)
        .order("updated_at", { ascending: false })
      if (error) throw error
      runInAction(() => {
        this.conversations.setItems(
          (data ?? []).map((row) => {
            const c = Conversation.create()
            c.setFromRow(row)
            return c
          })
        )
      })
    } catch (err) {
      console.error("refresh conversations failed", err)
    } finally {
      runInAction(() => {
        this.loading = false
      })
    }
  }

  async createNew(): Promise<Conversation> {
    if (!this.userId) throw new Error("not signed in")
    const { data, error } = await supabase
      .from("conversations")
      .insert({ user_id: this.userId, title: "New chat" })
      .select()
      .single()
    if (error) throw error
    const c = Conversation.create()
    c.setFromRow(data)
    runInAction(() => {
      this.conversations.addItem(c)
      this.setActive(c.id)
    })
    return c
  }

  async remove(id: string) {
    const { error } = await supabase.from("conversations").delete().eq("id", id)
    if (error) throw error
    const target = this.conversations.find(id)
    target?.unsubscribe()
    runInAction(() => {
      this.conversations.removeItem(id)
      if (this.activeId === id) this.activeId = null
    })
  }

  private subscribeConversations() {
    if (!this.userId) return
    this.convChannel = supabase
      .channel("conversations:user")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `user_id=eq.${this.userId}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
            const row = payload.new as Parameters<Conversation["setFromRow"]>[0]
            runInAction(() => {
              const existing = this.conversations.find(row.id)
              if (existing) {
                existing.setFromRow(row)
              } else {
                const c = Conversation.create()
                c.setFromRow(row)
                this.conversations.addItem(c)
              }
            })
          } else if (payload.eventType === "DELETE") {
            const row = payload.old as { id: string }
            runInAction(() => {
              this.conversations.removeItem(row.id)
            })
          }
        }
      )
      .subscribe()
  }

  private startRunnersPoll() {
    const tick = async () => {
      try {
        const res = await fetch("/api/runners")
        if (!res.ok) return
        const json = (await res.json()) as { runners: string[] }
        runInAction(() => {
          this.runningServerIds = new Set(json.runners)
        })
      } catch {
        // ignore
      }
    }
    void tick()
    this.runnersTimer = setInterval(tick, 3000)
  }
}

export const workspace = Workspace.create()
