import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  getProfile,
  logout as anyOAuthLogout,
  startLogin,
  type Profile,
} from "@anyoauth/client"
import { clearToken, refreshToken, setToken } from "@/lib/auth-token"
import { isDesktopShell, openExternal } from "@/lib/desktop"

type AuthUser = {
  id: string
  email: string | null
  user_metadata: {
    avatar_url?: string | null
    full_name?: string | null
    name?: string | null
    user_name?: string | null
    provider?: string | null
  }
}

type AuthState = {
  session: { user: AuthUser } | null
  user: AuthUser | null
  profile: Profile | null
  loading: boolean
  error: string | null
  pending: boolean
  pendingUrl: string | null
  signInWithGithub: () => void
  signInWithGoogle: () => void
  retryOpen: () => Promise<void>
  cancelLogin: () => void
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

const DESKTOP_POLL_MS = 1500
const DESKTOP_TIMEOUT_MS = 5 * 60 * 1000

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const refreshTimer = useRef<number | null>(null)
  const desktopGeneration = useRef(0)

  const exchangeSession = useCallback(async () => {
    const res = await fetch("/api/auth/session", { credentials: "include" })
    if (!res.ok) return null
    const body = (await res.json()) as {
      token?: string
      user?: AuthUser
      profile?: Profile
    }
    if (!body.token || !body.user) return null
    setToken(body.token)
    return body
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // In a normal browser this returns the AnyOAuth profile. In the
        // desktop webview there is no AnyOAuth cookie, so it is null and the
        // desktop session cookie is used by /api/auth/session instead.
        const nextProfile = await getProfile().catch(() => null)
        const body = await exchangeSession()
        if (cancelled) return
        if (!body) {
          if (nextProfile) setError("Could not establish an application session.")
          return
        }
        setProfile(nextProfile ?? body.profile ?? null)
        setUser(body.user ?? null)
      } catch {
        if (!cancelled) setError("Could not read the login session.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [exchangeSession])

  // PostgREST tokens are short-lived. Refresh before they expire; open SSE /
  // WebSocket connections keep the token they authenticated with.
  useEffect(() => {
    if (!user) return
    const tick = () => {
      void refreshToken()
    }
    refreshTimer.current = window.setInterval(tick, 50 * 60 * 1000)
    return () => {
      if (refreshTimer.current) window.clearInterval(refreshTimer.current)
      refreshTimer.current = null
    }
  }, [user])

  /** Desktop: the server opens the system browser, then we poll for the
   *  one-time handoff. The sign-in screen stays usable while waiting. */
  const desktopLogin = useCallback(
    async (provider: "google" | "github") => {
      const generation = ++desktopGeneration.current
      setError(null)
      setPending(true)
      setPendingUrl(null)
      try {
        const start = await fetch("/api/auth/desktop/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider }),
        })
        if (!start.ok) throw new Error(`Could not start sign-in (${start.status}).`)
        const { nonce, loginUrl, opened } = (await start.json()) as {
          nonce: string
          loginUrl: string
          opened?: boolean
        }
        const absolute = new URL(loginUrl, window.location.origin).href
        setPendingUrl(absolute)
        // The local server normally opens the browser. Fall back to the Tauri
        // command / window.open if it could not.
        if (!opened) await openExternal(absolute)

        const deadline = Date.now() + DESKTOP_TIMEOUT_MS
        while (Date.now() < deadline) {
          if (generation !== desktopGeneration.current) return
          await new Promise((resolve) => setTimeout(resolve, DESKTOP_POLL_MS))
          if (generation !== desktopGeneration.current) return
          const statusRes = await fetch(
            `/api/auth/desktop/status?nonce=${encodeURIComponent(nonce)}`,
            { credentials: "include" }
          )
          if (!statusRes.ok) continue
          const status = (await statusRes.json()) as {
            status: "pending" | "complete" | "expired"
            token?: string
          }
          if (status.status === "expired") {
            throw new Error("The sign-in request expired. Try again.")
          }
          if (status.status !== "complete" || !status.token) continue

          const exchange = await fetch("/api/auth/desktop/exchange", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ token: status.token }),
          })
          if (!exchange.ok) throw new Error("Could not finish desktop sign-in.")
          const body = (await exchange.json()) as {
            token: string
            user: AuthUser
            profile: Profile
          }
          if (generation !== desktopGeneration.current) return
          setToken(body.token)
          setUser(body.user)
          setProfile(body.profile)
          return
        }
        throw new Error("Timed out waiting for the browser sign-in.")
      } catch (err) {
        if (generation === desktopGeneration.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (generation === desktopGeneration.current) {
          setPending(false)
          setPendingUrl(null)
        }
      }
    },
    []
  )

  const retryOpen = useCallback(async () => {
    if (pendingUrl) await openExternal(pendingUrl)
  }, [pendingUrl])

  const cancelLogin = useCallback(() => {
    desktopGeneration.current += 1
    setPending(false)
    setPendingUrl(null)
    setError(null)
  }, [])

  const signInWithGithub = useCallback(() => {
    if (isDesktopShell()) void desktopLogin("github")
    else startLogin("github")
  }, [desktopLogin])

  const signInWithGoogle = useCallback(() => {
    if (isDesktopShell()) void desktopLogin("google")
    else startLogin("google")
  }, [desktopLogin])

  const signOut = useCallback(async () => {
    try {
      await fetch("/api/auth/desktop/logout", {
        method: "POST",
        credentials: "include",
      }).catch(() => {})
      await anyOAuthLogout().catch(() => {})
    } finally {
      clearToken()
      try {
        localStorage.removeItem("ai-coder:activeConversationId")
      } catch {
        // ignore storage errors
      }
      setUser(null)
      setProfile(null)
      window.location.assign("/")
    }
  }, [])

  const value: AuthState = {
    session: user ? { user } : null,
    user,
    profile,
    loading,
    error,
    pending,
    pendingUrl,
    signInWithGithub,
    signInWithGoogle,
    retryOpen,
    cancelLogin,
    signOut,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
