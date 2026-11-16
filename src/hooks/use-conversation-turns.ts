import { useEffect, useState } from "react"
import { api } from "@/lib/api"

export type TurnChangeFile = {
  path: string
  status: "A" | "M" | "D" | "R"
  insertions: number
  deletions: number
}

export type TurnChangeSet = {
  message_id: string
  conversation_id: string
  files: TurnChangeFile[]
  files_count: number
  truncated: boolean
  insertions: number
  deletions: number
  summary: string | null
  committed_in_sha: string | null
  created_at: string
}

/** Fetches per-turn change records for a conversation. Refetches on the
 *  existing `ai-coder:turn-done` event so a new turn's stripe appears as
 *  soon as the iteration ends.
 *
 *  See docs/WORK-STATE.md. */
export function useConversationTurns(
  conversationId: string | null
): Record<string, TurnChangeSet> {
  const [byMessageId, setByMessageId] = useState<Record<string, TurnChangeSet>>({})

  useEffect(() => {
    if (!conversationId) {
      setByMessageId({})
      return
    }
    let cancelled = false

    const refetch = async () => {
      try {
        const res = await api(`/api/conversations/${conversationId}/turns`)
        if (!res.ok || cancelled) return
        const json = (await res.json()) as { turns: TurnChangeSet[] }
        if (cancelled) return
        const next: Record<string, TurnChangeSet> = {}
        for (const t of json.turns) next[t.message_id] = t
        setByMessageId(next)
      } catch {
        // advisory — chat still renders without stripes
      }
    }

    void refetch()
    const onTurnDone = () => void refetch()
    window.addEventListener("ai-coder:turn-done", onTurnDone)
    return () => {
      cancelled = true
      window.removeEventListener("ai-coder:turn-done", onTurnDone)
    }
  }, [conversationId])

  return byMessageId
}
