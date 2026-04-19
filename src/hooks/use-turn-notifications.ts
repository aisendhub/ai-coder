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

function isAppFocused(): boolean {
  return typeof document !== "undefined" && !document.hidden && document.hasFocus()
}

function showOsNotification(id: string, title: string, snippet: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return false
  if (Notification.permission !== "granted") return false
  try {
    const n = new Notification(title, {
      body: snippet || "AI response ready",
      // tag dedupes per-conversation: a fresh turn replaces the previous notification
      tag: `ai-coder:conv:${id}`,
      renotify: true,
    } as NotificationOptions)
    n.onclick = () => {
      window.focus()
      workspace.setActive(id)
      n.close()
    }
    return true
  } catch {
    return false
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

function notifyTurnDone(id: string, title: string, snippet: string) {
  if (isAppFocused()) {
    showTurnToast(id, title, snippet)
  } else if (!showOsNotification(id, title, snippet)) {
    // Fallback to in-app toast if OS notifications aren't available/granted
    showTurnToast(id, title, snippet)
  }
}

/**
 * Listen for AI turn completions and surface them to the user. When the app
 * is focused, shows an in-app toast; when blurred or in a background tab,
 * fires an OS notification (if permission was granted). Clicking either
 * activates the conversation.
 */
export function useTurnNotifications() {
  useEffect(() => {
    const onTurnDone = async (e: Event) => {
      const { id, text } = (e as CustomEvent<{ id: string; text: string }>).detail ?? {}
      if (!id) return
      const title = workspace.conversations.find(id)?.title ?? "Chat"
      const snippet = text ? trimSnippet(text) : trimSnippet(await fetchLastAssistantText(id))
      notifyTurnDone(id, title, snippet)
    }

    const onBackgroundDone = async (e: Event) => {
      const ids = (e as CustomEvent<{ ids: string[] }>).detail?.ids ?? []
      for (const id of ids) {
        const title = workspace.conversations.find(id)?.title ?? "Chat"
        const snippet = trimSnippet(await fetchLastAssistantText(id))
        notifyTurnDone(id, title, snippet)
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
