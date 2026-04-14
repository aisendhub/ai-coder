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

type State = {
  conversations: Conversation[]
  activeId: string | null
  loading: boolean
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
