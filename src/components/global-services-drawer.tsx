// Global running-services indicator + drawer.
//
// The chip in the top bar shows a count of services running anywhere for the
// current user. Click to open a drawer that groups by Project → (chats |
// worktree). Each level has a "Stop all" button (with confirm) and each
// instance row has individual stop + log-jump actions. See SERVICES.md for
// the design + ENV-AND-SERVICES.md for the wider context.

import { useCallback, useEffect, useMemo, useState } from "react"
import { observer } from "mobx-react-lite"
import { toast } from "sonner"
import { Activity, ChevronDown, ChevronRight, Loader2, Square, GitBranch, Folder } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { useConfirm } from "@/lib/confirm"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { workspace } from "@/models"

type GlobalSnapshot = {
  id: string
  ownerId: string
  projectId: string
  serviceName: string
  worktreePath: string | null
  label: string | null
  status: "starting" | "running" | "stopping" | "stopped" | "exited" | "failed"
  port: number | null
  startedAt: number
  pid: number | null
  restarts?: number
}

type ProjectMeta = { id: string; name: string; cwd: string }
type ConvMeta = {
  id: string
  title: string
  kind: "chat" | "task"
  worktree_path: string | null
  branch: string | null
}

type ApiResponse = {
  services: GlobalSnapshot[]
  projects: ProjectMeta[]
  conversations: ConvMeta[]
}

const POLL_MS = 4000

// Live status used to color the chip + dot. Anything in [starting, running,
// stopping] is "live"; everything else is fading out and not interesting.
function isLive(s: GlobalSnapshot): boolean {
  return s.status === "starting" || s.status === "running" || s.status === "stopping"
}

export const GlobalServicesTrigger = observer(function GlobalServicesTrigger() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const activeProjectId = workspace.activeProjectId

  const refresh = useCallback(async () => {
    if (loading) return
    setLoading(true)
    try {
      const res = await api("/api/services/all")
      if (!res.ok) return
      const json = (await res.json()) as ApiResponse
      setData(json)
    } catch {
      // advisory; chip just won't update
    } finally {
      setLoading(false)
    }
  }, [loading])

  // Background poll so the chip count stays fresh without the drawer being
  // open. Cheap GET; one request every 4s per signed-in tab.
  useEffect(() => {
    void refresh()
    const t = setInterval(() => { void refresh() }, POLL_MS)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refresh immediately when the drawer opens — don't make the user wait for
  // the next poll tick to see post-start changes.
  useEffect(() => {
    if (open) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // External "open me" — fired by the project-switch toast's "View" action.
  // Lets other components surface the drawer without lifting state.
  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener("worktrees:open-services-drawer", onOpen)
    return () => window.removeEventListener("worktrees:open-services-drawer", onOpen)
  }, [])

  const live = useMemo(() => (data?.services ?? []).filter(isLive), [data])
  const liveCount = live.length
  const inOtherProjects = useMemo(
    () => activeProjectId
      ? live.some((s) => s.projectId !== activeProjectId)
      : false,
    [live, activeProjectId],
  )

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 px-2"
                  aria-label={`${liveCount} services running`}
                />
              }
            />
          }
        >
          <span
            className={cn(
              "inline-block size-2 rounded-full",
              liveCount === 0 && "bg-muted-foreground/40",
              liveCount > 0 && !inOtherProjects && "bg-emerald-500",
              liveCount > 0 && inOtherProjects && "bg-amber-500",
            )}
            aria-hidden
          />
          <Activity className="size-4" />
          {liveCount > 0 && (
            <span className="text-xs font-mono tabular-nums">{liveCount}</span>
          )}
        </TooltipTrigger>
        <TooltipContent>
          {liveCount === 0
            ? "No services running"
            : inOtherProjects
              ? `${liveCount} running — some in other projects`
              : `${liveCount} running in this project`}
        </TooltipContent>
      </Tooltip>
      <SheetContent side="right" className="flex flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <Activity className="size-4" />
            Running services
            {loading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
          </SheetTitle>
        </SheetHeader>
        <DrawerBody data={data} live={live} onAfterChange={refresh} />
      </SheetContent>
    </Sheet>
  )
})

