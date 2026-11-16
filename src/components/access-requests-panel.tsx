import { useCallback, useEffect, useState } from "react"
import {
  ShieldCheck,
  ShieldX,
  Clock,
  Check,
  X,
  RefreshCw,
  UserRoundCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { useIsMobile } from "@/hooks/use-mobile"

type AccessRequest = {
  id: string
  user_id: string
  email: string
  display_name: string | null
  avatar_url: string | null
  status: "pending" | "approved" | "denied"
  requested_at: string
  resolved_at: string | null
}

export function AccessRequestsPanel({ onClose }: { onClose?: () => void }) {
  const [requests, setRequests] = useState<AccessRequest[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api("/api/access-requests")
      if (r.ok) setRequests(await r.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const updateStatus = async (id: string, status: "approved" | "denied") => {
    const r = await api(`/api/access-requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    })
    if (r.ok) {
      const updated: AccessRequest = await r.json()
      setRequests((prev) => prev.map((req) => (req.id === updated.id ? updated : req)))
    }
  }

  const pending = requests.filter((r) => r.status === "pending")
  const resolved = requests.filter((r) => r.status !== "pending")

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="shrink-0 border-b">
        <div className="flex h-14 items-center justify-between px-3">
          <div className="flex items-center gap-2 min-w-0">
            <UserRoundCheck className="size-4 shrink-0" />
            <h2 className="text-sm font-medium">Access Requests</h2>
            {pending.length > 0 && (
              <span className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
                {pending.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger>
                <Button size="sm" variant="ghost" onClick={refresh}>
                  <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>
            {onClose && (
              <Tooltip>
                <TooltipTrigger>
                  <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close panel">
                    <X className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Close</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && requests.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Loading…
          </div>
        ) : requests.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
            No access requests yet.
          </div>
        ) : (
          <div className="divide-y">
            {pending.length > 0 && (
              <div>
                <div className="px-3 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Pending
                </div>
                {pending.map((req) => (
                  <RequestRow key={req.id} request={req} onUpdate={updateStatus} />
                ))}
              </div>
            )}
            {resolved.length > 0 && (
              <div>
                <div className="px-3 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Resolved
                </div>
                {resolved.map((req) => (
                  <RequestRow key={req.id} request={req} onUpdate={updateStatus} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function RequestRow({
  request,
  onUpdate,
}: {
  request: AccessRequest
  onUpdate: (id: string, status: "approved" | "denied") => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  const handle = async (status: "approved" | "denied") => {
    setBusy(true)
    try {
      await onUpdate(request.id, status)
    } finally {
      setBusy(false)
    }
  }

  const statusIcon =
    request.status === "approved" ? (
      <ShieldCheck className="size-3.5 text-green-500" />
    ) : request.status === "denied" ? (
      <ShieldX className="size-3.5 text-destructive" />
    ) : (
      <Clock className="size-3.5 text-amber-500" />
    )

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50">
      {request.avatar_url ? (
        <img
          src={request.avatar_url}
          alt=""
          className="size-8 rounded-full shrink-0"
        />
      ) : (
        <div className="size-8 rounded-full bg-muted shrink-0 flex items-center justify-center text-xs font-medium">
          {(request.display_name ?? request.email)[0]?.toUpperCase()}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">
          {request.display_name ?? request.email}
        </div>
        <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
          {statusIcon}
          {request.email}
          <span className="text-muted-foreground/60">
            · {new Date(request.requested_at).toLocaleDateString()}
          </span>
        </div>
      </div>
      {request.status === "pending" ? (
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => handle("approved")}
                className="text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-950/30"
              >
                <Check className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Approve</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => handle("denied")}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Deny</TooltipContent>
          </Tooltip>
        </div>
      ) : (
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  handle(request.status === "approved" ? "denied" : "approved")
                }
              >
                {request.status === "approved" ? (
                  <ShieldX className="size-3.5" />
                ) : (
                  <ShieldCheck className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {request.status === "approved" ? "Revoke access" : "Approve"}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  )
}

// Trigger button for the TopBar — matches the pattern of ChangesTrigger, etc.
export function AccessRequestsTrigger({
  open,
  onOpenChange,
  pendingCount,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pendingCount: number
}) {
  const isMobile = useIsMobile()
  if (isMobile) return null

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(!open)}
            aria-label={open ? "Close access requests" : "Open access requests"}
            aria-pressed={open}
            className={cn(
              "relative",
              open && "bg-accent text-accent-foreground"
            )}
          />
        }
      >
        <UserRoundCheck className="size-5" />
        {pendingCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground text-[9px] font-bold">
            {pendingCount}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>
        {open ? "Close access requests" : "Access requests"}
        {pendingCount > 0 ? ` (${pendingCount} pending)` : ""}
      </TooltipContent>
    </Tooltip>
  )
}
