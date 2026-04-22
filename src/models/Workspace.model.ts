import { action, computed, observable, runInAction } from "mobx"
import { BaseList } from "./BaseList.model"
import { BaseModel } from "./Base.model"
import { Conversation } from "./Conversation.model"
import { Project } from "./Project.model"
import { ServiceList } from "./ServiceList.model"
import { supabase } from "@/lib/supabase"

class ConversationList extends BaseList<typeof Conversation> {
  get ItemType() {
    return Conversation
  }
}

class ProjectList extends BaseList<typeof Project> {
  get ItemType() {
    return Project
  }
}

const LAST_PROJECT_KEY = "ai-coder:activeProjectId"

export class Workspace extends BaseModel {
  @observable userId: string | null = null
  @observable activeId: string | null = null
  @observable activeProjectId: string | null = null
  /** Conversation ids the SERVER reports as having an in-flight runner. */
  @observable runningServerIds = new Set<string>()
  /** Conversation ids whose AI turn finished while they were NOT active —
   *  cleared when the user activates the conversation. */
  @observable unreadIds = new Set<string>()
  /** When non-null, the file panel is open and showing this path
   *  (relative to the active conversation's project cwd). */
  @observable openFilePath: string | null = null
  @observable loading = false

  conversations = ConversationList.create()
  projects = ProjectList.create()
  services = ServiceList.create()

  private convChannel: ReturnType<typeof supabase.channel> | null = null
  private projectChannel: ReturnType<typeof supabase.channel> | null = null
  private runnersTimer: ReturnType<typeof setInterval> | null = null

  @computed get active(): Conversation | null {
    return this.activeId ? this.conversations.find(this.activeId) ?? null : null
  }

  @computed get activeProject(): Project | null {
    return this.activeProjectId
      ? this.projects.find(this.activeProjectId) ?? null
      : null
  }

