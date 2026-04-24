import { useCallback, useEffect, useRef, useState } from "react"
import { observer } from "mobx-react-lite"
import { ArrowUpRight, ChevronDown, ChevronRight, GitCommit, RefreshCw, Copy, X } from "lucide-react"
import { toast } from "sonner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { workspace } from "@/models"
import { SectionMenu } from "@/components/section-menu"
import { api } from "@/lib/api"

type Commit = {
  sha: string
  shortSha: string
  authorName: string
  authorEmail: string
  committerTime: number
  subject: string
}

type LogResponse = {
  commits: Commit[]
  branch: string
}

type Props = {
  expanded: boolean
  // Omit to hide the chevron (e.g. in the promoted standalone panel, where
  // there's nothing to collapse into).
  onToggleExpanded?: () => void
  // Section-level state. Same values whether this instance is the source
  // (in the accordion) or the destination (in a promoted side panel).
  promoted?: boolean
  fullscreen?: boolean
  onPromote?: () => void
  onRestore?: () => void
  onEnterFullscreen?: () => void
  onExitFullscreen?: () => void
  // Rendering role: when ghost, this instance is the placeholder in the
  // original accordion — it just shows a stub pointing to the promoted copy.
  ghost?: boolean
}

export const GitLogSection = observer(function GitLogSection({
  expanded,
  onToggleExpanded,
  promoted = false,
  fullscreen = false,
  onPromote,
  onRestore,
  onEnterFullscreen,
  onExitFullscreen,
  ghost = false,
}: Props) {
  const active = workspace.active
  const conversationId = active?.id ?? null
  const [commits, setCommits] = useState<Commit[]>([])
  const [branch, setBranch] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchLog = useCallback(async () => {
    if (!conversationId) {
      setCommits([])
      setBranch("")
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await api(`/api/git/log?conversationId=${encodeURIComponent(conversationId)}&limit=100`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as LogResponse
      setCommits(json.commits ?? [])
      setBranch(json.branch ?? "")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  // Only hit the API when the section is actually open. Avoids a useless
  // fetch for every conversation switch when the user keeps Git Log closed.
  const lastFetchedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!expanded) return
    if (lastFetchedFor.current === conversationId) return
    lastFetchedFor.current = conversationId
    fetchLog()
  }, [expanded, conversationId, fetchLog])

  // Refresh when the agent finishes a turn — new commits may have landed.
  useEffect(() => {
    if (!expanded) return
    const onTurnDone = () => fetchLog()
    window.addEventListener("ai-coder:turn-done", onTurnDone)
    return () => window.removeEventListener("ai-coder:turn-done", onTurnDone)
  }, [expanded, fetchLog])

  // Incoming "focus this commit" request (from the file-panel blame accordion).
  // Sticky — if the list isn't loaded yet, we keep the sha and scroll once
  // the row renders.
  const listRef = useRef<HTMLDivElement>(null)
  const [highlightedSha, setHighlightedSha] = useState<string | null>(null)
  useEffect(() => {
    const onFocus = (e: Event) => {
      const sha = (e as CustomEvent<{ sha: string }>).detail?.sha
      if (sha) setHighlightedSha(sha)
    }
    window.addEventListener("ai-coder:focus-commit", onFocus)
    return () => window.removeEventListener("ai-coder:focus-commit", onFocus)
  }, [])
  useEffect(() => {
    if (!highlightedSha || !expanded) return
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-sha="${highlightedSha}"]`
    )
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" })
    const timer = setTimeout(() => setHighlightedSha(null), 2000)
    return () => clearTimeout(timer)
  }, [highlightedSha, expanded, commits])

  // Ghost mode: this section has been promoted elsewhere; show only a stub
  // in its original spot so the user can find their way back.
  if (ghost) {
    return (
      <div className="shrink-0 border-b">
        <button
          type="button"
          onClick={onRestore}
          className="flex h-10 w-full items-center gap-2 px-3 text-left opacity-60 hover:opacity-100 hover:bg-accent/40 cursor-pointer"
          aria-label="Return Git log to sidebar"
        >
          <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
          <GitCommit className="size-4 shrink-0" />
          <h2 className="text-sm font-medium">Git log</h2>
          <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
            in panel
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col min-h-0", expanded && "flex-1")}>
      <div className="shrink-0 border-b">
        <div
          className={cn(
            "flex h-10 w-full items-center gap-2 px-3",
            onToggleExpanded && "cursor-pointer hover:bg-accent/40"
          )}
          onClick={onToggleExpanded}
          role={onToggleExpanded ? "button" : undefined}
          aria-expanded={onToggleExpanded ? expanded : undefined}
        >
          {onToggleExpanded &&
            (expanded ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            ))}
          <GitCommit className="size-4 shrink-0" />
          <h2 className="text-sm font-medium">Git log</h2>
          <span className="text-xs text-muted-foreground">{commits.length || ""}</span>
          {branch && (
            <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground max-w-[40%]" title={branch}>
              {branch}
            </span>
          )}
          <span
            className={cn("flex items-center gap-0.5", !branch && "ml-auto")}
            onClick={(e) => e.stopPropagation()}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation()
                      fetchLog()
                    }}
                    disabled={loading}
                    aria-label="Refresh git log"
                  />
                }
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              </TooltipTrigger>
              <TooltipContent>Refresh git log</TooltipContent>
            </Tooltip>
            {onPromote && onRestore && onEnterFullscreen && onExitFullscreen && (
              <SectionMenu
                promoted={promoted}
                fullscreen={fullscreen}
                onPromote={onPromote}
                onRestore={onRestore}
                onEnterFullscreen={onEnterFullscreen}
                onExitFullscreen={onExitFullscreen}
              />
            )}
            {fullscreen && onExitFullscreen && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation()
                        onExitFullscreen()
                      }}
                      aria-label="Close"
                    />
                  }
                >
                  <X className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>Close (Esc)</TooltipContent>
              </Tooltip>
            )}
          </span>
        </div>
      </div>
      {expanded && (
        <ScrollArea className="flex-1 min-h-0">
          {error && (
            <div className="p-3 text-xs text-red-600 bg-red-500/10 m-3 rounded-md">
              {error}
            </div>
          )}
          {!error && commits.length === 0 && !loading && (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No commits yet.
            </div>
          )}
          <div ref={listRef} className="flex flex-col">
            {commits.map((c) => (
              <CommitRow
                key={c.sha}
                commit={c}
                highlighted={highlightedSha === c.sha}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
})

function CommitRow({
  commit,
  highlighted,
}: {
  commit: Commit
  highlighted?: boolean
}) {
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(commit.sha)
      toast.success("Copied commit SHA", { description: commit.shortSha })
    } catch {
      toast.error("Copy failed")
    }
  }

  return (
    <div
      data-sha={commit.sha}
      className={cn(
        "group/commit flex items-start gap-2 px-3 py-2 border-b border-border/40 hover:bg-accent/30 transition-colors",
        highlighted && "bg-accent/50 ring-1 ring-primary/60"
      )}
    >
      <div className="shrink-0 flex flex-col items-center pt-0.5">
        <code className="text-[10px] font-mono text-muted-foreground">{commit.shortSha}</code>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] truncate" title={commit.subject}>
          {commit.subject || <span className="text-muted-foreground">(no subject)</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="truncate" title={`${commit.authorName} <${commit.authorEmail}>`}>
            {commit.authorName}
          </span>
          <span>·</span>
          <span className="shrink-0" title={new Date(commit.committerTime).toLocaleString()}>
            {formatRelative(commit.committerTime)}
          </span>
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="size-6 p-0 opacity-0 group-hover/commit:opacity-100 focus-visible:opacity-100 transition-opacity"
              onClick={copy}
              aria-label="Copy commit SHA"
            />
          }
        >
          <Copy className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>Copy SHA</TooltipContent>
      </Tooltip>
    </div>
  )
}

function formatRelative(ms: number): string {
  if (!ms) return ""
  const diff = Date.now() - ms
  const s = Math.round(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo ago`
  const y = Math.round(mo / 12)
  return `${y}y ago`
}
