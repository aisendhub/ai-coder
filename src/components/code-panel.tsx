import { useCallback, useEffect, useRef, useState } from "react"
import { observer } from "mobx-react-lite"
import { ChevronDown, ChevronRight, FileCode, RefreshCw, FileX, FilePlus, Pencil, GitCommitVertical, ArrowUpFromLine } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { workspace } from "@/models"

type ChangedFile = {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "untracked"
  oldPath?: string
  diff: string
}

type ChangesResponse = {
  workspace: string
  files: ChangedFile[]
  unpushedCount: number
}

async function dispatchPrompt(prompt: string) {
  let target = workspace.active
  if (!target) {
    try {
      target = await workspace.createNew()
    } catch (err) {
      console.error("dispatchPrompt: createNew failed", err)
      return
    }
  }
  void target.send(prompt)
}

export const CodePanel = observer(function CodePanel({ collapsed = false }: { collapsed?: boolean } = {}) {
  const conversationId = workspace.active?.id ?? null
  const [data, setData] = useState<ChangesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({})

  const fetchChanges = useCallback(async () => {
    if (!conversationId) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/changes?conversationId=${encodeURIComponent(conversationId)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as ChangesResponse
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  // Auto-retry on error with exponential backoff (2s, 4s, 8s, …, max 30s)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const backoffRef = useRef(2000)
  useEffect(() => {
    if (retryRef.current) clearTimeout(retryRef.current)
    if (error) {
      retryRef.current = setTimeout(() => {
        fetchChanges()
        backoffRef.current = Math.min(backoffRef.current * 2, 30_000)
      }, backoffRef.current)
    } else {
      backoffRef.current = 2000 // reset on success
    }
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current)
    }
  }, [error, fetchChanges])

  // Live updates: subscribe to /api/changes/stream (SSE).
  // Server pings on every file change in WORKSPACE_DIR; we refetch debounced.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debouncedRefetch = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current)
    refetchTimer.current = setTimeout(() => fetchChanges(), 150)
  }, [fetchChanges])

  useEffect(() => {
    fetchChanges()

    if (!conversationId) return

    let es: EventSource | null = null
    let esRetry: ReturnType<typeof setTimeout> | null = null

    function connectSSE() {
      es = new EventSource(`/api/changes/stream?conversationId=${encodeURIComponent(conversationId)}`)
      es.addEventListener("ready", debouncedRefetch)
      es.addEventListener("changed", debouncedRefetch)
      es.onerror = () => {
        // If the EventSource gave up (CLOSED), reconnect after a delay
        if (es?.readyState === EventSource.CLOSED) {
          esRetry = setTimeout(connectSSE, 5000)
        }
      }
    }
    connectSSE()

    const onTurnDone = () => fetchChanges()
    window.addEventListener("ai-coder:turn-done", onTurnDone)
    return () => {
      es?.close()
      if (esRetry) clearTimeout(esRetry)
      window.removeEventListener("ai-coder:turn-done", onTurnDone)
      if (refetchTimer.current) clearTimeout(refetchTimer.current)
    }
  }, [fetchChanges, debouncedRefetch, conversationId])

  const files = data?.files ?? []

  if (collapsed) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center py-2 gap-1">
        <FileCode className="size-4 text-muted-foreground" />
        <div className="text-[10px] tabular-nums text-muted-foreground">
          {files.length}
        </div>
        <div className="my-1 h-px w-6 bg-border" />
        {files.slice(0, 12).map((f) => (
          <div
            key={f.path}
            title={`${f.status}: ${f.path}`}
            className="size-7 rounded-md hover:bg-accent flex items-center justify-center"
          >
            <StatusIcon status={f.status} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="flex h-14 shrink-0 items-center justify-between px-3 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode className="size-4 shrink-0" />
          <h2 className="text-sm font-medium">Changes</h2>
          <span className="text-xs text-muted-foreground">{files.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="sm"
                variant="outline"
                onClick={() => dispatchPrompt("Commit all current changes with a descriptive commit message.")}
                disabled={files.length === 0}
              >
                <GitCommitVertical className="size-3.5" />
                Commit
              </Button>
            </TooltipTrigger>
            <TooltipContent>Commit all current changes</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="sm"
                variant="outline"
                onClick={() => dispatchPrompt(files.length > 0
                  ? "Commit the latest changes with a concise message and then push."
                  : "Push the latest commits to the remote repository.")}
                disabled={(data?.unpushedCount ?? 0) === 0 && files.length === 0}
              >
                <ArrowUpFromLine className="size-3.5" />
                Push
              </Button>
            </TooltipTrigger>
            <TooltipContent>Push to remote</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="sm"
                variant="ghost"
                onClick={fetchChanges}
                disabled={loading}
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh changes</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {error && (
          <div className="p-3 text-xs text-red-600 bg-red-500/10 m-3 rounded-md flex items-center justify-between gap-2">
            <span>{error}</span>
            <span className="text-red-400 shrink-0">Retrying…</span>
          </div>
        )}
        {files.length === 0 && !loading && !error && (
          <div className="p-6 text-center text-xs text-muted-foreground">
            No uncommitted changes.
          </div>
        )}
        <div className="flex flex-col gap-2 p-2">
          {files.map((f) => (
            <FileCard
              key={f.path}
              file={f}
              collapsed={openCards[f.path] ?? false}
              onToggle={() =>
                setOpenCards((c) => ({ ...c, [f.path]: !c[f.path] }))
              }
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
})

function FileCard({
  file,
  collapsed,
  onToggle,
}: {
  file: ChangedFile
  collapsed: boolean
  onToggle: () => void
}) {
  const name = file.path.split("/").pop() ?? file.path
  const dir = file.path.slice(0, file.path.length - name.length).replace(/\/$/, "")

  return (
    <div className="rounded-md border border-border/50 bg-card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left cursor-pointer hover:bg-accent/40"
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <StatusIcon status={file.status} />
        <div className="flex-1 min-w-0">
          <div className="truncate font-mono text-[13px]">{name}</div>
          {dir && (
            <div className="truncate text-[11px] text-muted-foreground font-mono">
              {dir}
            </div>
          )}
        </div>
        <StatusBadge status={file.status} />
      </button>
      {!collapsed && (
        <div className="border-t border-border/50 text-[12px]">
          <Diff file={file} />
        </div>
      )}
    </div>
  )
}

function Diff({ file }: { file: ChangedFile }) {
  const hunks = extractHunks(file.diff)
  if (hunks.length === 0) {
    return (
      <div className="p-3">
        {file.diff ? (
          <pre className="whitespace-pre-wrap font-mono text-[12px] leading-snug">
            {file.diff}
          </pre>
        ) : (
          <span className="text-xs text-muted-foreground">No diff.</span>
        )}
      </div>
    )
  }
  // Simple, reliable renderer — colors added/removed lines; no external CSS.
  return <SimpleDiff hunks={hunks} />
}

function SimpleDiff({ hunks }: { hunks: string[] }) {
  return (
    <div className="font-mono text-[12px] leading-snug">
      {hunks.map((hunk, i) => (
        <div key={i} className="border-b border-border/40 last:border-b-0">
          {hunk.split("\n").map((line, j) => {
            const first = line[0]
            const cls =
              line.startsWith("@@")
                ? "bg-muted text-muted-foreground"
                : first === "+"
                  ? "bg-green-500/10 text-green-800 dark:text-green-300"
                  : first === "-"
                    ? "bg-red-500/10 text-red-800 dark:text-red-300"
                    : ""
            return (
              <div
                key={j}
                className={cn("px-3 whitespace-pre overflow-x-auto", cls)}
              >
                {line || "\u00A0"}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function extractHunks(rawDiff: string): string[] {
  if (!rawDiff) return []
  // Split at every @@ line so each hunk is its own string
  const idx = rawDiff.indexOf("\n@@")
  const first = rawDiff.indexOf("@@")
  if (first === -1) return []
  const body = idx === -1 ? rawDiff.slice(first) : rawDiff.slice(first)
  const parts = body.split(/\n(?=@@)/g).map((p) => p.trim()).filter(Boolean)
  return parts
}

function StatusIcon({ status }: { status: ChangedFile["status"] }) {
  if (status === "added" || status === "untracked")
    return <FilePlus className="size-3.5 shrink-0 text-green-600" />
  if (status === "deleted")
    return <FileX className="size-3.5 shrink-0 text-red-600" />
  return <Pencil className="size-3.5 shrink-0 text-amber-600" />
}

function StatusBadge({ status }: { status: ChangedFile["status"] }) {
  const label =
    status === "untracked" ? "new" : status === "renamed" ? "renamed" : status
  const color =
    status === "added" || status === "untracked"
      ? "text-green-700 bg-green-500/10"
      : status === "deleted"
        ? "text-red-700 bg-red-500/10"
        : status === "renamed"
          ? "text-blue-700 bg-blue-500/10"
          : "text-amber-700 bg-amber-500/10"
  return (
    <span className={cn("text-[10px] rounded px-1.5 py-0.5 uppercase tracking-wide", color)}>
      {label}
    </span>
  )
}