function DrawerBody({
  data,
  live,
  onAfterChange,
}: {
  data: ApiResponse | null
  live: GlobalSnapshot[]
  onAfterChange: () => Promise<void>
}) {
  const confirm = useConfirm()

  const stopByScope = useCallback(
    async (
      scope: "user" | "project" | "project-chats" | "worktree",
      label: string,
      count: number,
      extra: { projectId?: string; worktreePath?: string | null } = {},
    ) => {
      const ok = await confirm({
        title: `Stop ${count} service${count === 1 ? "" : "s"}?`,
        description: `Will stop: ${label}. Each process gets a graceful SIGTERM first, then SIGKILL after a few seconds.`,
        variant: "destructive",
        confirmText: "Stop",
      })
      if (!ok) return
      try {
        const res = await api("/api/services/stop-scope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, ...extra }),
        })
        const body = (await res.json().catch(() => ({}))) as {
          stopped?: number
          matched?: number
          error?: string
        }
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
        toast.success(`Stopped ${body.stopped ?? 0}/${body.matched ?? 0}`)
        await onAfterChange()
      } catch (err) {
        toast.error("Stop failed", {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [confirm, onAfterChange],
  )

  const stopOne = useCallback(
    async (s: GlobalSnapshot) => {
      try {
        const res = await api(`/api/services/${s.id}/stop`, { method: "POST" })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error || `HTTP ${res.status}`)
        }
        toast.success(`Stopped ${s.serviceName}`)
        await onAfterChange()
      } catch (err) {
        toast.error("Stop failed", {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [onAfterChange],
  )

  // Index metadata for fast lookup.
  const projectsById = useMemo(
    () => new Map((data?.projects ?? []).map((p) => [p.id, p])),
    [data],
  )
  const conversationsByWorktree = useMemo(
    () => new Map((data?.conversations ?? []).map((c) => [c.worktree_path, c])),
    [data],
  )

  // Group: project → (worktree path | null) → instances
  const groups = useMemo(() => {
    const out = new Map<string, Map<string | null, GlobalSnapshot[]>>()
    for (const s of live) {
      if (!out.has(s.projectId)) out.set(s.projectId, new Map())
      const inner = out.get(s.projectId)!
      const wt = s.worktreePath ?? null
      if (!inner.has(wt)) inner.set(wt, [])
      inner.get(wt)!.push(s)
    }
    return out
  }, [live])

  if (live.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-xs text-muted-foreground">
        No services running.
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-y-auto">
      <div className="flex items-center justify-between border-b px-3 py-2 sticky top-0 bg-background z-10">
        <span className="text-xs text-muted-foreground">
          {live.length} running across {groups.size} project{groups.size === 1 ? "" : "s"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
          onClick={() => stopByScope("user", "everything across all projects", live.length)}
        >
          <Square className="size-3" />
          Stop all
        </Button>
      </div>

      <div className="flex flex-col">
        {Array.from(groups.entries()).map(([projectId, scoped]) => {
          const project = projectsById.get(projectId)
          const projectTotal = Array.from(scoped.values()).reduce((sum, list) => sum + list.length, 0)
          return (
            <ProjectGroup
              key={projectId}
              projectId={projectId}
              projectName={project?.name ?? projectId.slice(0, 8)}
              scoped={scoped}
              conversationsByWorktree={conversationsByWorktree}
              projectTotal={projectTotal}
              onStopOne={stopOne}
              onStopProject={() =>
                stopByScope(
                  "project",
                  `every service in ${project?.name ?? "this project"}`,
                  projectTotal,
                  { projectId },
                )
              }
              onStopProjectChats={(count) =>
                stopByScope(
                  "project-chats",
                  `chat instances in ${project?.name ?? "this project"}`,
                  count,
                  { projectId },
                )
              }
              onStopWorktree={(worktreePath, count, label) =>
                stopByScope(
                  "worktree",
                  label,
                  count,
                  { projectId, worktreePath },
                )
              }
            />
          )
        })}
      </div>
    </div>
  )
}

function ProjectGroup({
  projectId: _projectId,
  projectName,
  scoped,
  conversationsByWorktree,
  projectTotal,
  onStopOne,
  onStopProject,
  onStopProjectChats,
  onStopWorktree,
}: {
  projectId: string
  projectName: string
  scoped: Map<string | null, GlobalSnapshot[]>
  conversationsByWorktree: Map<string | null, ConvMeta>
  projectTotal: number
  onStopOne: (s: GlobalSnapshot) => Promise<void>
  onStopProject: () => Promise<void>
  onStopProjectChats: (count: number) => Promise<void>
  onStopWorktree: (worktreePath: string, count: number, label: string) => Promise<void>
}) {
  const [open, setOpen] = useState(true)
  const chatInstances = scoped.get(null) ?? []
  const worktreeEntries = Array.from(scoped.entries()).filter(([wt]) => wt !== null) as Array<[
    string,
    GlobalSnapshot[],
  ]>

  return (
    <div className="border-b">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/40"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <Folder className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium truncate flex-1">{projectName}</span>
        <span className="text-[11px] font-mono text-muted-foreground">{projectTotal}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 ml-1 text-[11px] text-destructive hover:text-destructive"
          onClick={(e) => { e.stopPropagation(); void onStopProject() }}
          title="Stop every service in this project"
        >
          Stop all
        </Button>
      </button>
      {open && (
        <div className="pb-2">
          {chatInstances.length > 0 && (
            <SubGroup
              label="Project (chats)"
              icon={<Folder className="size-3 text-muted-foreground" />}
              instances={chatInstances}
              onStopOne={onStopOne}
              onStopAll={() => onStopProjectChats(chatInstances.length)}
            />
          )}
          {worktreeEntries.map(([worktreePath, instances]) => {
            const conv = conversationsByWorktree.get(worktreePath)
            const label = conv?.title ?? worktreePath.split("/").pop() ?? worktreePath
            return (
              <SubGroup
                key={worktreePath}
                label={`Task: ${label}`}
                icon={<GitBranch className="size-3 text-muted-foreground" />}
                instances={instances}
                onStopOne={onStopOne}
                onStopAll={() =>
                  onStopWorktree(
                    worktreePath,
                    instances.length,
                    `${instances.length} service${instances.length === 1 ? "" : "s"} in "${label}"`,
                  )
                }
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function SubGroup({
  label,
  icon,
  instances,
  onStopOne,
  onStopAll,
}: {
  label: string
  icon: React.ReactNode
  instances: GlobalSnapshot[]
  onStopOne: (s: GlobalSnapshot) => Promise<void>
  onStopAll: () => Promise<void>
}) {
  return (
    <div className="ml-4 mt-1">
      <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {icon}
        <span className="flex-1 truncate">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1 text-[10px] text-destructive hover:text-destructive"
          onClick={() => void onStopAll()}
          title={`Stop all ${instances.length} in this scope`}
        >
          Stop
        </Button>
      </div>
      <div className="flex flex-col gap-0.5 px-3">
        {instances.map((s) => (
          <InstanceRow key={s.id} s={s} onStop={() => onStopOne(s)} />
        ))}
      </div>
    </div>
  )
}

function InstanceRow({ s, onStop }: { s: GlobalSnapshot; onStop: () => Promise<void> }) {
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent/30">
      <span
        className={cn(
          "inline-block size-1.5 rounded-full",
          s.status === "running" && "bg-emerald-500",
          s.status === "starting" && "bg-amber-500 animate-pulse",
          s.status === "stopping" && "bg-amber-500",
          (s.status === "stopped" || s.status === "exited" || s.status === "failed") && "bg-muted-foreground/40",
        )}
      />
      <span className="text-xs font-mono truncate flex-1">{s.serviceName}</span>
      {s.port != null && (
        <span className="text-[10px] font-mono text-muted-foreground">:{s.port}</span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-5 px-1.5 text-[10px]"
        onClick={() => void onStop()}
        title="Stop this instance"
      >
        Stop
      </Button>
    </div>
  )
}
