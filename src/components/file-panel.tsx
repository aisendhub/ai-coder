import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { observer } from "mobx-react-lite"
import { X, FileText, RefreshCw, Code, Eye, Download, GitCommit, MessageSquare, ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable"
import { cn } from "@/lib/utils"
import { highlightCode, languageForPath } from "@/lib/highlight"
import { workspace } from "@/models"
import { Markdown } from "@/components/markdown"
import { AnnotationAccordion } from "@/components/annotation-accordion"
import { AnnotationChip, authorInitials, compactAge, shaToColor } from "@/components/annotation-chip"
import { api, sseUrl } from "@/lib/api"

type BlameLine = {
  line: number
  sha: string
  shortSha: string
  author: string
  authorMail: string
  committerTime: number
  summary: string
  isUncommitted: boolean
}
type BlameResult = { cwd: string; path: string; lines: BlameLine[] }

type FileComment = {
  id: string
  project_id: string
  file_path: string
  body: string
  status: "open" | "resolved" | "outdated"
  anchor_start_line: number
  anchor_block_length: number
  anchor_preview: string
  resolved_line: number | null
  resolved_at: string | null
  resolved_confidence: "exact" | "shifted" | "outdated" | null
  conversation_id: string | null
  message_id: string | null
  created_by: string
  created_at: string
  updated_at: string
}

/** Files we auto-preview on open. Tiny allow-list — other formats show
 *  syntax-highlighted source as before. */
function isMarkdownPath(path: string | null): boolean {
  if (!path) return false
  const lower = path.toLowerCase()
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdx")
}

type LineStatus = "added" | "modified" | "context"

type FileResponse = {
  path: string
  content: string
  truncated: boolean
  sizeBytes: number
}

/** Top-bar icon button that toggles the blame rail in the file panel. Only
 *  meaningful when a file is open — caller decides whether to render it. */
export function BlameTrigger({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(!open)}
            aria-label={open ? "Hide blame" : "Show blame"}
            aria-pressed={open}
            className={cn(open && "bg-accent text-accent-foreground")}
          />
        }
      >
        <GitCommit className="size-5" />
      </TooltipTrigger>
      <TooltipContent>{open ? "Hide blame" : "Show blame"}</TooltipContent>
    </Tooltip>
  )
}

/** Top-bar icon button that toggles the comment rail + pins in the file panel. */
export function CommentsTrigger({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(!open)}
            aria-label={open ? "Hide comments" : "Show comments"}
            aria-pressed={open}
            className={cn(open && "bg-accent text-accent-foreground")}
          />
        }
      >
        <MessageSquare className="size-5" />
      </TooltipTrigger>
      <TooltipContent>{open ? "Hide comments" : "Show comments"}</TooltipContent>
    </Tooltip>
  )
}

/** ResizablePanel slot for the file panel — drops nothing into the layout
 *  when no file is open. Lives next to other ResizablePanels in App.tsx. */
export const FilePanelSlot = observer(function FilePanelSlot({
  blameEnabled,
  commentsEnabled,
}: {
  blameEnabled: boolean
  commentsEnabled: boolean
}) {
  if (!workspace.openFilePath) return null
  return (
    <>
      <ResizableHandle />
      <ResizablePanel id="file" order={9} defaultSize={36} minSize={20} maxSize={70}>
        <div className="h-full min-h-0 overflow-hidden border-l">
          <FilePanel blameEnabled={blameEnabled} commentsEnabled={commentsEnabled} />
        </div>
      </ResizablePanel>
    </>
  )
})

