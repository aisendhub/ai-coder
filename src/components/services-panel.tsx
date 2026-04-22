import { useCallback, useEffect, useRef, useState } from "react"
import { observer } from "mobx-react-lite"
import { toast } from "sonner"
import {
  Play,
  Square,
  ExternalLink,
  Server,
  Loader2,
  CircleAlert,
  Trash2,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { X } from "lucide-react"
import { useIsMobile } from "@/hooks/use-mobile"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
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
  collapsed = false,
}: {
  onClose?: () => void
  collapsed?: boolean
} = {}) {
  const userId = workspace.userId
  const active = workspace.active
  const activeProject = workspace.activeProject
  const services = workspace.services
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [runnerId, setRunnerId] = useState<RunnerId>("local-process")

  if (collapsed) {
    const liveCount = services.items.filter((s) => s.isLive).length
    return (
      <div className="flex h-full min-h-0 flex-col items-center py-2 gap-1">
        <Server className={cn("size-4", liveCount > 0 ? "text-emerald-500" : "text-muted-foreground")} />
        <div className="text-[10px] tabular-nums text-muted-foreground">
          {liveCount}
        </div>
        {services.items.length > 0 && <div className="my-1 h-px w-6 bg-border" />}
        {services.items.slice(0, 12).map((svc) => (
          <div
            key={svc.id}
            title={`${svc.status}: ${svc.label ?? svc.id}`}
            className="size-7 rounded-md hover:bg-accent flex items-center justify-center"
          >
            <span className={cn(
              "size-2 rounded-full",
              svc.status === "running" ? "bg-emerald-500 animate-pulse"
                : svc.status === "starting" ? "bg-amber-500 animate-pulse"
                : svc.status === "crashed" ? "bg-red-500"
                : "bg-muted-foreground/40"
            )} />
          </div>
        ))}
      </div>
    )
  }

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

  // On mount, probe the project's manifest. The panel's empty state renders
  // from this snapshot — we show the heuristic hit (if any) with a one-click
  // save + a separate "Ask agent to set up" CTA. No more silent LLM calls.
  const [manifestProbe, setManifestProbe] = useState<{
    loading: boolean
    cached: RunManifestDto | null
    detected: RunManifestDto | null
    cwd: string
  } | null>(null)

  useEffect(() => {
    if (!userId || !targetProjectId) {
      setManifestProbe(null)
      return
    }
    let cancelled = false
    const probe = async (showLoading: boolean) => {
      if (showLoading) {
        setManifestProbe((prev) =>
          prev ? { ...prev, loading: true } : { loading: true, cached: null, detected: null, cwd: "" }
        )
      }
      try {
        const view = await services.fetchProjectManifest(userId, targetProjectId, active?.id ?? null)
        if (cancelled) return
        setManifestProbe({
          loading: false,
          cached: view.cached,
          detected: view.detected,
          cwd: view.cwd,
        })
      } catch {
        if (cancelled) return
        setManifestProbe({ loading: false, cached: null, detected: null, cwd: "" })
      }
    }

    void probe(true)

    // Re-probe on every turn-done in case the agent wrote a <run-manifest>
    // block — the server parses it and saves in a finally hook, and we pick
    // up the change on the next refresh without polling.
    const onTurnDone = () => { void probe(false) }
    window.addEventListener("ai-coder:turn-done", onTurnDone)
    return () => {
      cancelled = true
      window.removeEventListener("ai-coder:turn-done", onTurnDone)
    }
    // Re-probe when the active conversation changes — switching from a chat
    // to a task worktree means the detect target cwd also changes.
  }, [userId, targetProjectId, services, active?.id])

  const [askingAgent, setAskingAgent] = useState(false)
  const onAskAgent = async () => {
    if (!userId || !active?.id) {
      toast.error("Open a chat to ask the agent", {
        description: "Service setup piggy-backs on the active conversation so the agent sees what you've been building.",
      })
      return
    }
    setAskingAgent(true)
    try {
      const res = await fetch(`/api/conversations/${active.id}/detect-services`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      toast.info("Asked the agent", {
        description: "Watch the chat — it'll inspect the repo and propose a run config.",
      })
    } catch (err) {
      toast.error("Couldn't ask agent", { description: (err as Error).message })
    } finally {
      setAskingAgent(false)
    }
  }

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
      const view = await services.fetchProjectManifest(userId, targetProjectId, active?.id ?? null)
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
      const view = await services.fetchProjectManifest(userId, targetProjectId, active?.id ?? null)
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

  // Delete the project's configured manifest. Stops any running instance
  // first (best-effort) so the user doesn't have to stop-then-delete.
  const confirm = useConfirm()
  const onDeleteManifest = async () => {
    if (!userId || !targetProjectId) return
    const ok = await confirm({
      title: "Delete this configuration?",
      description: "Clears the saved start command for this project. Any running instance will be stopped first. You can re-detect or ask the agent to set it up again.",
      confirmText: "Delete",
      variant: "destructive",
    })
    if (!ok) return
    try {
      // Stop + remove any live or stale instance for this project, best-effort.
      const projectInstances = services.items.filter((s) => s.projectId === targetProjectId)
      for (const inst of projectInstances) {
        if (inst.isLive) {
          await services.stop(userId, inst.id).catch(() => undefined)
        }
        await services.remove(userId, inst.id).catch(() => undefined)
      }
      await services.clearProjectManifest(userId, targetProjectId)
      setManifestProbe((p) => (p ? { ...p, cached: null } : p))
      setSelectedId(null)
      toast.success("Service configuration removed")
    } catch (err) {
      toast.error("Couldn't delete", { description: (err as Error).message })
    }
  }

  // One configured service per project in v1. Pick the most relevant running
  // instance to drive the card's status; if none, show it as stopped/idle.
  const projectInstances = targetProjectId
    ? services.items.filter((s) => s.projectId === targetProjectId)
    : []
  const instance =
    projectInstances.find((s) => s.isLive) ??
    [...projectInstances].sort((a, b) => b.startedAt - a.startedAt)[0] ??
    null

  // Old ServiceRow pattern had a separate selection id — now the "card" is
  // the service itself, so selection just toggles the log drawer.
  const expanded = selectedId === "card" && !!instance
  const selected = instance && expanded ? instance : null

  if (editor) {
    return (
      <ManifestEditor
        state={editor}
        onCancel={() => setEditor(null)}
        onSave={(m, run) => { void onSaveAndMaybeRun(m, run) }}
      />
    )
  }

  const listBody = manifestProbe?.cached ? (
    <ConfiguredServiceCard
      manifest={manifestProbe.cached}
      instance={instance}
      expanded={expanded}
      onToggleExpand={() =>
        setSelectedId((prev) => (prev === "card" ? null : "card"))
      }
      onRun={() => { void onStart() }}
      onStop={() => {
        if (instance) void onStop(instance)
      }}
      onConfigure={onEditManifest}
      onDelete={() => { void onDeleteManifest() }}
    />
  ) : (
    <EmptyState
      probe={manifestProbe}
      hasActiveConversation={!!active?.id}
      askingAgent={askingAgent}
      onUseDetected={async () => {
        if (!userId || !targetProjectId || !manifestProbe?.detected) return
        try {
          await services.saveProjectManifest(userId, targetProjectId, {
            ...manifestProbe.detected,
            cwd: manifestProbe.cwd,
          })
          setManifestProbe((p) => p ? { ...p, cached: manifestProbe.detected } : p)
          toast.success("Start command saved")
        } catch (err) {
          toast.error("Couldn't save", { description: (err as Error).message })
        }
      }}
      onEditManual={onEditManifest}
      onAskAgent={() => { void onAskAgent() }}
    />
  )

  return (
    <div className="flex flex-col h-full relative">
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        <Server className="size-4" />
        <div className="text-sm font-medium">
          Services
          {services.loading && (
            <Loader2 className="inline size-3 ml-1.5 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="flex-1" />
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

      {selected ? (
        // List + logs share the remaining height; the user resizes the split
        // via the handle and react-resizable-panels persists per-combination.
        <ResizablePanelGroup
          direction="vertical"
          autoSaveId="ai-coder-services-logs"
          className="flex-1 min-h-0"
        >
          <ResizablePanel id="services-list" order={1} defaultSize={55} minSize={20}>
            <ScrollArea className="h-full">{listBody}</ScrollArea>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="services-logs" order={2} defaultSize={45} minSize={15}>
            <LogViewer key={selected.id} svc={selected} />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <>
          <ScrollArea className="flex-1">{listBody}</ScrollArea>
          <IntegrationsFooter />
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

  const tooltipText = unavailableReason
    ? unavailableReason
    : value === "local-docker"
      ? "Run in a Docker container (prod parity)"
      : "Run as a host process (fastest)"

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Select value={value} onValueChange={(v) => onChange(v as RunnerId)}>
            <SelectTrigger
              size="sm"
              aria-label="Runner"
              className={cn(
                "text-xs px-2 min-w-0 w-auto gap-1",
                unavailableReason && "text-amber-500"
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {entries.map(([id, info]) => (
                <SelectItem key={id} value={id} disabled={!info.available}>
                  {RUNNER_LABELS[id]}
                  {!info.available && (
                    <span className="ml-1 text-muted-foreground">· unavailable</span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <TooltipContent>{tooltipText}</TooltipContent>
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

// ── Empty state ─────────────────────────────────────────────────────────────

function EmptyState({
  probe,
  hasActiveConversation,
  askingAgent,
  onUseDetected,
  onEditManual,
  onAskAgent,
}: {
  probe: {
    loading: boolean
    cached: RunManifestDto | null
    detected: RunManifestDto | null
    cwd: string
  } | null
  hasActiveConversation: boolean
  askingAgent: boolean
  onUseDetected: () => Promise<void>
  onEditManual: () => void
  onAskAgent: () => void
}) {
  if (!probe || probe.loading) {
    return (
      <div className="px-4 py-8 flex items-center justify-center text-xs text-muted-foreground gap-2">
        <Loader2 className="size-3.5 animate-spin" />
        Inspecting project…
      </div>
    )
  }

  // Manifest already saved — nothing's just running. Point user at Run.
  if (probe.cached) {
    return (
      <div className="px-4 py-8 text-sm text-muted-foreground text-center space-y-1">
        <div>Nothing running yet.</div>
        <div className="text-xs font-mono">{probe.cached.start}</div>
        <div className="pt-2">Click <span className="font-medium">Run</span> above to start it.</div>
      </div>
    )
  }

  return (
    <div className="px-4 py-5 space-y-4">
      {probe.detected ? (
        <div className="rounded-md border bg-muted/20 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <Server className="size-3.5 text-emerald-500 shrink-0" />
            <span className="font-medium">Detected automatically</span>
            <span className="ml-auto rounded-full px-2 py-0.5 text-[10px] font-mono bg-muted-foreground/10 text-muted-foreground">
              {probe.detected.stack}
            </span>
          </div>
          <div className="font-mono text-xs text-muted-foreground break-all">
            {probe.detected.start}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={() => { void onUseDetected() }}>
              Use this
            </Button>
            <Button variant="outline" size="sm" onClick={onEditManual}>
              Edit
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-dashed bg-muted/10 p-3 text-xs text-muted-foreground">
          Couldn't auto-detect a run command for this project. It might be a
          stack we don't template yet, or the entry point isn't obvious from
          the file tree.
        </div>
      )}

      <div className="rounded-md border bg-amber-500/5 p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs">
          <Sparkles className="size-3.5 text-amber-500 shrink-0" />
          <span className="font-medium">Ask the agent to set up your local dev services</span>
        </div>
        <div className="text-xs text-muted-foreground">
          The agent inspects the repo with full chat context (it sees what
          you've built in this conversation) and proposes a run config. The
          steps appear in chat — same flow as merging a worktree.
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onAskAgent}
            disabled={askingAgent || !hasActiveConversation}
          >
            {askingAgent ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            Ask the agent
          </Button>
          {!hasActiveConversation && (
            <span className="text-xs text-muted-foreground">Open a chat first.</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Configured service card ─────────────────────────────────────────────────
// One card per project in v1 — displays the saved manifest + whichever
// instance (live or most recent) best represents "the service." Stopped
// services don't vanish; the card stays, status dot reflects state.
// Refactor to multi-service later replaces the single card with a list of
// cards; everything else (controls, logs, etc.) stays.

function ConfiguredServiceCard({
  manifest,
  instance,
  expanded,
  onToggleExpand,
  onRun,
  onStop,
  onConfigure,
  onDelete,
}: {
  manifest: RunManifestDto
  instance: Service | null
  expanded: boolean
  onToggleExpand: () => void
  onRun: () => void
  onStop: () => void
  onConfigure: () => void
  onDelete: () => void
}) {
  const status: CardStatus = instance ? instance.status : "idle"
  const live = status === "running" || status === "starting"
  const hasLogs = instance !== null && (instance.isLive || instance.status === "crashed")

  return (
    <div className="p-3">
      <div
        className={cn(
          "rounded-md border bg-background",
          live && "border-emerald-500/30",
          status === "crashed" && "border-red-500/30",
        )}
      >
        <div className="px-3 py-2.5 flex items-center gap-3">
          <span
            className={cn(
              "inline-block size-2 rounded-full shrink-0",
              cardStatusColor(status),
              (status === "starting" || status === "stopping") && "animate-pulse",
            )}
            aria-label={status}
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium flex items-center gap-2">
              <span>Default service</span>
              <span className="text-[10px] font-mono uppercase text-muted-foreground rounded bg-muted px-1.5 py-0.5">
                {manifest.stack}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground">
                {cardStatusLabel(status)}
              </span>
            </div>
            <div className="text-xs text-muted-foreground font-mono truncate" title={manifest.start}>
              {manifest.start}
            </div>
            {instance?.error && (
              <div className="text-xs text-red-500 flex items-center gap-1 mt-0.5">
                <CircleAlert className="size-3 shrink-0" />
                <span className="truncate">{instance.error}</span>
              </div>
            )}
          </div>
          {status === "running" && instance && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    href={instance.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-md px-2 h-7 text-xs font-mono text-muted-foreground hover:bg-accent"
                    aria-label="Open in browser"
                  />
                }
              >
                <span>:{instance.port}</span>
                <ExternalLink className="size-3" />
              </TooltipTrigger>
              <TooltipContent>Open http://localhost:{instance.port}</TooltipContent>
            </Tooltip>
          )}
          <CardControls
            status={status}
            onRun={onRun}
            onStop={onStop}
            onConfigure={onConfigure}
            onDelete={onDelete}
          />
        </div>
        {hasLogs && (
          <>
            <Separator />
            <button
              type="button"
              onClick={onToggleExpand}
              className="w-full px-3 py-1.5 flex items-center gap-2 text-xs text-muted-foreground hover:bg-accent/40"
            >
              <ChevronLeft className={cn("size-3 transition-transform", expanded ? "-rotate-90" : "rotate-180")} />
              <span>{expanded ? "Hide logs" : "Show logs"}</span>
            </button>
          </>
        )}
      </div>
    </div>
  )
}

type CardStatus = Service["status"] | "idle"

function cardStatusColor(status: CardStatus): string {
  switch (status) {
    case "running": return "bg-emerald-500"
    case "starting": return "bg-amber-400"
    case "stopping": return "bg-amber-400"
    case "stopped": return "bg-muted-foreground/40"
    case "crashed": return "bg-red-500"
    case "idle": return "bg-muted-foreground/30"
  }
}

function cardStatusLabel(status: CardStatus): string {
  switch (status) {
    case "running": return "running"
    case "starting": return "starting…"
    case "stopping": return "stopping…"
    case "stopped": return "stopped"
    case "crashed": return "crashed"
    case "idle": return "not started"
  }
}

function CardControls({
  status,
  onRun,
  onStop,
  onConfigure,
  onDelete,
}: {
  status: CardStatus
  onRun: () => void
  onStop: () => void
  onConfigure: () => void
  onDelete: () => void
}) {
  const live = status === "running" || status === "starting"
  const stopping = status === "stopping"
  return (
    <div className="flex items-center gap-0.5 shrink-0">
      {live ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={(e) => { e.stopPropagation(); onStop() }}
                disabled={stopping}
                aria-label="Stop"
              />
            }
          >
            {stopping ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
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
                onClick={(e) => { e.stopPropagation(); onRun() }}
                aria-label="Run"
              />
            }
          >
            <Play className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Run</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={(e) => { e.stopPropagation(); onConfigure() }}
              aria-label="Configure"
            />
          }
        >
          <Sparkles className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>Configure</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-red-500"
              onClick={(e) => { e.stopPropagation(); onDelete() }}
              aria-label="Delete"
            />
          }
        >
          <Trash2 className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>Delete configuration</TooltipContent>
      </Tooltip>
    </div>
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
