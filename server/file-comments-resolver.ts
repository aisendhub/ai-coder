// Deterministic snapshot+diff anchor resolver for file comments.
//
// A comment stores (a) the full file content at creation time, and (b) a
// 1-based block of lines it was anchored to. To find where the anchor lives
// now, we diff the snapshot against the current file content (same algorithm
// as `git diff`) and walk the hunks to build a map from snapshot line → new
// line. The first surviving line of the block wins. If every line in the
// block was deleted, the comment is marked `outdated`.
//
// This is what GitHub PR review comments use (blob-SHA-anchored, walked via
// diff on new commits). No fuzzy matching, no per-language AST, no CRDT.

import { diffLines } from "diff"

export type ResolvedAnchor =
  | { resolvedLine: number; confidence: "exact" | "shifted" }
  | { resolvedLine: null; confidence: "outdated" }

/** Resolve a comment anchor against current file content.
 *  @param snapshot       File content at comment creation time (normalized).
 *  @param current        Current working-tree file content.
 *  @param startLine      1-based first line of the anchor block in snapshot.
 *  @param blockLength    Number of lines in the anchor block.
 */
export function resolveAnchor(
  snapshot: string,
  current: string,
  startLine: number,
  blockLength: number,
): ResolvedAnchor {
  const a = normalizeContent(snapshot)
  const b = normalizeContent(current)
  if (a === b) {
    return { resolvedLine: startLine, confidence: "exact" }
  }
  const lineMap = buildLineMap(a, b)
  const end = startLine + blockLength - 1
  for (let line = startLine; line <= end; line++) {
    const mapped = lineMap.get(line)
    if (typeof mapped === "number") {
      return { resolvedLine: mapped, confidence: "shifted" }
    }
  }
  return { resolvedLine: null, confidence: "outdated" }
}

/** Normalize file content for snapshot storage and diffing: unify line
 *  endings, strip trailing whitespace per line. Content that differs only
 *  in trailing whitespace compares equal. */
export function normalizeContent(s: string): string {
  return s
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
}

/** Build a map: snapshot-line (1-based) → current-line (1-based).
 *  Lines that were deleted in `current` have no entry in the map. */
function buildLineMap(oldStr: string, newStr: string): Map<number, number> {
  const changes = diffLines(oldStr, newStr)
  const lineMap = new Map<number, number>()
  let oldLine = 1
  let newLine = 1
  for (const change of changes) {
    const n = change.count ?? 0
    if (change.added) {
      newLine += n
    } else if (change.removed) {
      // Deleted lines: leave them out of the map.
      oldLine += n
    } else {
      // Context: unchanged lines map 1:1.
      for (let i = 0; i < n; i++) lineMap.set(oldLine + i, newLine + i)
      oldLine += n
      newLine += n
    }
  }
  return lineMap
}

/** Convenience: extract the Nth line (1-based) from content. Returns "" if
 *  out of range. Useful for the "> anchored line" quote in the chat message. */
export function lineAt(content: string, line: number): string {
  const lines = normalizeContent(content).split("\n")
  if (line < 1 || line > lines.length) return ""
  return lines[line - 1]
}
