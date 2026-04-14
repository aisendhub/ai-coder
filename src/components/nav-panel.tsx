import { useCallback, useEffect, useState } from "react"
import { observer } from "mobx-react-lite"
import { MessageSquare, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Sun, Trash2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { workspace } from "@/models"
import { cn } from "@/lib/utils"

type Props = {
  collapsed?: boolean
  onToggle?: () => void
}

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  const toggle = useCallback(() => {
    const next = !dark
    document.documentElement.classList.toggle("dark", next)
    localStorage.setItem("theme", next ? "dark" : "light")
    setDark(next)
  }, [dark])
  // Sync on mount (e.g. from localStorage or system preference)
  useEffect(() => {
    const saved = localStorage.getItem("theme")
    const prefersDark = saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)
    document.documentElement.classList.toggle("dark", prefersDark)
    setDark(prefersDark)
  }, [])
  return { dark, toggle }
}

export const NavPanel = observer(function NavPanel({
  collapsed = false,
  onToggle,
}: Props) {
  const conversations = workspace.sortedConversations
  const activeId = workspace.activeId
  const loading = workspace.loading
  const runningIds = workspace.runningServerIds
  const [query, setQuery] = useState("")
  const { dark, toggle: toggleTheme } = useTheme()

  const filtered = query
    ? conversations.filter((c) =>
        c.title.toLowerCase().includes(query.toLowerCase())
      )
    : conversations

  const handleNew = async () => {
    try {
      await workspace.createNew()
    } catch (err) {
      console.error("createNew failed", err)
    }
  }

  if (collapsed) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center bg-sidebar text-sidebar-foreground py-2 gap-1">
        <Tooltip>
          <TooltipTrigger>
            <Button size="icon" variant="ghost" aria-label="New chat" onClick={handleNew}>
              <Plus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">New chat</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            <Button size="icon" variant="ghost" aria-label="Search">
              <Search className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Search</TooltipContent>
        </Tooltip>
        <div className="my-1 h-px w-6 bg-border" />
        <div className="flex-1 flex flex-col gap-1 overflow-y-auto w-full items-center">
          {conversations.slice(0, 16).map((c) => (
            <Button
              key={c.id}
              size="icon"
              variant={c.id === activeId ? "secondary" : "ghost"}
              aria-label={c.title}
              title={c.title + (runningIds.has(c.id) ? " (running)" : "")}
              onClick={() => workspace.setActive(c.id)}
              className="relative"
            >
              <MessageSquare className="size-4" />
              {runningIds.has(c.id) && (
                <span className="absolute top-1 right-1 size-2 rounded-full bg-emerald-500 ring-2 ring-sidebar animate-pulse" />
              )}
            </Button>
          ))}
        </div>
        <div className="border-t w-full pt-1 flex flex-col items-center gap-1">
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="icon"
                variant="ghost"
                onClick={toggleTheme}
                aria-label="Toggle theme"
              >
                {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{dark ? "Light mode" : "Dark mode"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="icon"
                variant="ghost"
                onClick={onToggle}
                aria-label="Expand nav"
              >
                <PanelLeftOpen className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Expand nav</TooltipContent>
          </Tooltip>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="p-2 flex flex-col gap-2 border-b">
        <Button
          className="w-full justify-start gap-2"
          onClick={handleNew}
        >
          <Plus className="size-4" />
          New chat
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search"
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 flex flex-col gap-0.5">
          <div className="text-xs text-muted-foreground px-2 py-1 flex items-center justify-between">
            <span>Conversations</span>
            {loading && <span className="text-[10px]">loading…</span>}
          </div>
          {filtered.length === 0 && !loading && (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              {query ? "No matches." : "No conversations yet."}
            </div>
          )}
          {filtered.map((c) => (
            <ConversationRow
              key={c.id}
              title={c.title}
              updated={c.updatedAt}
              active={c.id === activeId}
              running={runningIds.has(c.id)}
              onClick={() => workspace.setActive(c.id)}
              onDelete={() => {
                if (confirm("Delete this conversation?")) void workspace.remove(c.id)
              }}
            />
          ))}
        </div>
      </ScrollArea>
      <div className="border-t flex items-center justify-between px-2 py-1.5">
        <div className="text-xs text-muted-foreground px-1">ai-coder · v0.1</div>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="icon"
                variant="ghost"
                onClick={toggleTheme}
                aria-label="Toggle theme"
                className="size-7"
              >
                {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{dark ? "Light mode" : "Dark mode"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="icon"
                variant="ghost"
                onClick={onToggle}
                aria-label="Collapse nav"
                className="size-7"
              >
                <PanelLeftClose className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Collapse nav</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
})

function ConversationRow({
  title,
  updated,
  active,
  running,
  onClick,
  onDelete,
}: {
  title: string
  updated: string
  active: boolean
  running: boolean
  onClick: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={cn(
        "group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground cursor-pointer min-w-0",
        active && "bg-sidebar-accent text-sidebar-accent-foreground"
      )}
      onClick={onClick}
    >
      <div className="relative shrink-0">
        <MessageSquare className="size-4 mt-0.5" />
        {running && (
          <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-sidebar animate-pulse" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate text-sm">{title}</div>
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          {running && <span className="text-emerald-600">running</span>}
          {running && <span>·</span>}
          <span>{formatRelative(updated)}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-600 shrink-0 cursor-pointer"
        aria-label="Delete conversation"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}

function formatRelative(iso: string): string {
  const d = new Date(iso).getTime()
  const diff = Date.now() - d
  const m = Math.floor(diff / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days}d`
  return new Date(d).toLocaleDateString()
}
