import { useEffect, useRef, useState } from "react"
import { observer } from "mobx-react-lite"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { TerminalIcon, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { workspace } from "@/models"
import { sseUrl } from "@/lib/api"
import "@xterm/xterm/css/xterm.css"

export const TerminalPanel = observer(function TerminalPanel({
  onClose,
}: { onClose?: () => void } = {}) {
  // Terminal is scoped to the active chat/task — cwd is derived server-side
  // from the conversation (worktree for tasks, project cwd for chats) so an
  // authed user can only open terminals inside their own workspace.
  const conversationId = workspace.active?.id ?? null
  // Cosmetic label below the header. Project cwd is a close-enough hint when
  // the conversation is a chat; tasks run in a worktree but the project cwd
  // still reads as "this project's terminal."
  const cwdLabel = workspace.activeProject?.cwd ?? ""
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [reconnectKey, setReconnectKey] = useState(0)

  useEffect(() => {
    if (!containerRef.current || !conversationId) return
    let cancelled = false

    const term = new XTerm({
      fontFamily:
        '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      convertEol: true,
      theme: themeFromDocument(),
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    requestAnimationFrame(() => {
      try { fit.fit() } catch { /* container not ready */ }
      term.focus()
    })
    termRef.current = term
    fitRef.current = fit

    // Listeners attach before the socket exists; they no-op until ws is ready.
    let ws: WebSocket | null = null
    const inputDisp = term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data)
    })
    const resizeDisp = term.onResize(({ cols, rows }) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }))
      }
    })
    const ro = new ResizeObserver(() => {
      try { fit.fit() } catch { /* ignore */ }
    })
    ro.observe(containerRef.current)

    // Resolve URL (with JWT token) async, then open. Cleanup below tolerates
    // the case where unmount happens before the socket exists.
    void (async () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
      const path = await sseUrl(`/api/terminal?conversationId=${encodeURIComponent(conversationId)}&cols=${term.cols}&rows=${term.rows}`)
      if (cancelled) return
      ws = new WebSocket(`${proto}//${window.location.host}${path}`)
      wsRef.current = ws

      ws.onmessage = (e) => {
        if (typeof e.data === "string") term.write(e.data)
        else if (e.data instanceof Blob) e.data.text().then((t) => term.write(t))
      }
      ws.onclose = () => {
        if (!cancelled) term.write("\r\n\x1b[2m[connection closed]\x1b[0m\r\n")
      }
      ws.onerror = () => {
        if (!cancelled) term.write("\r\n\x1b[31m[websocket error]\x1b[0m\r\n")
      }
    })()

    return () => {
      cancelled = true
      inputDisp.dispose()
      resizeDisp.dispose()
      ro.disconnect()
      ws?.close()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      wsRef.current = null
    }
  }, [conversationId, reconnectKey])

  const reconnect = () => setReconnectKey((k) => k + 1)

  if (!conversationId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        Select a chat or task to open a terminal.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="shrink-0 border-b">
        <div className="flex h-14 items-center justify-between px-3">
          <div className="flex items-center gap-2 min-w-0">
            <TerminalIcon className="size-4 shrink-0" />
            <h2 className="text-sm font-medium">Terminal</h2>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger>
                <Button size="sm" variant="ghost" onClick={reconnect}>
                  <RefreshCw className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reconnect</TooltipContent>
            </Tooltip>
            {onClose && (
              <Tooltip>
                <TooltipTrigger>
                  <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close terminal">
                    <X className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Close</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        <div className="px-3 pb-2 text-xs text-muted-foreground truncate font-mono">{cwdLabel}</div>
      </div>
      <div className="flex-1 min-h-0 bg-background p-2">
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  )
})

function themeFromDocument() {
  const styles = getComputedStyle(document.documentElement)
  const get = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback
  return {
    background: get("--background", "#0a0a0a"),
    foreground: get("--foreground", "#e5e5e5"),
    cursor: get("--foreground", "#e5e5e5"),
    selectionBackground: "rgba(120,120,120,0.35)",
  }
}
