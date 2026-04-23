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
  ChevronUp,
  ChevronDown,
  Cloud,
  CloudOff,
  Link2,
  Unlink,
  Sparkles,
  Settings2,
  ArrowDownToLine,
  Plus,
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
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { SearchAddon } from "@xterm/addon-search"
import "@xterm/xterm/css/xterm.css"
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
import type { Service, LogLine, ProjectService } from "@/models"
import type {
  RunManifestDto,
  RunnerId,
  ProjectServiceWriteDto,
  DetectedServiceCandidate,
} from "@/models/ServiceList.model"
import {
  SERVICES_PROPOSED_EVENT,
  consumeLatestServicesProposal,
  type ServicesProposedEventDetail,
} from "@/lib/hooks/services-proposal"

// Editor state shape. `serviceName` identifies which row we're editing; the
// first-run flow seeds it to "default" but users can rename in the editor.
// `isNew` distinguishes POST (create) from PUT (update) at save time.
type EditorInitial = Partial<
  RunManifestDto & {
    name?: string
    description?: string | null
    enabled?: boolean
    restart_policy?: "always" | "on-failure" | "never"
    max_restarts?: number
  }
>
type EditorState = {
  mode: "first-run" | "edit-project" | "add-service"
  projectId: string
  conversationId: string | null
  label: string | null
  serviceName: string
  isNew: boolean
  initial: EditorInitial
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

// What the editor emits on save. Superset of RunManifestDto so we can carry
// supervisor / name fields end-to-end without widening the Service model.
type EditorOutput = RunManifestDto & {
  name?: string
  description?: string | null
  enabled?: boolean
  restart_policy?: "always" | "on-failure" | "never"
  max_restarts?: number
}

// Round-trip a ProjectService row back into the write shape accepted by
// PUT /api/projects/:id/services/:name. Keeps reorder / enable-toggle
// updates free of "which fields do I have to re-send" bugs.
function serviceToWrite(row: ProjectService): ProjectServiceWriteDto {
  return {
    name: row.name,
    description: row.description,
    stack: row.stack,
    start: row.start,
    build: row.build,
    env: row.env,
    port: row.port,
    dockerfile: row.dockerfile,
    healthcheck: row.healthcheck,
    enabled: row.enabled,
    order_index: row.orderIndex,
    restart_policy: row.restartPolicy,
    max_restarts: row.maxRestarts,
  }
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
  // `+ Add` opens the picker (detected candidates + Ask agent + manual).
  // Full editor only opens via the picker's gear icon or when editing an
  // existing service — matches the "no-config-by-default" guidance.
  const [pickerOpen, setPickerOpen] = useState(false)
  // Agent-seeded proposals: when a `<run-services>` block lands in chat,
  // we open the picker pre-populated with that list. Null = nothing seeded
  // currently. Drained when the picker opens.
  const [seededProposals, setSeededProposals] = useState<DetectedServiceCandidate[] | null>(null)
  const [runnerId, setRunnerId] = useState<RunnerId>("local-process")

  // Listen for agent-proposed services. The event fires in the hook
  // (src/lib/hooks/services-proposal.ts) whenever an assistant message
  // contains a `<run-services>` / `<run-manifest>` block. If the panel is
  // already mounted we drain the mailbox here; App.tsx ensures the panel
  // mounts in response to the same event.
  useEffect(() => {
    // Drain any proposal that arrived before we mounted.
    const pending = consumeLatestServicesProposal()
    if (pending && pending.candidates.length > 0) {
      setSeededProposals(pending.candidates)
      setPickerOpen(true)
    }
    const onProposed = (ev: Event) => {
      const detail = (ev as CustomEvent<ServicesProposedEventDetail>).detail
      if (!detail || detail.candidates.length === 0) return
      setSeededProposals(detail.candidates)
      setPickerOpen(true)
    }
    window.addEventListener(SERVICES_PROPOSED_EVENT, onProposed)
    return () => window.removeEventListener(SERVICES_PROPOSED_EVENT, onProposed)
  }, [])

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

  // Scope discriminator for instance matching (Phase 9.2). null = chat on
  // the project's main cwd; any path = task worktree (isolated bucket).
  const scopeWorktreePath = active?.worktreePath ?? null

  // Silent refresh by design — the background poll catches services
  // started in another tab / session. The user doesn't need a spinner
  // every five seconds; per-service SSE (subscribeLogs) already updates
  // live status for anything we're already tracking.
  const silentRefresh = useCallback(() => {
    if (!userId) return
    void services.refresh(userId, { silent: true }).catch((err) => {
      console.error("[services] refresh failed", err)
    })
  }, [userId, services])

  useEffect(() => {
    silentRefresh()
    void services.refreshRunners()
    if (userId) void services.refreshRailwayIntegration(userId)
    const t = window.setInterval(silentRefresh, 5000)
    return () => window.clearInterval(t)
  }, [silentRefresh, services, userId])

  // Live project-services list (one row per configured service). Auto-
  // refreshed when active project changes via workspace.setActiveProject,
  // but we refetch on panel mount too — covers the "reopen panel after an
  // agent added a service" case without relying on setActiveProject firing.
  const projectServices = workspace.projectServices
  useEffect(() => {
    if (!userId || !targetProjectId) return
    void projectServices.refresh(userId, targetProjectId).catch(() => {
      /* surfaced via lastError */
    })
    // Re-pull on every turn-done — the agent may have emitted a
    // <run-services> or <run-manifest> block that the server reconciled.
    const onTurnDone = () => {
      if (userId && targetProjectId) {
        void projectServices.refresh(userId, targetProjectId).catch(() => {})
      }
    }
    window.addEventListener("ai-coder:turn-done", onTurnDone)
    return () => window.removeEventListener("ai-coder:turn-done", onTurnDone)
  }, [userId, targetProjectId, projectServices])

  // Keep the heuristic detection probe for the empty-state UX only (first-
  // run flow, pre-save). Once a project has any service row, we render
  // cards from projectServices and skip this.
  const [detectionProbe, setDetectionProbe] = useState<{
    loading: boolean
    detected: RunManifestDto | null
    cwd: string
  } | null>(null)

  useEffect(() => {
    if (!userId || !targetProjectId) {
      setDetectionProbe(null)
      return
    }
    // Skip the probe if the project already has at least one configured
    // service — we only need heuristic detection for the initial setup.
    if (projectServices.loadedProjectId === targetProjectId && projectServices.items.length > 0) {
      setDetectionProbe(null)
      return
    }
    let cancelled = false
    setDetectionProbe((prev) => prev ? { ...prev, loading: true } : { loading: true, detected: null, cwd: "" })
    void services
      .fetchProjectManifest(userId, targetProjectId, active?.id ?? null)
      .then((view) => {
        if (cancelled) return
        setDetectionProbe({ loading: false, detected: view.detected, cwd: view.cwd })
      })
      .catch(() => {
        if (cancelled) return
        setDetectionProbe({ loading: false, detected: null, cwd: "" })
      })
    return () => { cancelled = true }
  }, [userId, targetProjectId, services, active?.id, projectServices.loadedProjectId, projectServices.items.length])

  // Ask-the-agent lifecycle has two phases:
  //   'posting'    → HTTP request in flight (button shows spinner)
  //   'waiting'    → agent is working; card shows "Configuring…" state
  //   null         → idle (regular empty state or card)
  //
  // `ai-coder:turn-done` only fires for client-initiated turns (runTurn).
  // Server-initiated scripted turns (detect-services, merge, verify-run) go
  // straight through startRunner and never dispatch that event — so we can't
  // rely on it here. Instead we poll the manifest endpoint while waiting and
  // clear the phase the moment `cached` flips to non-null (reconcile saved).
  const [configurePhase, setConfigurePhase] = useState<"posting" | "waiting" | null>(null)

  useEffect(() => {
    if (configurePhase !== "waiting") return
    if (!userId || !targetProjectId) return

    let cancelled = false
    const maxMs = 90_000
    const startedAt = Date.now()

    const probeOnce = async () => {
      if (cancelled) return false
      try {
        await projectServices.refresh(userId, targetProjectId)
        if (cancelled) return false
        // Any saved service row means the agent has completed configuring.
        if (projectServices.items.length > 0) {
          setConfigurePhase(null)
          return true
        }
      } catch {
        /* keep polling */
      }
      return false
    }

    // First probe immediately (the agent might have finished between the
    // POST response and this effect running), then every 1.5s until saved
    // or we hit the safety deadline.
    void probeOnce()
    const interval = window.setInterval(async () => {
      const elapsed = Date.now() - startedAt
      if (elapsed > maxMs) {
        if (!cancelled) setConfigurePhase(null)
        window.clearInterval(interval)
        return
      }
      const hit = await probeOnce()
      if (hit) window.clearInterval(interval)
    }, 1500)

    // Also clear on client-initiated turn-done, in case the user sends a
    // chat that the agent replies to during the configuring window.
    const onTurnDone = () => setConfigurePhase(null)
    window.addEventListener("ai-coder:turn-done", onTurnDone)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener("ai-coder:turn-done", onTurnDone)
    }
  }, [configurePhase, userId, targetProjectId, projectServices])

  const onAskAgent = async () => {
    if (!userId || !active?.id) {
      toast.error("Open a chat to ask the agent", {
        description: "Service setup piggy-backs on the active conversation so the agent sees what you've been building.",
      })
      return
    }
    setConfigurePhase("posting")
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
      setConfigurePhase("waiting")
      toast.info("Configuring services…", {
        description: "The agent is inspecting the repo — follow along in chat.",
      })
    } catch (err) {
      setConfigurePhase(null)
      toast.error("Couldn't ask agent", { description: (err as Error).message })
    }
  }

  const startCached = useCallback(async (projectId: string, serviceName: string, conversationId: string | null, label: string | null) => {
    if (!userId) return
    try {
      await services.start({ userId, projectId, conversationId, serviceName, label, runnerId })
      toast.success(`${serviceName} started`, {
        description: runnerId === "local-docker" ? "Building image…" : undefined,
      })
    } catch (err) {
      toast.error(`Couldn't start ${serviceName}`, { description: (err as Error).message })
    }
  }, [userId, services, runnerId])

  const onStart = async (serviceName: string) => {
    if (!userId || !targetProjectId) return
    const row = projectServices.findByName(serviceName)
    if (!row) {
      toast.error(`Service '${serviceName}' not found`)
      return
    }
    await startCached(targetProjectId, serviceName, active?.id ?? null, row.description ?? targetLabel)
  }

  // Swap order_index with the adjacent row in the sorted list. Clamps at
  // the ends. Writes both rows so the ordering is stable across reloads.
  // Persists via PUT on each service so the server's trigger bumps
  // updated_at and we get canonical new values back.
  const onReorder = async (row: ProjectService, direction: "up" | "down") => {
    if (!userId || !targetProjectId) return
    const sorted = projectServices.sortedServices
    const idx = sorted.findIndex((s) => s.id === row.id)
    if (idx < 0) return
    const targetIdx = direction === "up" ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= sorted.length) return
    const other = sorted[targetIdx]
    // Work on a copy of the field so we can round-trip through the PUT
    // shape without dragging unrelated fields.
    const rowFields = serviceToWrite(row)
    const otherFields = serviceToWrite(other)
    rowFields.order_index = other.orderIndex
    otherFields.order_index = row.orderIndex
    try {
      await Promise.all([
        projectServices.update(userId, targetProjectId, row.name, rowFields),
        projectServices.update(userId, targetProjectId, other.name, otherFields),
      ])
    } catch (err) {
      toast.error("Couldn't reorder", { description: (err as Error).message })
    }
  }

  // Run all *enabled* services in order_index order. Sequential so we see
  // clean log separation and so Docker-runner builds don't fight for CPU.
  const onRunAll = async () => {
    if (!userId || !targetProjectId) return
    const rows = projectServices.sortedServices.filter((s) => s.enabled)
    if (rows.length === 0) return
    for (const r of rows) {
      await startCached(targetProjectId, r.name, active?.id ?? null, r.description ?? r.name)
    }
  }

  const onEditService = (row: ProjectService) => {
    if (!userId || !targetProjectId) return
    setEditor({
      mode: "edit-project",
      projectId: targetProjectId,
      conversationId: active?.id ?? null,
      label: targetLabel,
      serviceName: row.name,
      isNew: false,
      initial: {
        stack: row.stack,
        start: row.start,
        build: row.build ?? undefined,
        env: row.env,
        port: row.port ?? undefined,
        name: row.name,
        description: row.description,
        enabled: row.enabled,
        restart_policy: row.restartPolicy,
        max_restarts: row.maxRestarts,
      },
      detected: detectionProbe?.detected ?? null,
      cwd: detectionProbe?.cwd ?? activeProject?.cwd ?? "",
    })
  }

  // + Add opens the picker (detected list + Ask agent + manual). Manual
  // path from within the picker opens the full editor.
  const onAddService = () => {
    if (!userId || !targetProjectId) return
    setPickerOpen(true)
  }

  const openManualEditor = () => {
    if (!userId || !targetProjectId) return
    setPickerOpen(false)
    setEditor({
      mode: "add-service",
      projectId: targetProjectId,
      conversationId: active?.id ?? null,
      label: targetLabel,
      serviceName: "",
      isNew: true,
      initial: {
        stack: "custom",
        start: "",
        env: {},
        name: "",
        enabled: true,
        restart_policy: "on-failure",
        max_restarts: 5,
      },
      detected: null,
      cwd: detectionProbe?.cwd ?? activeProject?.cwd ?? "",
    })
  }

  // Save a detected candidate (skips the editor). When `run` is true, also
  // starts it immediately and fires verify-run when a conversation is
  // active — matches the old "Use & run" shortcut behaviour.
  const saveCandidate = async (cand: DetectedServiceCandidate, run: boolean) => {
    if (!userId || !targetProjectId) return
    try {
      await projectServices.create(userId, targetProjectId, {
        name: cand.name,
        stack: cand.stack,
        start: cand.start,
        build: cand.build ?? null,
        env: cand.env,
        port: cand.port ?? null,
      })
      if (!run) {
        toast.success(`${cand.name} saved`)
        return
      }
      const snap = await services.start({
        userId,
        projectId: targetProjectId,
        conversationId: active?.id ?? null,
        serviceName: cand.name,
        label: cand.rationale,
        runnerId,
      })
      toast.success(`${cand.name} started`, {
        description: active?.id ? "Asking the agent to watch the output…" : undefined,
      })
      if (active?.id) {
        try {
          await services.verifyRun(userId, active.id, snap.id)
        } catch (err) {
          console.warn("[verify-run] queue failed:", (err as Error).message)
        }
      }
    } catch (err) {
      toast.error("Couldn't save", { description: (err as Error).message })
    }
  }

  // Open the full editor prefilled from a detected candidate — the "gear"
  // icon path when the user wants to tweak before saving.
  const editCandidate = (cand: DetectedServiceCandidate) => {
    if (!userId || !targetProjectId) return
    setPickerOpen(false)
    setEditor({
      mode: "add-service",
      projectId: targetProjectId,
      conversationId: active?.id ?? null,
      label: targetLabel,
      serviceName: cand.name,
      isNew: true,
      initial: {
        name: cand.name,
        stack: cand.stack,
        start: cand.start,
        build: cand.build,
        env: cand.env,
        port: cand.port,
        enabled: true,
        restart_policy: "on-failure",
        max_restarts: 5,
      },
      detected: null,
      cwd: detectionProbe?.cwd ?? activeProject?.cwd ?? "",
    })
  }

  const onSaveAndMaybeRun = async (
    manifest: EditorOutput,
    run: boolean,
    scope: "project" | "task" = "project"
  ) => {
    if (!userId || !editor) return
    const rawName = (manifest.name ?? "").trim()
    const name =
      editor.mode === "first-run" ? "default" :
      rawName || editor.serviceName || "default"

    try {
      // Task-scoped save: write per-conversation override, don't touch the
      // project row. No rename/create — override is keyed by the existing
      // service name. Requires an active conversation.
      if (scope === "task" && editor.conversationId) {
        const override: Partial<RunManifestDto> = {
          stack: manifest.stack,
          start: manifest.start,
          env: manifest.env,
        }
        if (manifest.build !== undefined) override.build = manifest.build
        if (manifest.port !== undefined) override.port = manifest.port
        await services.saveServiceOverride(userId, editor.conversationId, name, override)
        const snap = editor
        setEditor(null)
        if (run) {
          await startCached(snap.projectId, name, snap.conversationId, snap.label)
        } else {
          toast.success(`Task override saved for ${name}`)
        }
        return
      }

      const write: ProjectServiceWriteDto = {
        name,
        stack: manifest.stack,
        start: manifest.start,
        env: manifest.env,
        build: manifest.build ?? null,
        port: manifest.port ?? null,
      }
      if (manifest.description !== undefined) write.description = manifest.description
      if (manifest.enabled !== undefined) write.enabled = manifest.enabled
      if (manifest.restart_policy !== undefined) write.restart_policy = manifest.restart_policy
      if (manifest.max_restarts !== undefined) write.max_restarts = manifest.max_restarts
      if (editor.isNew || editor.serviceName !== name) {
        const existing = projectServices.findByName(name)
        if (existing) {
          await projectServices.update(userId, editor.projectId, name, write)
        } else {
          await projectServices.create(userId, editor.projectId, write)
          if (!editor.isNew && editor.serviceName && editor.serviceName !== name) {
            await projectServices.remove(userId, editor.projectId, editor.serviceName).catch(() => undefined)
          }
        }
      } else {
        await projectServices.update(userId, editor.projectId, name, write)
      }
      const snap = editor
      setEditor(null)
      if (run) {
        await startCached(snap.projectId, name, snap.conversationId, snap.label)
      } else {
        toast.success(name === "default" ? "Start command saved" : `${name} saved`)
      }
    } catch (err) {
      toast.error("Couldn't save", { description: (err as Error).message })
    }
  }

  // Fetch the current task's overrides when the editor opens so the footer
  // knows whether to show the "Save for task" / "Clear override" buttons.
  // Also gives us the override values for merging into the initial fields
  // (user sees what they've overridden if they re-open the editor).
  const [hasTaskOverride, setHasTaskOverride] = useState(false)
  useEffect(() => {
    if (!editor || !editor.conversationId || !userId) {
      setHasTaskOverride(false)
      return
    }
    // Only tasks (with a worktree) get per-conversation overrides — a chat
    // on main cwd shares state with every other chat, overriding there
    // would surprise the user. Cheap check: the active conv has a path.
    if (!active?.worktreePath) {
      setHasTaskOverride(false)
      return
    }
    let cancelled = false
    void services
      .fetchServiceOverride(userId, editor.conversationId, editor.serviceName || "default")
      .then((ovr) => {
        if (!cancelled) setHasTaskOverride(!!ovr)
      })
      .catch(() => {
        if (!cancelled) setHasTaskOverride(false)
      })
    return () => { cancelled = true }
  }, [editor, userId, active?.worktreePath, services])

  const onClearOverride = async () => {
    if (!editor || !editor.conversationId || !userId) return
    try {
      await services.clearServiceOverride(
        userId,
        editor.conversationId,
        editor.serviceName || "default"
      )
      setEditor(null)
      toast.success("Task override cleared")
    } catch (err) {
      toast.error("Couldn't clear override", { description: (err as Error).message })
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

  // Delete a single service row. Stops its matching instance first (best-
  // effort) so the user doesn't have to stop-then-delete.
  const confirm = useConfirm()
  const onDeleteService = async (row: ProjectService) => {
    if (!userId || !targetProjectId) return
    const ok = await confirm({
      title: `Delete '${row.name}'?`,
      description: "Removes the saved configuration for this service. Any running instance will be stopped first. You can re-add or ask the agent to set it up again.",
      confirmText: "Delete",
      variant: "destructive",
    })
    if (!ok) return
    try {
      const projectInstances = services.items.filter(
        (s) => s.projectId === targetProjectId && s.serviceName === row.name
      )
      for (const inst of projectInstances) {
        if (inst.isLive) {
          await services.stop(userId, inst.id).catch(() => undefined)
        }
        await services.remove(userId, inst.id).catch(() => undefined)
      }
      await projectServices.remove(userId, targetProjectId, row.name)
      if (selectedId === row.name) setSelectedId(null)
      toast.success("Service configuration removed")
    } catch (err) {
      toast.error("Couldn't delete", { description: (err as Error).message })
    }
  }

  // Match a configured service to its most relevant instance within the
  // current scope (chat on main cwd = worktreePath null; task = worktree
  // path exact match). Live instance beats most-recent stopped one.
  const findInstance = (name: string): Service | null => {
    if (!targetProjectId) return null
    const candidates = services.items.filter(
      (s) =>
        s.projectId === targetProjectId &&
        s.serviceName === name &&
        s.worktreePath === scopeWorktreePath
    )
    return (
      candidates.find((s) => s.isLive) ??
      [...candidates].sort((a, b) => b.startedAt - a.startedAt)[0] ??
      null
    )
  }

  // Selection drives the log pane. Keyed by service name so a stopped
  // service can still have its logs expanded until a new run overwrites.
  const selectedRow = selectedId ? projectServices.findByName(selectedId) : null
  const selectedInstance = selectedRow ? findInstance(selectedRow.name) : null

  if (editor) {
    return (
      <ManifestEditor
        state={editor}
        hasTaskOverride={hasTaskOverride || (!!editor.conversationId && !!active?.worktreePath)}
        onCancel={() => setEditor(null)}
        onSave={(m, run, scope) => { void onSaveAndMaybeRun(m, run, scope) }}
        onClearOverride={hasTaskOverride ? () => { void onClearOverride() } : undefined}
      />
    )
  }

  const configuredServices = projectServices.sortedServices
  const hasConfigured = configuredServices.length > 0
  // Gate the picker auto-open on the services list having loaded for
  // THIS project. Without this, the panel briefly flashes the picker on
  // mount (items empty → "no services" → picker) before the initial
  // refresh settles and reveals the real list. Explicit "+ Add" still
  // opens the picker regardless of load state.
  const projectServicesLoaded = projectServices.loadedProjectId === targetProjectId

  const showPicker = pickerOpen || (projectServicesLoaded && !hasConfigured)
  if (showPicker && userId && targetProjectId) {
    return (
      <ServicePicker
        userId={userId}
        projectId={targetProjectId}
        conversationId={active?.id ?? null}
        hasActiveConversation={!!active?.id}
        configurePhase={configurePhase}
        dismissible={hasConfigured}
        seededProposals={seededProposals}
        onConsumeSeed={() => setSeededProposals(null)}
        onClose={() => {
          setSeededProposals(null)
          setPickerOpen(false)
        }}
        // Don't close on save — users commonly pick several candidates in a
        // row. When they're done, they hit the back arrow (dismissible) or
        // stay in the auto-hide empty state until a save surfaces the list.
        onSaveCandidate={(cand, run) => { void saveCandidate(cand, run) }}
        onEditCandidate={editCandidate}
        onAddManually={openManualEditor}
        onAskAgent={() => { void onAskAgent() }}
      />
    )
  }

  const listBody = hasConfigured ? (
    <div className="p-3 space-y-2">
      {configuredServices.map((row, idx) => {
        const inst = findInstance(row.name)
        const expandedHere = selectedId === row.name && !!inst
        // Reorder controls only make sense when there's more than one row.
        // Disable at the ends instead of hiding so the layout doesn't shift.
        const canMove = configuredServices.length > 1
        const canMoveUp = canMove && idx > 0
        const canMoveDown = canMove && idx < configuredServices.length - 1
        return (
          <ConfiguredServiceCard
            key={row.id}
            row={row}
            instance={inst}
            expanded={expandedHere}
            onToggleExpand={() =>
              setSelectedId((prev) => (prev === row.name ? null : row.name))
            }
            onRun={() => { void onStart(row.name) }}
            onStop={() => {
              if (inst) void onStop(inst)
            }}
            onConfigure={() => onEditService(row)}
            onDelete={() => { void onDeleteService(row) }}
            onMoveUp={canMove ? () => { void onReorder(row, "up") } : undefined}
            onMoveDown={canMove ? () => { void onReorder(row, "down") } : undefined}
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
            onCheckWithAgent={inst && active?.id ? async () => {
              if (!userId) return
              try {
                await services.verifyRun(userId, active.id, inst.id)
                toast.info("Asked the agent to check", {
                  description: "Watch the chat — it'll read the service's output and confirm or diagnose.",
                })
              } catch (err) {
                toast.error("Couldn't ask agent", { description: (err as Error).message })
              }
            } : undefined}
          />
        )
      })}
    </div>
  ) : !projectServicesLoaded ? (
    // Stable placeholder while the services list fetches. Without this,
    // the body flashes empty until the picker or the cards resolve.
    <div className="p-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      <span>Loading services…</span>
    </div>
  ) : null // picker handles the post-load empty case before we get here

  // Header button layout:
  //   (empty state)  → [RunnerSelect]  Run
  //   (configured)   → [RunnerSelect]  + Add service  Run all
  // Run all runs every *enabled* service in order. + Add opens a blank
  // editor with name=""; user picks the name + fills the start command.
  const canRunAll =
    hasConfigured && configuredServices.some((s) => s.enabled)

  return (
    <div className="flex flex-col h-full relative">
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        <Server className="size-4" />
        <div className="text-sm font-medium">Services</div>
        <div className="flex-1" />
        <RunnerSelect value={runnerId} onChange={setRunnerId} />
        {/* Always render the same Add + Run-all pair to keep header
            layout stable while the services list is still loading.
            Run-all is disabled until we have at least one enabled row;
            Add stays enabled so the picker is one click away. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                onClick={onAddService}
                disabled={!canStart}
                aria-label="Add service"
              />
            }
          >
            <Plus className="size-3.5" />
            Add
          </TooltipTrigger>
          <TooltipContent>Add another service (api, worker, …)</TooltipContent>
        </Tooltip>
        <Button
          size="sm"
          onClick={() => { void onRunAll() }}
          disabled={!canStart || !canRunAll}
        >
          <Play className="size-3.5" />
          Run all
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

      {selectedInstance ? (
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
            <LogViewer key={selectedInstance.id} svc={selectedInstance} />
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

// Parse dotenv-style "KEY=value" lines. Trims both sides, drops blank lines
// and comments, strips matching surrounding single/double quotes so values
// like `FOO="bar baz"` don't end up with literal quotes in the env.
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const idx = line.indexOf("=")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (!key) continue
    let value = line.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function formatEnv(env: Record<string, string> | undefined): string {
  if (!env) return ""
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n")
}

function ManifestEditor({
  state,
  hasTaskOverride,
  onCancel,
  onSave,
  onClearOverride,
}: {
  state: EditorState
  /** True when the active conversation has a worktree — enables the "save
   *  as task override" button. Otherwise there's no task scope to write to. */
  hasTaskOverride: boolean
  onCancel: () => void
  onSave: (
    m: EditorOutput,
    runAfterSave: boolean,
    scope: "project" | "task"
  ) => void
  /** Clears the current task's override for this service. Only rendered
   *  when `hasTaskOverride` is true. */
  onClearOverride?: () => void
}) {
  const init = state.initial
  const [name, setName] = useState<string>((init.name ?? state.serviceName) ?? "")
  const [description, setDescription] = useState<string>(init.description ?? "")
  const [stack, setStack] = useState<string>(init.stack ?? "custom")
  const [start, setStart] = useState<string>(init.start ?? "")
  const [build, setBuild] = useState<string>(init.build ?? "")
  const [portText, setPortText] = useState<string>(init.port != null ? String(init.port) : "")
  const [envText, setEnvText] = useState<string>(formatEnv(init.env))
  const [enabled, setEnabled] = useState<boolean>(init.enabled ?? true)
  const [restartPolicy, setRestartPolicy] = useState<"always" | "on-failure" | "never">(
    init.restart_policy ?? "on-failure"
  )
  const [maxRestartsText, setMaxRestartsText] = useState<string>(
    init.max_restarts != null ? String(init.max_restarts) : "5"
  )
  // Track user edits so LLM arrival doesn't clobber manual typing. Keyed by
  // mode-projectId so "regenerating" for a different scope resets the guard.
  const editedRef = useRef(false)
  const scopeKey = `${state.mode}:${state.projectId}:${state.serviceName}`
  useEffect(() => { editedRef.current = false }, [scopeKey])

  // When the parent updates `state.initial` (e.g. LLM detection resolved),
  // refill the fields — but only if the user hasn't already typed something.
  useEffect(() => {
    if (editedRef.current) return
    setStack(init.stack ?? "custom")
    setStart(init.start ?? "")
    setBuild(init.build ?? "")
    setPortText(init.port != null ? String(init.port) : "")
    setEnvText(formatEnv(init.env))
  }, [init.stack, init.start, init.build, init.port, init.env])

  const markEdited = () => { editedRef.current = true }

  const isFirstRun = state.mode === "first-run"
  const isAddService = state.mode === "add-service"
  const showNameField = isAddService
  // Supervisor section is noise on first-run (everyone starts with the
  // defaults); only surface it when the user is clearly configuring, not
  // confirming. Advanced toggle lets them see it if they want.
  const [showAdvanced, setShowAdvanced] = useState(!isFirstRun)
  const llmPending = state.llm?.status === "pending"
  // In add-service mode, require a name. Lowercase-friendly, no spaces.
  const nameValid = !showNameField || /^[a-zA-Z0-9_-]{1,40}$/.test(name.trim())
  const canSave = !!start.trim() && !llmPending && nameValid

  const handleSubmit = (run: boolean, scope: "project" | "task" = "project") => {
    if (!canSave) return
    const manifest: EditorOutput = {
      stack,
      start: start.trim(),
      cwd: state.cwd,
      env: parseEnv(envText),
    }
    if (build.trim()) manifest.build = build.trim()
    const portNum = parseInt(portText.trim(), 10)
    if (Number.isFinite(portNum) && portNum >= 1024 && portNum <= 65535) {
      manifest.port = portNum
    }
    if (showNameField) manifest.name = name.trim()
    // Only carry supervisor fields through on project-scoped saves; task
    // overrides don't touch the service row, so they'd be ignored anyway.
    if (scope === "project" && !isFirstRun) {
      manifest.description = description.trim() || null
      manifest.enabled = enabled
      manifest.restart_policy = restartPolicy
      const n = parseInt(maxRestartsText.trim(), 10)
      if (Number.isFinite(n) && n >= 0) manifest.max_restarts = n
    }
    onSave(manifest, run, scope)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        <Button variant="ghost" size="sm" onClick={onCancel} aria-label="Back">
          <ChevronLeft className="size-4" />
        </Button>
        <div className="text-sm font-medium">
          {isFirstRun
            ? "How do you run this app?"
            : isAddService
              ? "Add a service"
              : `Edit ${state.serviceName}`}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-4 py-3 space-y-4">
        <div className="text-xs text-muted-foreground">
          <div>
            {isFirstRun
              ? "Confirm the command we'll use to start this project. Saved to the project, used for every Run."
              : isAddService
                ? "Define an additional service (api, worker, …). Each service runs as its own process and gets its own port."
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

        {showNameField && (
          <label className="block space-y-1">
            <div className="text-xs font-medium">Name</div>
            <Input
              value={name}
              onChange={(e) => { setName(e.target.value); markEdited() }}
              placeholder="e.g. api, worker, web"
              className="font-mono text-sm"
              autoFocus
            />
            <div className="text-xs text-muted-foreground">
              Short identifier, unique within this project. Lowercase letters,
              digits, <code>_</code>, <code>-</code>.
            </div>
          </label>
        )}

        {!isFirstRun && (
          <label className="block space-y-1">
            <div className="text-xs font-medium">
              Description <span className="text-muted-foreground">(optional)</span>
            </div>
            <Input
              value={description}
              onChange={(e) => { setDescription(e.target.value); markEdited() }}
              placeholder="What this service does"
              className="text-sm"
            />
          </label>
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
            autoFocus={!showNameField}
          />
          <div className="text-xs text-muted-foreground">
            The host injects <code className="font-mono">PORT</code> as an env var. Use <code className="font-mono">$PORT</code> inline if your command needs the port as an argument.
          </div>
        </label>

        <label className="block space-y-1">
          <div className="text-xs font-medium">
            Bind port <span className="text-muted-foreground">(optional)</span>
          </div>
          <Input
            type="number"
            inputMode="numeric"
            min={1024}
            max={65535}
            value={portText}
            onChange={(e) => { setPortText(e.target.value); markEdited() }}
            placeholder="e.g. 3000"
            className="font-mono text-sm w-32"
          />
          <div className="text-xs text-muted-foreground">
            The port your app listens on by default (e.g. <code>3000</code>, <code>5173</code>, <code>8000</code>). We'll try to bind here first so URLs stay stable — if taken, we fall through to <code className="font-mono">4100–4999</code>.
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

        {!isFirstRun && (
          <div className="pt-2">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <ChevronLeft className={cn("size-3 transition-transform", showAdvanced ? "-rotate-90" : "rotate-180")} />
              <span>{showAdvanced ? "Hide advanced" : "Advanced (supervisor, enabled)"}</span>
            </button>
          </div>
        )}

        {!isFirstRun && showAdvanced && (
          <div className="space-y-4 border-t pt-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => { setEnabled(e.target.checked); markEdited() }}
                className="size-4 rounded border"
              />
              <span className="text-xs font-medium">Enabled</span>
              <span className="text-xs text-muted-foreground">
                — included in <span className="font-medium">Run all</span>.
              </span>
            </label>

            <label className="block space-y-1">
              <div className="text-xs font-medium">Restart policy</div>
              <select
                value={restartPolicy}
                onChange={(e) => { setRestartPolicy(e.target.value as typeof restartPolicy); markEdited() }}
                className="w-full h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="never">never — no auto-restart</option>
                <option value="on-failure">on-failure — restart on crash (default)</option>
                <option value="always">always — restart even on clean exit</option>
              </select>
              <div className="text-xs text-muted-foreground">
                The supervisor uses exponential backoff (1s, 2s, 4s, …) capped
                at 30s. Counter resets once the process stays up past 10s.
              </div>
            </label>

            <label className="block space-y-1">
              <div className="text-xs font-medium">Max restarts</div>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={50}
                value={maxRestartsText}
                onChange={(e) => { setMaxRestartsText(e.target.value); markEdited() }}
                className="font-mono text-sm w-32"
                disabled={restartPolicy === "never"}
              />
              <div className="text-xs text-muted-foreground">
                After this many consecutive fast failures, the supervisor
                gives up and posts a notice in chat.
              </div>
            </label>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-4 py-3 border-t flex-wrap">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {hasTaskOverride && onClearOverride && !isFirstRun && !isAddService && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onClearOverride}
                  aria-label="Clear task override"
                />
              }
            >
              Clear task override
            </TooltipTrigger>
            <TooltipContent>
              Removes this task's override, falling back to the project config.
            </TooltipContent>
          </Tooltip>
        )}
        <div className="flex-1" />
        {hasTaskOverride && !isFirstRun && !isAddService && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canSave}
                  onClick={() => handleSubmit(false, "task")}
                  aria-label="Save as task override"
                />
              }
            >
              Save for task
            </TooltipTrigger>
            <TooltipContent>
              Save only for this task (conversation-level override). Project
              config stays unchanged.
            </TooltipContent>
          </Tooltip>
        )}
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

// ── Service picker ──────────────────────────────────────────────────────────
// Opens either as the empty state (project has zero services) or when the
// user clicks "+ Add" on a project that already has services. Presents:
//   • One card per auto-detected candidate (root + subdirs + apps/* etc.)
//     — each with Run / Save / ⚙ (open full editor prefilled)
//   • "Ask the agent" — scripted turn with full chat context
//   • "+ Add manually" — blank full editor
// The full editor stays hidden by default; the ⚙ icon is the escape hatch
// for users who want to tweak a candidate before saving.

const ServicePicker = observer(function ServicePicker({
  userId,
  projectId,
  conversationId,
  hasActiveConversation,
  configurePhase,
  dismissible,
  seededProposals,
  onConsumeSeed,
  onClose,
  onSaveCandidate,
  onEditCandidate,
  onAddManually,
  onAskAgent,
}: {
  userId: string
  projectId: string
  conversationId: string | null
  hasActiveConversation: boolean
  configurePhase: "posting" | "waiting" | null
  /** True when there are already configured services — shows a Close button
   *  so the user can abort. False on the empty-state flow where there's
   *  nowhere to go back to. */
  dismissible: boolean
  /** Proposals from the agent (via ai-coder:services-proposed). When set,
   *  we prepend them to the list so they render above heuristic hits and
   *  call onConsumeSeed to clear the parent's buffer. */
  seededProposals?: DetectedServiceCandidate[] | null
  onConsumeSeed?: () => void
  onClose: () => void
  onSaveCandidate: (cand: DetectedServiceCandidate, run: boolean) => void
  onEditCandidate: (cand: DetectedServiceCandidate) => void
  onAddManually: () => void
  onAskAgent: () => void
}) {
  const services = workspace.services
  // Live set of already-configured names — drives the filter that hides
  // rows as the user saves them one by one. As an observable read, this
  // re-renders when workspace.projectServices.items grows.
  const existingNames = new Set(
    workspace.projectServices.items.map((s) => s.name)
  )
  const [loading, setLoading] = useState(true)
  const [candidates, setCandidates] = useState<DetectedServiceCandidate[]>([])
  const [error, setError] = useState<string | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  // Pending-save set keyed by `${source}:${subdir}:${name}` so the UI can
  // disable the row's buttons while the save is in flight (prevents the
  // user from double-clicking and creating twin rows).
  const [pending, setPending] = useState<Set<string>>(new Set())

  // Initial heuristic detect. AI is opt-in (button press) because it costs
  // money and takes a few seconds; no point burning either on every open.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void services
      .detectProjectServices(userId, projectId, conversationId)
      .then((res) => {
        if (cancelled) return
        setCandidates((prev) => {
          // Preserve any previously-added AI / seeded candidates; refresh
          // only the heuristic subset from the response.
          const preserved = prev.filter((c) => c.source !== "heuristic")
          const fresh = res.candidates.map((c) => ({ ...c, source: "heuristic" as const }))
          return [...fresh, ...preserved]
        })
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setError((err as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [services, userId, projectId, conversationId])

  // Drain seeded proposals (from `ai-coder:services-proposed`) into the
  // candidate list. Runs whenever the parent hands us a new seed so chat-
  // driven proposals flow in without needing to re-open the picker.
  useEffect(() => {
    if (!seededProposals || seededProposals.length === 0) return
    setCandidates((prev) => {
      // Dedupe by name: the heuristic pass may have already found the same
      // service. Agent rationale is usually richer, so agent-sourced entries
      // replace heuristic ones with the same name.
      const agentNames = new Set(seededProposals.map((c) => c.name))
      const remaining = prev.filter((c) => !agentNames.has(c.name))
      return [...seededProposals, ...remaining]
    })
    onConsumeSeed?.()
  }, [seededProposals, onConsumeSeed])

  const posting = configurePhase === "posting"

  // Dedupe by (subdir, name). AI often re-proposes what heuristic found —
  // keep the first-seen (heuristic wins on collision, since it cites a real
  // file in the tree). Saved rows stay hidden either way.
  const visible = dedupeCandidates(candidates).filter(
    (c) => !c.alreadySaved && !existingNames.has(c.name)
  )

  const runAiDetect = async () => {
    setAiLoading(true)
    setAiError(null)
    try {
      const res = await services.detectServicesWithLLM(userId, projectId, conversationId)
      if (res.error) {
        setAiError(res.error)
      }
      if (res.proposals.length > 0) {
        setCandidates((prev) => [
          ...prev,
          ...res.proposals.map((p) => ({ ...p, source: "ai" as const })),
        ])
      } else if (!res.error) {
        setAiError("No additional services found by the model.")
      }
    } catch (err) {
      setAiError((err as Error).message)
    } finally {
      setAiLoading(false)
    }
  }

  const candKey = (c: DetectedServiceCandidate) =>
    `${c.source ?? "heuristic"}:${c.subdir || "."}:${c.name}`

  const wrapSave = (cand: DetectedServiceCandidate, run: boolean) => {
    const key = candKey(cand)
    setPending((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    onSaveCandidate(cand, run)
    // Parent closes the picker on completion; keep key in pending so the
    // row visually disables until unmount. Cheap: small set, GC with the
    // component.
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        {dismissible && (
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Back">
            <ChevronLeft className="size-4" />
          </Button>
        )}
        <div className="text-sm font-medium">
          {dismissible ? "Add a service" : "Configure services"}
        </div>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void runAiDetect() }}
                disabled={aiLoading}
                aria-label="Detect with AI"
              />
            }
          >
            {aiLoading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            Detect with AI
          </TooltipTrigger>
          <TooltipContent>
            One-shot LLM scan — inspects the file tree and proposes
            candidates without touching anything.
          </TooltipContent>
        </Tooltip>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 py-4 space-y-4">
          {/* Chat-configure banner replaces the list only when the agent
              is actively in the "configuring services" loop. The AI-detect
              button above is separate — it's a sync REST call. */}
          {configurePhase === "waiting" ? (
            <div className="rounded-md border bg-amber-500/10 border-amber-500/40 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-amber-500 shrink-0 animate-pulse" />
                <div className="text-sm font-medium">Configuring services…</div>
              </div>
              <div className="text-xs text-muted-foreground">
                The agent is inspecting the repo and proposing a run config.
                Watch the chat for the step-by-step — new cards appear here
                once saved.
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Server className="size-3.5 text-emerald-500 shrink-0" />
                <div className="text-xs font-medium">Detected in your project</div>
                {loading && (
                  <Loader2 className="size-3 animate-spin text-muted-foreground" />
                )}
              </div>

              {error && (
                <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs flex items-start gap-2">
                  <CircleAlert className="size-3.5 text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-red-500">Detection failed</div>
                    <div className="text-muted-foreground">{error}</div>
                  </div>
                </div>
              )}

              {aiError && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs flex items-start gap-2">
                  <CircleAlert className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-amber-500">AI detection</div>
                    <div className="text-muted-foreground">{aiError}</div>
                  </div>
                </div>
              )}

              {!loading && !error && visible.length === 0 && !aiLoading && (
                <div className="rounded-md border border-dashed bg-muted/10 p-3 text-xs text-muted-foreground">
                  Nothing new detected automatically. Try <span className="font-medium">Detect with AI</span>,
                  ask the agent in chat, or add one manually below.
                </div>
              )}

              <div className="space-y-2">
                {visible.map((cand) => {
                  const key = candKey(cand)
                  const busy = pending.has(key)
                  return (
                    <CandidateCard
                      key={key}
                      cand={cand}
                      busy={busy}
                      onRun={() => wrapSave(cand, true)}
                      onSave={() => wrapSave(cand, false)}
                      onEdit={() => onEditCandidate(cand)}
                    />
                  )
                })}
              </div>

              {/* Conversation-aware deep setup: scripted turn via chat.
                  Use when the user wants the agent to reason WITH the
                  chat history (e.g. "add a worker for the Redis queue
                  we just scaffolded"). Auto-saves on completion. */}
              <div className="rounded-md border bg-amber-500/5 p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <Sparkles className="size-3.5 text-amber-500 shrink-0" />
                  <span className="font-medium">Configure via chat</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Runs in the active conversation with full chat context, so
                  the agent can pick up on what you've just been building.
                  It auto-saves when done.
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onAskAgent}
                    disabled={posting || !hasActiveConversation}
                  >
                    {posting ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="size-3.5" />
                    )}
                    Ask in chat
                  </Button>
                  {!hasActiveConversation && (
                    <span className="text-xs text-muted-foreground">Open a chat first.</span>
                  )}
                </div>
              </div>

              {/* Manual escape hatch. */}
              <div className="pt-1">
                <Button variant="ghost" size="sm" onClick={onAddManually}>
                  <Plus className="size-3.5" />
                  Add manually
                </Button>
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
})

// Drop later-source duplicates when (subdir, name) collide. Heuristic wins
// because its rationale cites a concrete file in the tree; AI proposals
// for the same slot are usually re-derivations of the same evidence.
function dedupeCandidates(list: DetectedServiceCandidate[]): DetectedServiceCandidate[] {
  const seen = new Set<string>()
  const out: DetectedServiceCandidate[] = []
  for (const c of list) {
    const key = `${c.subdir || "."}:${c.name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

function CandidateCard({
  cand,
  busy,
  onRun,
  onSave,
  onEdit,
}: {
  cand: DetectedServiceCandidate
  busy: boolean
  onRun: () => void
  onSave: () => void
  onEdit: () => void
}) {
  const fromAI = cand.source === "ai"
  return (
    <div
      className={cn(
        "rounded-md border bg-background",
        fromAI && "border-amber-500/30 bg-amber-500/5",
      )}
    >
      <div className="px-3 py-2.5 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{cand.name}</span>
          <span className="text-[10px] font-mono uppercase text-muted-foreground rounded bg-muted px-1.5 py-0.5">
            {cand.stack}
          </span>
          {cand.subdir && (
            <span className="text-[10px] font-mono text-muted-foreground rounded bg-muted px-1.5 py-0.5">
              {cand.subdir}/
            </span>
          )}
          {cand.port != null && (
            <span className="text-[10px] font-mono text-muted-foreground rounded bg-muted px-1.5 py-0.5">
              :{cand.port}
            </span>
          )}
          {fromAI && (
            <span className="text-[10px] font-mono uppercase rounded bg-amber-500/15 text-amber-500 px-1.5 py-0.5 inline-flex items-center gap-1">
              <Sparkles className="size-2.5" />
              AI
            </span>
          )}
          <span className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-[10px] font-mono",
            cand.confidence === "high" && "bg-emerald-500/10 text-emerald-500",
            cand.confidence === "medium" && "bg-amber-500/10 text-amber-500",
            cand.confidence === "low" && "bg-muted-foreground/10 text-muted-foreground",
          )}>
            {cand.confidence}
          </span>
        </div>
        <div className="font-mono text-xs text-muted-foreground break-all" title={cand.start}>
          {cand.start}
        </div>
        {cand.rationale && (
          <div className="text-xs text-muted-foreground">{cand.rationale}</div>
        )}
        <div className="flex items-center gap-1.5 pt-1">
          <Button size="sm" onClick={onRun} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            Run
          </Button>
          <Button variant="outline" size="sm" onClick={onSave} disabled={busy}>
            Save
          </Button>
          <div className="flex-1" />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={onEdit}
                  disabled={busy}
                  aria-label="Edit before saving"
                />
              }
            >
              <Settings2 className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Edit before saving</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

// ── Configured service card ─────────────────────────────────────────────────
// One card per configured service row (web, api, worker, …). Displays the
// saved config + whichever instance best represents "the service" in the
// current scope (live first, most-recent stopped otherwise). Stopped
// services don't vanish; the card stays, status dot reflects state.

const ConfiguredServiceCard = observer(function ConfiguredServiceCard({
  row,
  instance,
  expanded,
  onToggleExpand,
  onRun,
  onStop,
  onConfigure,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  onCheckWithAgent,
}: {
  row: ProjectService
  instance: Service | null
  expanded: boolean
  onToggleExpand: () => void
  onRun: () => void
  onStop: () => void
  onConfigure: () => void
  onDelete: () => void
  /** Undefined = hide reorder controls (only one service exists). */
  onMoveUp?: () => void
  onMoveDown?: () => void
  canMoveUp?: boolean
  canMoveDown?: boolean
  /** Supplied only when there's a live-or-recent instance AND an active
   *  conversation to send the notice into. Hidden otherwise. */
  onCheckWithAgent?: () => void
}) {
  const status: CardStatus = instance ? instance.status : "idle"
  const live = status === "running" || status === "starting"
  const hasLogs = instance !== null && (instance.isLive || instance.status === "crashed")
  const reattached = instance?.isReattached === true

  return (
    <div
      className={cn(
        "rounded-md border bg-background",
        live && "border-emerald-500/30",
        status === "crashed" && "border-red-500/30",
        !row.enabled && "opacity-60",
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
          <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
            <span className="truncate">{row.name}</span>
            <span className="text-[10px] font-mono uppercase text-muted-foreground rounded bg-muted px-1.5 py-0.5">
              {row.stack}
            </span>
            {!row.enabled && (
              <span className="text-[10px] font-mono uppercase text-muted-foreground rounded bg-muted px-1.5 py-0.5">
                disabled
              </span>
            )}
            {reattached && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className="text-[10px] font-mono uppercase rounded bg-amber-500/10 text-amber-500 px-1.5 py-0.5 cursor-help"
                      aria-label="Reattached from previous session"
                    />
                  }
                >
                  reattached
                </TooltipTrigger>
                <TooltipContent>
                  Started in a previous server session. Live logs aren't
                  available; stop and re-run to capture output.
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {row.description && (
            <div className="text-xs text-muted-foreground truncate" title={row.description}>
              {row.description}
            </div>
          )}
          <div className="text-xs text-muted-foreground font-mono truncate" title={row.start}>
            {row.start}
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
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          onCheckWithAgent={onCheckWithAgent}
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
  )
})

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
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  onCheckWithAgent,
}: {
  status: CardStatus
  onRun: () => void
  onStop: () => void
  onConfigure: () => void
  onDelete: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  canMoveUp?: boolean
  canMoveDown?: boolean
  onCheckWithAgent?: () => void
}) {
  const live = status === "running" || status === "starting"
  const stopping = status === "stopping"
  const showReorder = !!(onMoveUp || onMoveDown)
  return (
    <div className="flex items-center gap-0.5 shrink-0">
      {showReorder && (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={!canMoveUp}
                  onClick={(e) => { e.stopPropagation(); onMoveUp?.() }}
                  aria-label="Move up"
                />
              }
            >
              <ChevronUp className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Move up</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={!canMoveDown}
                  onClick={(e) => { e.stopPropagation(); onMoveDown?.() }}
                  aria-label="Move down"
                />
              }
            >
              <ChevronDown className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Move down</TooltipContent>
          </Tooltip>
        </>
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
      {onCheckWithAgent && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-amber-500"
                onClick={(e) => { e.stopPropagation(); onCheckWithAgent() }}
                aria-label="Check with agent"
              />
            }
          >
            <Sparkles className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Check with agent</TooltipContent>
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
          <Settings2 className="size-3.5" />
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

// Log viewer uses xterm.js so ANSI colors / cursor moves / progress bars from
// Vite, Next, chalk, etc. render natively. `@xterm/addon-web-links` turns
// http(s) URLs in the output into clickable links that open in a new tab.
async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`Copied ${label}`, { description: text, duration: 1500 })
  } catch {
    toast.error(`Couldn't copy ${label}`)
  }
}

const LogViewer = observer(function LogViewer({ svc }: { svc: Service }) {
  const userId = workspace.userId
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!containerRef.current || !userId) return

    const term = new XTerm({
      fontFamily:
        '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      theme: themeFromDocument(),
      scrollback: 5000,
    })
    const fit = new FitAddon()
    // Click opens in a new tab — the server URL from the running service is
    // the most common case and users expect http://localhost:… to launch a
    // browser, not navigate the current app window.
    const links = new WebLinksAddon((_e, uri) => {
      window.open(uri, "_blank", "noopener,noreferrer")
    })
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(links)
    term.loadAddon(search)

    // Keyboard shortcuts. xterm has no dedicated "shortcuts addon" — the
    // canonical hook is `attachCustomKeyEventHandler`. Returning false stops
    // xterm from processing the event further (i.e. we own it).
    //   Cmd/Ctrl+K    — clear the buffer (macOS Terminal convention)
    //   Cmd/Ctrl+F    — open find bar
    //   Cmd/Ctrl+L    — clear (Unix shell convention, same behavior)
    //   Esc (while finding) — close find bar
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === "k" || e.key === "K" || e.key === "l" || e.key === "L")) {
        term.clear()
        return false
      }
      if (mod && (e.key === "f" || e.key === "F")) {
        setSearchOpen(true)
        queueMicrotask(() => searchInputRef.current?.focus())
        return false
      }
      return true
    })

    term.open(containerRef.current)
    requestAnimationFrame(() => {
      try { fit.fit() } catch { /* container not sized yet */ }
    })
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    const writeLine = (line: LogLine) => {
      // Tint stderr red only when the app hasn't already styled the line —
      // avoid fighting the program's own color output.
      if (line.stream === "stderr" && !/\x1b\[/.test(line.text)) {
        term.write(`\x1b[31m${line.text}\x1b[0m\r\n`)
      } else {
        term.write(line.text + "\r\n")
      }
    }

    const unsub = workspace.services.subscribeLogs(userId, svc.id, writeLine)

    const ro = new ResizeObserver(() => {
      try { fit.fit() } catch { /* ignore */ }
    })
    ro.observe(containerRef.current)

    return () => {
      unsub()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [userId, svc.id])

  const findNext = () => {
    if (searchTerm) searchRef.current?.findNext(searchTerm)
  }
  const findPrev = () => {
    if (searchTerm) searchRef.current?.findPrevious(searchTerm)
  }
  const closeSearch = () => {
    setSearchOpen(false)
    setSearchTerm("")
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }

  return (
    <div className="h-full flex flex-col bg-muted/30 relative">
      <div className="px-4 py-2 border-b flex items-center gap-2 text-xs text-muted-foreground">
        <span>Logs</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => copyToClipboard(svc.cwd, "path")}
                className="font-mono truncate hover:text-foreground cursor-pointer text-left min-w-0"
                aria-label={`Copy path ${svc.cwd}`}
              >
                {svc.cwd}
              </button>
            }
          >
          </TooltipTrigger>
          <TooltipContent>Click to copy path</TooltipContent>
        </Tooltip>
        <span className="flex-1" />
        <span
          className={cn(
            "inline-block size-2 rounded-full shrink-0",
            cardStatusColor(svc.status),
            (svc.status === "starting" || svc.status === "stopping") && "animate-pulse"
          )}
          aria-label={svc.status}
        />
        <span className="text-[10px] font-mono">
          {cardStatusLabel(svc.status)}
        </span>
        {svc.pid != null && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => copyToClipboard(String(svc.pid), "PID")}
                  className="text-[10px] font-mono rounded bg-muted/60 px-1.5 py-0.5 cursor-pointer hover:bg-muted hover:text-foreground"
                  aria-label={`Copy process id ${svc.pid}`}
                >
                  pid {svc.pid}
                </button>
              }
            >
            </TooltipTrigger>
            <TooltipContent>
              <div>Click to copy PID</div>
              <div className="mt-1 text-[10px] opacity-80">
                Stop signals the whole process group.
                To kill manually:{" "}
                <code className="font-mono">kill -TERM -{svc.pid}</code>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
        <span className="text-[10px] font-mono text-muted-foreground/70 hidden sm:inline">
          ⌘K clear · ⌘F find
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="inline-flex size-6 items-center justify-center rounded hover:bg-accent hover:text-foreground"
                onClick={() => termRef.current?.scrollToBottom()}
                aria-label="Jump to latest"
              />
            }
          >
            <ArrowDownToLine className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Jump to latest</TooltipContent>
        </Tooltip>
      </div>
      {searchOpen && (
        <div className="absolute top-9 right-2 z-10 flex items-center gap-1 rounded-md border bg-background shadow-sm p-1">
          <input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? findPrev() : findNext() }
              else if (e.key === "Escape") { e.preventDefault(); closeSearch() }
            }}
            placeholder="Find"
            className="h-6 w-40 rounded bg-muted/60 px-2 text-xs outline-none focus:bg-muted"
            autoFocus
          />
          <button
            type="button"
            onClick={findPrev}
            disabled={!searchTerm}
            className="size-6 rounded hover:bg-accent text-xs disabled:opacity-40"
            aria-label="Previous match"
            title="Previous (Shift+Enter)"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={findNext}
            disabled={!searchTerm}
            className="size-6 rounded hover:bg-accent text-xs disabled:opacity-40"
            aria-label="Next match"
            title="Next (Enter)"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={closeSearch}
            className="size-6 rounded hover:bg-accent text-xs"
            aria-label="Close find"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 px-2 py-1" />
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

// xterm theme tied to the app's CSS variables so light/dark modes carry into
// the log viewer. Mirrors the helper in terminal-panel.tsx.
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
