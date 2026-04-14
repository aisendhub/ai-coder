import { useCallback, useEffect, useState } from "react"
import { ChevronDown, ChevronRight, FileCode, RefreshCw, FileX, FilePlus, Pencil } from "lucide-react"
import { DiffView, DiffModeEnum } from "@git-diff-view/react"
import "@git-diff-view/react/styles/diff-view.css"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type ChangedFile = {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "untracked"
  oldPath?: string
  diff: string
}

type ChangesResponse = {
  workspace: string
  files: ChangedFile[]
}

export function CodePanel() {
  const [data, setData] = useState<ChangesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const fetchChanges = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/changes")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as ChangesResponse
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchChanges()
    const onTurnDone = () => fetchChanges()
    window.addEventListener("ai-coder:turn-done", onTurnDone)
    return () => window.removeEventListener("ai-coder:turn-done", onTurnDone)
  }, [fetchChanges])

  const files = data?.files ?? []

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode className="size-4 shrink-0" />
          <h2 className="text-sm font-medium">Changes</h2>
          <span className="text-xs text-muted-foreground">{files.length}</span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={fetchChanges}
          disabled={loading}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {error && (
          <div className="p-3 text-xs text-red-600 bg-red-500/10 m-3 rounded-md">
            {error}
          </div>
        )}
        {!error && files.length === 0 && !loading && (
          <div className="p-6 text-center text-xs text-muted-foreground">
            No uncommitted changes.
          </div>
        )}
        <div className="flex flex-col gap-2 p-2">
          {files.map((f) => (
            <FileCard
              key={f.path}
              file={f}
              collapsed={collapsed[f.path] ?? false}
              onToggle={() =>
                setCollapsed((c) => ({ ...c, [f.path]: !c[f.path] }))
              }
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function FileCard({
  file,
  collapsed,
  onToggle,
}: {
  file: ChangedFile
  collapsed: boolean
  onToggle: () => void
}) {
  const name = file.path.split("/").pop() ?? file.path
  const dir = file.path.slice(0, file.path.length - name.length).replace(/\/$/, "")

  return (
    <div className="rounded-md border bg-card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-accent/40"
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <StatusIcon status={file.status} />
        <div className="flex-1 min-w-0">
          <div className="truncate font-mono text-[13px]">{name}</div>
          {dir && (
            <div className="truncate text-[11px] text-muted-foreground font-mono">
              {dir}
            </div>
          )}
        </div>
        <StatusBadge status={file.status} />
      </button>
      {!collapsed && (
        <div className="border-t max-h-[70vh] overflow-auto text-[12px]">
          <Diff file={file} />
        </div>
      )}
    </div>
  )
}

function Diff({ file }: { file: ChangedFile }) {
  const hunks = extractHunks(file.diff)
  if (hunks.length === 0) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        {file.status === "untracked" ? (
          <pre className="whitespace-pre-wrap font-mono">{file.diff || "(empty)"}</pre>
        ) : (
          "No diff."
        )}
      </div>
    )
  }
  return (
    <DiffView
      data={{
        hunks,
        oldFile: { fileName: file.oldPath ?? file.path, fileLang: detectLang(file.path) },
        newFile: { fileName: file.path, fileLang: detectLang(file.path) },
      }}
      diffViewMode={DiffModeEnum.Unified}
      diffViewTheme="light"
      diffViewFontSize={12}
      diffViewHighlight
      diffViewWrap
    />
  )
}

function extractHunks(rawDiff: string): string[] {
  if (!rawDiff) return []
  // Split at every @@ line so each hunk is its own string
  const idx = rawDiff.indexOf("\n@@")
  const first = rawDiff.indexOf("@@")
  if (first === -1) return []
  const body = idx === -1 ? rawDiff.slice(first) : rawDiff.slice(first)
  const parts = body.split(/\n(?=@@)/g).map((p) => p.trim()).filter(Boolean)
  return parts
}

function detectLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    sh: "bash",
    py: "python",
    rs: "rust",
    go: "go",
    sql: "sql",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
  }
  return map[ext] ?? "plaintext"
}

function StatusIcon({ status }: { status: ChangedFile["status"] }) {
  if (status === "added" || status === "untracked")
    return <FilePlus className="size-3.5 shrink-0 text-green-600" />
  if (status === "deleted")
    return <FileX className="size-3.5 shrink-0 text-red-600" />
  return <Pencil className="size-3.5 shrink-0 text-amber-600" />
}

function StatusBadge({ status }: { status: ChangedFile["status"] }) {
  const label =
    status === "untracked" ? "new" : status === "renamed" ? "renamed" : status
  const color =
    status === "added" || status === "untracked"
      ? "text-green-700 bg-green-500/10"
      : status === "deleted"
        ? "text-red-700 bg-red-500/10"
        : status === "renamed"
          ? "text-blue-700 bg-blue-500/10"
          : "text-amber-700 bg-amber-500/10"
  return (
    <span className={cn("text-[10px] rounded px-1.5 py-0.5 uppercase tracking-wide", color)}>
      {label}
    </span>
  )
}
