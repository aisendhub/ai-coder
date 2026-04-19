import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { observer } from "mobx-react-lite"
import { X, FileText, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable"
import { cn } from "@/lib/utils"
import { highlightCode, languageForPath } from "@/lib/highlight"
import { workspace } from "@/models"

type LineStatus = "added" | "modified" | "context"

type FileResponse = {
  path: string
  content: string
  truncated: boolean
  sizeBytes: number
}

/** ResizablePanel slot for the file panel — drops nothing into the layout
 *  when no file is open. Lives next to other ResizablePanels in App.tsx. */
export const FilePanelSlot = observer(function FilePanelSlot() {
  if (!workspace.openFilePath) return null
  return (
    <>
      <ResizableHandle />
      <ResizablePanel id="file" defaultSize={36} minSize={20} maxSize={70}>
        <div className="h-full min-h-0 overflow-hidden border-l">
          <FilePanel />
        </div>
      </ResizablePanel>
    </>
  )
})

export const FilePanel = observer(function FilePanel() {
  const conversationId = workspace.active?.id ?? null
  const path = workspace.openFilePath
  const [content, setContent] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [html, setHtml] = useState<string | null>(null)
  const [diff, setDiff] = useState<string>("")

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
        const cj = (await changesRes.json()) as { files: { path: string; diff: string; status: string }[] }
        const match = cj.files.find((f) => f.path === path)
        setDiff(match?.diff ?? "")
      } else {
        setDiff("")
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
    setError(null)
    if (path) fetchFile()
  }, [path, fetchFile])

  // Live refresh on file-system change.
  useEffect(() => {
    if (!conversationId || !path) return
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    const debounce = (() => {
      let t: ReturnType<typeof setTimeout> | null = null
      return () => {
        if (t) clearTimeout(t)
        t = setTimeout(() => fetchFile(), 200)
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
  }, [conversationId, path, fetchFile])

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
    return computeLineStatuses(content, diff)
  }, [content, diff])

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
      <ScrollArea className="flex-1 min-h-0">
        {!loading && !error && content !== null && (
          <FileBody
            content={content}
            html={language ? html : null}
            byLine={lineStatuses.byLine}
            removedAfter={lineStatuses.removedAfter}
          />
        )}
        {loading && content === null && (
          <div className="p-6 text-center text-xs text-muted-foreground">Loading…</div>
        )}
      </ScrollArea>
    </div>
  )
})

function FileBody({
  content,
  html,
  byLine,
  removedAfter,
}: {
  content: string
  html: string | null
  byLine: Map<number, LineStatus>
  removedAfter: Set<number>
}) {
  const codeRef = useRef<HTMLDivElement>(null)
  const [lineMetrics, setLineMetrics] = useState<{ height: number; top: number } | null>(null)

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
            return (
              <div
                key={i}
                className={cn("relative w-1.5", cls)}
                style={{ height: lineMetrics.height }}
              >
                {removedAfter.has(lineNo) && (
                  <div className="absolute -bottom-px left-0 h-0.5 w-2.5 bg-red-500/80" />
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Code (Shiki HTML or plain <pre>) — left-padded to clear the gutter */}
      <div ref={codeRef} className="pl-3 [&_pre]:bg-transparent! [&_pre]:p-3 [&_pre]:overflow-x-auto">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="whitespace-pre">{content}</pre>
        )}
      </div>
    </div>
  )
}

/**
 * Walk a unified-diff string, mapping each NEW-file line number to its
 * status. A `+` line is "added" unless paired with a preceding `-` line in
 * the same hunk position, in which case both are "modified". A `-` line not
 * paired with a `+` becomes a removed marker on the next visible new line.
 *
 * For untracked files (no hunks), every line is "added".
 */
function computeLineStatuses(content: string, diff: string): {
  byLine: Map<number, LineStatus>
  removedAfter: Set<number>
} {
  const byLine = new Map<number, LineStatus>()
  const removedAfter = new Set<number>()

  const lineCount = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0)

  // No diff or only-cat output (untracked): mark all as added
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
