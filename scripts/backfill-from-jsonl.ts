// Backfill Supabase messages from Claude Code's JSONL transcripts.
// Run: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/backfill-from-jsonl.ts [--dry]

import "dotenv/config"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createClient } from "@supabase/supabase-js"

type StreamEvent =
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; output: string }
  | { kind: "text"; text: string }

type ParsedMessage = {
  role: "user" | "assistant"
  text: string
  events: StreamEvent[]
  ts: string
}

const PROJECTS = path.join(os.homedir(), ".claude", "projects")
const dry = process.argv.includes("--dry")

const url =
  process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? ""
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
if (!url || !serviceKey) {
  console.error("Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}
const sb = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Walk all JSONL files and group entries by sessionId.
function loadAllSessions(): Map<string, ParsedMessage[]> {
  const sessions = new Map<string, ParsedMessage[]>()
  if (!fs.existsSync(PROJECTS)) {
    console.error(`No ${PROJECTS}; skipping`)
    return sessions
  }
  for (const projectDir of fs.readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, projectDir)
    let entries: string[] = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const file of entries) {
      if (!file.endsWith(".jsonl")) continue
      const sessionId = file.replace(/\.jsonl$/, "")
      const fullPath = path.join(dir, file)
      const messages = parseJsonl(fullPath)
      if (messages.length === 0) continue
      // Multiple files may share a sessionId (resumed sessions); merge in order.
      const existing = sessions.get(sessionId) ?? []
      sessions.set(sessionId, [...existing, ...messages])
    }
  }
  // Sort each session's messages by timestamp
  for (const [k, msgs] of sessions) {
    msgs.sort((a, b) => a.ts.localeCompare(b.ts))
    sessions.set(k, msgs)
  }
  return sessions
}

// Parse JSONL → group into UI turns: (user prompt) + (one assistant bubble
// containing all subsequent text/thinking/tool_use/tool_result events until
// the next user-typed prompt).
function parseJsonl(file: string): ParsedMessage[] {
  const out: ParsedMessage[] = []
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return out
  }

  let currentAssistant: ParsedMessage | null = null
  const flushAssistant = () => {
    if (currentAssistant && (currentAssistant.text || currentAssistant.events.length)) {
      out.push(currentAssistant)
    }
    currentAssistant = null
  }
  const ensureAssistant = (ts: string) => {
    if (!currentAssistant) {
      currentAssistant = { role: "assistant", text: "", events: [], ts }
    }
    return currentAssistant
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj.type !== "user" && obj.type !== "assistant") continue
    const content = obj.message?.content
    if (!Array.isArray(content)) continue
    const ts = obj.timestamp ?? ""

    if (obj.type === "user") {
      // Two flavors:
      //  (a) real user prompt: [{type:"text", text:"..."}]
      //  (b) tool_result echo: [{type:"tool_result", tool_use_id, content, is_error}]
      const isToolResult = content.some((b: any) => b?.type === "tool_result")
      if (isToolResult) {
        const a = ensureAssistant(ts)
        for (const block of content) {
          if (block?.type !== "tool_result") continue
          const text =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((p: any) => (p?.type === "text" ? p.text : ""))
                    .join("")
                : ""
          a.events.push({
            kind: "tool_result",
            toolUseId: block.tool_use_id,
            isError: Boolean(block.is_error),
            output: text.slice(0, 4000),
          })
        }
      } else {
        // Real user prompt — flush any in-flight assistant first
        flushAssistant()
        let text = ""
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            text += block.text
          }
        }
        if (text.trim()) {
          out.push({ role: "user", text, events: [], ts })
        }
      }
    } else {
      // assistant: append to current accumulator
      const a = ensureAssistant(ts)
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          a.text += block.text
          a.events.push({ kind: "text", text: block.text })
        } else if (
          block?.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          a.events.push({ kind: "thinking", text: block.thinking })
        } else if (block?.type === "tool_use") {
          a.events.push({
            kind: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          })
        }
      }
    }
  }
  flushAssistant()
  return out
}

async function main() {
  const sessions = loadAllSessions()
  console.log(`Loaded ${sessions.size} sessions from JSONL`)

  // Pull conversations that have a session id
  const { data: convs, error } = await sb
    .from("conversations")
    .select("id, session_id, title")
    .not("session_id", "is", null)
  if (error) throw error
  console.log(`Found ${convs?.length ?? 0} conversations with session_id`)

  let updated = 0
  let inserted = 0
  let skippedNoTranscript = 0

  for (const c of convs ?? []) {
    const sid = c.session_id as string
    const transcript = sessions.get(sid)
    if (!transcript) {
      skippedNoTranscript++
      continue
    }

    // Existing DB messages for this conversation, in order
    const { data: dbRows, error: mErr } = await sb
      .from("messages")
      .select("id, role, text, created_at")
      .eq("conversation_id", c.id)
      .order("created_at", { ascending: true })
    if (mErr) {
      console.error(`messages fetch failed for ${c.id}:`, mErr.message)
      continue
    }

    // Walk transcript and DB rows in parallel. Heuristic: pair them by index
    // when role matches; otherwise insert a new row at appropriate position.
    let dbi = 0
    for (const tm of transcript) {
      const dbRow = (dbRows ?? [])[dbi]
      if (dbRow && dbRow.role === tm.role) {
        // Update only if existing text is empty and transcript has content
        if ((dbRow.text ?? "").length === 0 && tm.text.length > 0) {
          if (!dry) {
            const { error: uErr } = await sb
              .from("messages")
              .update({ text: tm.text, events: tm.events })
              .eq("id", dbRow.id)
            if (uErr) {
              console.error(
                `update failed convo=${c.id} msg=${dbRow.id}:`,
                uErr.message
              )
              continue
            }
          }
          updated++
        }
        dbi++
      } else {
        // No matching DB row — insert (only if not dry)
        if (!dry) {
          const { error: iErr } = await sb.from("messages").insert({
            conversation_id: c.id,
            role: tm.role,
            text: tm.text,
            events: tm.events,
            created_at: tm.ts || new Date().toISOString(),
          })
          if (iErr) {
            console.error(`insert failed convo=${c.id}:`, iErr.message)
            continue
          }
        }
        inserted++
      }
    }
  }

  console.log(
    `${dry ? "[dry] " : ""}Done. updated=${updated} inserted=${inserted} skippedNoTranscript=${skippedNoTranscript}`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
