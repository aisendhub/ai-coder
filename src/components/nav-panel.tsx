import { MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"

const conversations = [
  { id: "1", title: "Refactor auth middleware", updated: "2m" },
  { id: "2", title: "Add dark mode to settings", updated: "1h" },
  { id: "3", title: "Migrate to Tailwind v4", updated: "yesterday" },
  { id: "4", title: "Fix flaky E2E test", updated: "2d" },
]

type Props = {
  collapsed?: boolean
  onToggle?: () => void
}

export function NavPanel({ collapsed = false, onToggle }: Props) {
  if (collapsed) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center bg-sidebar text-sidebar-foreground py-2 gap-1">
        <Button size="icon" variant="ghost" aria-label="New chat">
          <Plus className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Search">
          <Search className="size-4" />
        </Button>
        <div className="my-1 h-px w-6 bg-border" />
        <div className="flex-1 flex flex-col gap-1 overflow-y-auto w-full items-center">
          {conversations.map((c) => (
            <Button
              key={c.id}
              size="icon"
              variant="ghost"
              aria-label={c.title}
              title={c.title}
            >
              <MessageSquare className="size-4" />
            </Button>
          ))}
        </div>
        <div className="border-t w-full pt-1 flex justify-center">
          <Button
            size="icon"
            variant="ghost"
            onClick={onToggle}
            aria-label="Expand nav"
          >
            <PanelLeftOpen className="size-4" />
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="p-2 flex flex-col gap-2 border-b">
        <Button className="w-full justify-start gap-2">
          <Plus className="size-4" />
          New chat
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search" className="pl-8" />
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 flex flex-col gap-0.5">
          <div className="text-xs text-muted-foreground px-2 py-1">
            Conversations
          </div>
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              className="text-left rounded-md px-2 py-1.5 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex items-start gap-2 min-w-0"
            >
              <MessageSquare className="size-4 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm">{c.title}</div>
                <div className="text-xs text-muted-foreground">{c.updated}</div>
              </div>
            </button>
          ))}
        </div>
      </ScrollArea>
      <div className="border-t flex items-center justify-between px-2 py-1.5">
        <div className="text-xs text-muted-foreground px-1">ai-coder · v0.1</div>
        <Button
          size="icon"
          variant="ghost"
          onClick={onToggle}
          aria-label="Collapse nav"
          className="size-7"
        >
          <PanelLeftClose className="size-4" />
        </Button>
      </div>
    </div>
  )
}
