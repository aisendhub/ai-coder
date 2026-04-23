import { useEffect } from "react"
import { X, Minimize2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

// Modal fullscreen wrapper — same pattern as Board: fixed inset-0 above the
// whole app, Escape closes. Renders its own title bar above the section's
// content so the section doesn't need to know it's fullscreen.
export function FullscreenOverlay({
  title,
  icon,
  onExit,
  children,
}: {
  title: string
  icon?: React.ReactNode
  onExit: () => void
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onExit])

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex items-center justify-between border-b bg-background px-4 h-14 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <h2 className="text-sm font-semibold truncate">{title}</h2>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger>
              <Button variant="ghost" size="icon" onClick={onExit} aria-label="Exit fullscreen">
                <Minimize2 className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Exit fullscreen (Esc)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger>
              <Button variant="ghost" size="icon" onClick={onExit} aria-label="Close">
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close (Esc)</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}