export const FilePanel = observer(function FilePanel({
  blameEnabled,
  commentsEnabled,
}: {
  blameEnabled: boolean
  commentsEnabled: boolean
}) {
  const conversationId = workspace.active?.id ?? null
  const path = workspace.openFilePath
  const [content, setContent] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [html, setHtml] = useState<string | null>(null)
  const [diff, setDiff] = useState<string>("")
  // `null` = file isn't in the conversation's changes list (clean/unchanged).
  // Anything else is the git status reported by /api/changes.
  const [changeStatus, setChangeStatus] = useState<
    "added" | "modified" | "deleted" | "renamed" | "untracked" | null
  >(null)
  const [blame, setBlame] = useState<BlameResult | null>(null)
  const [openBlameLine, setOpenBlameLine] = useState<number | null>(null)
  const [comments, setComments] = useState<FileComment[]>([])
  const [openCommentId, setOpenCommentId] = useState<string | null>(null)
  const [composerLine, setComposerLine] = useState<number | null>(null)
  const projectId = workspace.active?.projectId ?? null
  const userId = workspace.userId
  // Only one annotation accordion open at a time, across types.
  const openBlame = (line: number | null) => {
    setOpenBlameLine(line)
    if (line !== null) {
      setOpenCommentId(null)
      setComposerLine(null)
    }
  }
  const openCommentById = (id: string | null) => {
    setOpenCommentId(id)
    if (id !== null) {
      setOpenBlameLine(null)
      setComposerLine(null)
    }
  }
  const openComposer = (line: number | null) => {
    setComposerLine(line)
    if (line !== null) {
      setOpenBlameLine(null)
      setOpenCommentId(null)
    }
  }
  // Markdown files open in preview. `</>`  toggles to raw source; Eye toggles
  // back. Reset whenever the user opens a different file so each open lands
  // in its own default view.
  const isMarkdown = isMarkdownPath(path)
  const [showSource, setShowSource] = useState(false)
  useEffect(() => { setShowSource(false) }, [path])

  const fetchFile = useCallback(async () => {
    if (!conversationId || !path) return
    setLoading(true)
    setError(null)
    try {
      // Pull the file's diff text from the changes endpoint (same payload the
      // ChangesPanel uses) so we can compute line statuses without a second
      // round-trip when it's already cached server-side.
      const [fileRes, changesRes] = await Promise.all([
        api(`/api/changes/file?conversationId=${encodeURIComponent(conversationId)}&path=${encodeURIComponent(path)}`),
        api(`/api/changes?conversationId=${encodeURIComponent(conversationId)}`),
      ])
      if (!fileRes.ok) {
        const j = await fileRes.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${fileRes.status}`)
      }
      const fileJson = (await fileRes.json()) as FileResponse
      setContent(fileJson.content)
      setTruncated(fileJson.truncated)
      if (changesRes.ok) {
        const cj = (await changesRes.json()) as {
          files: { path: string; diff: string; status: typeof changeStatus }[]
        }
        const match = cj.files.find((f) => f.path === path)
        setDiff(match?.diff ?? "")
        setChangeStatus(match?.status ?? null)
      } else {
        setDiff("")
        setChangeStatus(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setContent(null)
      setHtml(null)
    } finally {
      setLoading(false)
    }
  }, [conversationId, path])

  // Initial + path-change fetch.
  useEffect(() => {
    setHtml(null)
    setContent(null)
    setDiff("")
    setChangeStatus(null)
    setError(null)
    setOpenBlameLine(null)
    if (path) fetchFile()
  }, [path, fetchFile])

  // Blame fetch — only when enabled. Re-runs on path/conv change and on
  // file-watcher SSE (wired alongside the file-content watcher below).
  const fetchBlame = useCallback(async () => {
    if (!conversationId || !path || !blameEnabled) {
      setBlame(null)
      return
    }
    try {
      const res = await api(
        `/api/blame?conversationId=${encodeURIComponent(conversationId)}&path=${encodeURIComponent(path)}`,
      )
      if (!res.ok) {
        setBlame(null)
        return
      }
      setBlame((await res.json()) as BlameResult)
    } catch {
      setBlame(null)
    }
  }, [conversationId, path, blameEnabled])

  useEffect(() => {
    setBlame(null)
    setOpenBlameLine(null)
    if (blameEnabled) void fetchBlame()
  }, [blameEnabled, path, fetchBlame])

  // Comments fetch. Re-runs when conv/path/projectId/enabled changes or when
  // the file changes on disk (see SSE watcher below).
  const fetchComments = useCallback(async () => {
    if (!conversationId || !path || !projectId || !commentsEnabled) {
      setComments([])
      return
    }
    try {
      const res = await api(
        `/api/file-comments?projectId=${encodeURIComponent(projectId)}&filePath=${encodeURIComponent(path)}&conversationId=${encodeURIComponent(conversationId)}`,
      )
      if (!res.ok) {
        setComments([])
        return
      }
      const j = (await res.json()) as { comments: FileComment[] }
      setComments(j.comments ?? [])
    } catch {
      setComments([])
    }
  }, [conversationId, path, projectId, commentsEnabled])

  useEffect(() => {
    setComments([])
    setOpenCommentId(null)
    setComposerLine(null)
    if (commentsEnabled) void fetchComments()
  }, [commentsEnabled, path, projectId, fetchComments])

  const submitComment = useCallback(
    async (line: number, body: string) => {
      if (!conversationId || !path || !projectId || !userId || !body.trim()) return
      // Deterministic id: the same UUID lands on messages.id AND
      // file_comments.message_id server-side. Optimistic chat row uses it
      // immediately; realtime upgrades the row by id match when it arrives.
      const messageId = crypto.randomUUID()
      const commentId = crypto.randomUUID()
      const anchoredLine = content ? content.split("\n")[line - 1] ?? "" : ""
      const chatText = `[comment on ${path}:${line}]\n> ${anchoredLine}\n\n${body.trim()}`
      // Optimistically close the composer; re-fetch hydrates the list.
      setComposerLine(null)
      const conv = workspace.active
      if (conv) conv.addOptimisticUserMessage(messageId, chatText)
      try {
        const res = await api("/api/file-comments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId,
            projectId,
            conversationId,
            filePath: path,
            anchorStartLine: line,
            body: body.trim(),
            messageId,
            commentId,
          }),
        })
        if (!res.ok) return
        void fetchComments()
      } catch {
        // swallow — UI still closed; next fetch will reflect reality
      }
    },
    [conversationId, path, projectId, userId, content, fetchComments],
  )

  const updateCommentStatus = useCallback(
    async (id: string, status: FileComment["status"]) => {
      try {
        await api(`/api/file-comments/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        })
        void fetchComments()
      } catch {
        // ignore
      }
    },
    [fetchComments],
  )

  // Live refresh on file-system change.
  useEffect(() => {
    if (!conversationId || !path) return
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    const debounce = (() => {
      let t: ReturnType<typeof setTimeout> | null = null
      return () => {
        if (t) clearTimeout(t)
        t = setTimeout(() => {
          void fetchFile()
          if (blameEnabled) void fetchBlame()
          if (commentsEnabled) void fetchComments()
        }, 200)
      }
    })()
    async function connect() {
      const url = await sseUrl(`/api/changes/stream?conversationId=${encodeURIComponent(conversationId!)}`)
      es = new EventSource(url)
      es.addEventListener("changed", debounce)
      es.onerror = () => {
        if (es?.readyState === EventSource.CLOSED) retry = setTimeout(() => void connect(), 5000)
      }
    }
    void connect()
    return () => {
      es?.close()
      if (retry) clearTimeout(retry)
    }
  }, [conversationId, path, fetchFile, fetchBlame, fetchComments, blameEnabled, commentsEnabled])

  // Highlight when content changes.
  useEffect(() => {
    let cancelled = false
    if (!content || !path) {
      setHtml(null)
      return
    }
    const lang = languageForPath(path)
    if (!lang) {
      setHtml(null)
      return
    }
    void highlightCode(content, lang).then((out) => {
      if (!cancelled) setHtml(out)
    })
    return () => { cancelled = true }
  }, [content, path])

  const lineStatuses = useMemo(() => {
    if (!content) return { byLine: new Map<number, LineStatus>(), removedAfter: new Set<number>() }
    return computeLineStatuses(content, diff, changeStatus)
  }, [content, diff, changeStatus])

  const commentsByLine = useMemo(() => {
    const map = new Map<number, FileComment[]>()
    for (const c of comments) {
      if (c.status !== "open") continue
      if (c.resolved_line == null) continue
      const list = map.get(c.resolved_line)
      if (list) list.push(c)
      else map.set(c.resolved_line, [c])
    }
    return map
  }, [comments])

  const outdatedComments = useMemo(
    () => comments.filter((c) => c.status === "outdated"),
    [comments],
  )

  const openComment = useMemo(
    () => comments.find((c) => c.id === openCommentId) ?? null,
    [comments, openCommentId],
  )

  if (!path) return null

  const language = languageForPath(path)

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="shrink-0 border-b">
        <div className="flex h-14 items-center justify-between gap-2 px-3">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="size-4 shrink-0" />
            <h2 className="text-sm font-medium truncate" title={path}>
              {path.split("/").pop()}
            </h2>
            <span className="text-xs text-muted-foreground truncate font-mono">
              {path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {isMarkdown && (
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowSource((s) => !s)}
                    aria-label={showSource ? "Show rendered markdown" : "Show source"}
                  >
                    {showSource
                      ? <Eye className="size-3.5" />
                      : <Code className="size-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {showSource ? "Show rendered markdown" : "Show source"}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={content === null}
                  onClick={() => {
                    if (!content || !path) return
                    // Browser-side blob download. No server round-trip —
                    // we already have the file bytes in state.
                    const filename = path.split("/").pop() || "download"
                    const blob = new Blob([content], { type: "application/octet-stream" })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement("a")
                    a.href = url
                    a.download = filename
                    document.body.appendChild(a)
                    a.click()
                    a.remove()
                    URL.revokeObjectURL(url)
                  }}
                  aria-label="Download file"
                >
                  <Download className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Download</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger>
                <Button size="sm" variant="ghost" onClick={fetchFile} disabled={loading}>
                  <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reload</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => workspace.closeFile()}
                  aria-label="Close file"
                >
                  <X className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Close</TooltipContent>
            </Tooltip>
          </div>
        </div>
        {truncated && (
          <div className="px-3 pb-2 text-[11px] text-amber-600 dark:text-amber-400">
            File truncated to first 1 MB.
          </div>
        )}
        {error && (
          <div className="px-3 pb-2 text-xs text-red-600">{error}</div>
        )}
        {commentsEnabled && outdatedComments.length > 0 && (
          <OutdatedCommentsDrawer
            comments={outdatedComments}
            onResolve={(id) => updateCommentStatus(id, "resolved")}
          />
        )}
      </div>
      {isMarkdown && !showSource ? (
        <MarkdownPreviewBody
          loading={loading}
          error={error}
          content={content}
        />
      ) : (
        <FilePanelBody
          loading={loading}
          error={error}
          content={content}
          html={language ? html : null}
          byLine={lineStatuses.byLine}
          removedAfter={lineStatuses.removedAfter}
          blameEnabled={blameEnabled}
          blame={blame}
          openBlameLine={openBlameLine}
          onOpenBlameLine={openBlame}
          commentsEnabled={commentsEnabled}
          commentsByLine={commentsByLine}
          openComment={openComment}
          onOpenCommentById={openCommentById}
          composerLine={composerLine}
          onOpenComposer={openComposer}
          onSubmitComment={submitComment}
          onUpdateCommentStatus={updateCommentStatus}
        />
      )}
    </div>
  )
})

