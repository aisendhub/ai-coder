import { useEffect, useRef, useState } from "react"
import { observer } from "mobx-react-lite"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { TerminalIcon, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { workspace } from "@/models"
import { withAccessToken } from "@/lib/api"
import "@xterm/xterm/css/xterm.css"

export const TerminalPanel = observer(function TerminalPanel({
  onClose,
}: { onClose?: () => void } = {}) {
  const cwd = workspace.activeProject?.cwd ?? ""
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [reconnectKey, setReconnectKey] = useState(0)

  useEffect(() => {
    if (!containerRef.current || !cwd) return
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

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
    const baseUrl = `${proto}//${window.location.host}/api/terminal?cwd=${encodeURIComponent(cwd)}&cols=${term.cols}&rows=${term.rows}`

    // Queue input until the socket has actually connected — withAccessToken
    // is async (reads the Supabase session) so the WebSocket is created on
    // a microtask.
    let ws: WebSocket | null = null
    const pendingInput: string[] = []
    const sendToWs = (data: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data)
      else pendingInput.push(data)
    }

    // The access token has to ride on the query string because WebSocket has
    // no header API. The backend verifies it (and that `cwd` matches one of
    // the user's projects) before upgrading.
    void withAccessToken(baseUrl).then((url) => {
      if (cancelled) return
      const socket = new WebSocket(url)
      ws = socket
      wsRef.current = socket

      socket.onopen = () => {
        for (const data of pendingInput.splice(0)) socket.send(data)
      }
      socket.onmessage = (e) => {
        // Server sends raw pty bytes as strings (utf-8) or Blob if binary.
        if (typeof e.data === "string") term.write(e.data)
        else if (e.data instanceof Blob) e.data.text().then((t) => term.write(t))
      }
      socket.onclose = () => {
        if (!cancelled) term.write("\r\n\x1b[2m[connection closed]\x1b[0m\r\n")
      }
      socket.onerror = () => {
        if (!cancelled) term.write("\r\n\x1b[31m[websocket error]\x1b[0m\r\n")
      }
    })

    const inputDisp = term.onData((data) => {
      sendToWs(data)
    })

    const resizeDisp = term.onResize(({ cols, rows }) => {
      sendToWs(JSON.stringify({ type: "resize", cols, rows }))
    })

    const ro = new ResizeObserver(() => {
      try { fit.fit() } catch { /* ignore */ }
    })
    ro.observe(containerRef.current)

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
  }, [cwd, reconnectKey])

  const reconnect = () => setReconnectKey((k) => k + 1)

  if (!cwd) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        Select a project to open a terminal.
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
        <div className="px-3 pb-2 text-xs text-muted-foreground truncate font-mono">{cwd}</div>
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
