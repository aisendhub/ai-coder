import { useMemo, useState } from "react"
import { observer } from "mobx-react-lite"
import { ArrowUpRight, ChevronDown, ChevronRight, MessageSquare, Plus, Search, X } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { workspace } from "@/models"
import { ConversationRow } from "@/components/conversation-row"
import { SectionMenu } from "@/components/section-menu"
import { useDeleteConversation } from "@/hooks/use-delete-conversation"

type Props = {
  expanded: boolean
  // Omit to hide the chevron (e.g. in the promoted standalone panel).
  onToggleExpanded?: () => void
  // Section-level state — shared between inline and promoted copies so the
  // kebab menu reflects the same state everywhere.
  promoted?: boolean
  fullscreen?: boolean
  onPromote?: () => void
  onRestore?: () => void
  onEnterFullscreen?: () => void
  onExitFullscreen?: () => void
  // Rendering role.
  ghost?: boolean
  // Inline nav mode: the nav panel owns a shared query that filters both
  // Tasks and Chats. Pass it here so the two stay in sync. When omitted,
  // the section renders its own search input (used when promoted/fullscreen).
  externalQuery?: string
  // Optional callback fired after a conversation is activated — nav panel
  // passes closeMobileNav here so the drawer auto-closes on phones.
  onConversationOpen?: (id: string) => void
  // Loading indicator for the inline case.
  loading?: boolean
}

export const ChatsSection = observer(function ChatsSection({
  expanded,
  onToggleExpanded,
  promoted = false,
  fullscreen = false,
  onPromote,
  onRestore,
  onEnterFullscreen,
  onExitFullscreen,
  ghost = false,
  externalQuery,
  onConversationOpen,
  loading,
}: Props) {
  const conversations = workspace.sortedConversations
  const activeId = workspace.activeId
  const runningIds = workspace.runningServerIds
  const unreadIds = workspace.unreadIds
  const activeProject = workspace.activeProject
  const deleteConversation = useDeleteConversation()
  const [internalQuery, setInternalQuery] = useState("")

  const handleNewChat = async () => {
    if (!activeProject) return
    try {
      await workspace.createNew()
      onConversationOpen?.(workspace.activeId ?? "")
    } catch (err) {
      console.error("createNew failed", err)
    }
  }

  // Inline mode uses the parent's shared query; standalone mode has its own.
  const showInternalSearch = externalQuery === undefined
  const query = showInternalSearch ? internalQuery : externalQuery
  const chats = useMemo(() => {
    const list = conversations.filter((c) => c.kind !== "task")
    if (!query) return list
    const q = query.toLowerCase()
    return list.filter((c) => c.title.toLowerCase().includes(q))
  }, [conversations, query])

  // Ghost stub — lives in the source accordion while the real section is
  // promoted to a side panel. Click to pull it back.
  if (ghost) {
    return (
      <button
        type="button"
        onClick={onRestore}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs text-muted-foreground opacity-60 hover:opacity-100 hover:bg-sidebar-accent/50 cursor-pointer"
        aria-label="Return Chats to sidebar"
      >
        <ArrowUpRight className="size-3 shrink-0" />
        <MessageSquare className="size-3 shrink-0" />
        <span>Chats</span>
        <span className="text-[10px] opacity-60">{chats.length}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide">in panel</span>
      </button>
    )
  }

  const header = (
    <div
      className={cn(
        "flex w-full items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground",
        onToggleExpanded && "cursor-pointer hover:bg-sidebar-accent/50"
      )}
      onClick={onToggleExpanded}
      role={onToggleExpanded ? "button" : undefined}
      aria-expanded={onToggleExpanded ? expanded : undefined}
    >
      {onToggleExpanded &&
        (expanded ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        ))}
      <MessageSquare className="size-3 shrink-0" />
      <span>Chats</span>
      <span className="text-[10px] opacity-60">{chats.length}</span>
      {loading && <span className="text-[10px] ml-1">loading…</span>}
      <span
        className="ml-auto flex items-center"
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip>
          <TooltipTrigger>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation()
                void handleNewChat()
              }}
              disabled={!activeProject}
              aria-label="New chat"
            >
              <Plus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {activeProject ? "New chat" : "Select a project first"}
          </TooltipContent>
        </Tooltip>
        {onPromote && onRestore && onEnterFullscreen && onExitFullscreen && (
          <SectionMenu
            promoted={promoted}
            fullscreen={fullscreen}
            onPromote={onPromote}
            onRestore={onRestore}
            onEnterFullscreen={onEnterFullscreen}
            onExitFullscreen={onExitFullscreen}
          />
        )}
        {fullscreen && onExitFullscreen && (
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="sm"
                variant="ghost"
                className="size-5"
                onClick={(e) => {
                  e.stopPropagation()
                  onExitFullscreen()
                }}
                aria-label="Close"
              >
                <X className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Close (Esc)</TooltipContent>
          </Tooltip>
        )}
      </span>
    </div>
  )

  return (
    <div className={cn("flex flex-col min-h-0", expanded && "flex-1")}>
      {header}
      {expanded && (
        <>
          {showInternalSearch && (
            <div className="px-2 pb-1">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Filter chats…"
                  value={internalQuery}
                  onChange={(e) => setInternalQuery(e.target.value)}
                  className="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
          )}
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-2 flex flex-col gap-0.5">
              {chats.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  {query ? "No matches." : "No chats."}
                </div>
              ) : (
                chats.map((c) => (
                  <ConversationRow
                    key={c.id}
                    kind={c.kind}
                    title={c.title}
                    updated={c.updatedAt}
                    branch={c.branch}
                    iteration={c.loopIteration}
                    maxIterations={c.maxIterations}
                    shipped={!!c.shippedAt}
                    active={c.id === activeId}
                    running={runningIds.has(c.id)}
                    unread={unreadIds.has(c.id)}
                    onClick={() => {
                      workspace.setActive(c.id)
                      onConversationOpen?.(c.id)
                    }}
                    onDelete={() =>
                      void deleteConversation(c.id, "this conversation", !!c.worktreePath)
                    }
                  />
                ))
              )}
            </div>
          </ScrollArea>
        </>
      )}
    </div>
  )
})
