// Run with: npx tsx --test server/file-comments-resolver.test.ts
//
// Covers the representative anchor-shift scenarios: unchanged, clean inserts
// above/below, deletions before the block, single-line tampering (block
// partially survives), full block deletion (outdated), and the roll-forward
// case where we re-anchor after a successful shift.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { resolveAnchor, normalizeContent, lineAt } from "./file-comments-resolver.ts"

// Helpers
const join = (...lines: string[]) => lines.join("\n") + "\n"

test("exact match: snapshot === current → confidence 'exact'", () => {
  const snap = join("a", "b", "c", "d")
  const res = resolveAnchor(snap, snap, 2, 3)
  assert.deepEqual(res, { resolvedLine: 2, confidence: "exact" })
})

test("whitespace-only trailing change stays 'exact'", () => {
  const snap = join("a", "b  ", "c")
  const cur = join("a", "b", "c")
  const res = resolveAnchor(snap, cur, 2, 1)
  assert.deepEqual(res, { resolvedLine: 2, confidence: "exact" })
})

test("clean insert above block shifts the anchor", () => {
  const snap = join("a", "b", "c", "d")
  const cur = join("NEW", "a", "b", "c", "d")
  const res = resolveAnchor(snap, cur, 2, 3) // block = b,c,d
  assert.deepEqual(res, { resolvedLine: 3, confidence: "shifted" })
})

test("insert below block doesn't move anchor start", () => {
  const snap = join("a", "b", "c", "d")
  const cur = join("a", "b", "c", "NEW", "d")
  const res = resolveAnchor(snap, cur, 2, 2) // block = b,c
  assert.deepEqual(res, { resolvedLine: 2, confidence: "shifted" })
})

test("delete before block shifts the anchor up", () => {
  const snap = join("a", "b", "c", "d", "e")
  const cur = join("b", "c", "d", "e") // removed "a"
  const res = resolveAnchor(snap, cur, 3, 2) // block = c,d
  assert.deepEqual(res, { resolvedLine: 2, confidence: "shifted" })
})

test("single-line tamper of the anchor's first line: block partially survives → shifted to first survivor", () => {
  // Line 2 changes content; lines 3,4 untouched. Block length 3 covers 2,3,4.
  const snap = join("a", "b", "c", "d", "e")
  const cur = join("a", "bxxx", "c", "d", "e")
  const res = resolveAnchor(snap, cur, 2, 3)
  // Line 2 is deleted in the diff (replaced), so we fall through to line 3 in snap.
  // Line 3 (snap) maps to line 3 (cur) since diff parks "c" as context.
  assert.deepEqual(res, { resolvedLine: 3, confidence: "shifted" })
})

test("full block deletion → outdated", () => {
  const snap = join("a", "b", "c", "d", "e")
  const cur = join("a", "e") // removed b,c,d entirely
  const res = resolveAnchor(snap, cur, 2, 3) // block = b,c,d
  assert.deepEqual(res, { resolvedLine: null, confidence: "outdated" })
})

test("single-line block with line still intact → shifted", () => {
  const snap = join("a", "b", "c")
  const cur = join("NEW", "a", "b", "c")
  const res = resolveAnchor(snap, cur, 3, 1)
  assert.deepEqual(res, { resolvedLine: 4, confidence: "shifted" })
})

test("roll-forward: after a shift, re-resolving against the updated snapshot tracks the anchor across further edits", () => {
  // Simulates the optimization where successful re-anchors update snapshot +
  // anchor_start_line to the *new* values, keeping subsequent diffs tiny.
  const originalSnap = join("a", "b", "c")
  const afterFirstEdit = join("NEW", "a", "b", "c")
  const firstResolve = resolveAnchor(originalSnap, afterFirstEdit, 2, 2)
  assert.equal(firstResolve.confidence, "shifted")
  assert.equal(firstResolve.resolvedLine, 3) // "b" moved from line 2 → 3

  // Roll snapshot + start forward, then a second edit appends a line.
  const rolledSnap = afterFirstEdit
  const rolledStart = firstResolve.resolvedLine!
  const afterSecondEdit = join("NEW", "a", "b", "c", "tail")
  const secondResolve = resolveAnchor(rolledSnap, afterSecondEdit, rolledStart, 2)
  // Content differs → still shifted, but resolvedLine is correct (tail appended
  // below doesn't move the block start).
  assert.equal(secondResolve.confidence, "shifted")
  assert.equal(secondResolve.resolvedLine, 3)
})

test("empty content on both sides resolves to exact at start", () => {
  const res = resolveAnchor("", "", 1, 1)
  assert.deepEqual(res, { resolvedLine: 1, confidence: "exact" })
})

test("normalizeContent: \\r\\n and trailing whitespace are ignored", () => {
  const a = "foo  \r\nbar\t\r\nbaz"
  const b = "foo\nbar\nbaz"
  assert.equal(normalizeContent(a), normalizeContent(b))
})

test("lineAt returns the requested line or empty when out of range", () => {
  const content = join("first", "second", "third")
  assert.equal(lineAt(content, 1), "first")
  assert.equal(lineAt(content, 2), "second")
  assert.equal(lineAt(content, 0), "")
  assert.equal(lineAt(content, 99), "")
})
