import { useEffect } from "react"
import { toast } from "sonner"
import { workspace } from "@/models"
import { supabase } from "@/lib/supabase"

/**
 * Listen for background AI turn completions and show a toast notification
 * with the conversation title and a snippet of the assistant's last message.
 * Clicking the toast navigates to that conversation.
 */
export function useTurnNotifications() {
  useEffect(() => {
    const handler = async (e: Event) => {
      const ids = (e as CustomEvent<{ ids: string[] }>).detail.ids
      for (const id of ids) {
        const convo = workspace.conversations.find(id)
        const title = convo?.title ?? "Chat"

        // Fetch the last assistant message for this conversation
        let snippet = ""
        try {
          const { data } = await supabase
            .from("messages")
            .select("text")
            .eq("conversation_id", id)
            .eq("role", "assistant")
            .order("created_at", { ascending: false })
            .limit(1)
            .single()
          if (data?.text) {
            // Trim to a reasonable preview length
            snippet = data.text.length > 160
              ? data.text.slice(0, 160) + "..."
              : data.text
          }
        } catch {
          // ignore — we'll show the toast without a snippet
        }

        toast(title, {
          description: snippet || "AI response ready",
          duration: 4000,
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
    }

    window.addEventListener("ai-coder:background-done", handler)
    return () => window.removeEventListener("ai-coder:background-done", handler)
  }, [])
}
