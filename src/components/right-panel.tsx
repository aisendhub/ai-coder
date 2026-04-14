import { PanelRightClose, PanelRightOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/use-mobile"
import { CodePanel } from "@/components/code-panel"
import { cn } from "@/lib/utils"

type Props = {
  open: boolean
}

export function RightPanel({ open }: Props) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return null
  }

  return (
    <aside
      className={cn(
        "hidden md:flex flex-col border-l bg-background transition-[width] duration-200 ease-linear overflow-hidden shrink-0",
        open ? "w-90 lg:w-100" : "w-0"
      )}
      aria-hidden={!open}
    >
      <div className={cn("w-90 lg:w-100 h-full flex flex-col", !open && "invisible")}>
        <CodePanel />
      </div>
    </aside>
  )
}

export function RightPanelTrigger({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <Sheet>
        <SheetTrigger
          className="inline-flex items-center justify-center rounded-md size-9 hover:bg-accent hover:text-accent-foreground"
          aria-label="Open changes"
        >
          <PanelRightOpen className="size-5" />
        </SheetTrigger>
        <SheetContent side="right" className="p-0 w-[90vw] sm:w-100">
          <SheetHeader className="sr-only">
            <SheetTitle>Code changes</SheetTitle>
          </SheetHeader>
          <CodePanel />
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
            aria-label={open ? "Close changes" : "Open changes"}
          />
        }
      >
        {open ? (
          <PanelRightClose className="size-5" />
        ) : (
          <PanelRightOpen className="size-5" />
        )}
      </TooltipTrigger>
      <TooltipContent>{open ? "Close changes" : "Open changes"}</TooltipContent>
    </Tooltip>
  )
}
