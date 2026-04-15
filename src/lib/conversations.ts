import { supabase } from "@/lib/supabase"

export type Conversation = {
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

export type Project = {
  id: string
  user_id: string
  name: string
  cwd: string
  created_at: string
  updated_at: string
}

export async function listProjects(userId: string) {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
  if (error) throw error
  return (data ?? []) as Project[]
}

export async function createProject(userId: string, name: string, cwd: string) {
  const { data, error } = await supabase
    .from("projects")
    .insert({ user_id: userId, name, cwd })
    .select()
    .single()
  if (error) throw error
  return data as Project
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<Project, "name" | "cwd">>
) {
  const { error } = await supabase.from("projects").update(patch).eq("id", id)
  if (error) throw error
}

export async function deleteProject(id: string) {
  const { error } = await supabase.from("projects").delete().eq("id", id)
  if (error) throw error
}

export type DBMessage = {
  id: string
  conversation_id: string
  role: "user" | "assistant"
  text: string
  events: unknown
  created_at: string
}

export async function listConversations(userId: string) {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
  if (error) throw error
  return (data ?? []) as Conversation[]
}

export async function createConversation(userId: string, title = "New chat") {
  const { data, error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, title })
    .select()
    .single()
  if (error) throw error
  return data as Conversation
}

export async function updateConversation(
  id: string,
  patch: Partial<
    Pick<Conversation, "title" | "session_id" | "sandbox_id" | "repo_url">
  >
) {
  const { error } = await supabase
    .from("conversations")
    .update(patch)
    .eq("id", id)
  if (error) throw error
}

export async function deleteConversation(id: string) {
  const { error } = await supabase.from("conversations").delete().eq("id", id)
  if (error) throw error
}

export async function listMessages(conversationId: string) {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
  if (error) throw error
  return (data ?? []) as DBMessage[]
}

export async function insertMessage(
  conversationId: string,
  role: "user" | "assistant",
  text: string,
  events: unknown
) {
  const { data, error } = await supabase
    .from("messages")
    .insert({ conversation_id: conversationId, role, text, events })
    .select()
    .single()
  if (error) throw error
  return data as DBMessage
}

export async function updateMessage(
  id: string,
  patch: Partial<Pick<DBMessage, "text" | "events">>
) {
  const { error } = await supabase.from("messages").update(patch).eq("id", id)
  if (error) throw error
}
