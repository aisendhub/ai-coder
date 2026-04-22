import { useCallback, useEffect, useState } from "react"
import { observer } from "mobx-react-lite"
import { FolderGit2, Gauge, GitBranch, LayoutGrid, MessageSquare, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Sun, Trash2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { workspace } from "@/models"
import { cn } from "@/lib/utils"
import { useSidebarOptional } from "@/components/ui/sidebar"
import { NewProjectDialog } from "@/components/new-project-dialog"
import { Board } from "@/components/board"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type Props = {
  collapsed?: boolean
  onToggle?: () => void
}

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  const toggle = useCallback(() => {
    const next = !dark
    document.documentElement.classList.toggle("dark", next)
    localStorage.setItem("theme", next ? "dark" : "light")
    setDark(next)
  }, [dark])
  // Sync on mount (e.g. from localStorage or system preference)
  useEffect(() => {
    const saved = localStorage.getItem("theme")
    const prefersDark = saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)
    document.documentElement.classList.toggle("dark", prefersDark)
    setDark(prefersDark)
  }, [])
  return { dark, toggle }
}

export const NavPanel = observer(function NavPanel({
  collapsed = false,
  onToggle,
}: Props) {
  const sidebar = useSidebarOptional()
  const closeMobileNav = () => {
    if (sidebar?.isMobile) sidebar.setOpenMobile(false)
  }
  const conversations = workspace.sortedConversations
  const activeId = workspace.activeId
  const loading = workspace.loading
  const runningIds = workspace.runningServerIds
  const unreadIds = workspace.unreadIds
  const projects = workspace.sortedProjects
  const activeProject = workspace.activeProject
  const [query, setQuery] = useState("")
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [boardOpen, setBoardOpen] = useState(false)
  const { dark, toggle: toggleTheme } = useTheme()

  const filtered = query
    ? conversations.filter((c) =>
        c.title.toLowerCase().includes(query.toLowerCase())
      )
    : conversations

  // Split the sidebar so tasks (worktree + agent loop) are surfaced
  // distinctly from plain chats. Tasks appear first because they're what the
  // user is most likely watching.
  const tasks = filtered.filter((c) => c.kind === "task")
  const chats = filtered.filter((c) => c.kind !== "task")

  // Confirm before deleting; if the conversation has a worktree with
  // uncommitted changes or unpushed commits, surface that in the prompt so
  // the user doesn't accidentally trash work that's only on the local branch.
  const handleDelete = useCallback(async (id: string, label: string, hasWorktree: boolean) => {
    if (!hasWorktree) {
      if (!confirm(`Delete ${label}?`)) return
      try { await workspace.remove(id) } catch (err) { console.error("delete failed", err) }
      return
    }
    let warning = ""
    try {
      const res = await fetch(`/api/conversations/${id}/discard-status`)
      if (res.ok) {
        const s = (await res.json()) as {
          uncommittedFiles: number
          unpushedCommits: number
          hasUpstream: boolean
        }
        const bits: string[] = []
        if (s.uncommittedFiles > 0) bits.push(`${s.uncommittedFiles} uncommitted file${s.uncommittedFiles === 1 ? "" : "s"}`)
        if (s.unpushedCommits > 0) {
          bits.push(`${s.unpushedCommits} ${s.hasUpstream ? "unpushed" : "local-only"} commit${s.unpushedCommits === 1 ? "" : "s"}`)
        }
        if (bits.length) warning = `\n\nThis branch has ${bits.join(" and ")}. They'll be permanently lost when the reaper runs in 7 days.`
      }
    } catch {
      // Probe failed — fall through and use the generic confirm.
    }
    if (!confirm(`Delete ${label}?${warning}`)) return
    try { await workspace.remove(id) } catch (err) { console.error("delete failed", err) }
  }, [])

  const handleNew = async () => {
    if (!activeProject) {
      setProjectDialogOpen(true)
      return
    }
    try {
      await workspace.createNew()
      closeMobileNav()
    } catch (err) {
      console.error("createNew failed", err)
    }
  }

  const handleNewTask = async () => {
    if (!activeProject) {
      setProjectDialogOpen(true)
      return
    }
    try {
      await workspace.createTaskDraft()
      closeMobileNav()
    } catch (err) {
      console.error("createTaskDraft failed", err)
    }
  }

  const dialog = (
    <>
      <NewProjectDialog open={projectDialogOpen} onClose={() => setProjectDialogOpen(false)} />
      <Board open={boardOpen} onClose={() => setBoardOpen(false)} />
    </>
  )

  if (collapsed) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center bg-sidebar text-sidebar-foreground py-2 gap-1">
        {dialog}
        <Tooltip>
          <TooltipTrigger render={<Button size="icon" variant="ghost" aria-label="New chat" onClick={handleNew} />}>
            <Plus className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">New chat</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button size="icon" variant="ghost" aria-label="Task board" onClick={() => setBoardOpen(true)} />}>
            <LayoutGrid className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">Task board</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button size="icon" variant="ghost" aria-label="Search" />}>
            <Search className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">Search</TooltipContent>
        </Tooltip>
        <div className="my-1 h-px w-6 bg-border" />
        <div className="flex-1 flex flex-col gap-1 overflow-y-auto w-full items-center">
          {conversations.slice(0, 16).map((c) => (
            <Button
              key={c.id}
              size="icon"
              variant={c.id === activeId ? "secondary" : "ghost"}
              aria-label={c.title}
              title={
                c.title +
                (runningIds.has(c.id)
                  ? " (running)"
                  : unreadIds.has(c.id)
                    ? " (new)"
                    : "")
              }
              onClick={() => { workspace.setActive(c.id); closeMobileNav() }}
              className="relative"
            >
              {c.kind === "task" ? <Gauge className="size-4" /> : <MessageSquare className="size-4" />}
              {runningIds.has(c.id) ? (
                <span className="absolute top-1 right-1 size-2 rounded-full bg-emerald-500 ring-2 ring-sidebar animate-pulse" />
              ) : unreadIds.has(c.id) ? (
                <span className="absolute top-1 right-1 size-2 rounded-full bg-sky-500 ring-2 ring-sidebar" />
              ) : null}
            </Button>
          ))}
        </div>
        <div className="border-t w-full pt-1 flex flex-col items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={toggleTheme}
                  aria-label="Toggle theme"
                />
              }
            >
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </TooltipTrigger>
            <TooltipContent side="right">{dark ? "Light mode" : "Dark mode"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={onToggle}
                  aria-label="Expand nav"
                />
              }
            >
              <PanelLeftOpen className="size-4" />
            </TooltipTrigger>
            <TooltipContent side="right">Expand nav</TooltipContent>
          </Tooltip>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      {dialog}
      <div className="p-2 flex flex-col gap-2 border-b">
        <div className="flex items-center gap-3">
          <FolderGit2 className="size-4 text-muted-foreground shrink-0" />
          <Select
            value={activeProject?.id ?? ""}
            onValueChange={(v: string) => {
              if (v === "__new__") setProjectDialogOpen(true)
              else workspace.setActiveProject(v || null)
            }}
          >
            <SelectTrigger className="flex-1 min-w-0" aria-label="Project">
              <SelectValue placeholder="No projects">
                {(value: string) =>
                  projects.find((p) => p.id === value)?.name ?? "No projects"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
              {projects.length > 0 && <SelectSeparator />}
              <SelectItem value="__new__">+ New project…</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {activeProject && (
          <div className="text-[10px] text-muted-foreground px-1 font-mono truncate" title={activeProject.cwd}>
            {activeProject.cwd}
          </div>
        )}
        <div className="flex gap-1">
          <Button
            className="flex-1 justify-start gap-2"
            onClick={handleNew}
            disabled={!activeProject}
          >
            <Plus className="size-4" />
            Chat
          </Button>
          <Button
            className="flex-1 justify-start gap-2"
            variant="secondary"
            onClick={handleNewTask}
            disabled={!activeProject}
          >
            <Gauge className="size-4" />
            Task
          </Button>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search"
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 flex flex-col gap-0.5">
          {filtered.length === 0 && !loading && (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              {query ? "No matches." : "No conversations yet."}
            </div>
          )}
          {tasks.length > 0 && (
            <>
              <div className="text-xs text-muted-foreground px-2 py-1 flex items-center gap-1.5">
                <Gauge className="size-3" />
                <span>Tasks</span>
                <span className="text-[10px] opacity-60">{tasks.length}</span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-5 ml-auto"
                        onClick={() => setBoardOpen(true)}
                        aria-label="Open task board"
                      />
                    }
                  >
                    <LayoutGrid className="size-3" />
                  </TooltipTrigger>
                  <TooltipContent side="right">Task board</TooltipContent>
                </Tooltip>
              </div>
              {tasks.map((c) => (
                <ConversationRow
                  key={c.id}
                  kind={c.kind}
                  title={c.title}
                  updated={c.updatedAt}
                  branch={c.branch}
                  iteration={c.loopIteration}
                  maxIterations={c.maxIterations}
                  shipped={!!c.shippedAt}
                  active={c.id === activeId}
                  running={runningIds.has(c.id)}
                  unread={unreadIds.has(c.id)}
                  onClick={() => { workspace.setActive(c.id); closeMobileNav() }}
                  onDelete={() => void handleDelete(c.id, "this task", !!c.worktreePath)}
                />
              ))}
            </>
          )}
          {chats.length > 0 && (
            <>
              <div className="text-xs text-muted-foreground px-2 py-1 mt-1 flex items-center justify-between">
                <span>Chats</span>
                {loading && <span className="text-[10px]">loading…</span>}
              </div>
              {chats.map((c) => (
                <ConversationRow
                  key={c.id}
                  kind={c.kind}
                  title={c.title}
                  updated={c.updatedAt}
                  branch={c.branch}
                  iteration={c.loopIteration}
                  maxIterations={c.maxIterations}
                  shipped={!!c.shippedAt}
                  active={c.id === activeId}
                  running={runningIds.has(c.id)}
                  unread={unreadIds.has(c.id)}
                  onClick={() => { workspace.setActive(c.id); closeMobileNav() }}
                  onDelete={() => void handleDelete(c.id, "this conversation", !!c.worktreePath)}
                />
              ))}
            </>
          )}
        </div>
      </ScrollArea>
      <div className="border-t flex items-center justify-between px-2 py-1.5">
        <div className="text-xs text-muted-foreground px-1">ai-coder · v0.1</div>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={toggleTheme}
                  aria-label="Toggle theme"
                  className="size-7"
                />
              }
            >
              {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            </TooltipTrigger>
            <TooltipContent>{dark ? "Light mode" : "Dark mode"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={onToggle}
                  aria-label="Collapse nav"
                  className="size-7"
                />
              }
            >
              <PanelLeftClose className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Collapse nav</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
})

