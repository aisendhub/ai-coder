import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

export function Markdown({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "text-sm leading-relaxed wrap-break-word",
        "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
        "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-0.5",
        // Headings: light-blue, subtle tint on h1/h2 to mirror the Shiki
        // markdown source view (markup.heading + line highlight). h3+ stay
        // colored-only so hierarchy reads clearly without visual noise.
        "[&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-1.5 [&_h1]:text-sky-800 dark:[&_h1]:text-sky-300 [&_h1]:bg-sky-500/6 [&_h1]:rounded-sm [&_h1]:px-2 [&_h1]:py-1 [&_h1:first-child]:mt-0",
        "[&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-sky-700 dark:[&_h2]:text-sky-300 [&_h2]:bg-sky-500/5 [&_h2]:rounded-sm [&_h2]:px-2 [&_h2]:py-0.5",
        "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sky-700 dark:[&_h3]:text-sky-400",
        "[&_h4]:text-sm [&_h4]:font-semibold [&_h4]:mt-2 [&_h4]:mb-0.5 [&_h4]:text-sky-700 dark:[&_h4]:text-sky-400",
        "[&_h5]:text-xs [&_h5]:font-semibold [&_h5]:mt-2 [&_h5]:mb-0.5 [&_h5]:text-sky-700 dark:[&_h5]:text-sky-400 [&_h5]:uppercase [&_h5]:tracking-wide",
        "[&_h6]:text-xs [&_h6]:font-medium [&_h6]:mt-2 [&_h6]:mb-0.5 [&_h6]:text-sky-700/80 dark:[&_h6]:text-sky-400/80 [&_h6]:uppercase [&_h6]:tracking-wide",
        "[&_a]:underline [&_a]:underline-offset-2",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:my-2",
        "[&_hr]:my-3 [&_hr]:border-border",
        "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse",
        "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium",
        "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
        "[&_pre]:my-2 [&_pre]:rounded-md [&_pre]:bg-background/60 [&_pre]:border [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_pre]:leading-relaxed",
        "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-background/60 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.85em] [&_:not(pre)>code]:font-mono",
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  )
}
