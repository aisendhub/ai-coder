import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react"
import { observer } from "mobx-react-lite"
import { Paperclip, Send, Wrench, Brain, CheckCircle2, AlertTriangle, X, FileText, Image as ImageIcon } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Markdown } from "@/components/markdown"
import {
  extractFilePath,
  isEditingTool,
  useChatState,
} from "@/lib/chat-context"
import { workspace } from "@/models"
import type { Conversation, Message, StreamEvent } from "@/models"
import {
  type Attachment,
  readFileAsAttachment,
  isImageAttachment,
  MAX_TOTAL_SIZE,
} from "@/lib/attachment"

const MAX_TEXTAREA_HEIGHT = 240

export const ChatPanel = observer(function ChatPanel() {
  const conversation = workspace.active
  const { recordFileTouch } = useChatState()
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll instantly on conversation open, new messages, or streaming content.
  const activeId = conversation?.id
  const messageCount = conversation?.messages.items.length ?? 0
  const lastText = conversation?.lastAssistant?.text.length ?? 0
  const lastEvents = conversation?.lastAssistant?.events.length ?? 0
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant", block: "end" })
  }, [activeId, messageCount, lastText, lastEvents])

  // Wire tool_use events into the file-touch tracker for the side panel
  useEffect(() => {
    if (!conversation) return
    const last = conversation.lastAssistant
    if (!last) return
    for (const ev of last.events) {
      if (ev.kind === "tool_use" && isEditingTool(ev.name)) {
        const path = extractFilePath(ev.name, ev.input)
        if (path) recordFileTouch(path, ev.name)
      }
    }
  }, [conversation, conversation?.lastAssistant?.events.length, recordFileTouch])

  const handleSend = async (prompt: string, attachments?: Attachment[]) => {
    // Always read the latest active from the store — never the closure value,
    // which may be stale if the user just switched conversations.
    let target = workspace.active
    if (!target) {
      try {
        target = await workspace.createNew()
      } catch (err) {
        console.error("createNew failed", err)
        return
      }
    }
    console.log(
      "[chat] send",
      target.id.slice(0, 6),
      "streaming=" + target.streaming,
      "queueLen=" + target.queue.length,
      "attachments=" + (attachments?.length ?? 0)
    )
    void target.send(prompt, attachments)
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <ScrollArea className="flex-1 min-h-0">
        <div className="mx-auto w-full max-w-2xl px-4 py-6 flex flex-col gap-4">
          {!conversation && (
            <div className="text-center text-sm text-muted-foreground py-16">
              Start a conversation with Claude.
            </div>
          )}
          {conversation?.messages.items.map((m, i, all) => {
            const isLast = i === all.length - 1
            const isStreamingThis =
              conversation.streaming && isLast && m.role === "assistant"
            return (
              <MessageBubble
                key={m.id}
                message={m}
                isStreaming={isStreamingThis}
              />
            )
          })}
          {conversation?.queue.map((q, idx) => (
            <div
              key={`q-${idx}`}
              className="self-end max-w-[85%] rounded-2xl bg-primary/60 text-primary-foreground px-4 py-2 opacity-70"
            >
              {q.attachments && q.attachments.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1">
                  {q.attachments.map((a) => (
                    <span key={a.id} className="inline-flex items-center gap-1 text-[10px] bg-primary-foreground/20 rounded px-1.5 py-0.5">
                      <Paperclip className="size-2.5" />
                      {a.filename}
                    </span>
                  ))}
                </div>
              )}
              <div className="text-sm leading-relaxed whitespace-pre-wrap">
                {q.prompt}
              </div>
              <div className="text-[10px] mt-1 opacity-80">queued</div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      <div className="border-t p-3">
        <div className="mx-auto w-full max-w-2xl">
          <Composer onSend={handleSend} />
        </div>
      </div>
    </div>
  )
})

const MessageBubble = observer(function MessageBubble({
  message,
  isStreaming,
}: {
  message: Message
  isStreaming: boolean
}) {
  if (message.role === "user") {
    return (
      <div className="self-end max-w-[85%] rounded-2xl bg-primary text-primary-foreground px-4 py-2">
        {message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {message.attachments.map((a, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 text-xs bg-primary-foreground/20 rounded px-1.5 py-0.5"
              >
                {isImageAttachment(a) ? (
                  <ImageIcon className="size-3" />
                ) : (
                  <FileText className="size-3" />
                )}
                {a.filename}
              </span>
            ))}
          </div>
        )}
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
})

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
          {renderToolHint(event.input)}
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

function renderToolHint(input: unknown): string {
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

function Composer({
  onSend,
}: {
  onSend: (prompt: string, attachments?: Attachment[]) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [fileError, setFileError] = useState<string | null>(null)

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

  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return
    setFileError(null)

    const newAttachments: Attachment[] = []
    for (const file of Array.from(files)) {
      try {
        const att = await readFileAsAttachment(file)
        newAttachments.push(att)
      } catch (err) {
        setFileError(err instanceof Error ? err.message : "Failed to read file")
      }
    }

    setAttachments((prev) => {
      const combined = [...prev, ...newAttachments]
      const totalSize = combined.reduce((sum, a) => sum + a.sizeBytes, 0)
      if (totalSize > MAX_TOTAL_SIZE) {
        setFileError(`Total attachment size exceeds ${MAX_TOTAL_SIZE / 1024 / 1024} MB limit`)
        return prev
      }
      return combined
    })

    // Reset the input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
    setFileError(null)
  }

  function submit() {
    const trimmed = value.trim()
    if (!trimmed && attachments.length === 0) return
    onSend(trimmed || "(attached files)", attachments.length > 0 ? attachments : undefined)
    setValue("")
    setAttachments([])
    setFileError(null)
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }

  const canSend = value.trim().length > 0 || attachments.length > 0

  return (
    <div className="rounded-xl border bg-background shadow-xs focus-within:ring-2 focus-within:ring-ring">
      {/* Attachment preview strip */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="group relative flex items-center gap-1.5 rounded-lg border bg-muted/50 px-2.5 py-1.5 text-xs"
            >
              {isImageAttachment(att) ? (
                <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="max-w-[120px] truncate">{att.filename}</span>
              <span className="text-muted-foreground">
                {att.sizeBytes < 1024
                  ? `${att.sizeBytes} B`
                  : att.sizeBytes < 1024 * 1024
                    ? `${(att.sizeBytes / 1024).toFixed(1)} KB`
                    : `${(att.sizeBytes / (1024 * 1024)).toFixed(1)} MB`}
              </span>
              <button
                type="button"
                className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
                onClick={() => removeAttachment(att.id)}
                aria-label={`Remove ${att.filename}`}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {fileError && (
        <div className="px-3 pt-2 text-xs text-red-500">{fileError}</div>
      )}
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
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
        <Button
          type="button"
          size="icon"
          className="shrink-0"
          aria-label="Send"
          onClick={submit}
          disabled={!canSend}
        >
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  )
}

// Re-export so callers that imported these from chat-panel don't break.
// (Preferred: import from "@/models" directly.)
export type { Conversation }
