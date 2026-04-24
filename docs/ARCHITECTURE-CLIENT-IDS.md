# Architecture — client-generated IDs

**Rule:** every row the client creates gets its primary-key UUID **from the client**, not the server. The client picks the id, uses it immediately, sends it to the server, and the server persists with the same id. Realtime echoes confirm — they never invent new ids.

This is the same pattern used by CouchDB, Firebase, Linear, and any modern optimistic-UI app. We adopt it because we have a streaming agent + realtime sync and cannot afford to wait for a round-trip every time the client creates something.

## The decision rule (use this for every new row)

> **If the client needs to refer to the row — render it, link to it, scroll to it, set an FK on it — *before* the server's insert confirms, the client generates the id.**
> **Otherwise, the row is server-authored and the id source is irrelevant, as long as retries are idempotent.**

This is the single test. Apply it whenever you add a create endpoint or a new row type. It subsumes the worked examples in the table below.

Concretely:

- ✅ **Client-generated** when: the client inserts an optimistic row, another insert in the same request needs this row's id as an FK, a URL/route needs the id instantly, or a retry needs to be idempotent via PK conflict.
- 🚫 **Server-authored (id source doesn't matter)** when: the row is created in response to an internal server event (auto-loop tick, supervisor intervention, merge flow notice, watcher callback), or a composite natural key already handles idempotency, or the row is a derivative the client only ever observes via realtime.

If you're not sure which bucket a new row lands in, err toward client-generated — the cost is one `crypto.randomUUID()` call, and retrofitting later means changing every caller.

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

Every ✅ row in this table passes the decision rule above. Every 🚫 row fails it (and is noted with the reason). If a new row type isn't here, apply the rule to decide which bucket it goes in.

| Row type | Status | Why |
|---|---|---|
| **Conversations (chat + task)** | ✅ | Client needs the id in the URL/sidebar instantly. See `workspace.createNew` / `createTaskDraft`. |
| **Messages — runTurn first iteration** | ✅ | Optimistic user + assistant rows render before the first SSE event. Client passes `userMessageId` + `assistantMessageId` to `/api/chat`; server uses them on the first iteration's inserts. |
| **Messages — nudge (mid-turn)** | ✅ | Same optimistic render + deterministic swap as runTurn. `/api/messages/nudge` accepts `messageId`. |
| **Messages — comments flow** | ✅ | The file_comments row has an FK to messages; we need the id *before* inserting the comment. |
| **File comments (`file_comments.id`)** | ✅ | Accepted as `commentId` on the POST. Lets future threading / replies link to a comment before its insert confirms. |
| **Projects** | ✅ | Client renders the project in the sidebar + sets `activeProjectId` before server round-trip. |
| **Attachments** | N/A | Not a DB row — local-only composer id. |
| **Messages — auto-loop iterations 2+** | 🚫 | Server-authored. The server runs iteration N+1 autonomously; the client has no optimistic row waiting, no FK to set, no route to update. It observes via realtime only. |
| **Notice rows (merge, supervisor, verify-run)** | 🚫 | Server-authored. Fired by scripted flows; the client has no template for when they'll appear. |
| **`service_instances`** | 🚫 | Id comes from the runtime registry via upsert-on-id. Functionally equivalent (deterministic + idempotent); only different because the id source is server-side, not the browser. Revisit if a future UI flow lets the user manually spawn an instance — then the UI should generate the id. |
| **`project_services`** | 🚫 | Composite primary key `(project_id, name)`. The `id` column is incidental; no code links by it. Upsert on the natural key covers idempotency. |

## When NOT to use it (beyond server-authored rows)

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

- [x] Retrofit `runTurn` / `/api/chat` to accept a client-generated message id, remove the role+text fallback in `applyInsert`. Done.
- [x] Client-generate `file_comments.id`. Done (accepted as `commentId` on POST).
- [x] Retrofit projects. Done.
- [ ] Revisit `service_instances` if/when a UI flow spawns them directly (today: registry-spawned only).
- [ ] Audit future create endpoints against the decision rule as they land.

## Related files

- [src/models/Base.model.ts](../src/models/Base.model.ts) — `BaseModel.create()` defaults `id` to `crypto.randomUUID()`.
- [src/models/Conversation.model.ts](../src/models/Conversation.model.ts) — `applyInsert` id-match upgrade; `addOptimisticUserMessage(id, text)` helper for callers that need a deterministic chat-message id.
- [server/index.ts](../server/index.ts) — `/api/file-comments` POST shows the full pattern end-to-end (insert messages first, then file_comments with FK).
