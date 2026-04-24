import { useCallback } from "react"
import { useConfirm } from "@/lib/confirm"
import { workspace } from "@/models"
import { api } from "@/lib/api"

// Shared delete-with-confirm helper — used by the nav panel and by any
// section that can delete a conversation (e.g. ChatsSection when promoted).
// For worktree-backed conversations we first probe the server to surface
// how much uncommitted/unpushed work would be lost, so the user gets a
// meaningful warning in the confirm dialog instead of a blank prompt.
export function useDeleteConversation() {
  const confirm = useConfirm()
  return useCallback(
    async (id: string, label: string, hasWorktree: boolean) => {
      if (!hasWorktree) {
        const ok = await confirm({
          title: `Delete ${label}?`,
          variant: "destructive",
          confirmText: "Delete",
        })
        if (!ok) return
        try {
          await workspace.remove(id)
        } catch (err) {
          console.error("delete failed", err)
        }
        return
      }
      let warning = ""
      try {
        const res = await api(`/api/conversations/${id}/discard-status`)
        if (res.ok) {
          const s = (await res.json()) as {
            uncommittedFiles: number
            unpushedCommits: number
            hasUpstream: boolean
          }
          const bits: string[] = []
          if (s.uncommittedFiles > 0)
            bits.push(`${s.uncommittedFiles} uncommitted file${s.uncommittedFiles === 1 ? "" : "s"}`)
          if (s.unpushedCommits > 0) {
            bits.push(
              `${s.unpushedCommits} ${s.hasUpstream ? "unpushed" : "local-only"} commit${s.unpushedCommits === 1 ? "" : "s"}`
            )
          }
          if (bits.length)
            warning = `This branch has ${bits.join(" and ")}. They'll be permanently lost when the reaper runs in 7 days.`
        }
      } catch {
        // Probe failed — fall through and use the generic confirm.
      }
      const ok = await confirm({
        title: `Delete ${label}?`,
        description: warning || undefined,
        variant: "destructive",
        confirmText: "Delete",
      })
      if (!ok) return
      try {
        await workspace.remove(id)
      } catch (err) {
        console.error("delete failed", err)
      }
    },
    [confirm]
  )
}
