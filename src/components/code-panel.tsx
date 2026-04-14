import { FileCode, FileText } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { useChatState } from "@/lib/chat-context"

export function CodePanel() {
  const { files, clearFiles } = useChatState()

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <FileCode className="size-4" />
          <h2 className="text-sm font-medium">Changed files</h2>
          <span className="text-xs text-muted-foreground">
            {files.length}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={clearFiles}
          disabled={files.length === 0}
        >
          Clear
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {files.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Files Claude edits will appear here as the agent works.
          </div>
        ) : (
          <div className="p-2 flex flex-col gap-1">
            {files
              .slice()
              .sort((a, b) => b.lastAt - a.lastAt)
              .map((f) => (
                <FileRow key={f.path} file={f} />
              ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

function FileRow({
  file,
}: {
  file: { path: string; toolCount: number; lastTool: string }
}) {
  const name = file.path.split("/").pop() ?? file.path
  const dir = file.path.slice(0, file.path.length - name.length).replace(/\/$/, "")
  return (
    <div className="group rounded-md px-2 py-1.5 hover:bg-accent/40 flex items-center gap-2 text-sm min-w-0">
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="truncate font-mono text-[13px]">{name}</div>
        {dir && (
          <div className="truncate text-[11px] text-muted-foreground font-mono">
            {dir}
          </div>
        )}
      </div>
      <div className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
        {file.lastTool}
        {file.toolCount > 1 ? ` ×${file.toolCount}` : ""}
      </div>
    </div>
  )
}
