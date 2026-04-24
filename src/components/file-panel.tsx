import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { observer } from "mobx-react-lite"
import { X, FileText, RefreshCw, Code, Eye, Download, GitCommit } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable"
import { cn } from "@/lib/utils"
import { highlightCode, languageForPath } from "@/lib/highlight"
import { workspace } from "@/models"
import { Markdown } from "@/components/markdown"
import { AnnotationAccordion } from "@/components/annotation-accordion"
import { AnnotationChip, authorInitials, compactAge, shaToColor } from "@/components/annotation-chip"

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

/** ResizablePanel slot for the file panel — drops nothing into the layout
 *  when no file is open. Lives next to other ResizablePanels in App.tsx. */
export const FilePanelSlot = observer(function FilePanelSlot({
  blameEnabled,
}: {
  blameEnabled: boolean
}) {
  if (!workspace.openFilePath) return null
  return (
    <>
      <ResizableHandle />
      <ResizablePanel id="file" order={9} defaultSize={36} minSize={20} maxSize={70}>
        <div className="h-full min-h-0 overflow-hidden border-l">
          <FilePanel blameEnabled={blameEnabled} />
        </div>
      </ResizablePanel>
    </>
  )
})

export const FilePanel = observer(function FilePanel({
  blameEnabled,
}: {
  blameEnabled: boolean
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
        fetch(`/api/changes/file?conversationId=${encodeURIComponent(conversationId)}&path=${encodeURIComponent(path)}`),
        fetch(`/api/changes?conversationId=${encodeURIComponent(conversationId)}`),
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
      const res = await fetch(
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
        }, 200)
      }
    })()
    function connect() {
      es = new EventSource(`/api/changes/stream?conversationId=${encodeURIComponent(conversationId!)}`)
      es.addEventListener("changed", debounce)
      es.onerror = () => {
        if (es?.readyState === EventSource.CLOSED) retry = setTimeout(connect, 5000)
      }
    }
    connect()
    return () => {
      es?.close()
      if (retry) clearTimeout(retry)
    }
  }, [conversationId, path, fetchFile, fetchBlame, blameEnabled])

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
          onOpenBlameLine={setOpenBlameLine}
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
}: {
  content: string
  html: string | null
  byLine: Map<number, LineStatus>
  removedAfter: Set<number>
  blameEnabled: boolean
  blame: BlameResult | null
  openBlameLine: number | null
  onOpenBlameLine: (line: number | null) => void
}) {
  const codeRef = useRef<HTMLDivElement>(null)
  const [lineMetrics, setLineMetrics] = useState<{ height: number; top: number } | null>(null)
  // Per-line heights after soft-wrap so the gutter strip stays aligned when
  // a long line breaks over multiple visual rows. Populated for the Shiki
  // path (where each source line is its own `.line` span); the plain-<pre>
  // fallback keeps the uniform `lineMetrics.height` below.
  const [lineHeights, setLineHeights] = useState<number[] | null>(null)
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
      // actual rendered height — lines that wrap report > lh automatically.
      const lineEls = el.querySelectorAll<HTMLElement>("pre .line")
      if (lineEls.length > 0) {
        const heights: number[] = []
        for (const lineEl of lineEls) {
          heights.push(lineEl.getBoundingClientRect().height)
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

  return (
    <div className="relative font-mono text-[12px] leading-snug">
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
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  lineCount: number
  byLine: Map<number, LineStatus>
  removedAfter: Set<number>
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
    </div>
  )
}
