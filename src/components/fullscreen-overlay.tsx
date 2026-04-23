import { useEffect } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

// Fullscreen wrapper — just positioning + Escape-to-close + a floating X
// button. The section being shown renders its own header (with title,
// actions, and the kebab menu), so we intentionally don't add a second
// header here.
export function FullscreenOverlay({
  onExit,
  children,
}: {
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
      className="fixed inset-0 z-50 bg-background"
      role="dialog"
      aria-modal="true"
    >
      <Tooltip>
        <TooltipTrigger>
          <Button
            variant="ghost"
            size="icon"
            onClick={onExit}
            aria-label="Exit fullscreen"
            className="absolute right-3 top-2 z-10 size-7"
          >
            <X className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Close (Esc)</TooltipContent>
      </Tooltip>
      <div className="h-full min-h-0 flex flex-col">{children}</div>
    </div>
  )
}
