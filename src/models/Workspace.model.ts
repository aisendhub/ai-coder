import { action, computed, observable, runInAction } from "mobx"
import { toast } from "sonner"
import { BaseList } from "./BaseList.model"
import { BaseModel } from "./Base.model"
import { Conversation } from "./Conversation.model"
import { Project } from "./Project.model"
import { ServiceList } from "./ServiceList.model"
import { ProjectServiceList } from "./ProjectServiceList.model"
import { supabase } from "@/lib/supabase"
import { api } from "@/lib/api"

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

// Per-session set of project ids we've already shown the project-switch
// notice for. Repeated switches between two projects shouldn't toast every
// time — once is enough.
const switchNoticeShown = new Set<string>()

async function notifyIfPreviousProjectHasServices(
  projectId: string,
  projectName: string | null,
): Promise<void> {
  if (switchNoticeShown.has(projectId)) return
  try {
    const res = await api(`/api/services?projectId=${encodeURIComponent(projectId)}`)
    if (!res.ok) return
    const json = (await res.json()) as { services: Array<{ status: string }> }
    const live = json.services.filter(
      (s) => s.status === "running" || s.status === "starting" || s.status === "stopping",
    ).length
    if (live === 0) return
    switchNoticeShown.add(projectId)
    const label = projectName ?? "Previous project"
    toast.info(`${label}: ${live} service${live === 1 ? " is" : "s are"} still running`, {
      description: "They keep running across project switches. Open the global drawer to manage.",
      action: {
        label: "View",
        onClick: () =>
          window.dispatchEvent(new CustomEvent("worktrees:open-services-drawer")),
      },
      duration: 8000,
    })
  } catch {
    // advisory; silent failure is fine
  }
}

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
  /** When non-null, the file panel is in *commit-pinned* mode: it shows the
   *  file's content + diff at this sha instead of the working tree. Set by
   *  clicking a file inside the git-log expanded view. Cleared by opening a
   *  file from any working-tree surface or by hitting "back to working tree"
   *  in the file-panel banner. See docs/GIT-LOG.md. */
  @observable pinnedCommit: { sha: string; shortSha: string } | null = null
  @observable loading = false

  conversations = ConversationList.create()
  projects = ProjectList.create()
  services = ServiceList.create()
  projectServices = ProjectServiceList.create()

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
    this.pinnedCommit = null
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
    // Opening from any working-tree surface returns the panel to working-tree
    // mode. Commit-pinned mode is opt-in via openFileAtCommit().
    this.pinnedCommit = null
  }

  @action openFileAtCommit(path: string, sha: string, shortSha: string) {
    this.openFilePath = path
    this.pinnedCommit = { sha, shortSha }
  }

  @action unpinCommit() {
    this.pinnedCommit = null
  }

  @action closeFile() {
    this.openFilePath = null
    this.pinnedCommit = null
  }

  @action setActiveProject(id: string | null) {
    if (id === this.activeProjectId) return
    const previousId = this.activeProjectId
    const previousName = previousId
      ? this.projects.find(previousId)?.name ?? null
      : null
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
    // Clear prior-project service rows so the panel doesn't flash stale cards
    // before the fresh list loads. Callers re-fetch on the next render.
    this.projectServices.clearAll()
    if (this.userId && id) {
      void this.projectServices.refresh(this.userId, id).catch(() => {
        /* advisory; panel surfaces its own errors */
      })
    }
    // Passive notice: if the project we just left has running services, let
    // the user know so they don't forget about them. The global drawer chip
    // also shows an amber indicator, but this toast is the discovery moment.
    if (previousId) void notifyIfPreviousProjectHasServices(previousId, previousName)
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
    if (pick) {
      void this.projectServices.refresh(userId, pick).catch(() => {
        /* advisory */
      })
    }
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
      this.projectServices.clearAll()
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
    // Deterministic id: sidebar + activeProjectId flip before the server
    // round-trip (see docs/ARCHITECTURE-CLIENT-IDS.md).
    const id = crypto.randomUUID()
    const p = Project.create()
    p.setFromRow({
      id,
      user_id: this.userId,
      name,
      cwd,
      worktree_mode: worktreeMode,
      default_base_ref: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    runInAction(() => {
      this.projects.addItem(p)
      this.setActiveProject(p.id)
    })
    try {
      const res = await api("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name, cwd, worktreeMode }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      runInAction(() => p.setFromRow(data))
    } catch (err) {
      runInAction(() => {
        this.projects.removeItem(id)
        if (this.activeProjectId === id) {
          this.setActiveProject(this.projects.items[0]?.id ?? null)
        }
      })
      throw err
    }
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
   *  `initialGoal` pre-fills the form (used by Spin off from a chat).
   *  Client generates the id (see docs/ARCHITECTURE-CLIENT-IDS.md) so the
   *  conversation appears in the sidebar and the URL resolves before the
   *  server round-trip completes. */
  async createTaskDraft(input: { initialGoal?: string; title?: string } = {}): Promise<Conversation> {
    if (!this.userId) throw new Error("not signed in")
    if (!this.activeProjectId) throw new Error("no active project")
    const userId = this.userId
    const projectId = this.activeProjectId
    const id = crypto.randomUUID()
    const title = input.title ?? "New task"
    const c = Conversation.create()
    c.setFromRow({
      id,
      user_id: userId,
      project_id: projectId,
      title,
      session_id: null,
      sandbox_id: null,
      repo_url: null,
      kind: "task",
      auto_loop_enabled: false,
      auto_loop_goal: input.initialGoal ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    runInAction(() => {
      this.conversations.addItem(c)
      this.setActive(c.id)
    })
    try {
      const res = await api("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          projectId,
          title,
          kind: "task",
          autoLoopGoal: input.initialGoal,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      runInAction(() => c.setFromRow(data))
    } catch (err) {
      // Roll back the optimistic insert so the sidebar doesn't carry a
      // ghost conversation after a server error.
      runInAction(() => {
        this.conversations.removeItem(id)
        if (this.activeId === id) this.setActive(null)
      })
      throw err
    }
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
    const res = await api(`/api/conversations/${id}/arm`, {
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
    const userId = this.userId
    const projectId = this.activeProjectId
    // Client-generated id: the conversation exists in the sidebar, the URL
    // resolves, and the user can start typing immediately — all before the
    // server responds. Server insert uses the same id; realtime never sees
    // a different id to reconcile. See docs/ARCHITECTURE-CLIENT-IDS.md.
    const id = crypto.randomUUID()
    const c = Conversation.create()
    c.setFromRow({
      id,
      user_id: userId,
      project_id: projectId,
      title: "New chat",
      session_id: null,
      sandbox_id: null,
      repo_url: null,
      kind: "chat",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    runInAction(() => {
      this.conversations.addItem(c)
      this.setActive(c.id)
    })
    try {
      const res = await api("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          projectId,
          title: "New chat",
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      runInAction(() => c.setFromRow(data))
    } catch (err) {
      // Roll back the optimistic insert on server failure.
      runInAction(() => {
        this.conversations.removeItem(id)
        if (this.activeId === id) this.setActive(null)
      })
      throw err
    }
    return c
  }

  async remove(id: string) {
    // Soft-trash via the server: flips deleted_at, preserves worktree + branch
    // so the user can restore within the grace window. The reaper hard-deletes
    // and tears down the worktree after 7 days.
    const res = await api(`/api/conversations/${id}`, { method: "DELETE" })
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
    const res = await api(`/api/conversations/${id}/merge`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  /** Undo a shipped task: instruct the agent to hard-reset the base branch
   *  back before the squash commit and re-provision the worktree so the user
   *  can continue. Destructive — the agent refuses if the base branch moved
   *  past the shipped commit or if the commit was pushed. See docs/MERGE-FLOW.md. */
  async revertConversation(id: string): Promise<void> {
    const res = await api(`/api/conversations/${id}/revert`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  /** Pause a task: flips `auto_loop_enabled = false`. Current worker turn
   *  finishes, then the loop breaks cleanly at the next iteration boundary. */
  async pauseTask(id: string): Promise<void> {
    const res = await api(`/api/conversations/${id}/pause`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  /** Resume a paused task: flips the flag on and kicks a fresh worker turn
   *  so the evaluator can drive next steps without the user typing. */
  async resumeTask(id: string): Promise<void> {
    const res = await api(`/api/conversations/${id}/resume`, { method: "POST" })
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
    await api("/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: id }),
    })
  }

  async restore(id: string) {
    const res = await api(`/api/conversations/${id}/restore`, { method: "POST" })
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
        const res = await api("/api/runners")
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
