import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { observer } from "mobx-react-lite"
import { ChevronDown, ChevronRight, FileCode, RefreshCw, FileX, FilePlus, Pencil, GitCommitVertical, ArrowUpFromLine, ChevronsDownUp, ChevronsUpDown, Search, FileText, GitMerge, X } from "lucide-react"
import { toast } from "sonner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useConfirm } from "@/lib/confirm"
import { highlightCode, languageForPath } from "@/lib/highlight"
import { workspace } from "@/models"
import { GitLogSection } from "@/components/git-log-panel"
import { usePersistentState } from "@/hooks/use-persistent-state"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { api, sseUrl } from "@/lib/api"

// CodePanel is the right-side panel wrapper. It hosts two sections stacked
// vertically — Changes on top, Git log on bottom — with a drag-resizable
// split between them (same pattern as the services panel's list/logs).
// Each section's header is also accordion-collapsible; when one section is
// collapsed the other takes the remaining space and the resize handle goes
// away (there's nothing to size against). Open-states persist across reloads.
type CodePanelProps = {
  collapsed?: boolean
  onClose?: () => void
  // Section promotion/fullscreen state, owned by App.tsx so the promoted
  // copy and the ghosted stub stay in sync.
  gitLogPromoted?: boolean
  gitLogFullscreen?: boolean
  onPromoteGitLog?: () => void
  onRestoreGitLog?: () => void
  onEnterGitLogFullscreen?: () => void
  onExitGitLogFullscreen?: () => void
}

export const CodePanel = observer(function CodePanel({
  collapsed = false,
  onClose,
  gitLogPromoted = false,
  gitLogFullscreen = false,
  onPromoteGitLog,
  onRestoreGitLog,
  onEnterGitLogFullscreen,
  onExitGitLogFullscreen,
}: CodePanelProps = {}) {
  const [changesOpen, setChangesOpen] = usePersistentState(
    "ai-coder:panels:changesOpen",
    true
  )
  const [gitLogOpen, setGitLogOpen] = usePersistentState(
    "ai-coder:panels:gitLogOpen",
    false
  )
  const toggleChanges = () => setChangesOpen((v) => !v)
  const toggleGitLog = () => setGitLogOpen((v) => !v)

  // External "focus this commit" request (from the blame accordion) implies
  // the git log section should be open. App.tsx handles opening the outer
  // right panel; we handle expanding this section.
  useEffect(() => {
    const onOpen = () => setGitLogOpen(true)
    window.addEventListener("ai-coder:open-git-log", onOpen)
    return () => window.removeEventListener("ai-coder:open-git-log", onOpen)
  }, [setGitLogOpen])

  if (collapsed) {
    // Narrow rail — accordions don't make sense. Show just the Changes rail.
    return <ChangesSection collapsed onClose={onClose} />
  }

  const gitLogMenuProps = {
    promoted: gitLogPromoted,
    fullscreen: gitLogFullscreen,
    onPromote: onPromoteGitLog,
    onRestore: onRestoreGitLog,
    onEnterFullscreen: onEnterGitLogFullscreen,
    onExitFullscreen: onExitGitLogFullscreen,
  }

  // Git log promoted → render ghost stub instead of the resizable split.
  // Changes takes the remaining height; the stub is a single clickable row
  // that restores Git log to this spot.
  if (gitLogPromoted) {
    return (
      <div className="flex h-full flex-col min-h-0">
        <ChangesSection
          expanded={changesOpen}
          onToggleExpanded={toggleChanges}
          onClose={onClose}
        />
        <GitLogSection
          ghost
          expanded={false}
          onToggleExpanded={toggleGitLog}
          {...gitLogMenuProps}
        />
      </div>
    )
  }

  if (changesOpen && gitLogOpen) {
    return (
      <ResizablePanelGroup direction="vertical" autoSaveId="ai-coder-code-split">
        <ResizablePanel id="changes" order={1} defaultSize={65} minSize={15}>
          <div className="h-full min-h-0 flex flex-col">
            <ChangesSection
              expanded
              onToggleExpanded={toggleChanges}
              onClose={onClose}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="gitlog" order={2} defaultSize={35} minSize={15}>
          <div className="h-full min-h-0 flex flex-col">
            <GitLogSection
              expanded
              onToggleExpanded={toggleGitLog}
              {...gitLogMenuProps}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    )
  }

  // One or zero sections expanded: simple flex column, no handle needed.
  return (
    <div className="flex h-full flex-col min-h-0">
      <ChangesSection
        expanded={changesOpen}
        onToggleExpanded={toggleChanges}
        onClose={onClose}
      />
      <GitLogSection
        expanded={gitLogOpen}
        onToggleExpanded={toggleGitLog}
        {...gitLogMenuProps}
      />
    </div>
  )
})

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
  branch: string
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

