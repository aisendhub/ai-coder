import { useCallback, useEffect, useRef, useState } from "react"
import { observer } from "mobx-react-lite"
import { toast } from "sonner"
import {
  Play,
  Square,
  ExternalLink,
  RefreshCw,
  Server,
  Loader2,
  CircleAlert,
  Trash2,
  Settings,
  ChevronLeft,
} from "lucide-react"

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { workspace } from "@/models"
import type { Service, LogLine } from "@/models"
import type { RunManifestDto, RunnerId } from "@/models/ServiceList.model"

type EditorState = {
  mode: "first-run" | "edit-project"
  projectId: string
  conversationId: string | null
  label: string | null
  initial: Partial<RunManifestDto>
  detected: RunManifestDto | null
  cwd: string
}

// ── Trigger button (top-bar) ─────────────────────────────────────────────────

export const ServicesTrigger = observer(function ServicesTrigger() {
  const [open, setOpen] = useState(false)
  const liveCount = workspace.services.items.filter((s) => s.isLive).length

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <SheetTrigger
              className={cn(
                "inline-flex items-center justify-center rounded-md h-9 px-2 gap-1 hover:bg-accent hover:text-accent-foreground",
                liveCount > 0 && "text-emerald-500"
              )}
              aria-label="Running services"
            />
          }
        >
          <Server className="size-4" />
          {liveCount > 0 && (
            <span className="text-xs font-mono">{liveCount}</span>
          )}
        </TooltipTrigger>
        <TooltipContent>
          {liveCount > 0
            ? `${liveCount} service${liveCount === 1 ? "" : "s"} running`
            : "Services"}
        </TooltipContent>
      </Tooltip>
      <SheetContent side="right" className="p-0 w-[95vw] sm:w-[560px]">
        <SheetHeader className="sr-only">
          <SheetTitle>Services</SheetTitle>
        </SheetHeader>
        <ServicesPanel open={open} />
      </SheetContent>
    </Sheet>
  )
})

// ── Panel body ───────────────────────────────────────────────────────────────

