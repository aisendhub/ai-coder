// Universal fetch wrapper for /api/* endpoints. Attaches the current local
// PostgREST JWT as Authorization: Bearer <token>. Use everywhere in place of
// fetch().
//
// For EventSource (which can't set headers), use sseUrl() to get a URL with
// ?access_token= appended.

import { getToken, refreshToken } from "@/lib/auth-token"

async function withToken(init?: RequestInit): Promise<RequestInit> {
  let token = getToken()
  if (!token) token = await refreshToken()
  const headers = new Headers(init?.headers)
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`)
  }
  return { ...init, headers }
}

export async function api(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, await withToken(init))
  if (res.status !== 401) return res
  // Token may have expired. Refresh once and retry.
  const token = await refreshToken()
  if (!token) return res
  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${token}`)
  return fetch(input, { ...init, headers })
}

// Returns the input URL with ?access_token= appended, for EventSource use.
// The server middleware accepts the token from query string as a fallback to
// the Authorization header.
export async function sseUrl(input: string): Promise<string> {
  let token = getToken()
  if (!token) token = await refreshToken()
  if (!token) return input
  const u = new URL(input, window.location.origin)
  if (!u.searchParams.has("access_token")) {
    u.searchParams.set("access_token", token)
  }
  return u.pathname + u.search + u.hash
}
