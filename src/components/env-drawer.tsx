// Env vars drawer.
//
// Surfaces the two persisted env layers users can edit:
//   1. Project shared (project_env_vars table) — shared across every chat
//      and worktree on this project.
//   2. Worktree-scoped (conversation_env_vars table) — overrides for the
//      active task; cleaned up when the task hard-deletes.
// The third "service-scoped" layer is edited inline on each service card
// in the services panel (existing UX), so this drawer doesn't duplicate
// that surface.
//
// Secrets are write-only after first save: server returns "" with
// is_secret=true; the editor shows ••••• and disables read-back. To rotate,
// the user re-enters.
//
// See docs/ENV-AND-SERVICES.md.

import { useCallback, useEffect, useMemo, useState } from "react"
import { observer } from "mobx-react-lite"
import { toast } from "sonner"
import { KeyRound, Lock, Plus, Trash2, Loader2, Check, Pencil, X, Folder, GitBranch } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { useConfirm } from "@/lib/confirm"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { workspace } from "@/models"

type EnvRow = {
  id: string
  key: string
  is_secret: boolean
  description: string | null
  updated_at: string
  // value is "" for secrets (write-only); plaintext for non-secrets.
  value: string
}

type Scope = "project" | "conversation"

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

type EnvTriggerProps = {
  variant?: "icon" | "default"
  className?: string
}

export const EnvTrigger = observer(function EnvTrigger({
  variant = "icon",
  className,
}: EnvTriggerProps = {}) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size={variant === "icon" ? "icon" : "sm"}
                  className={cn("gap-1.5", className)}
                  aria-label="Edit env vars"
                />
              }
            />
          }
        >
          <KeyRound className="size-4" />
          {variant !== "icon" && <span className="text-xs">Env</span>}
        </TooltipTrigger>
        <TooltipContent>Env vars (project + worktree layers)</TooltipContent>
      </Tooltip>
      <SheetContent side="right" className="flex flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <KeyRound className="size-4" />
            Env vars
          </SheetTitle>
        </SheetHeader>
        <EnvDrawerBody />
      </SheetContent>
    </Sheet>
  )
})

const EnvDrawerBody = observer(function EnvDrawerBody() {
  const projectId = workspace.activeProjectId
  const conversationId = workspace.active?.id ?? null
  const conversationLabel = workspace.active?.title ?? null
  const conversationKind = workspace.active?.kind ?? null
  const projectName = workspace.activeProject?.name ?? null

  if (!projectId) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-xs text-muted-foreground">
        Select a project to manage env vars.
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-y-auto">
      <EnvSection
        scope="project"
        scopeId={projectId}
        title={projectName ?? "Project"}
        subtitle="Shared across every chat and task in this project."
        icon={<Folder className="size-3.5" />}
      />
      {conversationId && conversationKind === "task" && (
        <EnvSection
          scope="conversation"
          scopeId={conversationId}
          title={`Task: ${conversationLabel ?? "current"}`}
          subtitle="Overrides for this worktree only. Cleaned up when the task is hard-deleted."
          icon={<GitBranch className="size-3.5" />}
        />
      )}
      {conversationId && conversationKind !== "task" && (
        <div className="border-t px-4 py-3 text-[11px] text-muted-foreground">
          Worktree-scoped overrides only apply to tasks. Open a task to add per-worktree env.
        </div>
      )}
    </div>
  )
})