  @computed get sortedProjects(): Project[] {
    return [...this.projects.items].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    )
  }

  /** Conversations in the active project, newest first. */
  @computed get sortedConversations(): Conversation[] {
    const items = this.activeProjectId
      ? this.conversations.items.filter((c) => c.projectId === this.activeProjectId)
      : this.conversations.items
    return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  @action setActive(id: string | null) {
    if (id === this.activeId) return
    const prev = this.active
    prev?.unsubscribe()
    this.activeId = id
    // The open file is scoped to a conversation's project — drop it on switch.
    this.openFilePath = null
    const next = this.active
    if (next) {
      if (!next.loaded) void next.loadMessages()
      next.subscribe()
      if (this.unreadIds.has(next.id)) {
        const updated = new Set(this.unreadIds)
        updated.delete(next.id)
        this.unreadIds = updated
      }
    }
  }

  @action openFile(path: string) {
    this.openFilePath = path
  }

  @action closeFile() {
    this.openFilePath = null
  }

  @action setActiveProject(id: string | null) {
    if (id === this.activeProjectId) return
    this.activeProjectId = id
    try {
      if (id) localStorage.setItem(LAST_PROJECT_KEY, id)
      else localStorage.removeItem(LAST_PROJECT_KEY)
    } catch {
      // ignore storage errors
    }
    // If the active conversation doesn't belong to the new project, clear it.
    const current = this.active
    if (current && current.projectId !== id) {
      this.setActive(null)
    }
  }

  async signIn(userId: string) {
    if (this.userId === userId) return
    this.signOut()
    runInAction(() => {
      this.userId = userId
    })
    await this.refreshProjects()
    // Restore last active project, or pick the first one.
    const saved = (() => {
      try { return localStorage.getItem(LAST_PROJECT_KEY) } catch { return null }
    })()
    const pick = this.projects.find(saved ?? "") ? saved : this.projects.items[0]?.id ?? null
    runInAction(() => {
      this.activeProjectId = pick
    })
    await this.refresh()
    this.subscribeConversations()
    this.subscribeProjects()
    this.startRunnersPoll()
  }

  signOut() {
    this.active?.unsubscribe()
    if (this.convChannel) {
      void supabase.removeChannel(this.convChannel)
      this.convChannel = null
    }
    if (this.projectChannel) {
      void supabase.removeChannel(this.projectChannel)
      this.projectChannel = null
    }
    if (this.runnersTimer) {
      clearInterval(this.runnersTimer)
      this.runnersTimer = null
    }
    runInAction(() => {
      this.userId = null
      this.activeId = null
      this.activeProjectId = null
      this.conversations.setItems([])
      this.projects.setItems([])
      this.runningServerIds = new Set()
      this.unreadIds = new Set()
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
        .is("deleted_at", null)
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

  async refreshProjects() {
    if (!this.userId) return
    try {
      const { data, error } = await supabase
        .from("projects")
        .select("*")
        .eq("user_id", this.userId)
        .order("updated_at", { ascending: false })
      if (error) throw error
      runInAction(() => {
        this.projects.setItems(
          (data ?? []).map((row) => {
            const p = Project.create()
            p.setFromRow(row)
            return p
          })
        )
      })
    } catch (err) {
      console.error("refresh projects failed", err)
    }
  }

  async createProject(
    name: string,
    cwd: string,
    worktreeMode: "shared" | "per_conversation" = "shared"
  ): Promise<Project> {
    if (!this.userId) throw new Error("not signed in")
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: this.userId, name, cwd, worktreeMode }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    const data = await res.json()
    const p = Project.create()
    p.setFromRow(data)
    runInAction(() => {
      this.projects.addItem(p)
      this.setActiveProject(p.id)
    })
    return p
  }

  async removeProject(id: string) {
    const { error } = await supabase.from("projects").delete().eq("id", id)
    if (error) throw error
    runInAction(() => {
      this.projects.removeItem(id)
      if (this.activeProjectId === id) {
        this.setActiveProject(this.projects.items[0]?.id ?? null)
      }
    })
  }

  /** Create a *draft* task. No worktree, no worker fire — the empty-state
   *  form in the chat pane collects the goal + caps and calls `armTask()`.
   *  `initialGoal` pre-fills the form (used by Spin off from a chat). */
  async createTaskDraft(input: { initialGoal?: string; title?: string } = {}): Promise<Conversation> {
    if (!this.userId) throw new Error("not signed in")
    if (!this.activeProjectId) throw new Error("no active project")
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: this.userId,
        projectId: this.activeProjectId,
        title: input.title,
        kind: "task",
        autoLoopGoal: input.initialGoal,
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    const data = await res.json()
    const c = Conversation.create()
    c.setFromRow(data)
    runInAction(() => {
      this.conversations.addItem(c)
      this.setActive(c.id)
    })
    return c
  }

  /** Arm a draft task: persist goal + caps, provision the worktree, kick the
   *  first worker turn. Called from the empty-state form when the user hits
   *  Start. The server updates the row and starts the runner; realtime
   *  delivers the updated row + streamed messages. */
  async armTask(id: string, input: {
    goal: string
    maxIterations?: number
    maxCostUsd?: number
  }): Promise<void> {
    const res = await fetch(`/api/conversations/${id}/arm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  async createNew(): Promise<Conversation> {
    if (!this.userId) throw new Error("not signed in")
    if (!this.activeProjectId) throw new Error("no active project")
    // Server-side create so the worktree can be provisioned alongside the row.
    // Projects in "shared" mode get the row back with worktree_path = null and
    // behavior is unchanged.
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: this.userId,
        projectId: this.activeProjectId,
        title: "New chat",
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    const data = await res.json()
    const c = Conversation.create()
    c.setFromRow(data)
    runInAction(() => {
      this.conversations.addItem(c)
      this.setActive(c.id)
    })
    return c
  }

  async remove(id: string) {
    // Soft-trash via the server: flips deleted_at, preserves worktree + branch
    // so the user can restore within the grace window. The reaper hard-deletes
    // and tears down the worktree after 7 days.
    const res = await fetch(`/api/conversations/${id}`, { method: "DELETE" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    const target = this.conversations.find(id)
    target?.unsubscribe()
    runInAction(() => {
      this.conversations.removeItem(id)
      if (this.activeId === id) this.activeId = null
    })
  }

  /** Ask the agent to merge a task's worktree into its base branch. The
   *  server injects a scripted merge prompt; the agent runs git commands in
   *  chat, visible to the user. Success is signalled by conversations.shipped_at
   *  flipping (via the end-of-turn reconcile); conflicts become a normal chat
   *  back-and-forth. See docs/MERGE-FLOW.md. */
  async mergeConversation(id: string): Promise<void> {
    const res = await fetch(`/api/conversations/${id}/merge`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  /** Pause a task: flips `auto_loop_enabled = false`. Current worker turn
   *  finishes, then the loop breaks cleanly at the next iteration boundary. */
  async pauseTask(id: string): Promise<void> {
    const res = await fetch(`/api/conversations/${id}/pause`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  /** Resume a paused task: flips the flag on and kicks a fresh worker turn
   *  so the evaluator can drive next steps without the user typing. */
  async resumeTask(id: string): Promise<void> {
    const res = await fetch(`/api/conversations/${id}/resume`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  /** Stop a running conversation immediately. Aborts the in-flight runner
   *  (the loop's abort controller trips at the next iteration check) and —
   *  for tasks — flips `auto_loop_enabled` off so it doesn't auto-continue. */
  async stopConversation(id: string): Promise<void> {
    const target = this.conversations.find(id)
    // Flip the loop off first so a racing iteration-boundary check catches it.
    if (target?.kind === "task" && target.autoLoopEnabled) {
      try { await this.pauseTask(id) } catch { /* ignore */ }
    }
    await fetch("/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: id }),
    })
  }

  async restore(id: string) {
    const res = await fetch(`/api/conversations/${id}/restore`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    const row = await res.json()
    const c = Conversation.create()
    c.setFromRow(row)
    runInAction(() => {
      this.conversations.addItem(c)
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
            // Only hard/soft-trashed rows drop out of the sidebar. Shipped
            // tasks stay visible so the user can open them, review the
            // transcript, and see the status badge — they're still part of
            // the workflow until explicitly deleted.
            if (row.deleted_at) {
              runInAction(() => {
                this.conversations.removeItem(row.id)
                if (this.activeId === row.id) this.activeId = null
              })
              return
            }
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

  private subscribeProjects() {
    if (!this.userId) return
    this.projectChannel = supabase
      .channel("projects:user")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "projects",
          filter: `user_id=eq.${this.userId}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
            const row = payload.new as Parameters<Project["setFromRow"]>[0]
            runInAction(() => {
              const existing = this.projects.find(row.id)
              if (existing) existing.setFromRow(row)
              else {
                const p = Project.create()
                p.setFromRow(row)
                this.projects.addItem(p)
              }
            })
          } else if (payload.eventType === "DELETE") {
            const row = payload.old as { id: string }
            runInAction(() => {
              this.projects.removeItem(row.id)
              if (this.activeProjectId === row.id) {
                this.setActiveProject(this.projects.items[0]?.id ?? null)
              }
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
          const next = new Set(json.runners)
          const newlyDone: string[] = []
          for (const id of this.runningServerIds) {
            if (!next.has(id) && id !== this.activeId) newlyDone.push(id)
          }
          if (newlyDone.length > 0) {
            const unread = new Set(this.unreadIds)
            for (const id of newlyDone) unread.add(id)
            this.unreadIds = unread
            window.dispatchEvent(
              new CustomEvent("ai-coder:background-done", {
                detail: { ids: newlyDone },
              })
            )
          }
          this.runningServerIds = next
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