const ServicesPanel = observer(function ServicesPanel({ open }: { open: boolean }) {
  const userId = workspace.userId
  const active = workspace.active
  const activeProject = workspace.activeProject
  const services = workspace.services
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [runnerId, setRunnerId] = useState<RunnerId>("local-process")

  const targetProjectId = active?.projectId ?? activeProject?.id ?? null
  const targetLabel = active?.title ?? activeProject?.name ?? null
  const canStart = !!userId && !!targetProjectId

  const refresh = useCallback(async () => {
    if (!userId) return
    try {
      await services.refresh(userId)
    } catch (err) {
      console.error("[services] refresh failed", err)
    }
  }, [userId, services])

  useEffect(() => {
    if (!open) return
    void refresh()
    void services.refreshRunners()
    const t = window.setInterval(() => { void refresh() }, 5000)
    return () => window.clearInterval(t)
  }, [open, refresh, services])

  // Reset editor when the sheet closes so reopening is fresh.
  useEffect(() => {
    if (!open) setEditor(null)
  }, [open])

  const startCached = useCallback(async (projectId: string, conversationId: string | null, label: string | null) => {
    if (!userId) return
    try {
      await services.start({ userId, projectId, conversationId, label, runnerId })
      toast.success("Service started", {
        description: runnerId === "local-docker" ? "Building image…" : undefined,
      })
    } catch (err) {
      toast.error("Couldn't start service", { description: (err as Error).message })
    }
  }, [userId, services, runnerId])

  const onStart = async () => {
    if (!userId || !targetProjectId) return
    try {
      const view = await services.fetchProjectManifest(userId, targetProjectId)
      if (!view.cached) {
        setEditor({
          mode: "first-run",
          projectId: targetProjectId,
          conversationId: active?.id ?? null,
          label: targetLabel,
          initial: view.detected ?? { stack: "custom", start: "", env: {} },
          detected: view.detected,
          cwd: view.cwd,
        })
        return
      }
      await startCached(targetProjectId, active?.id ?? null, targetLabel)
    } catch (err) {
      toast.error("Couldn't load manifest", { description: (err as Error).message })
    }
  }

  const onEditManifest = async () => {
    if (!userId || !targetProjectId) return
    try {
      const view = await services.fetchProjectManifest(userId, targetProjectId)
      setEditor({
        mode: "edit-project",
        projectId: targetProjectId,
        conversationId: active?.id ?? null,
        label: targetLabel,
        initial: view.cached ?? view.detected ?? { stack: "custom", start: "", env: {} },
        detected: view.detected,
        cwd: view.cwd,
      })
    } catch (err) {
      toast.error("Couldn't load manifest", { description: (err as Error).message })
    }
  }

  const onSaveAndMaybeRun = async (manifest: RunManifestDto, run: boolean) => {
    if (!userId || !editor) return
    try {
      await services.saveProjectManifest(userId, editor.projectId, manifest)
      const snap = editor
      setEditor(null)
      if (run) {
        await startCached(snap.projectId, snap.conversationId, snap.label)
      } else {
        toast.success("Start command saved")
      }
    } catch (err) {
      toast.error("Couldn't save", { description: (err as Error).message })
    }
  }

  const onStop = async (svc: Service) => {
    if (!userId) return
    try {
      await services.stop(userId, svc.id)
    } catch (err) {
      toast.error("Stop failed", { description: (err as Error).message })
    }
  }

  const onRemove = async (svc: Service) => {
    if (!userId) return
    try {
      await services.remove(userId, svc.id)
      if (selectedId === svc.id) setSelectedId(null)
    } catch (err) {
      toast.error("Remove failed", { description: (err as Error).message })
    }
  }

  const selected = selectedId ? services.find(selectedId) : null

  if (editor) {
    return (
      <ManifestEditor
        state={editor}
        onCancel={() => setEditor(null)}
        onSave={(m, run) => { void onSaveAndMaybeRun(m, run) }}
      />
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        <Server className="size-4" />
        <div className="text-sm font-medium">Services</div>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => { void refresh() }}
          disabled={!userId}
          aria-label="Refresh"
        >
          <RefreshCw className={cn("size-3.5", services.loading && "animate-spin")} />
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void onEditManifest() }}
                disabled={!canStart}
                aria-label="Edit start command"
              />
            }
          >
            <Settings className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Edit start command</TooltipContent>
        </Tooltip>
        <RunnerSelect value={runnerId} onChange={setRunnerId} />
        <Button
          size="sm"
          onClick={() => { void onStart() }}
          disabled={!canStart}
        >
          <Play className="size-3.5" />
          Run
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {services.items.length === 0 ? (
          <div className="px-4 py-8 text-sm text-muted-foreground text-center">
            Nothing running. Click <span className="font-medium">Run</span> to start
            the active project or worktree.
          </div>
        ) : (
          <ul className="divide-y">
            {services.items.map((svc) => (
              <ServiceRow
                key={svc.id}
                svc={svc}
                selected={selectedId === svc.id}
                onSelect={() => setSelectedId(svc.id === selectedId ? null : svc.id)}
                onStop={() => { void onStop(svc) }}
                onRemove={() => { void onRemove(svc) }}
              />
            ))}
          </ul>
        )}
      </ScrollArea>

      {selected && (
        <>
          <Separator />
          <div className="h-[40%] min-h-[200px] max-h-[50vh]">
            <LogViewer key={selected.id} svc={selected} />
          </div>
        </>
      )}
    </div>
  )
})

// ── Runner picker ────────────────────────────────────────────────────────────

const RUNNER_LABELS: Record<RunnerId, string> = {
  "local-process": "Process",
  "local-docker": "Docker",
}

const RunnerSelect = observer(function RunnerSelect({
  value,
  onChange,
}: {
  value: RunnerId
  onChange: (v: RunnerId) => void
}) {
  const runners = workspace.services.runners
  // Fall back to showing both options even before the probe completes so the
  // select doesn't flash empty. Availability still gates selection below.
  const entries: Array<[RunnerId, { available: boolean; reason?: string }]> =
    runners.length
      ? runners.map((r) => [r.id, { available: r.available, reason: r.reason }])
      : [["local-process", { available: true }], ["local-docker", { available: false }]]

  const current = entries.find(([id]) => id === value)?.[1]
  const unavailableReason = current && !current.available ? current.reason : undefined

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <select
            value={value}
            onChange={(e) => onChange(e.target.value as RunnerId)}
            className={cn(
              "h-8 rounded-md border bg-background px-2 text-xs",
              unavailableReason && "text-amber-500"
            )}
            aria-label="Runner"
          />
        }
      >
        {entries.map(([id, info]) => (
          <option key={id} value={id} disabled={!info.available}>
            {RUNNER_LABELS[id]}{!info.available ? " (unavailable)" : ""}
          </option>
        ))}
      </TooltipTrigger>
      <TooltipContent>
        {unavailableReason
          ? unavailableReason
          : value === "local-docker"
            ? "Run in a Docker container (prod parity)"
            : "Run as a host process (fastest)"}
      </TooltipContent>
    </Tooltip>
  )
})