function EnvSection({
  scope,
  scopeId,
  title,
  subtitle,
  icon,
}: {
  scope: Scope
  scopeId: string
  title: string
  subtitle: string
  icon: React.ReactNode
}) {
  const [rows, setRows] = useState<EnvRow[]>([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const confirm = useConfirm()

  const baseUrl = useMemo(
    () =>
      scope === "project"
        ? `/api/projects/${scopeId}/env`
        : `/api/conversations/${scopeId}/env`,
    [scope, scopeId],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api(baseUrl)
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const json = (await res.json()) as { env: EnvRow[] }
      setRows(json.env)
    } catch (err) {
      toast.error(`Couldn't load ${scope} env`, {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setLoading(false)
    }
  }, [baseUrl, scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const upsert = useCallback(
    async (key: string, value: string, isSecret: boolean) => {
      const res = await api(`${baseUrl}/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value, is_secret: isSecret }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      await refresh()
    },
    [baseUrl, refresh],
  )

  const remove = useCallback(
    async (key: string) => {
      const ok = await confirm({
        title: `Delete ${key}?`,
        variant: "destructive",
        confirmText: "Delete",
      })
      if (!ok) return
      try {
        const res = await api(`${baseUrl}/${encodeURIComponent(key)}`, { method: "DELETE" })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error || `HTTP ${res.status}`)
        }
        await refresh()
      } catch (err) {
        toast.error("Delete failed", {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [baseUrl, confirm, refresh],
  )

  return (
    <section className="border-b">
      <header className="flex items-center justify-between px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            {icon}
            <span className="truncate">{title}</span>
            {loading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => setAdding(true)}
          disabled={adding}
        >
          <Plus className="size-3" />
          Add
        </Button>
      </header>

      <div className="flex flex-col gap-1 px-3 pb-3">
        {adding && (
          <RowEditor
            initial={null}
            onCancel={() => setAdding(false)}
            onSave={async (key, value, isSecret) => {
              try {
                await upsert(key, value, isSecret)
                setAdding(false)
              } catch (err) {
                toast.error("Save failed", {
                  description: err instanceof Error ? err.message : String(err),
                })
              }
            }}
            existingKeys={rows.map((r) => r.key)}
          />
        )}
        {rows.length === 0 && !adding && !loading ? (
          <div className="px-2 py-4 text-center text-[11px] text-muted-foreground">
            No env vars yet.
          </div>
        ) : (
          rows.map((row) =>
            editingKey === row.key ? (
              <RowEditor
                key={row.key}
                initial={row}
                onCancel={() => setEditingKey(null)}
                onSave={async (key, value, isSecret) => {
                  try {
                    await upsert(key, value, isSecret)
                    setEditingKey(null)
                  } catch (err) {
                    toast.error("Save failed", {
                      description: err instanceof Error ? err.message : String(err),
                    })
                  }
                }}
                existingKeys={rows.filter((r) => r.key !== row.key).map((r) => r.key)}
                lockKey
              />
            ) : (
              <RowDisplay
                key={row.key}
                row={row}
                onEdit={() => setEditingKey(row.key)}
                onDelete={() => void remove(row.key)}
              />
            ),
          )
        )}
      </div>
    </section>
  )
}

function RowDisplay({
  row,
  onEdit,
  onDelete,
}: {
  row: EnvRow
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="group flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 hover:bg-card/80">
      <span className="text-xs font-mono font-medium truncate">{row.key}</span>
      <span className="text-[10px] text-muted-foreground font-mono truncate flex-1 min-w-0">
        {row.is_secret ? (
          <span className="inline-flex items-center gap-1">
            <Lock className="size-3" />
            <span>•••••••• (write-only)</span>
          </span>
        ) : (
          row.value || <span className="italic text-muted-foreground/60">empty</span>
        )}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 opacity-0 group-hover:opacity-100"
        onClick={onEdit}
        aria-label="Edit"
      >
        <Pencil className="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100"
        onClick={onDelete}
        aria-label="Delete"
      >
        <Trash2 className="size-3" />
      </Button>
    </div>
  )
}

function RowEditor({
  initial,
  onCancel,
  onSave,
  existingKeys,
  lockKey = false,
}: {
  initial: EnvRow | null
  onCancel: () => void
  onSave: (key: string, value: string, isSecret: boolean) => Promise<void>
  existingKeys: string[]
  lockKey?: boolean
}) {
  const [key, setKey] = useState(initial?.key ?? "")
  // Editing a secret starts blank — values are not readable from the server.
  // The user must re-enter to rotate; cancelling preserves the existing.
  const [value, setValue] = useState(initial && !initial.is_secret ? initial.value : "")
  const [isSecret, setIsSecret] = useState(initial?.is_secret ?? false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmedKey = key.trim()
  const keyValid = trimmedKey.length > 0 && KEY_RE.test(trimmedKey)
  const collision = !lockKey && trimmedKey && existingKeys.includes(trimmedKey)
  const canSave = keyValid && !collision && !saving

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await onSave(trimmedKey, value, isSecret)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border bg-muted/30 p-2">
      <div className="flex items-center gap-2">
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="KEY_NAME"
          className="h-7 text-xs font-mono"
          disabled={lockKey || saving}
          autoFocus={!lockKey}
        />
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
          <input
            type="checkbox"
            className="size-3 cursor-pointer accent-primary"
            checked={isSecret}
            onChange={(e) => setIsSecret(e.target.checked)}
            disabled={saving}
          />
          Secret
        </label>
      </div>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={
          isSecret
            ? initial?.is_secret
              ? "(re-enter to rotate)"
              : "value"
            : "value (use ${{svc.URL}} to reference siblings)"
        }
        className="h-7 text-xs font-mono"
        type={isSecret ? "password" : "text"}
        disabled={saving}
        autoFocus={lockKey}
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleSave()
          if (e.key === "Escape") onCancel()
        }}
      />
      {!keyValid && trimmedKey && (
        <p className="text-[11px] text-destructive">
          Key must match POSIX env var rules: letters/digits/underscore, no leading digit.
        </p>
      )}
      {collision && (
        <p className="text-[11px] text-destructive">
          Already exists in this layer. Edit the existing row instead.
        </p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <div className="flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={onCancel}
          disabled={saving}
        >
          <X className="size-3" />
          Cancel
        </Button>
        <Button
          variant="default"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={handleSave}
          disabled={!canSave}
        >
          {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
          Save
        </Button>
      </div>
    </div>
  )
}
