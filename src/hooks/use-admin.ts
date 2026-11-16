import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { useAuth } from "@/lib/auth"

/** Returns { isAdmin, pendingCount } — re-checks when the session changes. */
export function useAdmin() {
  const { session } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
    if (!session) {
      setIsAdmin(false)
      setPendingCount(0)
      return
    }

    let cancelled = false
    const check = async () => {
      try {
        const r = await api("/api/health-authed")
        if (!r.ok || cancelled) return
        const body = await r.json()
        setIsAdmin(!!body.isAdmin)
        if (body.isAdmin) {
          const r2 = await api("/api/access-requests?status=pending")
          if (r2.ok && !cancelled) {
            const list = await r2.json()
            setPendingCount(Array.isArray(list) ? list.length : 0)
          }
        }
      } catch { /* ignore */ }
    }
    void check()

    // Poll every 30s so the admin sees new requests without manual refresh
    const timer = setInterval(check, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [session])

  return { isAdmin, pendingCount, refreshPending: () => {
    // Allow manual refresh after approve/deny
    api("/api/access-requests?status=pending").then(async (r) => {
      if (r.ok) {
        const list = await r.json()
        setPendingCount(Array.isArray(list) ? list.length : 0)
      }
    }).catch(() => {})
  }}
}
