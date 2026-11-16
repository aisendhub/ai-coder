import { useCallback, useEffect, useRef, useState } from "react"

// Watches the local API server. The UI is a thin client over that server, so
// when it stops answering every action silently hangs. Polling health lets us
// say so, and offer a restart, instead of leaving the user staring at a stop
// button.
const POLL_MS = 10_000
const TIMEOUT_MS = 4_000

async function probe(): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch("/api/health", {
      cache: "no-store",
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function useServerHealth() {
  // Start optimistic: a single failed probe (e.g. a reload mid-restart)
  // should not flash a scary banner.
  const [online, setOnline] = useState(true)
  const [checking, setChecking] = useState(false)
  const mounted = useRef(true)

  const check = useCallback(async () => {
    setChecking(true)
    const ok = await probe()
    if (mounted.current) {
      setOnline(ok)
      setChecking(false)
    }
    return ok
  }, [])

  useEffect(() => {
    mounted.current = true
    void check()
    const id = setInterval(() => void check(), POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") void check()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      mounted.current = false
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [check])

  return { online, checking, check }
}
