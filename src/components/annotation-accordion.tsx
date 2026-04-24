import type { ReactNode } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Shared expand-collapse card for file-panel annotations (comments + blame).
 *  Positioning is the caller's job — this is a pure visual component. */
export function AnnotationAccordion({
  header,
  children,
  onClose,
  className,
}: {
  header: ReactNode
  children: ReactNode
  onClose?: () => void
  className?: string
}) {
  return (
    <div
      className={cn(
        // Frosted glass: bg is semi-transparent so the code underneath stays
        // legible through the accordion. backdrop-blur softens it without
        // hiding context. Border softened to match.
        "rounded-md border border-border/50 shadow-lg text-card-foreground my-1.5",
        "bg-card/70 backdrop-blur-md backdrop-saturate-150",
        // Left offset: 36px (ml-9) clears the blame rail (ends at 18px) with
        // breathing room, so an open accordion on one line doesn't obscure
        // the blame stripes on subsequent lines — user can click adjacent
        // blame without closing. Right uses the original 12px.
        "ml-9 mr-3",
        className
      )}
    >
      <div className="flex items-start justify-between gap-2 px-3 py-1.5 border-b">
        <div className="min-w-0 flex-1 text-xs">{header}</div>
        {onClose && (
          <Button
            variant="ghost"
            size="sm"
            className="-my-1 -mr-1 size-6"
            onClick={onClose}
            aria-label="Close annotation"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="px-3 py-2 text-xs">{children}</div>
    </div>
  )
}
