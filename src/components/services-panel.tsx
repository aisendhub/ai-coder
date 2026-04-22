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
  Cloud,
  CloudOff,
  Link2,
  Unlink,
  Sparkles,
} from "lucide-react"

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { X } from "lucide-react"
import { useIsMobile } from "@/hooks/use-mobile"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { useConfirm } from "@/lib/confirm"
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
  /** LLM-detection state for the first-run flow. `pending` shows a spinner
   *  and disables Save; `ready` populates the form once; `failed` surfaces
   *  the error but lets the user proceed with heuristic defaults. */
  llm?:
    | { status: "pending" }
    | { status: "ready"; rationale: string; confidence: "high" | "medium" | "low" }
    | { status: "failed"; error: string }
}

// ── Trigger button (top-bar) ─────────────────────────────────────────────────
// Desktop: toggles the dockable services panel in the ResizablePanelGroup.
// Mobile: wraps the panel in a Sheet since there's no room to dock.

export const ServicesTrigger = observer(function ServicesTrigger({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const liveCount = workspace.services.items.filter((s) => s.isLive).length
  const isMobile = useIsMobile()

  const tooltipLabel =
    liveCount > 0
      ? `${liveCount} service${liveCount === 1 ? "" : "s"} running`
      : "Services"

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
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
          <TooltipContent>{tooltipLabel}</TooltipContent>
        </Tooltip>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="p-0 w-[95vw]"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Services</SheetTitle>
          </SheetHeader>
          <ServicesPanel onClose={() => onOpenChange(false)} />
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(!open)}
            aria-label={open ? "Close services" : "Open services"}
            aria-pressed={open}
            className={cn(
              "relative",
              open && "bg-accent text-accent-foreground",
              liveCount > 0 && !open && "text-emerald-500"
            )}
          />
        }
      >
        <Server className="size-5" />
        {liveCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-emerald-500 text-[10px] font-mono text-white flex items-center justify-center">
            {liveCount}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>{open ? `Close ${tooltipLabel.toLowerCase()}` : tooltipLabel}</TooltipContent>
    </Tooltip>
  )
})

// ── Panel body ───────────────────────────────────────────────────────────────
// Mounted when the user docks the panel; unmounted when they close it, so
// we no longer track an `open` flag — mount-time = open-time.

