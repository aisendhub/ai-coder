import { useEffect, useMemo, useState } from "react"
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
import { supabase } from "@/lib/supabase"
import { workspace } from "@/models"

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

type Props = {
  open: boolean
  onClose: () => void
}

export const Board = observer(function Board({ open, onClose }: Props) {
  const projectId = workspace.activeProjectId
  const [tasks, setTasks] = useState<BoardTask[]>([])
  const [loading, setLoading] = useState(false)
  const runningIds = workspace.runningServerIds

  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

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
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close board">
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-x-auto">
        <div className="flex gap-3 p-4 min-h-full">
          {COLUMN_ORDER.map((key) => (
            <BoardColumn
              key={key}
              columnKey={key}
              tasks={grouped[key]}
              onOpen={(id) => {
                workspace.setActive(id)
                onClose()
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
})

function BoardColumn({
  columnKey,
  tasks,
  onOpen,
}: {
  columnKey: ColumnKey
  tasks: BoardTask[]
  onOpen: (id: string) => void
}) {
  const meta = COLUMN_META[columnKey]
  const { Icon } = meta
  return (
    <div className="w-72 shrink-0 flex flex-col min-h-0 rounded-lg border bg-muted/30">
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
            <BoardCard key={t.id} task={t} columnKey={columnKey} onOpen={onOpen} />
          ))
        )}
      </div>
    </div>
  )
}

const BoardCard = observer(function BoardCard({
  task,
  columnKey,
  onOpen,
}: {
  task: BoardTask
  columnKey: ColumnKey
  onOpen: (id: string) => void
}) {
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
    if (!confirm(`Delete "${task.title}"?`)) return
    try { await workspace.remove(task.id) } catch (err) {
      toast.error("Delete failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(task.id)}
      className="text-left rounded-md border bg-card hover:border-primary/50 hover:bg-card/80 transition-colors p-2.5 flex flex-col gap-1.5 cursor-pointer"
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
