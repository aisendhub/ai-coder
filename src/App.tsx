import { useState } from "react"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { ChatPanel } from "@/components/chat-panel"
import { RightPanel } from "@/components/right-panel"
import { TopBar } from "@/components/top-bar"
import { AuthProvider, useAuth } from "@/lib/auth"
import { SignIn } from "@/components/sign-in"
import { isSupabaseConfigured } from "@/lib/supabase"
import { ChatStateProvider } from "@/lib/chat-context"

export default function App() {
  if (!isSupabaseConfigured) {
    return <SetupNotice />
  }
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  )
}

function AuthGate() {
  const { session, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-svh flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }
  if (!session) return <SignIn />
  return <Workspace />
}

function Workspace() {
  const [rightOpen, setRightOpen] = useState(true)
  return (
    <ChatStateProvider>
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
    </ChatStateProvider>
  )
}

function SetupNotice() {
  return (
    <div className="min-h-svh flex items-center justify-center p-6">
      <div className="max-w-md text-sm text-muted-foreground space-y-3">
        <h1 className="text-xl font-semibold text-foreground">
          Supabase not configured
        </h1>
        <p>
          Add <code>VITE_SUPABASE_URL</code> and{" "}
          <code>VITE_SUPABASE_ANON_KEY</code> to <code>.env</code> and restart{" "}
          <code>npm run dev</code>.
        </p>
      </div>
    </div>
  )
}
