# Migration — client-generated IDs across the codebase

Companion to [ARCHITECTURE-CLIENT-IDS.md](ARCHITECTURE-CLIENT-IDS.md). That one defines the pattern; this one drives it into every place that doesn't yet use it.

Work here is a retrofit, not a rewrite. Each item is scoped, reversible, and testable on its own.

## Principles the AI/LLM MUST follow when adding new endpoints

1. Every `insert` of a row the client creates accepts an `id` from the request.
2. If the request doesn't include one, the server generates it with `crypto.randomUUID()` and **echoes it back** in the response.
3. Server validates the format (`^[0-9a-f-]{36}$/i`) before using it.
4. Server handles `23505 unique_violation` on retry as idempotent success: fetch the existing row with that `id` and return it.
5. If the new row has an FK to another row also being created in the same request, insert the parent first with its client-provided id, then the child referencing that same id.
6. The client generates the id with `crypto.randomUUID()` **before** calling the API. It inserts the local optimistic row first, then POSTs.
7. The client's realtime handler (`applyInsert` on the model) upgrades the optimistic row by **id match** — never by role+text or any other fuzzy heuristic.

When you're writing a new `create` endpoint: these are not optional.

## Retrofit checklist

Status legend: ✅ done, 🟡 in progress, ❌ not started, 🚫 won't do

### Phase 1 — highest-value

- [✅] **Conversations (chat + task creation)** — `POST /api/conversations`, `workspace.createNew` / `workspace.createTaskDraft`. Done in commit `c98bc9e`.
- [✅] **Messages — comments flow** — `POST /api/file-comments`. Done in commit `ee29d93`.
- [❌] **Messages — runTurn (new-turn) flow** — `POST /api/chat`. Client already generates an optimistic UUID via `BaseModel.create()`, but it's not passed through. Server's `startRunner` inserts its own.
  - Client change: `Conversation.runTurn` sends `messageId` (user + assistant placeholder) to `/api/chat`.
  - Server change: `/api/chat` accepts `userMessageId` + `assistantMessageId`. `startRunner` uses `userMessageId` when it inserts the user row (skipping insert if `skipFirstUserInsert` is already set) and `assistantMessageId` for the assistant placeholder.
  - Fallback role+text match in `applyInsert` can then be removed.
- [❌] **Messages — nudge flow** — `POST /api/messages/nudge`. Accept `messageId`, use it on insert. Client's `Conversation.send` already creates an optimistic row; pass the id to both the local row and the request.

### Phase 2 — consistency / low friction

- [❌] **Projects** — `POST /api/projects`. Low call volume, but trivial retrofit. Worth doing so every entity follows the rule.
- [❌] **File comments row itself** (`file_comments.id`) — today server-generated. Linked `message_id` is already deterministic. Accepting a client-provided `id` lets callers link *to* a comment (e.g. future "reply" threading) without waiting for the insert response.

### Phase 3 — server-authored rows (explicitly exempt)

These rows are created server-side in response to agent/loop events, not client actions. They stay server-generated.

- [🚫] **Assistant message placeholders inserted mid-turn** outside of `/api/chat` (e.g. follow-up iterations) — server-authored, no client is waiting to link to them by a pre-known id. If we ever *do* need to link, revisit.
- [🚫] **Notice messages (merge flow, supervisor, verify-run, etc.)** — role=`notice`, authored by the server when it fires a scripted flow. No client UI waiting to pre-insert them.
- [🚫] **Service instances** (`service_instances`) — already uses the runtime registry's UUID via `upsert({ onConflict: "id" })`. Functionally equivalent to the pattern.
- [🚫] **Project services** (`project_services`) — composite key `(project_id, name)` + upsert. The row's `id` is incidental; no one links to it before insert.

### Phase 4 — cleanups after Phase 1 lands

- [❌] Remove the legacy role+text fallback in `Conversation.applyInsert`. Once every message-creating call site carries a deterministic id, the fallback is dead code.
- [❌] Consider making `BaseModel.create()`'s auto-`id` the canonical pattern and adding an assertion in `applyInsert` that every incoming row has an id we already know about (panic if not — helps catch silent drift).

## Per-endpoint retrofit template

Server:

```ts
app.post("/api/widgets", async (c) => {
  const body = await c.req.json<{ id?: string; /* ...other fields */ }>().catch(() => ({}))
  const id = body.id && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : crypto.randomUUID()

  const { data, error } = await sb.from("widgets").insert({ id, /* ...rest */ }).select().single()
  if (error?.code === "23505") {
    const { data: existing } = await sb.from("widgets").select("*").eq("id", id).single()
    if (existing) return c.json(existing)
  }
  if (error || !data) return c.json({ error: error?.message ?? "insert failed" }, 500)
  return c.json(data)
})
```

Client:

```ts
async createWidget(input: { /* ... */ }): Promise<Widget> {
  const id = crypto.randomUUID()
  const w = Widget.create()
  w.setFromProps({ id, ...input })
  runInAction(() => this.widgets.addItem(w))
  try {
    const res = await api("/api/widgets", { method: "POST", body: JSON.stringify({ id, ...input }) })
    if (!res.ok) throw new Error(await res.text())
    const data = await res.json()
    runInAction(() => w.setFromRow(data))
  } catch (err) {
    runInAction(() => this.widgets.removeItem(id))
    throw err
  }
  return w
}
```

Realtime (in the owning model):

```ts
@action private applyInsert(row: WidgetRow) {
  const existing = this.widgets.find(row.id)
  if (existing) {
    if (existing.isOptimistic) existing.setProps({ ...row, isOptimistic: false })
    return
  }
  // Fresh row (another tab / another user) — add it.
  this.widgets.addItem(Widget.fromProps({ ...row }))
}
```

## Testing each retrofit

- **Unit**: hit the endpoint with `{ id: "fixed-uuid", ... }` twice in a row. Second call should return the existing row (200), not a duplicate. Third call with a different payload + same id: behavior is your choice (accept vs reject); document it.
- **Integration**: create a widget while offline, observe optimistic row. Reconnect, observe id-match swap (no flicker, no duplicate row).
- **Rollback**: inject a server 500 during POST, observe the optimistic row is removed and `activeId` cleared if relevant.

## Related

- [ARCHITECTURE-CLIENT-IDS.md](ARCHITECTURE-CLIENT-IDS.md) — the pattern itself, why it exists, when not to use it.
- [CLAUDE.md](../CLAUDE.md) — one-line convention pointer with a link back here.
- `docs/FILE-ANNOTATIONS.md` — the feature that drove the pattern into the codebase first.
