import { useEffect, useState } from "react"
import { observer } from "mobx-react-lite"
import { toast } from "sonner"
import { Sparkles, Bell, BellOff, BellRing, Gauge } from "lucide-react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { ChangesTrigger, TerminalTrigger } from "@/components/right-panel"
import { ServicesTrigger } from "@/components/services-panel"
import { useIsMobile } from "@/hooks/use-mobile"
import { showOsNotification } from "@/hooks/use-turn-notifications"
import { workspace } from "@/models"

type Props = {
  rightOpen: boolean
  onRightOpenChange: (open: boolean) => void
  terminalOpen: boolean
  onTerminalOpenChange: (open: boolean) => void
}

export const TopBar = observer(function TopBar({
  rightOpen,
  onRightOpenChange,
  terminalOpen,
  onTerminalOpenChange,
}: Props) {
  const active = workspace.active
  const title = active?.title ?? "New chat"
  const branch = active?.branch ?? null
  const isMobile = useIsMobile()
  // Spin-off only makes sense on a regular chat that already has user input
  // worth carrying over. Tasks already are tasks.
  const userMessageCount = active?.messages.items.filter((m) => m.role === "user").length ?? 0
  const canSpinOff = active?.kind === "chat" && userMessageCount > 0

  const handleSpinOff = async () => {
    if (!active) return
    const userMessages = active.messages.items.filter((m) => m.role === "user")
    const recent = userMessages.slice(-5).map((m) => m.text.trim()).filter(Boolean)
    const initialGoal = recent.join("\n\n")
    try {
      await workspace.createTaskDraft({ initialGoal, title: active.title })
    } catch (err) {
      console.error("spin off failed", err)
    }
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
      {isMobile && (
        <>
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 self-stretch" />
        </>
      )}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Sparkles className="size-4" />
        </div>
        <div className="flex flex-col min-w-0">
          <div className="text-sm font-medium truncate">{title}</div>
          <div className="text-xs text-muted-foreground truncate font-mono" title={branch ?? undefined}>
            {branch ?? "Claude Code · connected"}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        {canSpinOff && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1"
                  onClick={handleSpinOff}
                  aria-label="Spin off as task"
                />
              }
            >
              <Gauge className="size-4" />
              <span className="text-xs">Spin off</span>
            </TooltipTrigger>
            <TooltipContent>
              Create a task pre-filled with this chat's prompts
            </TooltipContent>
          </Tooltip>
        )}
        <NotificationsTrigger />
        <ServicesTrigger />
        <ChangesTrigger open={rightOpen} onOpenChange={onRightOpenChange} />
        <TerminalTrigger open={terminalOpen} onOpenChange={onTerminalOpenChange} />
      </div>
    </header>
  )
})

function NotificationsTrigger() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() =>
    typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "unsupported"
  )

  // Re-sync if the user changes the setting in the browser while the app is open.
  useEffect(() => {
    if (permission === "unsupported") return
    const onFocus = () => setPermission(Notification.permission)
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [permission])

  if (permission === "unsupported") return null

  const onClick = async () => {
    // Always re-read permission at click time — state may be stale if the
    // user changed it via browser settings.
    const live = Notification.permission
    setPermission(live)
    console.debug("[notif] bell clicked, permission=", live)

    if (live === "default") {
      const result = await Notification.requestPermission().catch((err) => {
        console.error("[notif] requestPermission threw", err)
        return "denied" as const
      })
      console.debug("[notif] requestPermission result=", result)
      setPermission(result)
      if (result === "granted") {
        toast.success("Notifications enabled — click the bell again to fire a test.")
      } else if (result === "denied") {
        toast.error("Notifications blocked. Enable them in browser settings, then reload.")
      }
      return
    }

    if (live === "granted") {
      const fired = showOsNotification(
        "test",
        "ai-coder notifications work",
        "If no system banner appears, your OS / browser is suppressing it. Check macOS Notification Center settings for this browser."
      )
      // Always show an in-app confirmation so the click never feels dead.
      if (fired) {
        toast.success("Test notification fired", {
          description:
            "If no system banner appeared, OS-level notifications for the browser are off (macOS: System Settings → Notifications → [Browser]).",
          duration: 6000,
        })
      } else {
        toast.error("Test notification failed to construct — check the console.", {
          duration: 6000,
        })
      }
      return
    }

    // denied — can't re-prompt programmatically
    toast.error("Notifications are blocked.", {
      description: "Re-enable them in your browser's site settings, then reload.",
      duration: 6000,
    })
  }

  const Icon = permission === "granted" ? BellRing : permission === "denied" ? BellOff : Bell
  const label =
    permission === "granted"
      ? "Notifications on (click to test)"
      : permission === "denied"
        ? "Notifications blocked"
        : "Enable desktop notifications"

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            onClick={onClick}
            aria-label={label}
          />
        }
      >
        <Icon className="size-5" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
