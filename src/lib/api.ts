// Universal fetch wrapper for /api/* endpoints. Attaches the current Supabase
// JWT as Authorization: Bearer <token>. Use everywhere in place of fetch().
//
// For EventSource (which can't set headers), use sseUrl() to get a URL with
// ?access_token= appended.

import { supabase } from "@/lib/supabase"

async function currentAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export async function api(input: string, init?: RequestInit): Promise<Response> {
  const token = await currentAccessToken()
  const headers = new Headers(init?.headers)
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`)
  }
  return fetch(input, { ...init, headers })
}

// Returns the input URL with ?access_token= appended, for EventSource use.
// The server middleware accepts the token from query string as a fallback to
// the Authorization header.
export async function sseUrl(input: string): Promise<string> {
  const token = await currentAccessToken()
  if (!token) return input
  const u = new URL(input, window.location.origin)
  if (!u.searchParams.has("access_token")) {
    u.searchParams.set("access_token", token)
  }
  return u.pathname + u.search + u.hash
}
