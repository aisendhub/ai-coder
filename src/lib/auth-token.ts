// In-memory PostgREST JWT for the current AnyOAuth session. Never persisted:
// on reload the AnyOAuth cookie is exchanged again for a fresh token.

let token: string | null = null
let refreshPromise: Promise<string | null> | null = null

export function getToken(): string | null {
  return token
}

export function setToken(value: string | null): void {
  token = value
}

export function clearToken(): void {
  token = null
}

/** Mint a new token from /api/auth/session. Deduplicates concurrent calls. */
export function refreshToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise
  refreshPromise = fetch("/api/auth/session", { credentials: "include" })
    .then(async (res) => {
      if (!res.ok) {
        token = null
        return null
      }
      const body = (await res.json()) as { token?: string }
      token = body.token ?? null
      return token
    })
    .catch(() => {
      token = null
      return null
    })
    .finally(() => {
      refreshPromise = null
    })
  return refreshPromise
}
