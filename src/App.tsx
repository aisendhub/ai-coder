import { useEffect, useRef, useState } from "react"
import type { ImperativePanelHandle } from "react-resizable-panels"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { AppSidebar } from "@/components/app-sidebar"
import { NavPanel } from "@/components/nav-panel"
import { ChatPanel } from "@/components/chat-panel"
import { CodePanel } from "@/components/code-panel"
import { RightPanel as MobileRightPanel } from "@/components/right-panel"
import { TopBar } from "@/components/top-bar"
import { useIsMobile } from "@/hooks/use-mobile"
import { AuthProvider, useAuth } from "@/lib/auth"
import { SignIn } from "@/components/sign-in"
import { isSupabaseConfigured } from "@/lib/supabase"
import { ChatStateProvider } from "@/lib/chat-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { workspace } from "@/models"
import { useUrlSync } from "@/lib/url-sync"
import { useTurnNotifications } from "@/hooks/use-turn-notifications"

export default function App() {
  if (!isSupabaseConfigured) return <SetupNotice />
  return (
    <TooltipProvider delay={300}>
      <AuthProvider>
        <AuthGate />
        <Toaster position="top-right" expand={false} richColors closeButton />
      </AuthProvider>
    </TooltipProvider>
  )
}

function AuthGate() {
  const { session, loading, user } = useAuth()

  // Wire user → workspace store
  useEffect(() => {
    if (user?.id) void workspace.signIn(user.id)
    else workspace.signOut()
  }, [user?.id])

  // Bind URL ↔ active conversation
  useUrlSync()

  // Show toast notifications for background AI turn completions
  useTurnNotifications()

  if (loading) {
    return (
      <div className="h-svh flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }
  if (!session) return <SignIn />
  return <Workspace />
}

function Workspace() {
  const isMobile = useIsMobile()
  if (isMobile) return <MobileLayout />
  return <DesktopLayout />
}

function DesktopLayout() {
  const [rightOpen, setRightOpen] = useState(true)
  const [navCollapsed, setNavCollapsed] = useState(false)
  const [codeCollapsed, setCodeCollapsed] = useState(false)
  const navRef = useRef<ImperativePanelHandle>(null)
  const toggleNav = () => {
    const panel = navRef.current
    if (!panel) return
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }
  return (
    <ChatStateProvider>
      <div className="h-svh w-screen overflow-hidden">
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="ai-coder-main-3pane"
          className="h-full w-full"
        >
          <ResizablePanel
            ref={navRef}
            id="nav"
            defaultSize={18}
            minSize={15}
            maxSize={30}
            collapsible
            collapsedSize={4}
            onResize={(size) =>
              setNavCollapsed(typeof size === "number" ? size < 6 : false)
            }
          >
            <div className="h-full min-h-0 overflow-hidden border-r">
              <NavPanel collapsed={navCollapsed} onToggle={toggleNav} />
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="chat" defaultSize={50} minSize={30}>
            <div className="h-full min-h-0 overflow-hidden flex flex-col">
              <TopBar
                rightOpen={rightOpen}
                onRightOpenChange={setRightOpen}
              />
              <div className="flex-1 min-h-0 overflow-hidden">
                <ChatPanel />
              </div>
            </div>
          </ResizablePanel>
          {rightOpen && (
            <>
              <ResizableHandle />
              <ResizablePanel
                id="code"
                defaultSize={32}
                minSize={20}
                maxSize={70}
                collapsible
                collapsedSize={4}
                onResize={(size) =>
                  setCodeCollapsed(typeof size === "number" ? size < 6 : false)
                }
              >
                <div className="h-full min-h-0 overflow-hidden border-l">
                  <CodePanel collapsed={codeCollapsed} />
                </div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </ChatStateProvider>
  )
}

function MobileLayout() {
  const [rightOpen, setRightOpen] = useState(false)
  return (
    <ChatStateProvider>
      <SidebarProvider style={{ height: "100svh" } as React.CSSProperties}>
        <AppSidebar />
        <SidebarInset className="h-svh min-w-0 flex-1 flex flex-col overflow-hidden">
          <TopBar rightOpen={rightOpen} onRightOpenChange={setRightOpen} />
          <div className="flex-1 min-h-0 overflow-hidden">
            <ChatPanel />
          </div>
          <MobileRightPanel open={rightOpen} />
        </SidebarInset>
      </SidebarProvider>
    </ChatStateProvider>
  )
}

function SetupNotice() {
  return (
    <div className="h-svh flex items-center justify-center p-6">
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
