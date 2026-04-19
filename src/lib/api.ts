import { supabase } from "@/lib/supabase"

/** Current Supabase access token, or null if the user isn't signed in. */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

/** fetch() wrapper that attaches the Supabase access token. The backend's
 *  `requireAuth` middleware rejects requests without a valid Bearer token,
 *  so every /api/* call must go through this (or set the header manually). */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const token = await getAccessToken()
  const headers = new Headers(init.headers)
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`)
  }
  return fetch(input, { ...init, headers })
}

/** Append `access_token=<jwt>` to a URL. Used for EventSource and WebSocket
 *  connections, which can't set Authorization headers. */
export async function withAccessToken(url: string): Promise<string> {
  const token = await getAccessToken()
  if (!token) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}access_token=${encodeURIComponent(token)}`
}
