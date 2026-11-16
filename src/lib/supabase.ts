import { createClient } from "@supabase/supabase-js"
import { getToken } from "@/lib/auth-token"

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(url && anonKey)

// The Supabase-shaped client fronts local PostgREST. AnyOAuth owns login, so
// the `auth` namespace is disabled; every REST/Realtime request carries the
// short-lived JWT supplied by `accessToken`.
export const supabase = createClient(
  url ?? "http://localhost:54321",
  anonKey ?? "missing-anon-key",
  {
    accessToken: async () => getToken(),
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }
)
