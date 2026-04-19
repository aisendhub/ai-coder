import { useEffect, useState } from "react"
import { observer } from "mobx-react-lite"
import { Sparkles, Bell } from "lucide-react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { ChangesTrigger, TerminalTrigger } from "@/components/right-panel"
import { useIsMobile } from "@/hooks/use-mobile"
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
  const title = workspace.active?.title ?? "New chat"
  const isMobile = useIsMobile()
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
          <div className="text-xs text-muted-foreground truncate">
            Claude Code · connected
          </div>
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        <NotificationsTrigger />
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

  // Hide the button once the user has made a decision (granted or denied).
  // Once denied, the browser blocks programmatic re-prompts anyway.
  if (permission !== "default") return null

  const request = async () => {
    try {
      const result = await Notification.requestPermission()
      setPermission(result)
    } catch {
      // ignore
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            onClick={request}
            aria-label="Enable desktop notifications"
          />
        }
      >
        <Bell className="size-5" />
      </TooltipTrigger>
      <TooltipContent>Enable desktop notifications</TooltipContent>
    </Tooltip>
  )
}
