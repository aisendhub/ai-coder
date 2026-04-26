import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { observer } from "mobx-react-lite"
import { ArrowUpRight, ChevronDown, ChevronRight, File, Folder, FolderOpen, GitCommit, RefreshCw, Copy, X } from "lucide-react"
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

type CommitFile = {
  path: string
  oldPath?: string
  status: "A" | "M" | "D" | "R" | "C" | "T"
  insertions: number
  deletions: number
  isBinary: boolean
}

type CommitDetail = {
  sha: string
  shortSha: string
  files: CommitFile[]
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
  // One row expanded at a time. The expanded row fetches /api/git/commit and
  // renders the file list inline (see docs/GIT-LOG.md). Detail is cached per
  // sha for the lifetime of this section instance — refresh blows it away.
  const [expandedSha, setExpandedSha] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, CommitDetail>>({})
  const [detailLoading, setDetailLoading] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<{ sha: string; message: string } | null>(null)
  const toggleExpanded = useCallback(
    (sha: string) => {
      setExpandedSha((prev) => (prev === sha ? null : sha))
    },
    []
  )
  // Fetch detail for the currently expanded sha if we don't have it yet.
  useEffect(() => {
    if (!expandedSha || !conversationId) return
    if (details[expandedSha]) return
    const sha = expandedSha
    let cancelled = false
    setDetailLoading(sha)
    setDetailError(null)
    ;(async () => {
      try {
        const res = await api(
          `/api/git/commit?conversationId=${encodeURIComponent(conversationId)}&sha=${encodeURIComponent(sha)}`
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as CommitDetail
        if (cancelled) return
        setDetails((prev) => ({ ...prev, [sha]: json }))
      } catch (err) {
        if (cancelled) return
        setDetailError({ sha, message: err instanceof Error ? err.message : String(err) })
      } finally {
        if (!cancelled) setDetailLoading((cur) => (cur === sha ? null : cur))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [expandedSha, conversationId, details])
  // Drop the cache (and the current expansion) on refresh — stale data after
  // a new commit lands is worse than re-fetching.
  useEffect(() => {
    setDetails({})
    setExpandedSha(null)
    setDetailError(null)
    setDetailLoading(null)
  }, [conversationId])
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
                expanded={expandedSha === c.sha}
                onToggle={() => toggleExpanded(c.sha)}
                detail={details[c.sha] ?? null}
                detailLoading={detailLoading === c.sha}
                detailError={detailError && detailError.sha === c.sha ? detailError.message : null}
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
  expanded,
  onToggle,
  detail,
  detailLoading,
  detailError,
}: {
  commit: Commit
  highlighted?: boolean
  expanded: boolean
  onToggle: () => void
  detail: CommitDetail | null
  detailLoading: boolean
  detailError: string | null
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
        "border-b border-border/40 transition-colors",
        highlighted && "bg-accent/50 ring-1 ring-primary/60",
        expanded && "bg-accent/20"
      )}
    >
      <div
        className={cn(
          "group/commit flex items-start gap-2 px-3 py-2 hover:bg-accent/30 cursor-pointer select-none"
        )}
        onClick={onToggle}
        role="button"
        aria-expanded={expanded}
        aria-controls={`commit-detail-${commit.sha}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        <div className="shrink-0 flex flex-col items-center pt-0.5">
          {expanded ? (
            <ChevronDown className="size-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 text-muted-foreground" />
          )}
        </div>
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
      {expanded && (
        <CommitFiles
          id={`commit-detail-${commit.sha}`}
          commit={commit}
          detail={detail}
          loading={detailLoading}
          error={detailError}
        />
      )}
    </div>
  )
}

type FileNode = { type: "file"; file: CommitFile }
type DirNode = { type: "dir"; name: string; path: string; children: TreeNode[] }
type TreeNode = FileNode | DirNode

// Build a folder/file tree from a flat path list. Single-child dir chains
// collapse into one segmented row (e.g. "src/components" instead of two
// rows) so deep paths don't waste vertical space on filler folders.
function buildFileTree(files: CommitFile[]): TreeNode[] {
  const root: DirNode = { type: "dir", name: "", path: "", children: [] }
  for (const file of files) {
    const parts = file.path.split("/")
    let curr = root
    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i]
      const dirPath = parts.slice(0, i + 1).join("/")
      let child = curr.children.find(
        (n): n is DirNode => n.type === "dir" && n.path === dirPath
      )
      if (!child) {
        child = { type: "dir", name: dirName, path: dirPath, children: [] }
        curr.children.push(child)
      }
      curr = child
    }
    curr.children.push({ type: "file", file })
  }
  const sortChildren = (children: TreeNode[]): TreeNode[] =>
    [...children].sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1
      const an = a.type === "dir" ? a.name : a.file.path
      const bn = b.type === "dir" ? b.name : b.file.path
      return an.localeCompare(bn)
    })
  const compact = (node: DirNode): DirNode => {
    const children = sortChildren(
      node.children.map((c) => (c.type === "dir" ? compact(c) : c))
    )
    if (children.length === 1 && children[0].type === "dir") {
      const only = children[0]
      return {
        type: "dir",
        name: node.name ? `${node.name}/${only.name}` : only.name,
        path: only.path,
        children: only.children,
      }
    }
    return { ...node, children }
  }
  return sortChildren(
    root.children.map((c) => (c.type === "dir" ? compact(c) : c))
  )
}

function countFiles(node: DirNode): number {
  let n = 0
  for (const c of node.children) {
    if (c.type === "file") n++
    else n += countFiles(c)
  }
  return n
}

function flattenVisible(
  nodes: TreeNode[],
  depth: number,
  isCollapsed: (p: string) => boolean
): { node: TreeNode; depth: number }[] {
  const out: { node: TreeNode; depth: number }[] = []
  for (const n of nodes) {
    out.push({ node: n, depth })
    if (n.type === "dir" && !isCollapsed(n.path)) {
      out.push(...flattenVisible(n.children, depth + 1, isCollapsed))
    }
  }
  return out
}

function CommitFiles({
  id,
  commit,
  detail,
  loading,
  error,
}: {
  id: string
  commit: Commit
  detail: CommitDetail | null
  loading: boolean
  error: string | null
}) {
  const openFile = useCallback(
    (file: CommitFile) => {
      // Deleted at this commit: opening at this sha shows empty content.
      // Future: pin to sha^ for D so users see what was lost. For now the
      // diff view still surfaces the deletion.
      workspace.openFileAtCommit(file.path, commit.sha, commit.shortSha)
    },
    [commit.sha, commit.shortSha]
  )
  // Default to all folders expanded; track only what the user collapses.
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set())
  const toggleDir = useCallback((path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])
  const tree = useMemo(
    () => (detail ? buildFileTree(detail.files) : []),
    [detail]
  )
  const visible = useMemo(
    () => flattenVisible(tree, 0, (p) => collapsedDirs.has(p)),
    [tree, collapsedDirs]
  )
  return (
    <div id={id} className="pl-9 pr-2 pb-2">
      {loading && !detail && (
        <div className="px-2 py-3 text-xs text-muted-foreground">Loading files…</div>
      )}
      {error && (
        <div className="px-2 py-2 text-xs text-red-600 bg-red-500/10 rounded-md my-1">
          {error}
        </div>
      )}
      {detail && detail.files.length === 0 && (
        <div className="px-2 py-3 text-xs text-muted-foreground">No file changes.</div>
      )}
      {detail && detail.files.length > 0 && (
        <div className="rounded-md border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
          {visible.map(({ node, depth }) =>
            node.type === "file" ? (
              <FileRow
                key={`f:${node.file.path}`}
                file={node.file}
                depth={depth}
                onOpen={openFile}
              />
            ) : (
              <DirRow
                key={`d:${node.path}`}
                node={node}
                depth={depth}
                open={!collapsedDirs.has(node.path)}
                onToggle={toggleDir}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}

function DirRow({
  node,
  depth,
  open,
  onToggle,
}: {
  node: DirNode
  depth: number
  open: boolean
  onToggle: (path: string) => void
}) {
  const count = countFiles(node)
  return (
    <button
      type="button"
      onClick={() => onToggle(node.path)}
      aria-expanded={open}
      className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-[12px] hover:bg-accent/40 border-b border-border/30 last:border-b-0 cursor-pointer"
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      title={node.path}
    >
      {open ? (
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
      )}
      {open ? (
        <FolderOpen className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
      ) : (
        <Folder className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
      )}
      <span className="flex-1 min-w-0 font-mono text-[11px] truncate">
        {node.name}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
        {count}
      </span>
    </button>
  )
}

function FileRow({
  file,
  depth,
  onOpen,
}: {
  file: CommitFile
  depth: number
  onOpen: (file: CommitFile) => void
}) {
  const name = file.path.split("/").pop() ?? file.path
  return (
    <button
      type="button"
      onClick={() => onOpen(file)}
      className="group/file w-full flex items-center gap-2 px-2 py-1.5 text-left text-[12px] hover:bg-accent/40 border-b border-border/30 last:border-b-0 cursor-pointer"
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
    >
      <span className="inline-block size-3 shrink-0" />
      <File className="size-3.5 shrink-0 text-muted-foreground" />
      <StatusBadge status={file.status} />
      <span className="flex-1 min-w-0 font-mono text-[11px] truncate">
        {name}
      </span>
      {file.isBinary ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">binary</span>
      ) : (
        <span className="shrink-0 text-[10px] font-mono tabular-nums">
          <span className="text-emerald-600">+{file.insertions}</span>
          <span className="text-muted-foreground"> / </span>
          <span className="text-rose-600">−{file.deletions}</span>
        </span>
      )}
    </button>
  )
}

function StatusBadge({ status }: { status: CommitFile["status"] }) {
  const map: Record<CommitFile["status"], { label: string; className: string; title: string }> = {
    A: { label: "A", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", title: "added" },
    M: { label: "M", className: "bg-amber-500/15 text-amber-700 dark:text-amber-300", title: "modified" },
    D: { label: "D", className: "bg-rose-500/15 text-rose-700 dark:text-rose-300", title: "deleted" },
    R: { label: "R", className: "bg-sky-500/15 text-sky-700 dark:text-sky-300", title: "renamed" },
    C: { label: "C", className: "bg-violet-500/15 text-violet-700 dark:text-violet-300", title: "copied" },
    T: { label: "T", className: "bg-muted text-muted-foreground", title: "type changed" },
  }
  const m = map[status] ?? map.M
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center size-5 shrink-0 rounded text-[10px] font-mono font-medium",
        m.className
      )}
      title={m.title}
    >
      {m.label}
    </span>
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
