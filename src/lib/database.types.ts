// Placeholder — replace with `supabase gen types typescript --project-id <id>` output.

export type Database = {
  public: {
    Tables: {
      projects: {
        Row: {
          id: string
          user_id: string
          name: string
          cwd: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          name: string
          cwd: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          name?: string
          cwd?: string
          updated_at?: string
        }
      }
      conversations: {
        Row: {
          id: string
          user_id: string
          project_id: string
          title: string
          session_id: string | null
          sandbox_id: string | null
          repo_url: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          project_id: string
          title?: string
          session_id?: string | null
          sandbox_id?: string | null
          repo_url?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          title?: string
          project_id?: string
          session_id?: string | null
          sandbox_id?: string | null
          repo_url?: string | null
          updated_at?: string
        }
      }
      messages: {
        Row: {
          id: string
          conversation_id: string
          role: "user" | "assistant"
          text: string
          events: unknown
          attachments: unknown
          created_at: string
        }
        Insert: {
          id?: string
          conversation_id: string
          role: "user" | "assistant"
          text?: string
          events?: unknown
          attachments?: unknown
          created_at?: string
        }
        Update: {
          text?: string
          events?: unknown
          attachments?: unknown
        }
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}
