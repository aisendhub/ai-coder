import { createContext, useContext, useState, type ReactNode } from "react"

export type FileChange = {
  path: string
  toolCount: number          // how many tool_use calls touched it this session
  lastTool: string            // "Edit" | "Write" | "MultiEdit" | "Bash" | ...
  lastAt: number              // Date.now()
}

type ChatState = {
  files: FileChange[]
  recordFileTouch: (path: string, tool: string) => void
  clearFiles: () => void
}

const ChatContext = createContext<ChatState | null>(null)

export function ChatStateProvider({ children }: { children: ReactNode }) {
  const [files, setFiles] = useState<FileChange[]>([])

  const recordFileTouch = (path: string, tool: string) => {
    setFiles((curr) => {
      const existing = curr.find((f) => f.path === path)
      if (existing) {
        return curr.map((f) =>
          f.path === path
            ? {
                ...f,
                toolCount: f.toolCount + 1,
                lastTool: tool,
                lastAt: Date.now(),
              }
            : f
        )
      }
      return [
        ...curr,
        { path, toolCount: 1, lastTool: tool, lastAt: Date.now() },
      ]
    })
  }

  const clearFiles = () => setFiles([])

  return (
    <ChatContext.Provider value={{ files, recordFileTouch, clearFiles }}>
      {children}
    </ChatContext.Provider>
  )
}

export function useChatState() {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error("useChatState must be used within ChatStateProvider")
  return ctx
}

// Extract a file path from a tool_use input payload, for tools that edit files.
export function extractFilePath(
  _toolName: string,
  input: unknown
): string | null {
  if (!input || typeof input !== "object") return null
  const obj = input as Record<string, unknown>
  // Edit, Write, MultiEdit, NotebookEdit, Read — all use file_path
  if (typeof obj.file_path === "string") return obj.file_path
  // Some tools use "path"
  if (typeof obj.path === "string") return obj.path
  return null
}

export function isEditingTool(name: string): boolean {
  return (
    name === "Edit" ||
    name === "Write" ||
    name === "MultiEdit" ||
    name === "NotebookEdit"
  )
}
