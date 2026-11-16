import { useState } from "react"
import { ChevronDown, ChevronRight, GitCommit, FilePen } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TurnChangeSet, TurnChangeFile } from "@/hooks/use-conversation-turns"

/** Thin row rendered between MessageBubbles (or directly under the assistant
 *  bubble that produced it) showing what the turn changed: summary, files,
 *  +/-, and committed/pending state. Click to expand the file list.
 *
 *  See docs/WORK-STATE.md. */
export function WorkStripe({ turn }: { turn: TurnChangeSet }) {
  const [expanded, setExpanded] = useState(false)
  const committed = !!turn.committed_in_sha
  const fileNoun = turn.files_count === 1 ? "file" : "files"

  return (
    <div
      className={cn(
        "self-stretch rounded-md border bg-card/30 text-xs overflow-hidden",
        committed
          ? "border-emerald-500/30"
          : "border-amber-500/40"
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-card/60 cursor-pointer text-left"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        {committed ? (
          <GitCommit className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <FilePen className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />
        )}
        <span className="font-mono text-[10px] text-muted-foreground shrink-0">
          {turn.files_count}{turn.truncated ? "+" : ""} {fileNoun}
        </span>
        <span className="font-mono text-[10px] inline-flex items-center gap-1.5 shrink-0">
          {turn.insertions > 0 && (
            <span className="text-emerald-600 dark:text-emerald-400">+{turn.insertions}</span>
          )}
          {turn.deletions > 0 && (
            <span className="text-rose-600 dark:text-rose-400">−{turn.deletions}</span>
          )}
        </span>
        {turn.summary && (
          <span className="truncate text-muted-foreground">— {turn.summary}</span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground shrink-0">
          {committed ? (
            <span title={`Committed in ${turn.committed_in_sha?.slice(0, 7)}`}>
              {turn.committed_in_sha?.slice(0, 7)}
            </span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">pending</span>
          )}
        </span>
      </button>
      {expanded && turn.files.length > 0 && (
        <ul className="border-t bg-background/40 divide-y divide-border/50">
          {turn.files.map((f) => (
            <FileRow key={f.path} file={f} />
          ))}
          {turn.truncated && (
            <li className="px-2.5 py-1 text-[10px] text-muted-foreground italic">
              {turn.files_count - turn.files.length} more file{turn.files_count - turn.files.length === 1 ? "" : "s"} not shown
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

const STATUS_STYLE: Record<TurnChangeFile["status"], { label: string; tone: string }> = {
  A: { label: "A", tone: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10" },
  M: { label: "M", tone: "text-amber-600 dark:text-amber-400 bg-amber-500/10" },
  D: { label: "D", tone: "text-rose-600 dark:text-rose-400 bg-rose-500/10" },
  R: { label: "R", tone: "text-sky-600 dark:text-sky-400 bg-sky-500/10" },
}

function FileRow({ file }: { file: TurnChangeFile }) {
  const s = STATUS_STYLE[file.status]
  return (
    <li className="flex items-center gap-2 px-2.5 py-1 text-[11px]">
      <span
        className={cn(
          "font-mono text-[10px] w-4 text-center rounded shrink-0",
          s.tone
        )}
      >
        {s.label}
      </span>
      <span className="font-mono truncate" title={file.path}>{file.path}</span>
      <span className="ml-auto font-mono text-[10px] inline-flex items-center gap-1.5 shrink-0">
        {file.insertions > 0 && (
          <span className="text-emerald-600 dark:text-emerald-400">+{file.insertions}</span>
        )}
        {file.deletions > 0 && (
          <span className="text-rose-600 dark:text-rose-400">−{file.deletions}</span>
        )}
      </span>
    </li>
  )
}
