import { FileCode, Check, Plus, Minus } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

type Change = {
  file: string
  additions: number
  deletions: number
  status: "pending" | "applied"
}

const changes: Change[] = [
  { file: "src/middleware/auth.ts", additions: 24, deletions: 18, status: "applied" },
  { file: "src/middleware/auth.test.ts", additions: 6, deletions: 2, status: "applied" },
  { file: "src/routes/login.ts", additions: 3, deletions: 3, status: "pending" },
]

export function CodePanel() {
  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <FileCode className="size-4" />
          <h2 className="text-sm font-medium">Changes</h2>
          <span className="text-xs text-muted-foreground">
            {changes.length} files
          </span>
        </div>
        <Button size="sm" variant="outline">
          Apply all
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 flex flex-col gap-2">
          {changes.map((c) => (
            <div
              key={c.file}
              className="rounded-md border p-3 flex flex-col gap-2 hover:bg-accent/40 cursor-pointer"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-sm font-mono">{c.file}</div>
                {c.status === "applied" ? (
                  <Check className="size-4 text-green-600 shrink-0" />
                ) : (
                  <span className="text-xs text-amber-600 shrink-0">
                    pending
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="flex items-center gap-0.5 text-green-600">
                  <Plus className="size-3" />
                  {c.additions}
                </span>
                <span className="flex items-center gap-0.5 text-red-600">
                  <Minus className="size-3" />
                  {c.deletions}
                </span>
              </div>
            </div>
          ))}
        </div>
        <Separator />
        <div className="p-3 text-xs text-muted-foreground">
          Tool calls and diffs appear here as Claude edits.
        </div>
      </ScrollArea>
    </div>
  )
}
