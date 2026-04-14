import { useState } from "react"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { ChatPanel } from "@/components/chat-panel"
import { RightPanel } from "@/components/right-panel"
import { TopBar } from "@/components/top-bar"

export default function App() {
  const [rightOpen, setRightOpen] = useState(true)

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="flex min-h-svh min-w-0 flex-1 flex-row">
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar rightOpen={rightOpen} onRightOpenChange={setRightOpen} />
          <main className="min-h-0 flex-1">
            <ChatPanel />
          </main>
        </div>
        <RightPanel open={rightOpen} />
      </SidebarInset>
    </SidebarProvider>
  )
}