// ── Manifest editor ──────────────────────────────────────────────────────────

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const idx = line.indexOf("=")
    if (idx === -1) continue
    out[line.slice(0, idx).trim()] = line.slice(idx + 1)
  }
  return out
}

function formatEnv(env: Record<string, string> | undefined): string {
  if (!env) return ""
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n")
}

function ManifestEditor({
  state,
  onCancel,
  onSave,
}: {
  state: EditorState
  onCancel: () => void
  onSave: (m: RunManifestDto, runAfterSave: boolean) => void
}) {
  const init = state.initial
  const [stack, setStack] = useState<string>(init.stack ?? "custom")
  const [start, setStart] = useState<string>(init.start ?? "")
  const [build, setBuild] = useState<string>(init.build ?? "")
  const [envText, setEnvText] = useState<string>(formatEnv(init.env))

  const isFirstRun = state.mode === "first-run"
  const canSave = !!start.trim()

  const handleSubmit = (run: boolean) => {
    if (!canSave) return
    const manifest: RunManifestDto = {
      stack,
      start: start.trim(),
      cwd: state.cwd,
      env: parseEnv(envText),
    }
    if (build.trim()) manifest.build = build.trim()
    onSave(manifest, run)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        <Button variant="ghost" size="sm" onClick={onCancel} aria-label="Back">
          <ChevronLeft className="size-4" />
        </Button>
        <div className="text-sm font-medium">
          {isFirstRun ? "How do you run this app?" : "Edit start command"}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-4 py-3 space-y-4">
        <div className="text-xs text-muted-foreground">
          <div>
            {isFirstRun
              ? "Confirm the command we'll use to start this project. Saved to the project, used for every Run."
              : "Saved to the project. Applies to every task and chat in this project unless a task override exists."}
          </div>
          <div className="mt-1 font-mono truncate" title={state.cwd}>cwd: {state.cwd}</div>
          {state.detected && isFirstRun && (
            <div className="mt-1">
              Detected: <span className="font-mono">{state.detected.stack}</span>
              {state.detected.start && <> · <span className="font-mono">{state.detected.start}</span></>}
            </div>
          )}
        </div>

        <label className="block space-y-1">
          <div className="text-xs font-medium">Stack</div>
          <select
            value={stack}
            onChange={(e) => setStack(e.target.value)}
            className="w-full h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="node">node</option>
            <option value="bun">bun</option>
            <option value="python">python</option>
            <option value="static">static</option>
            <option value="docker">docker</option>
            <option value="custom">custom</option>
          </select>
        </label>

        <label className="block space-y-1">
          <div className="text-xs font-medium">Start command</div>
          <Input
            value={start}
            onChange={(e) => setStart(e.target.value)}
            placeholder="e.g. npm run dev"
            className="font-mono text-sm"
            autoFocus
          />
          <div className="text-xs text-muted-foreground">
            Port is auto-assigned. Use <code className="font-mono">$PORT</code> in the command if your app needs it injected.
          </div>
        </label>

        <label className="block space-y-1">
          <div className="text-xs font-medium">Build command <span className="text-muted-foreground">(optional)</span></div>
          <Input
            value={build}
            onChange={(e) => setBuild(e.target.value)}
            placeholder="e.g. npm ci && npm run build"
            className="font-mono text-sm"
          />
        </label>

        <label className="block space-y-1">
          <div className="text-xs font-medium">Environment <span className="text-muted-foreground">(KEY=value per line)</span></div>
          <textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder="NODE_ENV=development&#10;DATABASE_URL=postgres://…"
            rows={5}
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs resize-y"
          />
        </label>
      </div>

      <div className="flex items-center gap-2 px-4 py-3 border-t">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <div className="flex-1" />
        {!isFirstRun && (
          <Button
            variant="outline"
            size="sm"
            disabled={!canSave}
            onClick={() => handleSubmit(false)}
          >
            Save
          </Button>
        )}
        <Button
          size="sm"
          disabled={!canSave}
          onClick={() => handleSubmit(true)}
        >
          <Play className="size-3.5" />
          {isFirstRun ? "Save & Run" : "Save & Run"}
        </Button>
      </div>
    </div>
  )
}

