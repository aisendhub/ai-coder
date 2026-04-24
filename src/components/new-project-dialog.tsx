import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ArrowLeft, Folder, GitBranch, Loader2 } from "lucide-react"
import { workspace } from "@/models"
import { api } from "@/lib/api"

type DirEntry = { name: string; path: string }
type BrowseResponse = {
  root: string
  path: string
  name: string
  parent: string | null
  dirs: DirEntry[]
}
type GitInfo = { isGitRepo: boolean; defaultBaseRef: string | null }

type Props = {
  open: boolean
  onClose: () => void
}

export function NewProjectDialog({ open, onClose }: Props) {
  const [name, setName] = useState("")
  const [listing, setListing] = useState<BrowseResponse | null>(null)
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null)
  const [perConversation, setPerConversation] = useState(true)
  const [loadingDir, setLoadingDir] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName("")
    setError(null)
    setPerConversation(true)
    void browse(undefined)
  }, [open])

  useEffect(() => {
    if (!listing) {
      setGitInfo(null)
      return
    }
    let cancelled = false
    api(`/api/fs/git-info?path=${encodeURIComponent(listing.path)}`)
      .then((r) => r.json())
      .then((info: GitInfo) => { if (!cancelled) setGitInfo(info) })
      .catch(() => { if (!cancelled) setGitInfo({ isGitRepo: false, defaultBaseRef: null }) })
    return () => { cancelled = true }
  }, [listing?.path])

  async function browse(path: string | undefined) {
    setLoadingDir(true)
    setError(null)
    try {
      const q = path ? `?path=${encodeURIComponent(path)}` : ""
      const res = await api(`/api/fs/list${q}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setListing(json as BrowseResponse)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingDir(false)
    }
  }

  async function handleCreate() {
    if (!listing) return
    const finalName = name.trim() || listing.name
    setCreating(true)
    setError(null)
    const mode =
      gitInfo?.isGitRepo && perConversation ? "per_conversation" : "shared"
    try {
      await workspace.createProject(finalName, listing.path, mode)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border bg-card text-card-foreground shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b">
          <h2 className="text-base font-semibold">New project</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Pick a directory on this machine. Conversations in this project use it as cwd.
          </p>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Project name</label>
            <Input
              placeholder={listing?.name ?? "My project"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1"
              autoFocus
            />
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-muted-foreground">Directory</span>
              <span className="text-xs font-mono truncate flex-1">{listing?.path ?? "…"}</span>
            </div>
            <div className="flex items-center gap-1 mb-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={!listing?.parent || loadingDir}
                onClick={() => listing?.parent && browse(listing.parent)}
              >
                <ArrowLeft className="size-3.5" />
                Up
              </Button>
              {loadingDir && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            </div>
            <ScrollArea className="h-60 rounded-md border">
              <div className="p-1">
                {listing?.dirs.length === 0 && !loadingDir && (
                  <div className="p-2 text-xs text-muted-foreground">No subdirectories.</div>
                )}
                {listing?.dirs.map((d) => (
                  <button
                    key={d.path}
                    type="button"
                    onClick={() => browse(d.path)}
                    className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground text-left cursor-pointer"
                  >
                    <Folder className="size-4 text-muted-foreground" />
                    <span className="truncate">{d.name}</span>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>

          <div className="rounded-md border p-3 space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 size-3.5 cursor-pointer accent-primary"
                checked={!!gitInfo?.isGitRepo && perConversation}
                disabled={!gitInfo?.isGitRepo}
                onChange={(e) => setPerConversation(e.target.checked)}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <GitBranch className="size-3.5" />
                  Per-task worktree
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                  {gitInfo == null
                    ? "Checking…"
                    : gitInfo.isGitRepo
                      ? `Tasks get their own branch off ${gitInfo.defaultBaseRef ?? "HEAD"} so they can ship via Merge/PR. Chats always share the project cwd.`
                      : "Not a git repository — tasks will run on the shared cwd."}
                </div>
              </div>
            </label>
          </div>

          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>

        <div className="p-4 border-t flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!listing || creating}>
            {creating ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null}
            Use this folder
          </Button>
        </div>
      </div>
    </div>
  )
}
