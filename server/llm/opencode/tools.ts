// Canonical tool names/inputs for the OpenCode runtime.
//
// ai-coder's UI (file-touch tracker, diff panel) was written against Claude
// Code's tool names. OpenCode uses lowercase names (`read`, `write`, `edit`,
// `patch`, `bash`, `glob`, `grep`). Normalize at the provider boundary so the
// UI never needs a provider-specific branch. Keep the raw input alongside the
// normalized keys; the inspector still shows exactly what the model emitted.

const TOOL_NAMES: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  patch: "Edit",
  multi_edit: "MultiEdit",
  multiedit: "MultiEdit",
  notebookedit: "NotebookEdit",
  bash: "Bash",
  shell: "Bash",
  glob: "Glob",
  grep: "Grep",
  list: "List",
  ls: "List",
  task: "Task",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  webfetch: "WebFetch",
  websearch: "WebSearch",
}

export function canonicalToolName(name: string): string {
  if (!name) return "Tool"
  return TOOL_NAMES[name.toLowerCase()] ?? name
}

export function isEditingToolName(name: string): boolean {
  return (
    name === "Edit" ||
    name === "Write" ||
    name === "MultiEdit" ||
    name === "NotebookEdit"
  )
}

export type CanonicalTool = { name: string; input: unknown }

/** Normalize OpenCode's tool name and add `file_path` for editing tools.
 *  `path` is preserved, so non-ai-coder consumers still see the original. */
export function canonicalizeTool(name: string, input: unknown): CanonicalTool {
  const canonical = canonicalToolName(name)
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { name: canonical, input }
  }
  const obj = input as Record<string, unknown>
  if (
    (canonical === "Edit" ||
      canonical === "Write" ||
      canonical === "MultiEdit" ||
      canonical === "Read") &&
    typeof obj.path === "string" &&
    typeof obj.file_path !== "string"
  ) {
    return { name: canonical, input: { ...obj, file_path: obj.path } }
  }
  return { name: canonical, input }
}

/** Flatten OpenCode's `tool.success` content array. */
export function toolContentToText(content: unknown): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (typeof content === "object" && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>
    if (typeof obj.text === "string") return obj.text
    if (typeof obj.uri === "string") return obj.name ? `[file] ${obj.name}` : `[file] ${obj.uri}`
    return JSON.stringify(content)
  }
  if (!Array.isArray(content)) return String(content)
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (!part || typeof part !== "object") return ""
      const p = part as Record<string, unknown>
      if (p.type === "text" && typeof p.text === "string") return p.text
      if (p.type === "file" && typeof p.uri === "string") {
        return p.name ? `[file] ${p.name}` : `[file] ${p.uri}`
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}
