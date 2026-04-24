# Architecture — client-generated IDs

**Rule:** every row the client creates gets its primary-key UUID **from the client**, not the server. The client picks the id, uses it immediately, sends it to the server, and the server persists with the same id. Realtime echoes confirm — they never invent new ids.

This is the same pattern used by CouchDB, Firebase, Linear, and any modern optimistic-UI app. We adopt it because we have a streaming agent + realtime sync and cannot afford to wait for a round-trip every time the client creates something.

## Why

1. **Instant UX.** The user creates a chat / sends a message / opens a comment and sees it *now*. No spinner while the server rolls a UUID.
2. **Deterministic links.** A newly-created comment can reference `message_id` the moment it's created, because the client already knows the id. No callbacks, no "wait for realtime, then patch the FK."
3. **Idempotent retries.** If a POST fails or a network hiccup makes the client retry, the second request carries the same id. The server's PK unique constraint makes duplicate inserts a no-op (or a 409 we treat as success).
4. **Clean realtime swap.** When the server's realtime INSERT arrives, the row's id already matches our optimistic row. No fuzzy "find-by-role-and-text" matching; just upgrade-in-place by id. See [Conversation.model.ts `applyInsert`](../src/models/Conversation.model.ts).
5. **Deep-linking before server confirmation.** URL bar shows `/c/{id}` the instant a chat is created, even before persistence lands. Refresh works because the id is authoritative.

## The pattern

```
1. Client:    id = crypto.randomUUID()
2. Client:    insert optimistic row locally with { id, ...props, isOptimistic: true }
3. Client:    POST /api/thing { id, ...props }
4. Server:    insert into db ({ id, ... })  -- PK uniqueness enforces idempotency
5. Realtime:  INSERT row echoed back with same id
6. Client:    applyInsert(row) → find by id → flip isOptimistic=false, merge server-derived fields
```

The pattern falls apart if any step invents its own id. Every step above references the same UUID.

## Where it's applied

| Row type | Status | Notes |
|---|---|---|
| **Messages (comments flow)** | ✅ | Client generates `messageId`, passes to `/api/file-comments` POST which inserts `messages.id = messageId` before the `file_comments` row (FK satisfied). See [server/index.ts `app.post("/api/file-comments"…)`](../server/index.ts). |
| **File comments** | ✅ | `file_comments.id` is generated server-side today, but the *linked* `message_id` is deterministic. Comment row id could also become client-deterministic in a v2; no caller needs it pre-insert. |
| **Conversations (chat + task)** | ✅ | Client generates `conversationId` before POSTing `/api/conversations`. URL/sidebar update instantly. Server insert carries the same id. |
| **Messages (runTurn path)** | ⚠️ Partial | Optimistic row carries a client UUID today (via `BaseModel.create()`), but the server insert uses its own UUID. The `applyInsert` fallback upgrades by role+text match. Retrofit: pass the client id through `/api/chat` and have `startRunner` use it. Tracked as follow-up. |
| **Projects** | ❌ | Server-generated. Low value to retrofit — projects are rare to create. Leave as-is. |
| **Tasks / task drafts** | ✅ | Same as conversations (tasks ARE conversations with `kind='task'`). |
| **Attachments** | N/A | Attachment ids are local-only (not stored as PK in DB); they label upload items in the composer. |

## When NOT to use it

- **Server-owned artifacts.** A commit SHA, a git-blame line, a compiled bundle hash — anything the server computes from external sources. Those aren't "things the client creates."
- **Untrusted clients.** If you ever open the API to third parties, client-supplied ids become a small attack surface (squatting on predictable UUIDs to DoS PK inserts). Solution: validate format + reject conflicts, same as a normal auth check.
- **Multi-device auth without reliable UUIDv4.** We rely on `crypto.randomUUID()` (browser-native, full 128-bit entropy). If running in an environment without it, fall back to server ids.

## Implementation notes

### Browser id generation

`crypto.randomUUID()` is Web Crypto standard — available in every evergreen browser and in Node 16+. No library needed.

### Optimistic → canonical swap

```ts
// src/models/Conversation.model.ts (paraphrased)
@action private applyInsert(row: MessageRow) {
  const byId = this.messages.find(row.id)
  if (byId) {
    // Deterministic-id fast path: upgrade in place.
    if (byId.isOptimistic) {
      byId.setProps({ ...row, isOptimistic: false })
    }
    return
  }
  // ...fallback role+text match for legacy callers (to be removed)
}
```

Always try id-match first. Fallback is for legacy call sites that predate this rule.

### FK ordering

When you need `table_b.parent_id → table_a.id` in the same request, insert into `table_a` **first**. Comments flow does this: `messages` insert → `file_comments` insert (referencing `message_id`). If the first insert fails, skip the second — no orphan.

### Idempotent retries

Postgres `INSERT` with a duplicate PK returns `23505 unique_violation`. Client treats 409/23505 on retry as success (the row already exists with the data we sent last time). If you care about *which* payload won, add an `updated_at` bump or `INSERT ... ON CONFLICT DO NOTHING`.

### Why not just `INSERT ... RETURNING id` everywhere?

That works for *single-row* inserts where no downstream code needs the id before the response lands. It breaks down when:

- You want optimistic UI (you'd be waiting for the server).
- You want to link two rows in the same request (you need the id *before* insert 2).
- You want to show `/c/{id}` in the URL immediately.

Deterministic ids subsume the `RETURNING id` pattern for every use case that matters in this app.

## Follow-up work

- [ ] Retrofit `runTurn` / `/api/chat` to accept a client-generated message id, so the fallback optimistic-upgrade path in `applyInsert` can be removed entirely.
- [ ] Consider making `file_comments.id` client-generated so the comment row has a stable id before the first fetch (today: `id` comes back in the POST response).
- [ ] Audit any other create endpoints that don't yet follow the pattern.

## Related files

- [src/models/Base.model.ts](../src/models/Base.model.ts) — `BaseModel.create()` defaults `id` to `crypto.randomUUID()`.
- [src/models/Conversation.model.ts](../src/models/Conversation.model.ts) — `applyInsert` id-match upgrade; `addOptimisticUserMessage(id, text)` helper for callers that need a deterministic chat-message id.
- [server/index.ts](../server/index.ts) — `/api/file-comments` POST shows the full pattern end-to-end (insert messages first, then file_comments with FK).
