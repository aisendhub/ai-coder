import { useCallback, useEffect, useState } from "react"
import { observer } from "mobx-react-lite"
import { ChevronDown, ChevronRight, FolderGit2, Gauge, LayoutGrid, MessageSquare, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Sun } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { workspace } from "@/models"
import { cn } from "@/lib/utils"
import { usePersistentState } from "@/hooks/use-persistent-state"
import { useDeleteConversation } from "@/hooks/use-delete-conversation"
import { useSidebarOptional } from "@/components/ui/sidebar"
import { NewProjectDialog } from "@/components/new-project-dialog"
import { Board } from "@/components/board"
import { ConversationRow } from "@/components/conversation-row"
import { ChatsSection } from "@/components/chats-section"
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
  // Chats promotion/fullscreen — owned by App.tsx so the promoted copy
  // and the ghost stub stay in sync.
  chatsPromoted?: boolean
  chatsFullscreen?: boolean
  onPromoteChats?: () => void
  onRestoreChats?: () => void
  onEnterChatsFullscreen?: () => void
  onExitChatsFullscreen?: () => void
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
  chatsPromoted = false,
  chatsFullscreen = false,
  onPromoteChats,
  onRestoreChats,
  onEnterChatsFullscreen,
  onExitChatsFullscreen,
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
  const [tasksOpen, setTasksOpen] = usePersistentState("ai-coder:panels:nav:tasksOpen", true)
  const [chatsOpen, setChatsOpen] = usePersistentState("ai-coder:panels:nav:chatsOpen", true)
  const { dark, toggle: toggleTheme } = useTheme()
  const handleDelete = useDeleteConversation()

  const filtered = query
    ? conversations.filter((c) =>
        c.title.toLowerCase().includes(query.toLowerCase())
      )
    : conversations

  // Tasks render inline here; Chats delegates to ChatsSection which
  // computes its own list (it may be promoted out of the nav entirely).
  const tasks = filtered.filter((c) => c.kind === "task")

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
      {filtered.length === 0 && !loading ? (
        <div className="flex-1 min-h-0 px-2 py-3 text-xs text-muted-foreground">
          {query ? "No matches." : "No conversations yet."}
        </div>
      ) : (() => {
        const toggleTasks = () => setTasksOpen((v) => !v)
        const toggleChats = () => setChatsOpen((v) => !v)

        const tasksHeader = (
          <button
            type="button"
            onClick={toggleTasks}
            className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs text-muted-foreground hover:bg-sidebar-accent/50 cursor-pointer"
            aria-expanded={tasksOpen}
          >
            {tasksOpen ? (
              <ChevronDown className="size-3 shrink-0" />
            ) : (
              <ChevronRight className="size-3 shrink-0" />
            )}
            <Gauge className="size-3 shrink-0" />
            <span>Tasks</span>
            <span className="text-[10px] opacity-60">{tasks.length}</span>
            <span
              className="ml-auto flex items-center"
              onClick={(e) => e.stopPropagation()}
            >
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleNewTask()
                    }}
                    disabled={!activeProject}
                    aria-label="New task"
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {activeProject ? "New task" : "Select a project first"}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation()
                      setBoardOpen(true)
                    }}
                    aria-label="Open task board"
                  >
                    <LayoutGrid className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Task board</TooltipContent>
              </Tooltip>
            </span>
          </button>
        )

        const tasksBody = (
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-2 flex flex-col gap-0.5">
              {tasks.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">No tasks.</div>
              ) : (
                tasks.map((c) => (
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
                ))
              )}
            </div>
          </ScrollArea>
        )

        // Chats is rendered via the shared ChatsSection component so the
        // same instance can be promoted to a side panel or fullscreen from
        // App.tsx. When promoted, we render a one-row ghost stub here.
        const chatsSection = chatsPromoted ? (
          <ChatsSection
            ghost
            expanded={false}
            promoted
            fullscreen={chatsFullscreen}
            onPromote={onPromoteChats}
            onRestore={onRestoreChats}
            onEnterFullscreen={onEnterChatsFullscreen}
            onExitFullscreen={onExitChatsFullscreen}
          />
        ) : (
          <ChatsSection
            expanded={chatsOpen}
            onToggleExpanded={toggleChats}
            promoted={false}
            fullscreen={chatsFullscreen}
            onPromote={onPromoteChats}
            onRestore={onRestoreChats}
            onEnterFullscreen={onEnterChatsFullscreen}
            onExitFullscreen={onExitChatsFullscreen}
            externalQuery={query}
            onConversationOpen={closeMobileNav}
            loading={loading}
          />
        )

        // Layout logic: the resizable split only makes sense when both
        // sections are present AND expanded. If Chats is promoted elsewhere,
        // Tasks takes the full height above the ghost stub.
        if (chatsPromoted) {
          return (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className={cn("flex flex-col min-h-0", tasksOpen && "flex-1")}>
                {tasksHeader}
                {tasksOpen && tasksBody}
              </div>
              {chatsSection}
            </div>
          )
        }

        if (tasksOpen && chatsOpen) {
          return (
            <ResizablePanelGroup
              direction="vertical"
              autoSaveId="ai-coder-nav-split"
              className="flex-1 min-h-0"
            >
              <ResizablePanel id="nav-tasks" order={1} defaultSize={50} minSize={15}>
                <div className="h-full min-h-0 flex flex-col">
                  {tasksHeader}
                  {tasksBody}
                </div>
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="nav-chats" order={2} defaultSize={50} minSize={15}>
                <div className="h-full min-h-0 flex flex-col">
                  {chatsSection}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          )
        }

        // One or zero expanded: plain flex column — whichever is open fills
        // the remaining space, the other is just a header.
        return (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className={cn("flex flex-col min-h-0", tasksOpen && "flex-1")}>
              {tasksHeader}
              {tasksOpen && tasksBody}
            </div>
            {chatsSection}
          </div>
        )
      })()}
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

