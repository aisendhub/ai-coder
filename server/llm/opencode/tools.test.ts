import test from "node:test"
import assert from "node:assert/strict"
import {
  canonicalToolName,
  canonicalizeTool,
  isEditingToolName,
  toolContentToText,
} from "./tools.ts"

test("canonicalToolName maps OpenCode names to ai-coder names", () => {
  assert.equal(canonicalToolName("read"), "Read")
  assert.equal(canonicalToolName("write"), "Write")
  assert.equal(canonicalToolName("edit"), "Edit")
  assert.equal(canonicalToolName("patch"), "Edit")
  assert.equal(canonicalToolName("bash"), "Bash")
  assert.equal(canonicalToolName("shell"), "Bash")
  assert.equal(canonicalToolName("glob"), "Glob")
  assert.equal(canonicalToolName("grep"), "Grep")
  assert.equal(canonicalToolName("webfetch"), "WebFetch")
  assert.equal(canonicalToolName("custom_tool"), "custom_tool")
  assert.equal(canonicalToolName(""), "Tool")
})

test("canonicalizeTool adds file_path for editing tools and keeps path", () => {
  const out = canonicalizeTool("write", { path: "src/a.ts", content: "x" })
  assert.equal(out.name, "Write")
  assert.deepEqual(out.input, {
    path: "src/a.ts",
    content: "x",
    file_path: "src/a.ts",
  })

  const read = canonicalizeTool("read", { path: "README.md" })
  assert.equal(read.name, "Read")
  assert.deepEqual(read.input, { path: "README.md", file_path: "README.md" })

  const bash = canonicalizeTool("bash", { command: "ls" })
  assert.equal(bash.name, "Bash")
  assert.deepEqual(bash.input, { command: "ls" })

  const scalar = canonicalizeTool("edit", "not-an-object")
  assert.equal(scalar.name, "Edit")
  assert.equal(scalar.input, "not-an-object")
})

test("isEditingToolName matches the file-touch tracker contract", () => {
  for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    assert.equal(isEditingToolName(name), true)
  }
  for (const name of ["Read", "Bash", "Glob", "Grep"]) {
    assert.equal(isEditingToolName(name), false)
  }
})

test("toolContentToText flattens text and file blocks", () => {
  assert.equal(toolContentToText("done"), "done")
  assert.equal(toolContentToText({ type: "text", text: "hello" }), "hello")
  assert.equal(
    toolContentToText([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]),
    "one\ntwo"
  )
  assert.equal(
    toolContentToText([
      { type: "file", uri: "file:///tmp/a.png", mime: "image/png", name: "a.png" },
    ]),
    "[file] a.png"
  )
  assert.equal(
    toolContentToText([{ type: "file", uri: "file:///tmp/a.png", mime: "image/png" }]),
    "[file] file:///tmp/a.png"
  )
  assert.equal(toolContentToText(null), "")
  assert.equal(toolContentToText(undefined), "")
})
