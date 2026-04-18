import { useEffect } from "react"
import { toast } from "sonner"
import { workspace } from "@/models"
import { supabase } from "@/lib/supabase"

const TOAST_DURATION_MS = 6000
const SNIPPET_MAX_LEN = 160

function trimSnippet(text: string): string {
  const clean = text.trim()
  if (clean.length <= SNIPPET_MAX_LEN) return clean
  return clean.slice(0, SNIPPET_MAX_LEN) + "..."
}

async function fetchLastAssistantText(conversationId: string): Promise<string> {
  try {
    const { data } = await supabase
      .from("messages")
      .select("text")
      .eq("conversation_id", conversationId)
      .eq("role", "assistant")
      .order("created_at", { ascending: false })
      .limit(1)
      .single()
    return data?.text ?? ""
  } catch {
    return ""
  }
}

function showTurnToast(id: string, title: string, snippet: string) {
  toast(title, {
    description: snippet || "AI response ready",
    duration: TOAST_DURATION_MS,
    action: {
      label: "View",
      onClick: () => workspace.setActive(id),
    },
    onClick: () => {
      workspace.setActive(id)
      toast.dismiss()
    },
  })
}

/**
 * Listen for AI turn completions and show a toast notification with the
 * conversation title and the last assistant message. Fires for both the
 * active conversation (via ai-coder:turn-done) and background conversations
 * (via ai-coder:background-done). Clicking the toast activates the conversation.
 */
export function useTurnNotifications() {
  useEffect(() => {
    const onTurnDone = async (e: Event) => {
      const { id, text } = (e as CustomEvent<{ id: string; text: string }>).detail ?? {}
      if (!id) return
      const title = workspace.conversations.find(id)?.title ?? "Chat"
      const snippet = text ? trimSnippet(text) : trimSnippet(await fetchLastAssistantText(id))
      showTurnToast(id, title, snippet)
    }

    const onBackgroundDone = async (e: Event) => {
      const ids = (e as CustomEvent<{ ids: string[] }>).detail?.ids ?? []
      for (const id of ids) {
        const title = workspace.conversations.find(id)?.title ?? "Chat"
        const snippet = trimSnippet(await fetchLastAssistantText(id))
        showTurnToast(id, title, snippet)
      }
    }

    window.addEventListener("ai-coder:turn-done", onTurnDone)
    window.addEventListener("ai-coder:background-done", onBackgroundDone)
    return () => {
      window.removeEventListener("ai-coder:turn-done", onTurnDone)
      window.removeEventListener("ai-coder:background-done", onBackgroundDone)
    }
  }, [])
}
