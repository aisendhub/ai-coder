import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import {
  type Conversation,
  createConversation as createConversationDB,
  deleteConversation as deleteConversationDB,
  listConversations,
  updateConversation,
} from "@/lib/conversations"
import { useAuth } from "@/lib/auth"
import { supabase } from "@/lib/supabase"

type State = {
  conversations: Conversation[]
  activeId: string | null
  loading: boolean
  runningIds: Set<string>
  setActive: (id: string | null) => void
  refresh: () => Promise<void>
  createNew: () => Promise<Conversation>
  remove: (id: string) => Promise<void>
  updateTitle: (id: string, title: string) => Promise<void>
  setSessionId: (id: string, sessionId: string) => Promise<void>
}

const ConversationContext = createContext<State | null>(null)

export function ConversationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    if (!user) {
      setConversations([])
      return
    }
    setLoading(true)
    try {
      const data = await listConversations(user.id)
      setConversations(data)
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Realtime: keep the conversations list reactive (server-side runners may
  // bump updated_at on a conversation we're not viewing).
  useEffect(() => {
    if (!user) return
    const channel = supabase
      .channel("conversations:user")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const c = payload.new as Conversation
            setConversations((prev) =>
              prev.some((x) => x.id === c.id) ? prev : [c, ...prev]
            )
          } else if (payload.eventType === "UPDATE") {
            const c = payload.new as Conversation
            setConversations((prev) => {
              const exists = prev.some((x) => x.id === c.id)
              const merged = exists
                ? prev.map((x) => (x.id === c.id ? { ...x, ...c } : x))
                : [c, ...prev]
              return [...merged].sort((a, b) =>
                b.updated_at.localeCompare(a.updated_at)
              )
            })
          } else if (payload.eventType === "DELETE") {
            const c = payload.old as { id: string }
            setConversations((prev) => prev.filter((x) => x.id !== c.id))
          }
        }
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [user])

  // Poll which conversations have a server-side runner active.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetch("/api/runners")
        if (!res.ok) return
        const json = (await res.json()) as { runners: string[] }
        if (cancelled) return
        setRunningIds(new Set(json.runners))
      } catch {
        // ignore
      }
    }
    void tick()
    const interval = setInterval(tick, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const createNew = useCallback(async () => {
    if (!user) throw new Error("not signed in")
    const c = await createConversationDB(user.id)
    setConversations((prev) => [c, ...prev])
    setActiveId(c.id)
    return c
  }, [user])

  const remove = useCallback(
    async (id: string) => {
      await deleteConversationDB(id)
      setConversations((prev) => prev.filter((c) => c.id !== id))
      if (activeId === id) setActiveId(null)
    },
    [activeId]
  )

  const updateTitle = useCallback(async (id: string, title: string) => {
    await updateConversation(id, { title })
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c))
    )
  }, [])

  const setSessionId = useCallback(async (id: string, sessionId: string) => {
    await updateConversation(id, { session_id: sessionId })
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, session_id: sessionId } : c))
    )
  }, [])

  return (
    <ConversationContext.Provider
      value={{
        conversations,
        activeId,
        loading,
        runningIds,
        setActive: setActiveId,
        refresh,
        createNew,
        remove,
        updateTitle,
        setSessionId,
      }}
    >
      {children}
    </ConversationContext.Provider>
  )
}

export function useConversations() {
  const ctx = useContext(ConversationContext)
  if (!ctx)
    throw new Error("useConversations must be used within ConversationProvider")
  return ctx
}

export function useActiveConversation(): Conversation | null {
  const { conversations, activeId } = useConversations()
  return conversations.find((c) => c.id === activeId) ?? null
}
