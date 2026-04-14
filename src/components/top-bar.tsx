import { observer } from "mobx-react-lite"
import { Sparkles } from "lucide-react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { RightPanelTrigger } from "@/components/right-panel"
import { useIsMobile } from "@/hooks/use-mobile"
import { workspace } from "@/models"

type Props = {
  rightOpen: boolean
  onRightOpenChange: (open: boolean) => void
}

export const TopBar = observer(function TopBar({
  rightOpen,
  onRightOpenChange,
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
      <RightPanelTrigger open={rightOpen} onOpenChange={onRightOpenChange} />
    </header>
  )
})