/** Rendered-markdown view for .md/.mdx/.markdown files. No gutter — the
 *  source view already covers diff inspection; this is for reading. */
function MarkdownPreviewBody({
  loading,
  error,
  content,
}: {
  loading: boolean
  error: string | null
  content: string | null
}) {
  return (
    <div className="flex-1 min-h-0 overflow-auto">
      {!loading && !error && content !== null && (
        <div className="max-w-3xl mx-auto px-6 py-4">
          <Markdown>{content}</Markdown>
        </div>
      )}
      {loading && content === null && (
        <div className="p-6 text-center text-xs text-muted-foreground">Loading…</div>
      )}
    </div>
  )
}

function FilePanelBody({
  loading,
  error,
  content,
  html,
  byLine,
  removedAfter,
  blameEnabled,
  blame,
  openBlameLine,
  onOpenBlameLine,
  commentsEnabled,
  commentsByLine,
  openComment,
  onOpenCommentById,
  composerLine,
  onOpenComposer,
  onSubmitComment,
  onUpdateCommentStatus,
}: {
  loading: boolean
  error: string | null
  content: string | null
  html: string | null
  byLine: Map<number, LineStatus>
  removedAfter: Set<number>
  blameEnabled: boolean
  blame: BlameResult | null
  openBlameLine: number | null
  onOpenBlameLine: (line: number | null) => void
  commentsEnabled: boolean
  commentsByLine: Map<number, FileComment[]>
  openComment: FileComment | null
  onOpenCommentById: (id: string | null) => void
  composerLine: number | null
  onOpenComposer: (line: number | null) => void
  onSubmitComment: (line: number, body: string) => void
  onUpdateCommentStatus: (id: string, status: FileComment["status"]) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const lineCount = useMemo(() => {
    if (!content) return 0
    let n = 1
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++
    if (content.endsWith("\n")) n--
    return Math.max(n, 1)
  }, [content])

  return (
    <div className="flex-1 min-h-0 flex">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto scrollbar-hide relative">
        {!loading && !error && content !== null && (
          <FileBody
            content={content}
            html={html}
            byLine={byLine}
            removedAfter={removedAfter}
            blameEnabled={blameEnabled}
            blame={blame}
            openBlameLine={openBlameLine}
            onOpenBlameLine={onOpenBlameLine}
            commentsEnabled={commentsEnabled}
            commentsByLine={commentsByLine}
            openComment={openComment}
            onOpenCommentById={onOpenCommentById}
            composerLine={composerLine}
            onOpenComposer={onOpenComposer}
            onSubmitComment={onSubmitComment}
            onUpdateCommentStatus={onUpdateCommentStatus}
          />
        )}
        {loading && content === null && (
          <div className="p-6 text-center text-xs text-muted-foreground">Loading…</div>
        )}
      </div>
      {!loading && !error && content !== null && lineCount > 0 && (
        <Minimap
          scrollRef={scrollRef}
          lineCount={lineCount}
          byLine={byLine}
          removedAfter={removedAfter}
          commentsEnabled={commentsEnabled}
          commentsByLine={commentsByLine}
          onOpenCommentById={onOpenCommentById}
        />
      )}
    </div>
  )
}

function FileBody({
  content,
  html,
  byLine,
  removedAfter,
  blameEnabled,
  blame,
  openBlameLine,
  onOpenBlameLine,
  commentsEnabled,
  commentsByLine,
  openComment,
  onOpenCommentById,
  composerLine,
  onOpenComposer,
  onSubmitComment,
  onUpdateCommentStatus,
}: {
  content: string
  html: string | null
  byLine: Map<number, LineStatus>
  removedAfter: Set<number>
  blameEnabled: boolean
  blame: BlameResult | null
  openBlameLine: number | null
  onOpenBlameLine: (line: number | null) => void
  commentsEnabled: boolean
  commentsByLine: Map<number, FileComment[]>
  openComment: FileComment | null
  onOpenCommentById: (id: string | null) => void
  composerLine: number | null
  onOpenComposer: (line: number | null) => void
  onSubmitComment: (line: number, body: string) => void
  onUpdateCommentStatus: (id: string, status: FileComment["status"]) => void
}) {
  const codeRef = useRef<HTMLDivElement>(null)
  const [lineMetrics, setLineMetrics] = useState<{ height: number; top: number } | null>(null)
  // Per-line heights after soft-wrap so the gutter strip stays aligned when
  // a long line breaks over multiple visual rows. Populated for the Shiki
  // path (where each source line is its own `.line` span); the plain-<pre>
  // fallback keeps the uniform `lineMetrics.height` below.
  const [lineHeights, setLineHeights] = useState<number[] | null>(null)
  const [hoveredLine, setHoveredLine] = useState<number | null>(null)
  // Cumulative top offsets — offsets[i] is the top of line i+1 in FileBody
  // coord space. Used to position the annotation accordion below a line.
  const lineOffsets = useMemo(() => {
    if (!lineHeights || !lineMetrics) return null
    const offsets: number[] = [lineMetrics.top]
    for (let i = 0; i < lineHeights.length - 1; i++) {
      offsets.push(offsets[i] + lineHeights[i])
    }
    return offsets
  }, [lineHeights, lineMetrics])

  // Measure where the rendered code's first line sits and how tall a line is,
  // so the gutter strip aligns 1:1 with the code lines whether we use Shiki HTML
  // or the plain <pre> fallback.
  useEffect(() => {
    const el = codeRef.current
    if (!el) return
    const measure = () => {
      const pre = el.querySelector("pre") as HTMLElement | null
      if (!pre) return
      const codeStyles = getComputedStyle(pre)
      const lh = parseFloat(codeStyles.lineHeight)
      const padTop = parseFloat(codeStyles.paddingTop)
      if (Number.isFinite(lh) && Number.isFinite(padTop)) {
        setLineMetrics({ height: lh, top: padTop })
      }
      // Shiki emits one `.line` span per source line. Capture each one's
      // actual rendered height, and stamp a 1-based index so the mousemove
      // delegation can read `dataset.lineNo` directly.
      const lineEls = el.querySelectorAll<HTMLElement>("pre .line")
      if (lineEls.length > 0) {
        const heights: number[] = []
        for (let i = 0; i < lineEls.length; i++) {
          lineEls[i].dataset.lineNo = String(i + 1)
          heights.push(lineEls[i].getBoundingClientRect().height)
        }
        setLineHeights(heights)
      } else {
        setLineHeights(null)
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [content, html])

  const lineCount = useMemo(() => {
    // Match Shiki's line count: it splits on \n and produces one .line per piece.
    let n = 1
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++
    // Trailing newline produces an empty trailing line — Shiki includes it.
    if (content.endsWith("\n")) n--
    return Math.max(n, 1)
  }, [content])

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!commentsEnabled) return
    const target = (e.target as HTMLElement).closest<HTMLElement>(".line")
    if (!target) {
      setHoveredLine(null)
      return
    }
    const n = parseInt(target.dataset.lineNo ?? "", 10)
    if (!Number.isFinite(n)) return
    setHoveredLine(n)
  }
  const onMouseLeave = () => setHoveredLine(null)

  return (
    <div
      className="relative font-mono text-[12px] leading-snug"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      {/* Gutter: 6px stripes per line, color-coded by diff status */}
      {lineMetrics && (
        <div
          className="absolute left-0 top-0 w-1.5 pointer-events-none"
          style={{ paddingTop: lineMetrics.top }}
        >
          {Array.from({ length: lineCount }, (_, i) => {
            const lineNo = i + 1
            const status = byLine.get(lineNo) ?? "context"
            const cls =
              status === "added"
                ? "bg-green-500/70"
                : status === "modified"
                  ? "bg-amber-500/70"
                  : ""
            // Use the measured height for wrapped lines; fall back to the
            // uniform line-height when per-line data isn't available yet.
            const h = lineHeights?.[i] ?? lineMetrics.height
            return (
              <div
                key={i}
                className={cn("relative w-1.5", cls)}
                style={{ height: h }}
              >
                {removedAfter.has(lineNo) && (
                  <div className="absolute -bottom-px left-0 h-0.5 w-2.5 bg-red-500/80" />
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Blame rail: 10px clickable column sitting between the gutter stripe
          and the wrapper padding. Each row is an <AnnotationChip> with a
          stripe color hashed from the commit SHA. */}
      {blameEnabled && blame && lineMetrics && (
        <div
          className="absolute top-0 pointer-events-auto"
          style={{ left: 8, width: 10, paddingTop: lineMetrics.top }}
          aria-label="Blame rail"
        >
          {Array.from({ length: lineCount }, (_, i) => {
            const lineNo = i + 1
            const info = blame.lines[i]
            const h = lineHeights?.[i] ?? lineMetrics.height
            if (!info) return <div key={i} style={{ height: h }} />
            const color = info.isUncommitted
              ? "hsl(0 0% 55%)"
              : shaToColor(info.sha)
            return (
              <div key={i} style={{ height: h }}>
                <AnnotationChip
                  color={color}
                  faded
                  isOpen={openBlameLine === lineNo}
                  onClick={() =>
                    onOpenBlameLine(openBlameLine === lineNo ? null : lineNo)
                  }
                  title={`${info.author} — ${info.summary}`}
                />
              </div>
            )
          })}
        </div>
      )}

      {/* Code (Shiki HTML or plain <pre>) — left-padded to clear the gutter
          and leave room for the blame rail (even when it's not currently
          rendered, so toggling blame doesn't shift layout).
          Lines soft-wrap so long edits are readable without horizontal
          scrolling; the gutter's per-line heights adapt via `lineHeights`.
          `file-code` enables the CSS-counter line numbers (see index.css). */}
      <div
        ref={codeRef}
        className="file-code pl-5 [&_pre]:bg-transparent! [&_pre]:py-3 [&_pre]:pr-3 [&_pre]:pl-10 [&_pre]:overflow-x-hidden [&_.shiki]:whitespace-normal [&_.shiki>code]:whitespace-normal [&_.line]:block [&_.line]:whitespace-pre-wrap [&_.line]:wrap-break-word"
      >
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="whitespace-pre-wrap wrap-break-word">{content}</pre>
        )}
      </div>

      {/* Comment composer hover trigger — a faint "+" at the right edge of
          the hovered line. Only visible when comments are on, no existing
          comment on that line, and no other composer/accordion is active. */}
      {commentsEnabled &&
        hoveredLine !== null &&
        !commentsByLine.get(hoveredLine) &&
        composerLine !== hoveredLine &&
        lineOffsets &&
        lineHeights &&
        hoveredLine <= lineOffsets.length && (
          <button
            type="button"
            className="absolute right-1 z-20 flex size-4 items-center justify-center rounded-sm bg-primary text-primary-foreground text-[11px] leading-none shadow-sm opacity-80 hover:opacity-100 cursor-pointer"
            style={{
              top:
                lineOffsets[hoveredLine - 1] +
                (lineHeights[hoveredLine - 1] ?? 0) / 2 -
                8,
            }}
            aria-label={`Comment on line ${hoveredLine}`}
            onClick={() => onOpenComposer(hoveredLine)}
          >
            +
          </button>
        )}

      {/* Annotation accordion — absolute-positioned below the anchored line.
          Overlays the lines beneath; close to reveal them again. One open at
          a time (per annotation type) for now. */}
      {blameEnabled &&
        blame &&
        openBlameLine !== null &&
        lineOffsets &&
        lineHeights &&
        openBlameLine >= 1 &&
        openBlameLine <= lineOffsets.length && (
          <BlameAccordion
            info={blame.lines[openBlameLine - 1]}
            top={lineOffsets[openBlameLine - 1] + (lineHeights[openBlameLine - 1] ?? 0)}
            onClose={() => onOpenBlameLine(null)}
          />
        )}

      {commentsEnabled &&
        openComment &&
        openComment.resolved_line != null &&
        lineOffsets &&
        lineHeights &&
        openComment.resolved_line <= lineOffsets.length && (
          <CommentAccordion
            comment={openComment}
            top={
              lineOffsets[openComment.resolved_line - 1] +
              (lineHeights[openComment.resolved_line - 1] ?? 0)
            }
            onClose={() => onOpenCommentById(null)}
            onResolve={() => onUpdateCommentStatus(openComment.id, "resolved")}
            onReopen={() => onUpdateCommentStatus(openComment.id, "open")}
          />
        )}

      {commentsEnabled &&
        composerLine !== null &&
        lineOffsets &&
        lineHeights &&
        composerLine <= lineOffsets.length && (
          <CommentComposer
            line={composerLine}
            top={
              lineOffsets[composerLine - 1] +
              (lineHeights[composerLine - 1] ?? 0)
            }
            onCancel={() => onOpenComposer(null)}
            onSubmit={(body) => onSubmitComment(composerLine, body)}
          />
        )}
    </div>
  )
}

function BlameAccordion({
  info,
  top,
  onClose,
}: {
  info: BlameLine | undefined
  top: number
  onClose: () => void
}) {
  if (!info) return null
  const when = info.committerTime
    ? new Date(info.committerTime).toLocaleString()
    : "—"
  const openInGitLog = () => {
    window.dispatchEvent(new CustomEvent("ai-coder:open-git-log"))
    // Fire focus after a tick so App/code-panel listeners have a chance to
    // open the section before git-log-panel tries to scroll to the row.
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("ai-coder:focus-commit", { detail: { sha: info.sha } })
      )
    }, 50)
  }
  return (
    <div className="absolute inset-x-0 z-10" style={{ top }}>
      <AnnotationAccordion
        onClose={onClose}
        header={
          <div className="flex items-center gap-2 min-w-0">
            <GitCommit className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-semibold truncate">{info.summary}</span>
            {!info.isUncommitted && (
              <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                {info.shortSha}
              </span>
            )}
          </div>
        }
      >
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center size-5 rounded-full bg-muted text-[9px] font-medium">
              {authorInitials(info.author)}
            </span>
            <span className="font-medium">{info.author}</span>
            {info.authorMail && (
              <span className="text-muted-foreground truncate">{info.authorMail}</span>
            )}
          </div>
          <div className="text-muted-foreground">
            {info.isUncommitted ? (
              "Uncommitted — working tree"
            ) : (
              <>
                {compactAge(info.committerTime)} ago <span className="mx-1">·</span> {when}
              </>
            )}
          </div>
          {!info.isUncommitted && (
            <div className="pt-1">
              <button
                type="button"
                onClick={openInGitLog}
                className="text-[11px] text-primary hover:underline cursor-pointer"
              >
                Open in git log →
              </button>
            </div>
          )}
        </div>
      </AnnotationAccordion>
    </div>
  )
}

function CommentAccordion({
  comment,
  top,
  onClose,
  onResolve,
  onReopen,
}: {
  comment: FileComment
  top: number
  onClose: () => void
  onResolve: () => void
  onReopen: () => void
}) {
  const when = new Date(comment.created_at).toLocaleString()
  const shifted = comment.resolved_confidence === "shifted"
  const isResolved = comment.status === "resolved"
  return (
    <div className="absolute inset-x-0 z-10" style={{ top }}>
      <AnnotationAccordion
        onClose={onClose}
        header={
          <div className="flex items-center gap-2 min-w-0">
            <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-semibold truncate">Comment</span>
            {shifted && comment.anchor_start_line !== comment.resolved_line && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                moved from line {comment.anchor_start_line}
              </span>
            )}
          </div>
        }
      >
        <div className="space-y-2">
          <div className="whitespace-pre-wrap wrap-break-word">{comment.body}</div>
          <div className="text-muted-foreground text-[11px]">
            {compactAge(new Date(comment.created_at).getTime())} ago
            <span className="mx-1">·</span>
            {when}
          </div>
          <div className="flex items-center gap-3 pt-1">
            {isResolved ? (
              <button
                type="button"
                onClick={onReopen}
                className="text-[11px] text-primary hover:underline cursor-pointer"
              >
                Reopen
              </button>
            ) : (
              <button
                type="button"
                onClick={onResolve}
                className="text-[11px] text-primary hover:underline cursor-pointer"
              >
                Resolve
              </button>
            )}
            {comment.message_id && (
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("ai-coder:focus-message", {
                      detail: { messageId: comment.message_id },
                    }),
                  )
                }
                className="text-[11px] text-primary hover:underline cursor-pointer"
              >
                Show in chat →
              </button>
            )}
          </div>
        </div>
      </AnnotationAccordion>
    </div>
  )
}

function CommentComposer({
  line,
  top,
  onCancel,
  onSubmit,
}: {
  line: number
  top: number
  onCancel: () => void
  onSubmit: (body: string) => void
}) {
  const [text, setText] = useState("")
  const taRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    taRef.current?.focus()
  }, [])
  const submit = () => {
    const body = text.trim()
    if (!body) return
    onSubmit(body)
    setText("")
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault()
      onCancel()
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      submit()
    }
  }
  return (
    <div className="absolute inset-x-0 z-10" style={{ top }}>
      <AnnotationAccordion
        onClose={onCancel}
        header={
          <div className="flex items-center gap-2 min-w-0">
            <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-semibold">Comment on line {line}</span>
          </div>
        }
      >
        <div className="space-y-2">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            placeholder="Write a comment… (⌘⏎ to post)"
            className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={submit} disabled={!text.trim()}>
              Comment
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      </AnnotationAccordion>
    </div>
  )
}

