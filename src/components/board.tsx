import { useCallback, useEffect, useMemo, useState } from "react"
import { observer } from "mobx-react-lite"
import { toast } from "sonner"
import {
  Gauge,
  GitBranch,
  Pause,
  Play,
  Ship as ShipIcon,
  Trash2,
  X,
  Loader2,
  CircleDashed,
  CheckCircle2,
  Archive,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useConfirm } from "@/lib/confirm"
import { supabase } from "@/lib/supabase"
import { api } from "@/lib/api"
import { workspace } from "@/models"

type ConfirmFn = ReturnType<typeof useConfirm>
type DiffSummary = { filesChanged: number; additions: number; deletions: number }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

type BoardTask = {
  id: string
  title: string
  project_id: string
  branch: string | null
  base_ref: string | null
  worktree_path: string | null
  kind: string
  auto_loop_enabled: boolean
  loop_iteration: number
  loop_cost_usd: number | string | null
  max_iterations: number
  max_cost_usd: number | string | null
  deleted_at: string | null
  shipped_at: string | null
  updated_at: string
}

type ColumnKey = "backlog" | "running" | "review" | "shipped" | "trashed"

const COLUMN_META: Record<ColumnKey, { label: string; hint: string; Icon: typeof Gauge; tone: string }> = {
  backlog: {
    label: "Backlog",
    hint: "Queued — the first worker turn hasn't completed yet.",
    Icon: CircleDashed,
    tone: "text-muted-foreground",
  },
  running: {
    label: "Running",
    hint: "A worker turn is live on the server.",
    Icon: Loader2,
    tone: "text-emerald-600 dark:text-emerald-400",
  },
  review: {
    label: "Review",
    hint: "Loop stopped — open the task to review changes and ship.",
    Icon: Gauge,
    tone: "text-sky-600 dark:text-sky-400",
  },
  shipped: {
    label: "Shipped",
    hint: "Merged into base; the worktree is gone.",
    Icon: CheckCircle2,
    tone: "text-emerald-700 dark:text-emerald-400",
  },
  trashed: {
    label: "Trashed",
    hint: "Soft-trashed. Reaper cleans up after the grace window.",
    Icon: Archive,
    tone: "text-amber-600 dark:text-amber-400",
  },
}

const COLUMN_ORDER: ColumnKey[] = ["backlog", "running", "review", "shipped", "trashed"]

function columnFor(t: BoardTask, runningIds: Set<string>): ColumnKey {
  if (t.deleted_at) return "trashed"
  if (t.shipped_at) return "shipped"
  if (runningIds.has(t.id)) return "running"
  if (t.loop_iteration === 0) return "backlog"
  return "review"
}

// Map a (from → to) drag onto the underlying lifecycle action. Returns null
// for transitions that don't correspond to a real state change (same column,
// terminal source, target that requires data we can't fabricate from a drop).
type DragAction =
  | { kind: "open" }       // backlog → running needs a goal; punt to detail UI
  | { kind: "pause" }      // running → review
  | { kind: "resume" }     // review → running
  | { kind: "trash" }      // → trashed
  | { kind: "restore" }    // trashed → review|backlog
  | { kind: "ship" }       // review → shipped (merge)

function transitionFor(from: ColumnKey, to: ColumnKey): DragAction | null {
  if (from === to) return null
  if (from === "shipped") return null   // terminal; can't drag out of shipped
  if (to === "backlog") return null     // can't reset loop_iteration
  if (to === "shipped") return from === "review" ? { kind: "ship" } : null
  if (to === "trashed") return { kind: "trash" }
  if (to === "running") {
    if (from === "review") return { kind: "resume" }
    if (from === "backlog") return { kind: "open" }
    if (from === "trashed") return { kind: "restore" }
    return null
  }
  if (to === "review") {
    if (from === "running") return { kind: "pause" }
    if (from === "trashed") return { kind: "restore" }
    return null
  }
  return null
}

