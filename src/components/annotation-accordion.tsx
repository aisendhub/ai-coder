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
        "rounded-md border bg-card text-card-foreground shadow-sm mx-3 my-1.5",
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