function OutdatedCommentsDrawer({
  comments,
  onResolve,
}: {
  comments: FileComment[]
  onResolve: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="border-t bg-muted/30">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/40 cursor-pointer"
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        <span>
          {comments.length} outdated comment{comments.length > 1 ? "s" : ""}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-2 max-h-48 overflow-auto">
          {comments.map((c) => (
            <div key={c.id} className="rounded-md border bg-background p-2 text-xs space-y-1">
              <div className="text-muted-foreground">
                Original line {c.anchor_start_line}:
                <span className="ml-2 font-mono truncate text-foreground/80">
                  {c.anchor_preview || "(empty)"}
                </span>
              </div>
              <div className="whitespace-pre-wrap wrap-break-word">{c.body}</div>
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span>{compactAge(new Date(c.created_at).getTime())} ago</span>
                <button
                  type="button"
                  onClick={() => onResolve(c.id)}
                  className="text-primary hover:underline cursor-pointer"
                >
                  Resolve
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Walk a unified-diff string, mapping each NEW-file line number to its
 * status. A `+` line is "added" unless paired with a preceding `-` line in
 * the same hunk position, in which case both are "modified". A `-` line not
 * paired with a `+` becomes a removed marker on the next visible new line.
 *
 * `changeStatus` comes from /api/changes. `null` means the file isn't in the
 * changes list at all (clean/unchanged) — we render no gutter markers. Only
 * explicitly untracked/added files with no hunks get the all-green treatment.
 */
function computeLineStatuses(
  content: string,
  diff: string,
  changeStatus:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "untracked"
    | null,
): {
  byLine: Map<number, LineStatus>
  removedAfter: Set<number>
} {
  const byLine = new Map<number, LineStatus>()
  const removedAfter = new Set<number>()

  // File not in the changes list → nothing changed, no markers.
  if (changeStatus === null) return { byLine, removedAfter }

  const lineCount = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0)

  // Untracked/newly-added file (diff is empty or a raw cat-style dump with no
  // hunks): mark every line as added.
  if (!diff || !/^@@ /m.test(diff)) {
    for (let i = 1; i <= Math.max(lineCount, 1); i++) byLine.set(i, "added")
    return { byLine, removedAfter }
  }

  const lines = diff.split("\n")
  let newLineNo = 0 // running new-file line cursor

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunkMatch) {
      newLineNo = parseInt(hunkMatch[1], 10) - 1
      continue
    }
    if (line.startsWith("\\")) continue // "\ No newline at end of file"

    if (line.startsWith("+") && !line.startsWith("+++")) {
      newLineNo += 1
      // Was the previous diff line a "-"? If so, this is a modification, not pure add.
      let j = i - 1
      while (j >= 0 && lines[j].startsWith("\\")) j--
      const prev = j >= 0 ? lines[j] : ""
      const wasRemove = prev.startsWith("-") && !prev.startsWith("---")
      byLine.set(newLineNo, wasRemove ? "modified" : "added")
      // If we marked this as modified, clear any removedAfter that targeted it
      // (the deletion is already represented by the modified status).
      if (wasRemove) removedAfter.delete(newLineNo)
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // A removed line — if NOT followed by a `+`, it leaves a gap marker
      // on the next new-line we emit. Look ahead.
      let k = i + 1
      while (k < lines.length && lines[k].startsWith("\\")) k++
      const next = k < lines.length ? lines[k] : ""
      const willBecomeModification = next.startsWith("+") && !next.startsWith("+++")
      if (!willBecomeModification) {
        // Mark a stripe between current newLineNo and the next visible line.
        // Use newLineNo (the previous new line) — UI draws marker at its bottom edge.
        if (newLineNo >= 1) removedAfter.add(newLineNo)
        else removedAfter.add(1)
      }
    } else if (line.startsWith(" ")) {
      newLineNo += 1
    }
  }

  return { byLine, removedAfter }
}

/**
 * Vertical minimap of the file's diff status.
 *
 * - Compresses the full file's height into the visible viewport height: each
 *   line maps to a 1-Npx slice (`viewportHeight / lineCount`, min 1.5px).
 * - Coalesces adjacent same-status lines into runs so we render O(runs) divs
 *   rather than O(lines).
 * - A semi-transparent overlay shows the currently-visible region.
 * - Click anywhere → scrolls so the corresponding line is centered in view.
 * - Drag the overlay (or anywhere) → continuous scroll.
 */
function Minimap({
  scrollRef,
  lineCount,
  byLine,
  removedAfter,
  commentsEnabled,
  commentsByLine,
  onOpenCommentById,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  lineCount: number
  byLine: Map<number, LineStatus>
  removedAfter: Set<number>
  commentsEnabled: boolean
  commentsByLine: Map<number, FileComment[]>
  onOpenCommentById: (id: string | null) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [scrollState, setScrollState] = useState({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })
  const [trackHeight, setTrackHeight] = useState(0)

  // Sync scroll metrics from the parent scroller
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => {
      setScrollState({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      })
    }
    update()
    el.addEventListener("scroll", update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    // Also re-measure when inner content grows
    const inner = el.firstElementChild
    if (inner) ro.observe(inner)
    return () => {
      el.removeEventListener("scroll", update)
      ro.disconnect()
    }
  }, [scrollRef])

  // Track height (the minimap's own dimensions in CSS px)
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const update = () => setTrackHeight(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Coalesce per-line statuses into runs (one rendered div per run)
  const runs = useMemo(() => {
    type Run = { start: number; end: number; status: LineStatus }
    const out: Run[] = []
    let cur: Run | null = null
    for (let n = 1; n <= lineCount; n++) {
      const s = byLine.get(n)
      if (!s) {
        cur = null
        continue
      }
      if (cur && cur.status === s && cur.end === n - 1) {
        cur.end = n
      } else {
        cur = { start: n, end: n, status: s }
        out.push(cur)
      }
    }
    return out
  }, [byLine, lineCount])

  const removedList = useMemo(() => Array.from(removedAfter).sort((a, b) => a - b), [removedAfter])

  const linePx = trackHeight > 0 && lineCount > 0 ? trackHeight / lineCount : 0
  const sliverH = Math.max(linePx, 1.5)

  // Viewport indicator: maps the visible code region to minimap pixel space
  const indicator = (() => {
    const { scrollTop, scrollHeight, clientHeight } = scrollState
    if (scrollHeight <= clientHeight || trackHeight === 0) return null
    const scale = trackHeight / scrollHeight
    return {
      top: Math.max(0, scrollTop * scale),
      height: Math.max(20, clientHeight * scale),
    }
  })()

  const scrollToY = useCallback(
    (clientY: number, smooth: boolean) => {
      const track = trackRef.current
      const scroller = scrollRef.current
      if (!track || !scroller) return
      const rect = track.getBoundingClientRect()
      const y = clientY - rect.top
      const ratio = Math.max(0, Math.min(1, y / rect.height))
      const target = ratio * (scroller.scrollHeight - scroller.clientHeight)
      scroller.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" })
    },
    [scrollRef]
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    scrollToY(e.clientY, true)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return
    scrollToY(e.clientY, false)
  }

  return (
    <div
      ref={trackRef}
      className="relative w-2.5 shrink-0 p-px border-l border-l-transparent cursor-pointer select-none transition-colors"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      aria-label="File minimap"
    >
      {/* slivers + indicator are positioned inside the 1px padding so they
          line up with the rounded scrollbar-thumb width (8px wide). */}
      {runs.map((r, i) => {
        const top = (r.start - 1) * linePx
        const height = Math.max((r.end - r.start + 1) * linePx, sliverH)
        const cls =
          r.status === "added"
            ? "bg-green-500/70"
            : r.status === "modified"
              ? "bg-amber-500/70"
              : ""
        return (
          <div
            key={i}
            className={cn("absolute inset-x-px rounded-full", cls)}
            style={{ top, height }}
          />
        )
      })}
      {removedList.map((n) => (
        <div
          key={`r-${n}`}
          className="absolute inset-x-px h-px bg-red-500/80"
          style={{ top: n * linePx }}
        />
      ))}
      {indicator && (
        <div
          className="absolute inset-x-px rounded-full bg-foreground/15 pointer-events-none"
          style={{ top: indicator.top, height: indicator.height }}
        />
      )}
      {/* Comment pins (merged into the minimap column). Pin precedence: a
          pin overlaps + visually replaces any diff heatmap slice at the same
          line, since commented lines matter more than change density. The
          button stops pointer propagation so a click opens the accordion
          instead of triggering the scroll-to-click behavior. */}
      {commentsEnabled &&
        Array.from(commentsByLine.entries()).map(([line, list]) => {
          if (list.length === 0) return null
          const top = Math.max(0, (line - 1) * linePx - 2)
          const first = list[0]
          const count = list.length
          return (
            <button
              key={`c-${line}`}
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onOpenCommentById(first.id)
              }}
              aria-label={`Open comment on line ${line}`}
              className="absolute -left-0.5 size-3 rounded-full bg-primary ring-1 ring-background shadow-sm cursor-pointer flex items-center justify-center text-[8px] font-bold text-primary-foreground"
              style={{ top }}
            >
              {count > 1 ? count : ""}
            </button>
          )
        })}
    </div>
  )
}
