import { useEffect } from "react"
import { autorun } from "mobx"
import { workspace } from "@/models"

const PREFIX = "/c/"

function pathToId(pathname: string): string | null {
  if (!pathname.startsWith(PREFIX)) return null
  const id = pathname.slice(PREFIX.length).split("/")[0]
  return id || null
}

function idToPath(id: string | null): string {
  return id ? `${PREFIX}${id}` : "/"
}

/**
 * Two-way bind workspace.activeId ↔ window.location.pathname.
 *
 * - On mount: if URL has `/c/<id>`, activate that conversation.
 * - When workspace.activeId changes: pushState to `/c/<id>` (no reload).
 * - On browser back/forward (popstate): re-activate from URL.
 */
export function useUrlSync() {
  useEffect(() => {
    // Initial: URL is the source of truth.
    const initial = pathToId(window.location.pathname)
    if (initial && initial !== workspace.activeId) {
      // Defer until conversations have a chance to load
      const stop = autorun(() => {
        if (workspace.conversations.find(initial)) {
          workspace.setActive(initial)
          stop()
        }
      })
      // Stop the autorun if the user navigates away before it resolves
      const cleanup = () => stop()
      setTimeout(cleanup, 5_000)
    } else if (!initial && workspace.activeId) {
      // No id in URL but we have an active — reflect it
      window.history.replaceState(null, "", idToPath(workspace.activeId))
    } else if (!initial && !workspace.activeId) {
      // Refresh landed on "/" without a conversation id. Restore the last
      // active chat, if it still exists, once conversations have loaded.
      let saved: string | null = null
      try {
        saved = localStorage.getItem("ai-coder:activeConversationId")
      } catch {
        saved = null
      }
      if (saved) {
        const stop = autorun(() => {
          if (workspace.conversations.find(saved!)) {
            workspace.setActive(saved!)
            stop()
          }
        })
        setTimeout(stop, 5_000)
      }
    }

    // Sync activeId → URL
    const stopSync = autorun(() => {
      const id = workspace.activeId
      const target = idToPath(id)
      if (window.location.pathname !== target) {
        window.history.pushState(null, "", target)
      }
    })

    // Sync popstate → activeId
    const onPop = () => {
      const id = pathToId(window.location.pathname)
      if (id !== workspace.activeId) workspace.setActive(id)
    }
    window.addEventListener("popstate", onPop)

    return () => {
      stopSync()
      window.removeEventListener("popstate", onPop)
    }
  }, [])
}