const ChangesSection = observer(function ChangesSection({
  collapsed = false,
  onClose,
  expanded = true,
  onToggleExpanded,
}: {
  collapsed?: boolean
  onClose?: () => void
  expanded?: boolean
  onToggleExpanded?: () => void
} = {}) {
  const active = workspace.active
  const conversationId = active?.id ?? null
  // Merge action only makes sense on tasks with their own worktree branch.
  // Plain chats — even ones that happen to carry a legacy `worktree_path` —
  // get the standard Commit/Push prompts instead.
  const showMergeAction = active?.kind === "task" && !!active?.worktreePath
  const mergePending = !!active?.mergeRequestedAt && !active?.shippedAt
  const [data, setData] = useState<ChangesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState("")
  const [merging, setMerging] = useState(false)
  const confirm = useConfirm()

  const handleMerge = useCallback(async () => {
    if (!conversationId) return
    const label = active?.title || "this task"
    const base = active?.baseRef ?? "base"
    const ok = await confirm({
      title: `Merge ${label} into ${base}?`,
      description: "The agent will run the merge in the chat — you'll see each step.",
      confirmText: "Merge",
    })
    if (!ok) return
    setMerging(true)
    try {
      await workspace.mergeConversation(conversationId)
      toast.info("Merging…", {
        description: "I've asked the agent to merge. Watch the chat for progress and any conflicts.",
        duration: 6000,
      })
    } catch (err) {
      toast.error("Couldn't start merge", {
        description: err instanceof Error ? err.message : String(err),
        duration: 8000,
      })
    } finally {
      setMerging(false)
    }
  }, [conversationId, active, confirm])

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
      const res = await api(`/api/changes?conversationId=${encodeURIComponent(conversationId)}`)
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
    const convId = conversationId

    let es: EventSource | null = null
    let esRetry: ReturnType<typeof setTimeout> | null = null

    async function connectSSE() {
      const url = await sseUrl(`/api/changes/stream?conversationId=${encodeURIComponent(convId)}`)
      es = new EventSource(url)
      es.addEventListener("ready", debouncedRefetch)
      es.addEventListener("changed", debouncedRefetch)
      es.onerror = () => {
        // If the EventSource gave up (CLOSED), reconnect after a delay
        if (es?.readyState === EventSource.CLOSED) {
          esRetry = setTimeout(() => void connectSSE(), 5000)
        }
      }
    }
    void connectSSE()

    const onTurnDone = () => fetchChanges()
    window.addEventListener("ai-coder:turn-done", onTurnDone)
    return () => {
      es?.close()
      if (esRetry) clearTimeout(esRetry)
      window.removeEventListener("ai-coder:turn-done", onTurnDone)
      if (refetchTimer.current) clearTimeout(refetchTimer.current)
    }
    // shippedAt/worktreePath flip when a merge completes (realtime update):
    // including them re-runs this effect, which re-resolves cwd server-side
    // and refetches the diff. Without this, the panel keeps showing the
    // pre-merge worktree diff until the user refreshes.
  }, [fetchChanges, debouncedRefetch, conversationId, active?.shippedAt, active?.worktreePath])

  const files = data?.files ?? []

  const filteredFiles = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return files
    return files.filter(
      (f) =>
        f.path.toLowerCase().includes(q) ||
        f.diff.toLowerCase().includes(q)
    )
  }, [files, search])

  const collapseAll = useCallback(() => {
    const next: Record<string, boolean> = {}
    for (const f of filteredFiles) next[f.path] = false
    setOpenCards((prev) => ({ ...prev, ...next }))
  }, [filteredFiles])

  const expandAll = useCallback(() => {
    const next: Record<string, boolean> = {}
    for (const f of filteredFiles) next[f.path] = true
    setOpenCards((prev) => ({ ...prev, ...next }))
  }, [filteredFiles])

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

  const accordion = !!onToggleExpanded
  return (
    <div className={cn("@container flex flex-col min-h-0", expanded ? "flex-1" : "shrink-0")}>
      <div className="shrink-0 border-b">
        <div
          className={cn(
            "flex h-14 items-center justify-between px-3 gap-2",
            accordion && "cursor-pointer hover:bg-accent/40"
          )}
          onClick={accordion ? onToggleExpanded : undefined}
          role={accordion ? "button" : undefined}
          aria-expanded={accordion ? expanded : undefined}
        >
          <div className="flex items-center gap-2 min-w-0">
            {accordion &&
              (expanded ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              ))}
            <FileCode className="size-4 shrink-0" />
            <h2 className="text-sm font-medium @max-[280px]:hidden">Changes</h2>
            <span className="text-xs text-muted-foreground">{files.length}</span>
          </div>
          <div
            className="flex items-center gap-1 shrink-0"
            onClick={accordion ? (e) => e.stopPropagation() : undefined}
          >
            {showMergeAction ? (
              // Task with a worktree → Merge button. The server injects a
              // scripted prompt; the agent runs the merge in the chat. Commit
              // and Push buttons are hidden because the merge flow handles
              // both stages.
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="sm"
                      variant="default"
                      onClick={handleMerge}
                      disabled={merging || mergePending}
                      aria-label={mergePending ? "Merging" : "Merge"}
                      className="@max-[360px]:px-1.5"
                    />
                  }
                >
                  <GitMerge className={cn("size-3.5", (merging || mergePending) && "animate-pulse")} />
                  <span className="@max-[360px]:hidden">{mergePending ? "Merging…" : "Merge"}</span>
                </TooltipTrigger>
                <TooltipContent>
                  {mergePending
                    ? "Agent is merging — watch the chat"
                    : `Ask the agent to merge into ${active?.baseRef ?? "base"}`}
                </TooltipContent>
              </Tooltip>
            ) : (
              // Shared-cwd conversation → plain Commit + Push prompts to the
              // agent. No ship flow because there's no task branch to merge.
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => dispatchPrompt("Commit all current changes with a descriptive commit message.")}
                        disabled={files.length === 0}
                        aria-label="Commit"
                        className="@max-[360px]:px-1.5"
                      />
                    }
                  >
                    <GitCommitVertical className="size-3.5" />
                    <span className="@max-[360px]:hidden">Commit</span>
                  </TooltipTrigger>
                  <TooltipContent>Commit all current changes</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => dispatchPrompt(files.length > 0
                          ? "Commit the latest changes with a concise message and then push."
                          : "Push the latest commits to the remote repository.")}
                        disabled={(data?.unpushedCount ?? 0) === 0 && files.length === 0}
                        aria-label="Push"
                        className="@max-[360px]:px-1.5"
                      />
                    }
                  >
                    <ArrowUpFromLine className="size-3.5" />
                    <span className="@max-[360px]:hidden">Push</span>
                  </TooltipTrigger>
                  <TooltipContent>Push to remote</TooltipContent>
                </Tooltip>
              </>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={fetchChanges}
                    disabled={loading}
                  />
                }
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              </TooltipTrigger>
              <TooltipContent>Refresh changes</TooltipContent>
            </Tooltip>
            {onClose && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close changes" />
                  }
                >
                  <X className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>Close</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        {expanded && (
          <div className="flex items-center gap-1 px-3 pb-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Filter files…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button size="sm" variant="ghost" onClick={expandAll} disabled={filteredFiles.length === 0} />
                }
              >
                <ChevronsUpDown className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Expand all</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button size="sm" variant="ghost" onClick={collapseAll} disabled={filteredFiles.length === 0} />
                }
              >
                <ChevronsDownUp className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Collapse all</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
      {expanded && (
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
        {files.length > 0 && filteredFiles.length === 0 && search && (
          <div className="p-6 text-center text-xs text-muted-foreground">
            No files matching &ldquo;{search}&rdquo;
          </div>
        )}
        <div className="flex flex-col gap-2 p-2">
          {filteredFiles.map((f) => (
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
      )}
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

  const canOpen = file.status !== "deleted"

  return (
    <div className="group/file-card rounded-md border border-border/50 bg-card overflow-hidden">
      <div className="w-full flex items-center gap-1 px-2 py-1.5 hover:bg-accent/40">
        <button
          type="button"
          onClick={onToggle}
          className="flex-1 min-w-0 flex items-center gap-2 text-left cursor-pointer"
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
        {canOpen && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  className="size-6 p-0 opacity-0 group-hover/file-card:opacity-100 focus-visible:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation()
                    workspace.openFile(file.path)
                  }}
                  aria-label="Open full file"
                />
              }
            >
              <FileText className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Open full file</TooltipContent>
          </Tooltip>
        )}
      </div>
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
    if (!file.diff) {
      return <div className="p-3"><span className="text-xs text-muted-foreground">No diff.</span></div>
    }
    return <NewFileBody path={file.path} content={file.diff} />
  }
  // Simple, reliable renderer — colors added/removed lines; no external CSS.
  return <SimpleDiff hunks={hunks} />
}

function NewFileBody({ path, content }: { path: string; content: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    setDone(false)
    void (async () => {
      const lang = languageForPath(path)
      if (!lang) {
        if (!cancelled) setDone(true)
        return
      }
      try {
        const out = await highlightCode(content, lang)
        if (cancelled) return
        setHtml(out)
      } finally {
        if (!cancelled) setDone(true)
      }
    })()
    return () => { cancelled = true }
  }, [path, content])

  if (html) {
    return (
      <div
        className="[&_pre]:bg-transparent! [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:scrollbar-thin [&_pre]:font-mono [&_pre]:text-[12px] [&_pre]:leading-snug"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  // Plain pre while highlighting (or when language is unsupported)
  return (
    <div className="p-3">
      <pre className={cn(
        "whitespace-pre-wrap font-mono text-[12px] leading-snug",
        !done && "text-muted-foreground"
      )}>
        {content}
      </pre>
    </div>
  )
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
                className={cn("px-3 whitespace-pre overflow-x-auto scrollbar-thin", cls)}
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