export const ServicesPanel = observer(function ServicesPanel({
  onClose,
}: {
  onClose?: () => void
} = {}) {
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
    void refresh()
    void services.refreshRunners()
    if (userId) void services.refreshRailwayIntegration(userId)
    const t = window.setInterval(() => { void refresh() }, 5000)
    return () => window.clearInterval(t)
  }, [refresh, services, userId])

  // First-run auto-prompt. If we have a project/task scope AND nothing is
  // cached AND no services are running for this scope, open the editor
  // pre-filled by the LLM (falls back to heuristic). Runs once per mount.
  const llmBootstrappedRef = useRef(false)
  useEffect(() => {
    if (llmBootstrappedRef.current) return
    if (!userId || !targetProjectId) return
    if (editor) return
    // If any services exist for this user, skip auto-prompt — the user is
    // clearly past the "how do I run this" step for at least one project.
    if (services.items.length > 0) return
    llmBootstrappedRef.current = true

    void (async () => {
      try {
        const view = await services.fetchProjectManifest(userId, targetProjectId)
        if (view.cached) return // already configured — don't auto-open
        // Open editor immediately in pending state so the user sees
        // "detecting…" instead of a blank sheet while the LLM runs.
        setEditor({
          mode: "first-run",
          projectId: targetProjectId,
          conversationId: active?.id ?? null,
          label: targetLabel,
          initial: view.detected ?? { stack: "custom", start: "", env: {} },
          detected: view.detected,
          cwd: view.cwd,
          llm: { status: "pending" },
        })
        const result = await services.detectLlmManifest(userId, targetProjectId)
        const proposal = result.llm.proposal
        setEditor((prev) => {
          // User may have cancelled, saved, or switched projects while the
          // LLM was thinking — only populate if we're still on the same
          // first-run pending state.
          if (!prev || prev.mode !== "first-run" || prev.projectId !== targetProjectId) {
            return prev
          }
          if (prev.llm?.status !== "pending") return prev
          if (!proposal || !proposal.start) {
            return {
              ...prev,
              llm: result.llm.error
                ? { status: "failed", error: result.llm.error }
                : { status: "failed", error: "LLM didn't propose a start command" },
            }
          }
          return {
            ...prev,
            initial: {
              stack: proposal.stack,
              start: proposal.start,
              build: proposal.build,
              env: proposal.env,
            },
            llm: {
              status: "ready",
              rationale: proposal.rationale,
              confidence: proposal.confidence,
            },
          }
        })
      } catch (err) {
        setEditor((prev) =>
          prev && prev.mode === "first-run"
            ? { ...prev, llm: { status: "failed", error: (err as Error).message } }
            : prev
        )
      }
    })()
  }, [userId, targetProjectId, services, editor, targetLabel, active])

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
    <div className="flex flex-col h-full relative">
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
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 ml-1"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        )}
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
          <div className="h-[40%] min-h-50 max-h-[50vh]">
            <LogViewer key={selected.id} svc={selected} />
          </div>
        </>
      )}

      {!selected && <IntegrationsFooter />}
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
  // Track user edits so LLM arrival doesn't clobber manual typing. Keyed by
  // mode-projectId so "regenerating" for a different scope resets the guard.
  const editedRef = useRef(false)
  const scopeKey = `${state.mode}:${state.projectId}`
  useEffect(() => { editedRef.current = false }, [scopeKey])

  // When the parent updates `state.initial` (e.g. LLM detection resolved),
  // refill the fields — but only if the user hasn't already typed something.
  useEffect(() => {
    if (editedRef.current) return
    setStack(init.stack ?? "custom")
    setStart(init.start ?? "")
    setBuild(init.build ?? "")
    setEnvText(formatEnv(init.env))
  }, [init.stack, init.start, init.build, init.env])

  const markEdited = () => { editedRef.current = true }

  const isFirstRun = state.mode === "first-run"
  const llmPending = state.llm?.status === "pending"
  const canSave = !!start.trim() && !llmPending

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
          {state.detected && isFirstRun && state.llm?.status !== "ready" && (
            <div className="mt-1">
              Detected: <span className="font-mono">{state.detected.stack}</span>
              {state.detected.start && <> · <span className="font-mono">{state.detected.start}</span></>}
            </div>
          )}
        </div>

        {state.llm?.status === "pending" && (
          <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin shrink-0" />
            <span>Asking the model to inspect this project…</span>
          </div>
        )}
        {state.llm?.status === "ready" && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs space-y-1">
            <div className="flex items-center gap-2 font-medium">
              <Sparkles className="size-3.5 text-amber-500 shrink-0" />
              <span>Model suggestion</span>
              <span className={cn(
                "ml-auto rounded-full px-2 py-0.5 text-[10px] font-mono",
                state.llm.confidence === "high" && "bg-emerald-500/10 text-emerald-500",
                state.llm.confidence === "medium" && "bg-amber-500/10 text-amber-500",
                state.llm.confidence === "low" && "bg-muted-foreground/10 text-muted-foreground",
              )}>
                {state.llm.confidence}
              </span>
            </div>
            {state.llm.rationale && (
              <div className="text-muted-foreground">{state.llm.rationale}</div>
            )}
          </div>
        )}
        {state.llm?.status === "failed" && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs flex items-start gap-2">
            <CircleAlert className="size-3.5 text-red-500 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-red-500">LLM detection failed</div>
              <div className="text-muted-foreground">{state.llm.error}</div>
            </div>
          </div>
        )}

        <label className="block space-y-1">
          <div className="text-xs font-medium">Stack</div>
          <select
            value={stack}
            onChange={(e) => { setStack(e.target.value); markEdited() }}
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
            onChange={(e) => { setStart(e.target.value); markEdited() }}
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
            onChange={(e) => { setBuild(e.target.value); markEdited() }}
            placeholder="e.g. npm ci && npm run build"
            className="font-mono text-sm"
          />
        </label>

        <label className="block space-y-1">
          <div className="text-xs font-medium">Environment <span className="text-muted-foreground">(KEY=value per line)</span></div>
          <textarea
            value={envText}
            onChange={(e) => { setEnvText(e.target.value); markEdited() }}
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

