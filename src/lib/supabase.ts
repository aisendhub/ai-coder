import { createClient } from "@supabase/supabase-js"
import type { Database } from "./database.types"

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(url && anonKey)

// Dummy client when env is missing — lets the app boot and render a setup screen
// instead of throwing on import. Any method call will fail clearly.
export const supabase = createClient<Database>(
  url ?? "http://localhost:54321",
  anonKey ?? "missing-anon-key",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
)
