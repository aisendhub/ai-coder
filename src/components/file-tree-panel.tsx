import { useCallback, useEffect, useMemo, useState } from "react"
import { observer } from "mobx-react-lite"
import {
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  FolderTree,
  Folder,
  FolderOpen,
  File,
  RefreshCw,
  Search,
  X,
  Eye,
  EyeOff,
} from "lucide-react"
import { api } from "@/lib/api"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { workspace } from "@/models"

type Entry = {
  name: string
  type: "dir" | "file" | "other"
}

type TreeResponse = {
  path: string
  entries: Entry[]
}

type DirState = {
  entries: Entry[] | null // null = not loaded yet
  loading: boolean
  error: string | null
}

export const FileTreePanel = observer(function FileTreePanel({
  onClose,
}: { onClose?: () => void } = {}) {
  const active = workspace.active
  const conversationId = active?.id ?? null
  const cwd = active?.worktreePath ?? workspace.activeProject?.cwd ?? ""
  const [dirs, setDirs] = useState<Map<string, DirState>>(() => new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""])) // root always expanded
  const [showHidden, setShowHidden] = useState(false)
  const [search, setSearch] = useState("")

  const loadDir = useCallback(
    async (path: string) => {
      if (!conversationId) return
      setDirs((prev) => {
        const next = new Map(prev)
        const curr = next.get(path) ?? { entries: null, loading: false, error: null }
        next.set(path, { ...curr, loading: true, error: null })
        return next
      })
      try {
        const qs = new URLSearchParams({
          conversationId,
          path,
          ...(showHidden ? { hidden: "1" } : {}),
        })
        const res = await api(`/api/tree?${qs.toString()}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as TreeResponse
        setDirs((prev) => {
          const next = new Map(prev)
          next.set(path, { entries: json.entries, loading: false, error: null })
          return next
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setDirs((prev) => {
          const next = new Map(prev)
          next.set(path, { entries: null, loading: false, error: msg })
          return next
        })
      }
    },
    [conversationId, showHidden]
  )

  // Reset + load root whenever conversation changes.
  useEffect(() => {
    if (!conversationId) {
      setDirs(new Map())
      setExpanded(new Set([""]))
      return
    }
    setDirs(new Map())
    setExpanded(new Set([""]))
    void loadDir("")
  }, [conversationId, loadDir])

  // Reload every visible directory when hidden-file toggle flips.
  useEffect(() => {
    // Snapshot which dirs are currently loaded so we can refresh them.
    const loadedPaths = Array.from(dirs.keys())
    if (loadedPaths.length === 0) return
    for (const p of loadedPaths) void loadDir(p)
    // We intentionally depend on showHidden only — reloading on every `dirs`
    // change would loop forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden])

  const toggle = useCallback(
    (path: string, entry: Entry) => {
      if (entry.type !== "dir") return
      const full = joinPath(path, entry.name)
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(full)) {
          next.delete(full)
        } else {
          next.add(full)
          const state = dirs.get(full)
          if (!state || (state.entries === null && !state.loading)) {
            void loadDir(full)
          }
        }
        return next
      })
    },
    [dirs, loadDir]
  )

  const refreshAll = useCallback(() => {
    for (const p of dirs.keys()) void loadDir(p)
  }, [dirs, loadDir])

  // Expand every folder we've already fetched. (We can't expand unloaded
  // folders without fetching them — this just opens what's been touched.)
  const expandAll = useCallback(() => {
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const [path, state] of dirs) {
        if (!state.entries) continue
        for (const e of state.entries) {
          if (e.type === "dir") next.add(joinPath(path, e.name))
        }
      }
      return next
    })
  }, [dirs])

  const collapseAll = useCallback(() => {
    // Keep the root open — collapsing it would leave an empty panel.
    setExpanded(new Set([""]))
  }, [])

  // True if any folder beyond the root is expanded. Drives the single
  // toggle button: any open → click collapses; otherwise click expands.
  const anyExpanded = expanded.size > 1

  const rootState = dirs.get("")
  const rootName = useMemo(() => cwd.split("/").filter(Boolean).pop() ?? "/", [cwd])

  if (!conversationId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        Select a conversation to browse files.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="shrink-0 border-b">
        <div className="flex h-14 items-center justify-between px-3 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <FolderTree className="size-4 shrink-0" />
            <h2 className="text-sm font-medium truncate">Files</h2>
            <span className="text-xs text-muted-foreground truncate font-mono" title={cwd}>
              {rootName}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowHidden((v) => !v)}
                    aria-pressed={showHidden}
                    aria-label={showHidden ? "Hide dotfiles" : "Show dotfiles"}
                    className={cn(showHidden && "bg-accent text-accent-foreground")}
                  />
                }
              >
                {showHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
              </TooltipTrigger>
              <TooltipContent>{showHidden ? "Hide dotfiles" : "Show dotfiles"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button size="sm" variant="ghost" onClick={refreshAll} aria-label="Refresh" />
                }
              >
                <RefreshCw className={cn("size-3.5", rootState?.loading && "animate-spin")} />
              </TooltipTrigger>
              <TooltipContent>Refresh tree</TooltipContent>
            </Tooltip>
            {onClose && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close files" />
                  }
                >
                  <X className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>Close</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 px-3 pb-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Filter files…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={anyExpanded ? collapseAll : expandAll}
                  aria-label={anyExpanded ? "Collapse all" : "Expand all"}
                />
              }
            >
              {anyExpanded ? (
                <ChevronsUp className="size-3.5" />
              ) : (
                <ChevronsDown className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipContent>
              {anyExpanded ? "Collapse all" : "Expand all loaded folders"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {rootState?.error && (
          <div className="p-3 text-xs text-red-600 bg-red-500/10 m-3 rounded-md">
            {rootState.error}
          </div>
        )}
        <div className="py-1">
          <TreeChildren
            path=""
            dirs={dirs}
            expanded={expanded}
            onToggle={toggle}
            depth={0}
            search={search.trim().toLowerCase()}
          />
        </div>
      </ScrollArea>
    </div>
  )
})

function TreeChildren({
  path,
  dirs,
  expanded,
  onToggle,
  depth,
  search,
}: {
  path: string
  dirs: Map<string, DirState>
  expanded: Set<string>
  onToggle: (parent: string, entry: Entry) => void
  depth: number
  search: string
}) {
  const state = dirs.get(path)
  if (!state) return null
  if (state.loading && state.entries === null) {
    return <div className="pl-6 py-1 text-[11px] text-muted-foreground">Loading…</div>
  }
  if (state.error) {
    return <div className="pl-6 py-1 text-[11px] text-red-600">{state.error}</div>
  }
  const entries = state.entries ?? []

  // With a filter: keep (a) any entry whose own name matches, or (b) any
  // directory whose loaded subtree contains a match. Folders along a match
  // path remain visible as breadcrumbs, even when their names don't match.
  const visible = search
    ? entries.filter((e) => {
        const full = joinPath(path, e.name)
        if (e.name.toLowerCase().includes(search)) return true
        if (e.type === "dir" && subtreeMatches(full, dirs, search)) return true
        return false
      })
    : entries

  if (entries.length === 0) {
    return <div className="pl-6 py-1 text-[11px] text-muted-foreground">Empty</div>
  }
  if (visible.length === 0) {
    return <div className="pl-6 py-1 text-[11px] text-muted-foreground">No matches</div>
  }

  return (
    <>
      {visible.map((entry) => {
        const full = joinPath(path, entry.name)
        const isDir = entry.type === "dir"
        const nameMatches = !!search && entry.name.toLowerCase().includes(search)
        // When searching, auto-open a folder whose children we've loaded and
        // that contains a match — otherwise the user has to manually expand to
        // see why it matched. Folders whose own name matches stay collapsed
        // so the result list stays compact.
        const autoOpen =
          !!search && isDir && !nameMatches && subtreeMatches(full, dirs, search)
        const isOpen = isDir && (expanded.has(full) || autoOpen)
        return (
          <div key={full}>
            <TreeRow
              entry={entry}
              fullPath={full}
              depth={depth}
              isOpen={isOpen}
              onToggle={() => onToggle(path, entry)}
            />
            {isDir && isOpen && (
              <TreeChildren
                path={full}
                dirs={dirs}
                expanded={expanded}
                onToggle={onToggle}
                depth={depth + 1}
                search={search}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

// Returns true if any loaded descendant of `path` has a name containing the
// search query. Only walks folders we've already fetched — won't trigger I/O.
function subtreeMatches(path: string, dirs: Map<string, DirState>, search: string): boolean {
  const state = dirs.get(path)
  if (!state || !state.entries) return false
  for (const e of state.entries) {
    if (e.name.toLowerCase().includes(search)) return true
    if (e.type === "dir") {
      const full = joinPath(path, e.name)
      if (subtreeMatches(full, dirs, search)) return true
    }
  }
  return false
}

function TreeRow({
  entry,
  fullPath,
  depth,
  isOpen,
  onToggle,
}: {
  entry: Entry
  fullPath: string
  depth: number
  isOpen: boolean
  onToggle: () => void
}) {
  const isDir = entry.type === "dir"
  const onClick = () => {
    if (isDir) onToggle()
    else workspace.openFile(fullPath)
  }
  const Icon = isDir ? (isOpen ? FolderOpen : Folder) : File
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-1 px-2 py-0.5 text-left hover:bg-accent/40 cursor-pointer"
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      title={fullPath}
    >
      {isDir ? (
        isOpen ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )
      ) : (
        <span className="inline-block size-3 shrink-0" />
      )}
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          isDir ? "text-sky-600 dark:text-sky-400" : "text-muted-foreground"
        )}
      />
      <span className="truncate text-[12px] font-mono">{entry.name}</span>
    </button>
  )
}

function joinPath(parent: string, name: string): string {
  if (!parent) return name
  return `${parent}/${name}`
}
