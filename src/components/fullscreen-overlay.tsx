import { useEffect } from "react"

// Fullscreen wrapper — just positioning + Escape-to-close. The section
// being shown renders its own header with its own close (X) button when
// fullscreen is active; we don't add a second one here.
export function FullscreenOverlay({
  onExit,
  children,
}: {
  onExit: () => void
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onExit])

  return (
    <div
      className="fixed inset-0 z-50 bg-background"
      role="dialog"
      aria-modal="true"
    >
      <div className="h-full min-h-0 flex flex-col">{children}</div>
    </div>
  )
}
