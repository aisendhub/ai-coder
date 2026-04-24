// test change — verify file-panel gutter shows "modified" (amber) not all-added (green)
// test change — second line to confirm adjacent-line modified detection
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
import { FilePanelSlot } from "@/components/file-panel"
import { ServicesPanel } from "@/components/services-panel"
import { TerminalPanel } from "@/components/terminal-panel"
import { FileTreePanel } from "@/components/file-tree-panel"
import { RightPanel as MobileRightPanel } from "@/components/right-panel"
import { GitLogSection } from "@/components/git-log-panel"
import { ChatsSection } from "@/components/chats-section"
import { FullscreenOverlay } from "@/components/fullscreen-overlay"
import { TopBar } from "@/components/top-bar"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePersistentState } from "@/hooks/use-persistent-state"
import { AuthProvider, useAuth } from "@/lib/auth"
import { SignIn } from "@/components/sign-in"
import { isSupabaseConfigured } from "@/lib/supabase"
import { ChatStateProvider } from "@/lib/chat-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { ConfirmProvider } from "@/lib/confirm"
import { workspace } from "@/models"
import { useUrlSync } from "@/lib/url-sync"
import { useTurnNotifications } from "@/hooks/use-turn-notifications"

export default function App() {
  if (!isSupabaseConfigured) return <SetupNotice />
  return (
    <TooltipProvider delay={300}>
      <ConfirmProvider>
        <AuthProvider>
          <AuthGate />
          <Toaster position="top-right" expand={false} richColors closeButton />
        </AuthProvider>
      </ConfirmProvider>
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
  // Panel open state persists across reloads; widths are handled by
  // react-resizable-panels via `autoSaveId` (per-combination).
  const [rightOpen, setRightOpen] = usePersistentState("ai-coder:panels:rightOpen", true)
  const [terminalOpen, setTerminalOpen] = usePersistentState("ai-coder:panels:terminalOpen", false)
  const [servicesOpen, setServicesOpen] = usePersistentState("ai-coder:panels:servicesOpen", false)
  const [fileTreeOpen, setFileTreeOpen] = usePersistentState("ai-coder:panels:fileTreeOpen", false)
  const [blameEnabled, setBlameEnabled] = usePersistentState("ai-coder:panels:blameEnabled", false)
  const [commentsEnabled, setCommentsEnabled] = usePersistentState("ai-coder:panels:commentsEnabled", true)
  // When the agent's reply drops a <run-services> block, open the services
  // panel automatically so the user sees the pick-list without hunting for
  // it. The panel itself listens for the same event to open the picker +
  // seed its candidate list (see services-panel.tsx).
  useEffect(() => {
    const onProposed = () => setServicesOpen(true)
    window.addEventListener("ai-coder:services-proposed", onProposed)
    return () => window.removeEventListener("ai-coder:services-proposed", onProposed)
  }, [setServicesOpen])
  // "Open in git log" (fired from the file-panel blame accordion) auto-opens
  // the right/changes panel so the git-log section is actually mounted.
  useEffect(() => {
    const onOpen = () => setRightOpen(true)
    window.addEventListener("ai-coder:open-git-log", onOpen)
    return () => window.removeEventListener("ai-coder:open-git-log", onOpen)
  }, [setRightOpen])
  // Section promotion: when promoted, a section lives in its own dockable
  // side panel instead of inside its parent accordion. Fullscreen is a
  // separate axis — a promoted section can also be fullscreened and returns
  // to its panel when closed.
  const [gitLogPromoted, setGitLogPromoted] = usePersistentState("ai-coder:panels:gitLogPromoted", false)
  const [gitLogFullscreen, setGitLogFullscreen] = useState(false)
  const [chatsPromoted, setChatsPromoted] = usePersistentState("ai-coder:panels:chatsPromoted", false)
  const [chatsFullscreen, setChatsFullscreen] = useState(false)
  const [navCollapsed, setNavCollapsed] = useState(false)
  const [codeCollapsed, setCodeCollapsed] = useState(false)
  const [servicesCollapsed, setServicesCollapsed] = useState(false)
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
          autoSaveId="ai-coder-main-5pane"
          className="h-full w-full"
        >
          <ResizablePanel
            ref={navRef}
            id="nav"
            order={1}
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
              <NavPanel
                collapsed={navCollapsed}
                onToggle={toggleNav}
                chatsPromoted={chatsPromoted}
                chatsFullscreen={chatsFullscreen}
                onPromoteChats={() => setChatsPromoted(true)}
                onRestoreChats={() => setChatsPromoted(false)}
                onEnterChatsFullscreen={() => setChatsFullscreen(true)}
                onExitChatsFullscreen={() => setChatsFullscreen(false)}
              />
            </div>
          </ResizablePanel>
          {chatsPromoted && (
            <>
              <ResizableHandle />
              <ResizablePanel
                id="chatsPanel"
                order={2}
                defaultSize={20}
                minSize={15}
                maxSize={40}
              >
                <div className="h-full min-h-0 overflow-hidden border-r bg-sidebar text-sidebar-foreground">
                  <ChatsSection
                    expanded
                    promoted
                    fullscreen={chatsFullscreen}
                    onPromote={() => setChatsPromoted(true)}
                    onRestore={() => setChatsPromoted(false)}
                    onEnterFullscreen={() => setChatsFullscreen(true)}
                    onExitFullscreen={() => setChatsFullscreen(false)}
                  />
                </div>
              </ResizablePanel>
            </>
          )}
          <ResizableHandle />
          <ResizablePanel id="chat" order={3} defaultSize={50} minSize={30}>
            <div className="h-full min-h-0 overflow-hidden flex flex-col">
              <TopBar
                rightOpen={rightOpen}
                onRightOpenChange={setRightOpen}
                terminalOpen={terminalOpen}
                onTerminalOpenChange={setTerminalOpen}
                servicesOpen={servicesOpen}
                onServicesOpenChange={setServicesOpen}
                fileTreeOpen={fileTreeOpen}
                onFileTreeOpenChange={setFileTreeOpen}
                blameEnabled={blameEnabled}
                onBlameEnabledChange={setBlameEnabled}
                commentsEnabled={commentsEnabled}
                onCommentsEnabledChange={setCommentsEnabled}
              />
              <div className="flex-1 min-h-0 overflow-hidden">
                <ChatPanel />
              </div>
            </div>
          </ResizablePanel>
          {fileTreeOpen && (
            <>
              <ResizableHandle />
              <ResizablePanel
                id="fileTree"
                order={4}
                defaultSize={22}
                minSize={15}
                maxSize={45}
              >
                <div className="h-full min-h-0 overflow-hidden border-l">
                  <FileTreePanel onClose={() => setFileTreeOpen(false)} />
                </div>
              </ResizablePanel>
            </>
          )}
          {rightOpen && (
            <>
              <ResizableHandle />
              <ResizablePanel
                id="code"
                order={5}
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
                  <CodePanel
                    collapsed={codeCollapsed}
                    onClose={() => setRightOpen(false)}
                    gitLogPromoted={gitLogPromoted}
                    gitLogFullscreen={gitLogFullscreen}
                    onPromoteGitLog={() => setGitLogPromoted(true)}
                    onRestoreGitLog={() => setGitLogPromoted(false)}
                    onEnterGitLogFullscreen={() => setGitLogFullscreen(true)}
                    onExitGitLogFullscreen={() => setGitLogFullscreen(false)}
                  />
                </div>
              </ResizablePanel>
            </>
          )}
          {gitLogPromoted && (
            <>
              <ResizableHandle />
              <ResizablePanel
                id="gitLogPanel"
                order={8}
                defaultSize={26}
                minSize={18}
                maxSize={55}
              >
                <div className="h-full min-h-0 overflow-hidden border-l">
                  <GitLogSection
                    expanded
                    promoted
                    fullscreen={gitLogFullscreen}
                    onPromote={() => setGitLogPromoted(true)}
                    onRestore={() => setGitLogPromoted(false)}
                    onEnterFullscreen={() => setGitLogFullscreen(true)}
                    onExitFullscreen={() => setGitLogFullscreen(false)}
                  />
                </div>
              </ResizablePanel>
            </>
          )}
          {terminalOpen && (
            <>
              <ResizableHandle />
              <ResizablePanel
                id="terminal"
                order={6}
                defaultSize={28}
                minSize={18}
                maxSize={60}
              >
                <div className="h-full min-h-0 overflow-hidden border-l">
                  <TerminalPanel onClose={() => setTerminalOpen(false)} />
                </div>
              </ResizablePanel>
            </>
          )}
          {servicesOpen && (
            <>
              <ResizableHandle />
              <ResizablePanel
                id="services"
                order={7}
                defaultSize={28}
                minSize={22}
                maxSize={50}
                collapsible
                collapsedSize={4}
                onResize={(size) =>
                  setServicesCollapsed(typeof size === "number" ? size < 6 : false)
                }
              >
                <div className="h-full min-h-0 overflow-hidden border-l relative">
                  <ServicesPanel collapsed={servicesCollapsed} onClose={() => setServicesOpen(false)} />
                </div>
              </ResizablePanel>
            </>
          )}
          <FilePanelSlot blameEnabled={blameEnabled} commentsEnabled={commentsEnabled} />
        </ResizablePanelGroup>
        {gitLogFullscreen && (
          <FullscreenOverlay onExit={() => setGitLogFullscreen(false)}>
            <GitLogSection
              expanded
              promoted={gitLogPromoted}
              fullscreen
              onPromote={() => setGitLogPromoted(true)}
              onRestore={() => setGitLogPromoted(false)}
              onEnterFullscreen={() => setGitLogFullscreen(true)}
              onExitFullscreen={() => setGitLogFullscreen(false)}
            />
          </FullscreenOverlay>
        )}
        {chatsFullscreen && (
          <FullscreenOverlay onExit={() => setChatsFullscreen(false)}>
            <ChatsSection
              expanded
              promoted={chatsPromoted}
              fullscreen
              onPromote={() => setChatsPromoted(true)}
              onRestore={() => setChatsPromoted(false)}
              onEnterFullscreen={() => setChatsFullscreen(true)}
              onExitFullscreen={() => setChatsFullscreen(false)}
            />
          </FullscreenOverlay>
        )}
      </div>
    </ChatStateProvider>
  )
}