// ── Integrations footer ─────────────────────────────────────────────────────

const IntegrationsFooter = observer(function IntegrationsFooter() {
  const userId = workspace.userId
  const services = workspace.services
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()

  const railway = services.railway

  const onDisconnect = async () => {
    if (!userId) return
    const ok = await confirm({
      title: "Disconnect Railway?",
      description: "You can reconnect any time.",
      variant: "destructive",
      confirmText: "Disconnect",
    })
    if (!ok) return
    setBusy(true)
    try {
      await services.disconnectRailway(userId)
      toast.success("Railway disconnected")
    } catch (err) {
      toast.error("Disconnect failed", { description: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Separator />
      <div className="px-4 py-2.5 flex items-center gap-2 text-xs">
        {railway.connected ? (
          <>
            <Cloud className="size-3.5 text-emerald-500 shrink-0" />
            <div className="min-w-0 flex-1 truncate">
              <span className="text-muted-foreground">Railway · </span>
              <span className="font-medium">
                {railway.account.username ?? railway.account.email ?? railway.account.id}
              </span>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    onClick={() => { void onDisconnect() }}
                    disabled={busy}
                    aria-label="Disconnect Railway"
                  />
                }
              >
                <Unlink className="size-3" />
              </TooltipTrigger>
              <TooltipContent>Disconnect</TooltipContent>
            </Tooltip>
          </>
        ) : (
          <>
            <CloudOff className="size-3.5 text-muted-foreground shrink-0" />
            <div className="flex-1 text-muted-foreground">Railway not connected</div>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => setDialogOpen(true)}
              disabled={!userId}
            >
              <Link2 className="size-3" />
              Connect
            </Button>
          </>
        )}
      </div>
      {dialogOpen && (
        <RailwayConnectDialog onClose={() => setDialogOpen(false)} />
      )}
    </>
  )
})

function RailwayConnectDialog({ onClose }: { onClose: () => void }) {
  const userId = workspace.userId
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = !!userId && !!token.trim() && !busy

  const onSubmit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await workspace.services.connectRailway(userId!, token.trim())
      toast.success("Railway connected")
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="absolute inset-0 z-10 bg-background flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Back">
          <ChevronLeft className="size-4" />
        </Button>
        <div className="text-sm font-medium">Connect Railway</div>
      </div>
      <div className="flex-1 overflow-auto px-4 py-4 space-y-4 text-sm">
        <p className="text-muted-foreground">
          Paste a Railway personal token. We validate it against Railway's API
          before saving, and store it encrypted.
        </p>
        <p className="text-muted-foreground">
          Generate one at{" "}
          <a
            href="https://railway.com/account/tokens"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            railway.com/account/tokens
          </a>
          .
        </p>
        <label className="block space-y-1">
          <div className="text-xs font-medium">Token</div>
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="rw_…"
            className="font-mono text-sm"
            autoFocus
          />
        </label>
        {error && (
          <div className="text-xs text-red-500 flex items-start gap-1">
            <CircleAlert className="size-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-4 py-3 border-t">
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <div className="flex-1" />
        <Button size="sm" onClick={() => { void onSubmit() }} disabled={!canSubmit}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
          Connect
        </Button>
      </div>
    </div>
  )
}