// ── Service row ──────────────────────────────────────────────────────────────

function statusColor(status: Service["status"]): string {
  switch (status) {
    case "running": return "bg-emerald-500"
    case "starting": return "bg-amber-400"
    case "stopping": return "bg-amber-400"
    case "stopped": return "bg-muted-foreground/40"
    case "crashed": return "bg-red-500"
  }
}

function ServiceRow({
  svc,
  selected,
  onSelect,
  onStop,
  onRemove,
}: {
  svc: Service
  selected: boolean
  onSelect: () => void
  onStop: () => void
  onRemove: () => void
}) {
  const label = svc.label ?? svc.cwd.split("/").slice(-2).join("/")
  const live = svc.isLive
  return (
    <li
      className={cn(
        "px-4 py-2 flex items-center gap-3 cursor-pointer hover:bg-accent/40",
        selected && "bg-accent/60"
      )}
      onClick={onSelect}
    >
      <span
        className={cn(
          "inline-block size-2 rounded-full shrink-0",
          statusColor(svc.status)
        )}
        aria-label={svc.status}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">{label}</div>
        <div className="text-xs text-muted-foreground font-mono truncate">
          {svc.stack} · {svc.start}
        </div>
        {svc.error && (
          <div className="text-xs text-red-500 truncate flex items-center gap-1">
            <CircleAlert className="size-3 shrink-0" />
            {svc.error}
          </div>
        )}
      </div>
      <div className="text-xs font-mono text-muted-foreground shrink-0">
        :{svc.port}
      </div>
      {live && svc.status === "running" && (
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={svc.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center justify-center size-7 rounded-md hover:bg-accent"
                aria-label="Open in browser"
              />
            }
          >
            <ExternalLink className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Open http://localhost:{svc.port}</TooltipContent>
        </Tooltip>
      )}
      {live ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={(e) => { e.stopPropagation(); onStop() }}
                disabled={svc.status === "stopping"}
                aria-label="Stop"
              />
            }
          >
            {svc.status === "stopping" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Square className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipContent>Stop</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={(e) => { e.stopPropagation(); onRemove() }}
                aria-label="Remove"
              />
            }
          >
            <Trash2 className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Remove</TooltipContent>
        </Tooltip>
      )}
    </li>
  )
}

// ── Log viewer ───────────────────────────────────────────────────────────────

const LogViewer = observer(function LogViewer({ svc }: { svc: Service }) {
  const userId = workspace.userId
  const [lines, setLines] = useState<LogLine[]>([])
  const [autoscroll, setAutoscroll] = useState(true)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setLines([])
    if (!userId) return
    const unsub = workspace.services.subscribeLogs(userId, svc.id, (line) => {
      setLines((prev) => {
        // Cap in-browser history too so super-long sessions stay snappy.
        const next = prev.length > 2000 ? prev.slice(-1500) : prev
        return [...next, line]
      })
    })
    return () => unsub()
  }, [userId, svc.id])

  useEffect(() => {
    if (!autoscroll) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [lines, autoscroll])

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoscroll(atBottom)
  }

  return (
    <div className="h-full flex flex-col bg-muted/30">
      <div className="px-4 py-2 border-b flex items-center gap-2 text-xs text-muted-foreground">
        <span>Logs</span>
        <span className="font-mono">{svc.cwd}</span>
        <span className="flex-1" />
        {!autoscroll && (
          <button
            type="button"
            className="underline hover:text-foreground"
            onClick={() => {
              setAutoscroll(true)
              const el = scrollRef.current
              if (el) el.scrollTop = el.scrollHeight
            }}
          >
            Jump to latest
          </button>
        )}
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-auto px-4 py-2 font-mono text-xs whitespace-pre-wrap break-all"
      >
        {lines.length === 0 ? (
          <div className="text-muted-foreground">Waiting for output…</div>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={cn(line.stream === "stderr" && "text-red-400")}
            >
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  )
})
