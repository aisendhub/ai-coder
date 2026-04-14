import { MessageSquare, Plus, Search } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
} from "@/components/ui/sidebar"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

const conversations = [
  { id: "1", title: "Refactor auth middleware", updated: "2m" },
  { id: "2", title: "Add dark mode to settings", updated: "1h" },
  { id: "3", title: "Migrate to Tailwind v4", updated: "yesterday" },
  { id: "4", title: "Fix flaky E2E test", updated: "2d" },
]

export function AppSidebar() {
  return (
    <Sidebar side="left" collapsible="offcanvas">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1">
          <Button size="sm" className="flex-1 justify-start gap-2">
            <Plus className="size-4" />
            New chat
          </Button>
        </div>
        <div className="relative px-2">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search" className="pl-8" />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Conversations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {conversations.map((c) => (
                <SidebarMenuItem key={c.id}>
                  <SidebarMenuButton className="flex items-start gap-2">
                    <MessageSquare className="size-4 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm">{c.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {c.updated}
                      </div>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="text-xs text-muted-foreground px-2 py-1">
          ai-coder · v0.1
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
