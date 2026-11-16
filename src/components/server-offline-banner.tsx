import { useState } from "react"
import { AlertTriangle, Loader2, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { isDesktopShell, restartServer } from "@/lib/desktop"

/** Slim banner shown when the local API server stops answering. Offers a
 *  re-check everywhere, and a real restart in the desktop shell (which can
 *  spawn scripts/restart-server.sh). */
export function ServerOfflineBanner({
  checking,
  onRetry,
}: {
  checking: boolean
  onRetry: () => Promise<boolean>
}) {
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const desktop = isDesktopShell()

  const handleRestart = async () => {
    setRestarting(true)
    setError(null)
    try {
      await restartServer()
      const ok = await onRetry()
      if (ok) window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div className="fixed inset-x-0 top-0 z-50 flex items-center gap-2 border-b border-amber-500/40 bg-amber-100 px-3 py-1.5 text-xs text-amber-950 shadow-sm dark:bg-amber-950 dark:text-amber-100">
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        The server isn’t responding — responses won’t arrive until it’s back.
        {!desktop && (
          <span className="opacity-80"> Run `npm run server:restart`.</span>
        )}
        {error && <span className="ml-1 opacity-80">({error})</span>}
      </span>
      <div className="ml-auto flex items-center gap-1 shrink-0">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 gap-1"
          onClick={() => void onRetry()}
          disabled={checking}
        >
          {checking ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RotateCw className="size-3" />
          )}
          Retry
        </Button>
        {desktop && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 gap-1"
            onClick={() => void handleRestart()}
            disabled={restarting}
          >
            {restarting && <Loader2 className="size-3 animate-spin" />}
            Restart server
          </Button>
        )}
      </div>
    </div>
  )
}
