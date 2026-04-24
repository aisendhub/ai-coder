import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** Shared annotation chip for the file-panel rail (comments + blame).
 *  Visual-only: callers compute color / label / state. Dense (blame) chips
 *  should pass `faded`; sparse (comment) chips should not. */
export function AnnotationChip({
  color,
  label,
  faded,
  isOpen,
  title,
  onClick,
  className,
  children,
}: {
  color?: string
  label?: string
  faded?: boolean
  isOpen?: boolean
  title?: string
  onClick?: () => void
  className?: string
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isOpen ? true : undefined}
      title={title}
      className={cn(
        "relative flex items-center gap-1 h-full w-full text-left text-[10px] font-mono tabular-nums",
        "transition-[opacity,color] duration-100 cursor-pointer",
        "text-muted-foreground hover:text-foreground hover:opacity-100",
        faded && !isOpen ? "opacity-35" : "opacity-100",
        isOpen && "text-foreground",
        className
      )}
    >
      {color && (
        <span
          aria-hidden
          className="block h-full w-[3px] shrink-0 rounded-sm"
          style={{ backgroundColor: color }}
        />
      )}
      {label && <span className="truncate">{label}</span>}
      {children}
    </button>
  )
}

/** Hash a 40-hex commit SHA (or any string) to a stable HSL color with a
 *  mid saturation/lightness that reads on both light and dark themes. */
export function shaToColor(sha: string): string {
  if (!sha || /^0+$/.test(sha)) return "hsl(0 0% 55%)"
  let h = 0
  for (let i = 0; i < Math.min(sha.length, 12); i++) {
    h = (h * 31 + sha.charCodeAt(i)) >>> 0
  }
  return `hsl(${h % 360} 55% 55%)`
}

/** "3w" / "5mo" / "2y" compact age for chip labels. Input is ms since epoch. */
export function compactAge(ms: number): string {
  if (!ms) return ""
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`
  return `${Math.floor(s / (86400 * 365))}y`
}

/** "Alice Example" → "AE". Empty / single-word → first two chars. */
export function authorInitials(name: string): string {
  const cleaned = name.trim()
  if (!cleaned) return "?"
  const parts = cleaned.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return cleaned.slice(0, 2).toUpperCase()
}
