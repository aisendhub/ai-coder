import { useEffect, useRef, useState } from "react"
import { MoreVertical, PanelRight, Maximize2, Minimize2, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type Props = {
  promoted: boolean
  fullscreen: boolean
  onPromote: () => void
  onRestore: () => void
  onEnterFullscreen: () => void
  onExitFullscreen: () => void
}

// Small kebab dropdown for accordion-section actions: promote to side panel,
// restore to inline, go fullscreen, or exit fullscreen. Built inline rather
// than pulling in a menu primitive — the list is tiny and the interaction is
// always one-click-and-dismiss.
export function SectionMenu({
  promoted,
  fullscreen,
  onPromote,
  onRestore,
  onEnterFullscreen,
  onExitFullscreen,
}: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const close = () => setOpen(false)

  return (
    <div ref={rootRef} className="relative inline-flex">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation()
                setOpen((v) => !v)
              }}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label="Section options"
            />
          }
        >
          <MoreVertical className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>More options</TooltipContent>
      </Tooltip>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 min-w-50 rounded-md border bg-popover text-popover-foreground shadow-md py-1"
          onClick={(e) => e.stopPropagation()}
        >
          {promoted ? (
            <MenuItem
              icon={<Undo2 className="size-3.5" />}
              onClick={() => { onRestore(); close() }}
            >
              Return to sidebar
            </MenuItem>
          ) : (
            <MenuItem
              icon={<PanelRight className="size-3.5" />}
              onClick={() => { onPromote(); close() }}
            >
              Open in side panel
            </MenuItem>
          )}
          {fullscreen ? (
            <MenuItem
              icon={<Minimize2 className="size-3.5" />}
              onClick={() => { onExitFullscreen(); close() }}
            >
              Exit fullscreen
            </MenuItem>
          ) : (
            <MenuItem
              icon={<Maximize2 className="size-3.5" />}
              onClick={() => { onEnterFullscreen(); close() }}
            >
              Fullscreen
            </MenuItem>
          )}
        </div>
      )}
    </div>
  )
}

function MenuItem({
  children,
  icon,
  onClick,
  className,
}: {
  children: React.ReactNode
  icon?: React.ReactNode
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer",
        className
      )}
    >
      {icon}
      {children}
    </button>
  )
}
