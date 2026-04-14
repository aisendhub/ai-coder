import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react"
import { Paperclip, Send, Wrench, Brain, CheckCircle2, AlertTriangle } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Markdown } from "@/components/markdown"
import {
  extractFilePath,
  isEditingTool,
  useChatState,
} from "@/lib/chat-context"
import {
  useActiveConversation,
  useConversations,
} from "@/lib/conversation-context"
import {
  insertMessage,
  listMessages,
  updateMessage,
} from "@/lib/conversations"

const MAX_TEXTAREA_HEIGHT = 240

type StreamEvent =
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; output: string }
  | { kind: "text"; text: string }

type Message = {
  id: string
  role: "user" | "assistant"
  text: string
  events: StreamEvent[]
}

let idCounter = 0
const nextId = () => `${Date.now()}-${++idCounter}`

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState(false)
  const [queued, setQueued] = useState<string[]>([])
  const sessionIdRef = useRef<string | undefined>(undefined)
  const streamingRef = useRef(false)
  const queueRef = useRef<string[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const { recordFileTouch } = useChatState()
  const conversation = useActiveConversation()
  const { createNew, setSessionId, updateTitle } = useConversations()
  const conversationIdRef = useRef<string | null>(null)
  const loadedConvIdRef = useRef<string | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages])

  // Load history when active conversation changes — but skip if we've already
  // loaded this conversation locally (e.g. just created via runPrompt).
  useEffect(() => {
    conversationIdRef.current = conversation?.id ?? null
    sessionIdRef.current = conversation?.session_id ?? undefined
    if (!conversation) {
      loadedConvIdRef.current = null
      setMessages([])
      return
    }
    if (loadedConvIdRef.current === conversation.id) return
    loadedConvIdRef.current = conversation.id
    let cancelled = false
    listMessages(conversation.id)
      .then((rows) => {
        if (cancelled) return
        setMessages(
          rows.map((r) => ({
            id: r.id,
            role: r.role,
            text: r.text,
            events: Array.isArray(r.events) ? (r.events as StreamEvent[]) : [],
          }))
        )
      })
      .catch((err) => console.error("listMessages failed", err))
    return () => {
      cancelled = true
    }
  }, [conversation])

  const runPrompt = useCallback(async (prompt: string) => {
    // Ensure we have an active conversation; create one if not.
    let convId = conversationIdRef.current
    if (!convId) {
      try {
        const c = await createNew()
        convId = c.id
        conversationIdRef.current = c.id
        loadedConvIdRef.current = c.id   // skip the auto-fetch on this id
        sessionIdRef.current = undefined
      } catch (err) {
        console.error("createNew failed", err)
        return
      }
    }

    // Title the conversation from the first user prompt
    const isFirstMessage = messages.length === 0
    if (isFirstMessage && convId) {
      const title = prompt.split("\n")[0].slice(0, 60)
      void updateTitle(convId, title || "New chat")
    }

    const userMsg: Message = {
      id: nextId(),
      role: "user",
      text: prompt,
      events: [],
    }
    const assistantId = nextId()
    setMessages((m) => [
      ...m,
      userMsg,
      { id: assistantId, role: "assistant", text: "", events: [] },
    ])
    setStreaming(true)
    streamingRef.current = true

    // Persist user + (placeholder) assistant rows. Keep DB ids separate from
    // the in-memory ids so the SSE stream can update local state immediately
    // (no async setState swap to race against).
    let assistantDbId: string | null = null
    try {
      await insertMessage(convId, "user", prompt, [])
      const aRow = await insertMessage(convId, "assistant", "", [])
      assistantDbId = aRow.id
    } catch (err) {
      console.error("insertMessage failed", err)
    }

    const updateAssistant = (fn: (msg: Message) => Message) =>
      setMessages((m) => m.map((msg) => (msg.id === assistantId ? fn(msg) : msg)))

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, sessionId: sessionIdRef.current }),
      })
      if (!res.body) throw new Error("no body")

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split("\n\n")
        buffer = parts.pop() ?? ""
        for (const part of parts) {
          const event = /event: (.+)/.exec(part)?.[1]
          const data = /data: (.+)/.exec(part)?.[1]
          if (!event || !data) continue
          const payload = JSON.parse(data)

          if (event === "session") {
            sessionIdRef.current = payload.sessionId
            // Persist on the conversation so resume works after reload
            if (convId && payload.sessionId) {
              void setSessionId(convId, payload.sessionId)
            }
          } else if (event === "text") {
            updateAssistant((msg) => ({
              ...msg,
              text: msg.text + payload.text,
              events: [...msg.events, { kind: "text", text: payload.text }],
            }))
          } else if (event === "thinking") {
            updateAssistant((msg) => ({
              ...msg,
              events: [...msg.events, { kind: "thinking", text: payload.text }],
            }))
          } else if (event === "tool_use") {
            const path = extractFilePath(payload.name, payload.input)
            if (path && isEditingTool(payload.name)) {
              recordFileTouch(path, payload.name)
            }
            updateAssistant((msg) => ({
              ...msg,
              events: [
                ...msg.events,
                {
                  kind: "tool_use",
                  id: payload.id,
                  name: payload.name,
                  input: payload.input,
                },
              ],
            }))
          } else if (event === "tool_result") {
            updateAssistant((msg) => ({
              ...msg,
              events: [
                ...msg.events,
                {
                  kind: "tool_result",
                  toolUseId: payload.toolUseId,
                  isError: payload.isError,
                  output: payload.output,
                },
              ],
            }))
          } else if (event === "error") {
            updateAssistant((msg) => ({
              ...msg,
              text: msg.text + `\n⚠️ ${payload.message}`,
            }))
          }
        }
      }
    } catch (err) {
      updateAssistant((msg) => ({
        ...msg,
        text:
          msg.text +
          `\n⚠️ ${err instanceof Error ? err.message : String(err)}`,
      }))
    } finally {
      setStreaming(false)
      streamingRef.current = false
      window.dispatchEvent(new CustomEvent("ai-coder:turn-done"))

      // Persist the final assistant text + events to the DB
      if (assistantDbId) {
        const finalMsg = (
          await new Promise<Message | undefined>((resolveMsg) => {
            setMessages((m) => {
              resolveMsg(m.find((x) => x.id === assistantId))
              return m
            })
          })
        )
        if (finalMsg) {
          void updateMessage(assistantDbId, {
            text: finalMsg.text,
            events: finalMsg.events,
          })
        }
      }

      const next = queueRef.current.shift()
      setQueued([...queueRef.current])
      if (next) {
        void runPrompt(next)
      }
    }
  }, [createNew, messages.length, recordFileTouch, setSessionId, updateTitle])

  const sendPrompt = useCallback(
    (prompt: string) => {
      if (streamingRef.current) {
        queueRef.current.push(prompt)
        setQueued([...queueRef.current])
        return
      }
      void runPrompt(prompt)
    },
    [runPrompt]
  )

  // Allow other components to send prompts via custom events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ prompt: string }>).detail
      if (detail?.prompt) sendPrompt(detail.prompt)
    }
    window.addEventListener("ai-coder:send-prompt", handler)
    return () => window.removeEventListener("ai-coder:send-prompt", handler)
  }, [sendPrompt])

  return (
    <div className="flex flex-col h-full min-h-0">
      <ScrollArea className="flex-1 min-h-0">
        <div className="mx-auto w-full max-w-2xl px-4 py-6 flex flex-col gap-4">
          {messages.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-16">
              Start a conversation with Claude.
            </div>
          )}
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1
            const isStreamingThis =
              streaming && isLast && m.role === "assistant"
            return (
              <MessageBubble
                key={m.id}
                message={m}
                isStreaming={isStreamingThis}
              />
            )
          })}
          {queued.map((q, idx) => (
            <div
              key={`q-${idx}`}
              className="self-end max-w-[85%] rounded-2xl bg-primary/60 text-primary-foreground px-4 py-2 opacity-70"
            >
              <div className="text-sm leading-relaxed whitespace-pre-wrap">
                {q}
              </div>
              <div className="text-[10px] mt-1 opacity-80">queued</div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      <div className="border-t p-3">
        <div className="mx-auto w-full max-w-2xl">
          <Composer onSend={sendPrompt} />
        </div>
      </div>
    </div>
  )
}

function MessageBubble({
  message,
  isStreaming,
}: {
  message: Message
  isStreaming: boolean
}) {
  if (message.role === "user") {
    return (
      <div className="self-end max-w-[85%] rounded-2xl bg-primary text-primary-foreground px-4 py-2">
        <div className="text-sm leading-relaxed whitespace-pre-wrap">
          {message.text}
        </div>
      </div>
    )
  }

  const hasContent = message.text.length > 0 || message.events.length > 0

  return (
    <div className="self-start max-w-[85%] w-full flex flex-col gap-2">
      {message.events
        .filter((e) => e.kind !== "text")
        .map((e, idx) => (
          <ActivityRow key={idx} event={e} />
        ))}
      {(message.text || (isStreaming && !hasContent)) && (
        <div className="rounded-2xl bg-muted px-4 py-2">
          {message.text ? (
            <Markdown>
              {isStreaming ? message.text + "▍" : message.text}
            </Markdown>
          ) : (
            <ThinkingDots />
          )}
        </div>
      )}
      {isStreaming && hasContent && !message.text && <ThinkingDots />}
    </div>
  )
}

function ActivityRow({ event }: { event: StreamEvent }) {
  if (event.kind === "thinking") {
    return (
      <div className="flex items-start gap-2 text-xs text-muted-foreground italic border-l-2 border-muted pl-3 py-1">
        <Brain className="size-3.5 mt-0.5 shrink-0" />
        <div className="whitespace-pre-wrap">{event.text}</div>
      </div>
    )
  }
  if (event.kind === "tool_use") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground rounded-md bg-muted/50 px-2 py-1">
        <Wrench className="size-3.5 shrink-0" />
        <span className="font-mono truncate">
          {event.name}
          {renderToolHint(event.name, event.input)}
        </span>
      </div>
    )
  }
  if (event.kind === "tool_result") {
    return (
      <div
        className={
          "flex items-start gap-2 text-xs rounded-md px-2 py-1 " +
          (event.isError
            ? "bg-red-500/10 text-red-700 dark:text-red-400"
            : "bg-green-500/10 text-green-700 dark:text-green-400")
        }
      >
        {event.isError ? (
          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
        ) : (
          <CheckCircle2 className="size-3.5 mt-0.5 shrink-0" />
        )}
        <div className="font-mono whitespace-pre-wrap line-clamp-3 min-w-0">
          {event.output || (event.isError ? "error" : "ok")}
        </div>
      </div>
    )
  }
  return null
}