type TaskStatus = "backlog" | "running" | "review" | "shipped"

function taskStatusFor(input: {
  shipped: boolean
  running: boolean
  iteration: number
}): TaskStatus {
  if (input.shipped) return "shipped"
  if (input.running) return "running"
  if (input.iteration === 0) return "backlog"
  return "review"
}

const STATUS_STYLE: Record<TaskStatus, { label: string; tone: string }> = {
  backlog: { label: "backlog", tone: "text-muted-foreground" },
  running: { label: "running", tone: "text-emerald-600 dark:text-emerald-400" },
  review: { label: "review", tone: "text-sky-600 dark:text-sky-400" },
  shipped: { label: "shipped", tone: "text-emerald-600 dark:text-emerald-400" },
}

function ConversationRow({
  kind,
  title,
  updated,
  branch,
  iteration,
  maxIterations,
  shipped,
  active,
  running,
  unread,
  onClick,
  onDelete,
}: {
  kind: "chat" | "task"
  title: string
  updated: string
  branch: string | null
  iteration: number
  maxIterations: number
  shipped: boolean
  active: boolean
  running: boolean
  unread: boolean
  onClick: () => void
  onDelete: () => void
}) {
  // Branch labels come through prefixed with `ai-coder/` — drop the namespace
  // from the pill so the conversation's own slug reads cleanly.
  const shortBranch = branch?.replace(/^ai-coder\//, "") ?? null
  const Icon = kind === "task" ? Gauge : MessageSquare
  const status = kind === "task" ? taskStatusFor({ shipped, running, iteration }) : null
  const statusStyle = status ? STATUS_STYLE[status] : null
  return (
    <div
      className={cn(
        "group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground cursor-pointer min-w-0",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
        shipped && !active && "opacity-70"
      )}
      onClick={onClick}
    >
      <div className="relative shrink-0">
        <Icon className={cn("size-4 mt-0.5", shipped && "text-emerald-600 dark:text-emerald-400")} />
        {running ? (
          <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-sidebar animate-pulse" />
        ) : unread ? (
          <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-sky-500 ring-2 ring-sidebar" />
        ) : null}
      </div>
      <div className="flex-1 min-w-0">
        <div className={cn("truncate text-sm", unread && !active && "font-semibold")}>{title}</div>
        <div className="text-xs text-muted-foreground flex items-center gap-1 min-w-0">
          {statusStyle && (
            <>
              <span className={cn("font-medium", statusStyle.tone)}>{statusStyle.label}</span>
              <span>·</span>
            </>
          )}
          {unread && !running && !shipped && <span className="text-sky-600">new</span>}
          {unread && !running && !shipped && <span>·</span>}
          {kind === "task" && !shipped && (status === "review" || status === "running") && (
            <>
              <span className="font-mono text-[10px]">{iteration}/{maxIterations}</span>
              <span>·</span>
            </>
          )}
          {shortBranch && (
            <>
              <span
                className="inline-flex items-center gap-0.5 font-mono text-[10px] truncate min-w-0"
                title={branch ?? undefined}
              >
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{shortBranch}</span>
              </span>
              <span>·</span>
            </>
          )}
          <span className="shrink-0">{formatRelative(updated)}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-600 shrink-0 cursor-pointer"
        aria-label="Delete conversation"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}

function formatRelative(iso: string): string {
  const d = new Date(iso).getTime()
  const diff = Date.now() - d
  const m = Math.floor(diff / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days}d`
  return new Date(d).toLocaleDateString()
}