async function runTransition(
  action: DragAction,
  taskId: string,
  task: BoardTask | undefined,
  confirm: ConfirmFn,
  open: () => void,
): Promise<void> {
  switch (action.kind) {
    case "open":
      // backlog→running needs a goal; let the task detail collect it.
      open()
      return
    case "pause":
      await workspace.pauseTask(taskId)
      return
    case "resume":
      await workspace.resumeTask(taskId)
      return
    case "restore":
      await workspace.restore(taskId)
      return
    case "trash": {
      const ok = await confirm({
        title: `Delete "${task?.title ?? "this task"}"?`,
        variant: "destructive",
        confirmText: "Delete",
      })
      if (!ok) return
      await workspace.remove(taskId)
      return
    }
    case "ship": {
      const base = task?.base_ref ?? "base"
      const ok = await confirm({
        title: `Merge "${task?.title ?? "this task"}" into ${base}?`,
        description: "The agent will run the merge in the chat — you'll see each step.",
        confirmText: "Merge",
      })
      if (!ok) return
      await workspace.mergeConversation(taskId)
      return
    }
  }
}

type Props = {
  open: boolean
  onClose: () => void
}

export const Board = observer(function Board({ open, onClose }: Props) {
  const projectId = workspace.activeProjectId
  const [tasks, setTasks] = useState<BoardTask[]>([])
  const [loading, setLoading] = useState(false)
  const runningIds = workspace.runningServerIds
  const confirm = useConfirm()
  // Tracks the active HTML5 drag — set on dragStart, cleared on dragEnd or
  // drop. `from` is the source column at drag-start; we use it to decide
  // which transitions are valid as the cursor passes over each column.
  const [drag, setDrag] = useState<{ taskId: string; from: ColumnKey } | null>(null)
  // Per-card diff summaries (files changed + insertions/deletions vs base).
  // Empty for backlog/shipped/trashed; the server only computes for tasks
  // that have a worktree and a base ref.
  const [summaries, setSummaries] = useState<Record<string, DiffSummary>>({})
  // Disk usage summary for this project's worktrees. Loaded from
  // GET /api/projects/:id/usage when the board opens; refreshed after a
  // manual prune so the indicator reflects what was just freed.
  const [usage, setUsage] = useState<{ totalBytes: number; trashedBytes: number } | null>(null)
  const [pruning, setPruning] = useState(false)

  const refreshUsage = useCallback(async () => {
    if (!projectId) {
      setUsage(null)
      return
    }
    try {
      const res = await api(`/api/projects/${projectId}/usage`)
      if (!res.ok) return
      const json = (await res.json()) as {
        project: { totalBytes: number; trashedBytes: number }
      }
      setUsage({
        totalBytes: json.project.totalBytes,
        trashedBytes: json.project.trashedBytes,
      })
    } catch {
      // advisory; the indicator just won't render
    }
  }, [projectId])

  const handlePrune = useCallback(async () => {
    if (!projectId || pruning) return
    const trashedCount = tasks.filter((t) => t.deleted_at).length
    if (trashedCount === 0) {
      toast.info("Nothing to prune", { description: "No trashed tasks." })
      return
    }
    const ok = await confirm({
      title: `Prune ${trashedCount} trashed task${trashedCount === 1 ? "" : "s"}?`,
      description:
        "This skips the 7-day grace window and permanently removes the worktree(s) on disk.",
      variant: "destructive",
      confirmText: "Prune now",
    })
    if (!ok) return
    setPruning(true)
    try {
      const res = await api(`/api/projects/${projectId}/prune-trashed`, {
        method: "POST",
      })
      const body = (await res.json().catch(() => ({}))) as {
        count?: number
        bytesFreed?: number
        error?: string
      }
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      toast.success(`Pruned ${body.count ?? 0} task(s)`, {
        description: body.bytesFreed
          ? `Freed ${formatBytes(body.bytesFreed)}.`
          : undefined,
      })
      await refreshUsage()
    } catch (err) {
      toast.error("Prune failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setPruning(false)
    }
  }, [projectId, pruning, tasks, confirm, refreshUsage])

  const handleDrop = useCallback(
    async (taskId: string, from: ColumnKey, to: ColumnKey) => {
      const transition = transitionFor(from, to)
      if (!transition) return
      const task = tasks.find((t) => t.id === taskId)
      try {
        await runTransition(transition, taskId, task, confirm, () => {
          workspace.setActive(taskId)
          onClose()
        })
      } catch (err) {
        toast.error("Couldn't move task", {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [tasks, confirm, onClose]
  )

  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  // Refresh the disk-usage indicator whenever the board opens. The values
  // change slowly (per-task, not per-keystroke) so we don't poll — just
  // refresh on open and after a manual prune.
  useEffect(() => {
    if (!open) {
      setUsage(null)
      return
    }
    void refreshUsage()
  }, [open, refreshUsage])

  // Load all tasks (including trashed) for the active project when the board
  // opens. Small scope keeps the query fast; realtime below handles updates.
  useEffect(() => {
    if (!open || !projectId) {
      setTasks([])
      return
    }
    let cancelled = false
    setLoading(true)
    supabase
      .from("conversations")
      .select("id, title, project_id, branch, base_ref, worktree_path, kind, auto_loop_enabled, loop_iteration, loop_cost_usd, max_iterations, max_cost_usd, deleted_at, shipped_at, updated_at")
      .eq("project_id", projectId)
      .eq("kind", "task")
      .order("updated_at", { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          toast.error("Failed to load board", { description: error.message })
          setTasks([])
        } else {
          setTasks((data ?? []) as BoardTask[])
        }
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, projectId])

  // Realtime: keep the board in sync while it's open. Any conversation change
  // in this project updates the local list; state transitions re-shuffle
  // cards into the right column automatically via the derivation below.
  useEffect(() => {
    if (!open || !projectId) return
    const ch = supabase
      .channel(`board:${projectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `project_id=eq.${projectId}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
            const row = payload.new as BoardTask
            if (row.kind !== "task") return
            setTasks((prev) => {
              const idx = prev.findIndex((t) => t.id === row.id)
              if (idx >= 0) {
                const next = prev.slice()
                next[idx] = row
                return next
              }
              return [row, ...prev]
            })
          } else if (payload.eventType === "DELETE") {
            const row = payload.old as { id: string }
            setTasks((prev) => prev.filter((t) => t.id !== row.id))
          }
        }
      )
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [open, projectId])

  const grouped = useMemo(() => {
    const out: Record<ColumnKey, BoardTask[]> = {
      backlog: [], running: [], review: [], shipped: [], trashed: [],
    }
    for (const t of tasks) out[columnFor(t, runningIds)].push(t)
    return out
  }, [tasks, runningIds])

  // Fetch diff summaries for tasks where they're meaningful: anything with a
  // worktree that hasn't shipped or been trashed. We key the effect on the
  // sorted ids so realtime card moves don't re-fire it on every render.
  const summaryIdsKey = useMemo(() => {
    return tasks
      .filter((t) => !t.shipped_at && !t.deleted_at && t.worktree_path)
      .map((t) => t.id)
      .sort()
      .join(",")
  }, [tasks])
  useEffect(() => {
    if (!open || summaryIdsKey === "") {
      setSummaries({})
      return
    }
    const ids = summaryIdsKey.split(",")
    let cancelled = false
    void (async () => {
      try {
        const res = await api("/api/conversations/diff-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        })
        if (!res.ok || cancelled) return
        const json = (await res.json()) as {
          summaries: Record<string, DiffSummary | null>
        }
        if (cancelled) return
        const next: Record<string, DiffSummary> = {}
        for (const [id, s] of Object.entries(json.summaries)) {
          if (s) next[id] = s
        }
        setSummaries(next)
      } catch {
        // advisory — cards just don't render the diff hint
      }
    })()
    return () => { cancelled = true }
  }, [open, summaryIdsKey])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex items-center justify-between border-b bg-background px-4 h-14 shrink-0">
        <div className="flex items-center gap-2">
          <Gauge className="size-4" />
          <h2 className="text-sm font-semibold">Task board</h2>
          <span className="text-xs text-muted-foreground">
            {workspace.activeProject?.name ?? ""}
          </span>
          {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground ml-1" />}
        </div>
        <div className="flex items-center gap-3">
          {usage && usage.totalBytes > 0 && (
            <span
              className="text-[11px] text-muted-foreground font-mono inline-flex items-center gap-2"
              title={
                usage.trashedBytes > 0
                  ? `Total worktree disk usage: ${formatBytes(usage.totalBytes)} (${formatBytes(usage.trashedBytes)} in trashed tasks)`
                  : `Total worktree disk usage: ${formatBytes(usage.totalBytes)}`
              }
            >
              <span>{formatBytes(usage.totalBytes)} on disk</span>
              {usage.trashedBytes > 0 && (
                <span className="text-amber-600 dark:text-amber-400">
                  · {formatBytes(usage.trashedBytes)} trashed
                </span>
              )}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            disabled={pruning || tasks.filter((t) => t.deleted_at).length === 0}
            onClick={handlePrune}
            title="Hard-delete trashed tasks now (skips the 7-day grace window)"
          >
            {pruning ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
            Prune trashed
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close board">
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-x-auto">
        <div className="flex gap-3 p-4 min-h-full">
          {COLUMN_ORDER.map((key) => {
            const dropAction = drag ? transitionFor(drag.from, key) : null
            const isDropTarget = !!drag && drag.from !== key && !!dropAction
            const isInvalidTarget = !!drag && drag.from !== key && !dropAction
            return (
              <BoardColumn
                key={key}
                columnKey={key}
                tasks={grouped[key]}
                summaries={summaries}
                isDropTarget={isDropTarget}
                isInvalidTarget={isInvalidTarget}
                onOpen={(id) => {
                  workspace.setActive(id)
                  onClose()
                }}
                onCardDragStart={(id) => setDrag({ taskId: id, from: key })}
                onCardDragEnd={() => setDrag(null)}
                onColumnDrop={(taskId, from) => {
                  setDrag(null)
                  void handleDrop(taskId, from, key)
                }}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
})

function BoardColumn({
  columnKey,
  tasks,
  summaries,
  isDropTarget,
  isInvalidTarget,
  onOpen,
  onCardDragStart,
  onCardDragEnd,
  onColumnDrop,
}: {
  columnKey: ColumnKey
  tasks: BoardTask[]
  summaries: Record<string, DiffSummary>
  isDropTarget: boolean
  isInvalidTarget: boolean
  onOpen: (id: string) => void
  onCardDragStart: (taskId: string) => void
  onCardDragEnd: () => void
  onColumnDrop: (taskId: string, from: ColumnKey) => void
}) {
  const meta = COLUMN_META[columnKey]
  const { Icon } = meta
  const [over, setOver] = useState(false)

  const handleDragOver = (e: React.DragEvent) => {
    if (!isDropTarget) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    if (!over) setOver(true)
  }
  const handleDragLeave = () => setOver(false)
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setOver(false)
    if (!isDropTarget) return
    const data = e.dataTransfer.getData("application/x-board-task")
    if (!data) return
    try {
      const { taskId, from } = JSON.parse(data) as { taskId: string; from: ColumnKey }
      onColumnDrop(taskId, from)
    } catch {
      /* malformed payload — ignore */
    }
  }

  return (
    <div
      className={cn(
        "w-72 shrink-0 flex flex-col min-h-0 rounded-lg border bg-muted/30 transition-colors",
        isDropTarget && "ring-1 ring-primary/40",
        over && isDropTarget && "ring-2 ring-primary bg-primary/5",
        isInvalidTarget && "opacity-50",
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="px-3 py-2 border-b flex items-center gap-2 sticky top-0 bg-muted/50 rounded-t-lg">
        <Icon className={cn("size-3.5", meta.tone, columnKey === "running" && "animate-spin")} />
        <span className="text-xs font-medium">{meta.label}</span>
        <span className="text-[10px] text-muted-foreground ml-auto">{tasks.length}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2">
        {tasks.length === 0 ? (
          <div className="text-[11px] text-muted-foreground px-2 py-3 text-center">
            {meta.hint}
          </div>
        ) : (
          tasks.map((t) => (
            <BoardCard
              key={t.id}
              task={t}
              columnKey={columnKey}
              summary={summaries[t.id]}
              onOpen={onOpen}
              onDragStart={() => onCardDragStart(t.id)}
              onDragEnd={onCardDragEnd}
            />
          ))
        )}
      </div>
    </div>
  )
}

const BoardCard = observer(function BoardCard({
  task,
  columnKey,
  summary,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  task: BoardTask
  columnKey: ColumnKey
  summary: DiffSummary | undefined
  onOpen: (id: string) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const confirm = useConfirm()
  const cost = Number(task.loop_cost_usd ?? 0)
  const maxCost = Number(task.max_cost_usd ?? 0)
  const shortBranch = task.branch?.replace(/^ai-coder\//, "") ?? null
  const canInteract = columnKey !== "shipped" && columnKey !== "trashed"
  const canPauseResume = canInteract && task.loop_iteration > 0
  const isPaused = !task.auto_loop_enabled

  const handlePauseResume = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      if (isPaused) await workspace.resumeTask(task.id)
      else await workspace.pauseTask(task.id)
    } catch (err) {
      toast.error(isPaused ? "Resume failed" : "Pause failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleTrash = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const ok = await confirm({
      title: `Delete "${task.title}"?`,
      variant: "destructive",
      confirmText: "Delete",
    })
    if (!ok) return
    try { await workspace.remove(task.id) } catch (err) {
      toast.error("Delete failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Shipped tasks are terminal — disable drag entirely so the cursor
  // doesn't suggest the card can be moved.
  const draggable = columnKey !== "shipped"
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move"
    e.dataTransfer.setData(
      "application/x-board-task",
      JSON.stringify({ taskId: task.id, from: columnKey }),
    )
    onDragStart()
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(task.id)}
      draggable={draggable}
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "text-left rounded-md border bg-card hover:border-primary/50 hover:bg-card/80 transition-colors p-2.5 flex flex-col gap-1.5 cursor-pointer",
        draggable && "active:cursor-grabbing",
      )}
    >
      <div className="flex items-start gap-1 min-w-0">
        <div className="text-sm font-medium truncate flex-1 min-w-0">{task.title}</div>
        {columnKey === "running" && (
          <span className="size-2 mt-1.5 shrink-0 rounded-full bg-emerald-500 animate-pulse" />
        )}
      </div>

      {shortBranch && (
        <div className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground truncate">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate" title={task.branch ?? undefined}>{shortBranch}</span>
        </div>
      )}

      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="font-mono">{task.loop_iteration}/{task.max_iterations}</span>
        <span className="font-mono">${cost.toFixed(3)}{maxCost > 0 ? `/$${maxCost.toFixed(2)}` : ""}</span>
        {summary && summary.filesChanged > 0 && (
          <span
            className="font-mono inline-flex items-center gap-1.5 ml-auto"
            title={`${summary.filesChanged} file${summary.filesChanged === 1 ? "" : "s"} changed vs ${task.base_ref ?? "base"}`}
          >
            <span>{summary.filesChanged}f</span>
            <span className="text-emerald-600 dark:text-emerald-400">+{summary.additions}</span>
            <span className="text-rose-600 dark:text-rose-400">−{summary.deletions}</span>
          </span>
        )}
      </div>

      {(canPauseResume || canInteract) && (
        <div className="flex items-center gap-1 mt-1 pt-1 border-t border-border/50">
          {canPauseResume && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 gap-1 text-[11px]"
              onClick={handlePauseResume}
              title={isPaused ? "Resume loop" : "Pause loop"}
            >
              {isPaused ? <Play className="size-3" /> : <Pause className="size-3" />}
              {isPaused ? "Resume" : "Pause"}
            </Button>
          )}
          {canInteract && task.worktree_path && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 gap-1 text-[11px]"
              onClick={(e) => { e.stopPropagation(); onOpen(task.id) }}
              title="Open to ship"
            >
              <ShipIcon className="size-3" />
              Ship
            </Button>
          )}
          {canInteract && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 ml-auto text-destructive hover:text-destructive"
              onClick={handleTrash}
              title="Trash task"
            >
              <Trash2 className="size-3" />
            </Button>
          )}
        </div>
      )}
    </button>
  )
})
