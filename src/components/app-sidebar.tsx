import { Sidebar, SidebarContent } from "@/components/ui/sidebar"
import { NavPanel } from "@/components/nav-panel"

export function AppSidebar() {
  return (
    <Sidebar side="left" collapsible="offcanvas">
      <SidebarContent className="p-0">
        <NavPanel />
      </SidebarContent>
    </Sidebar>
  )
}
