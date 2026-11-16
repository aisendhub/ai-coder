import { useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"

export type DiffSummary = {
  filesChanged: number
  additions: number
  deletions: number
  pending: boolean
  commitCount: number
}

/** Batched diff-summary fetcher shared by the board and the chats sidebar.
 *  Refetches whenever the id set changes or a turn finishes for any chat in
 *  the workspace (via the existing `ai-coder:turn-done` event). Returns a map
 *  keyed by conversation id; ids without a summary (shipped, deleted, no
 *  worktree) are absent from the map rather than mapped to null, so callers
 *  can `summaries[id] && …` without a falsy-but-present pitfall.
 *
 *  See docs/WORK-STATE.md. */
export function useDiffSummaries(
  ids: string[],
  enabled = true
): Record<string, DiffSummary> {
  const [summaries, setSummaries] = useState<Record<string, DiffSummary>>({})
  // Stable cache key so [a,b] vs [b,a] doesn't churn.
  const idsKey = useMemo(() => Array.from(new Set(ids)).sort().join(","), [ids])

  useEffect(() => {
    if (!enabled || idsKey === "") {
      setSummaries({})
      return
    }
    const idList = idsKey.split(",")
    let cancelled = false

    const refetch = async () => {
      try {
        const res = await api("/api/conversations/diff-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: idList }),
        })
        if (!res.ok || cancelled) return
        const json = (await res.json()) as {
          summaries: Record<string, DiffSummary | null>
        }
        if (cancelled) return
        const next: Record<string, DiffSummary> = {}
        for (const [id, s] of Object.entries(json.summaries)) {
          if (s) next[id] = s
        }
        setSummaries(next)
      } catch {
        // advisory — UI just doesn't render the chip
      }
    }

    void refetch()
    const onTurnDone = () => void refetch()
    window.addEventListener("ai-coder:turn-done", onTurnDone)
    return () => {
      cancelled = true
      window.removeEventListener("ai-coder:turn-done", onTurnDone)
    }
  }, [idsKey, enabled])

  return summaries
}