function MobileLayout() {
  const [rightOpen, setRightOpen] = usePersistentState("ai-coder:panels:mobile:rightOpen", false)
  const [terminalOpen, setTerminalOpen] = usePersistentState("ai-coder:panels:mobile:terminalOpen", false)
  const [servicesOpen, setServicesOpen] = usePersistentState("ai-coder:panels:mobile:servicesOpen", false)
  // Mobile hides the file-tree trigger (handled inside FileTreeTrigger);
  // we keep a no-op state here just to satisfy TopBar's prop shape.
  const [fileTreeOpen, setFileTreeOpen] = useState(false)
  useEffect(() => {
    const onProposed = () => setServicesOpen(true)
    window.addEventListener("ai-coder:services-proposed", onProposed)
    return () => window.removeEventListener("ai-coder:services-proposed", onProposed)
  }, [setServicesOpen])
  return (
    <ChatStateProvider>
      <SidebarProvider style={{ height: "100svh" } as React.CSSProperties}>
        <AppSidebar />
        <SidebarInset className="h-svh min-w-0 flex-1 flex flex-col overflow-hidden">
          <TopBar
            rightOpen={rightOpen}
            onRightOpenChange={setRightOpen}
            terminalOpen={terminalOpen}
            onTerminalOpenChange={setTerminalOpen}
            servicesOpen={servicesOpen}
            onServicesOpenChange={setServicesOpen}
            fileTreeOpen={fileTreeOpen}
            onFileTreeOpenChange={setFileTreeOpen}
            blameEnabled={false}
            onBlameEnabledChange={() => {}}
            commentsEnabled={false}
            onCommentsEnabledChange={() => {}}
          />
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
