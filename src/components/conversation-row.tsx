import { Gauge, GitBranch, MessageSquare, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"

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

export function ConversationRow({
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