function renderToolHint(_name: string, input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const obj = input as Record<string, unknown>
  const hint =
    obj.file_path ?? obj.path ?? obj.command ?? obj.pattern ?? obj.url
  if (typeof hint === "string") return ` · ${hint.slice(0, 60)}`
  return ""
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1.5 rounded-2xl bg-muted px-4 py-3 w-fit">
      <Dot delay="0ms" />
      <Dot delay="150ms" />
      <Dot delay="300ms" />
    </div>
  )
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="size-2 rounded-full bg-muted-foreground/60 animate-bounce"
      style={{ animationDelay: delay }}
    />
  )
}

function Composer({ onSend }: { onSend: (prompt: string) => void }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState("")

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value)
    autosize(e.target)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function submit() {
    const trimmed = value.trim()
    if (!trimmed) return
    onSend(trimmed)
    setValue("")
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }

  return (
    <div className="rounded-xl border bg-background shadow-xs focus-within:ring-2 focus-within:ring-ring">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        rows={1}
        placeholder="Ask Claude to change your code…"
        className="block w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm leading-6 outline-none placeholder:text-muted-foreground"
        style={{ maxHeight: MAX_TEXTAREA_HEIGHT }}
      />
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <Tooltip>
          <TooltipTrigger>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label="Upload files"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Upload files</TooltipContent>
        </Tooltip>
        <input ref={fileInputRef} type="file" multiple className="hidden" />
        <Tooltip>
          <TooltipTrigger>
            <Button
              type="button"
              size="icon"
              className="shrink-0"
              aria-label="Send"
              onClick={submit}
              disabled={!value.trim()}
            >
              <Send className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Send message</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
