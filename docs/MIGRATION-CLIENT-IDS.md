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

## The decision rule (canonical — apply to every new row)

> **If the client needs to refer to the row — render it, link to it, scroll to it, set an FK on it — *before* the server's insert confirms, the client generates the id.**
> **Otherwise, the row is server-authored and the id source is irrelevant, as long as retries are idempotent.**

This is the single test for whether a new row type belongs in the ✅ or 🚫 bucket below. See [ARCHITECTURE-CLIENT-IDS.md](ARCHITECTURE-CLIENT-IDS.md) for the underlying reasoning.

## Retrofit status

Status legend: ✅ done, 🟡 in progress, ❌ not started, 🚫 won't do (passes the "server-authored" side of the rule).

### ✅ Done

- **Conversations (chat + task)** — `POST /api/conversations`, `workspace.createNew` / `workspace.createTaskDraft`. Shipped in `c98bc9e`.
- **Messages — comments flow** — `POST /api/file-comments` inserts the messages row + the comment row with client-provided ids. Shipped in `ee29d93`.
- **Messages — runTurn first iteration** — `Conversation.runTurn` sends `userMessageId` + `assistantMessageId` to `/api/chat`; `startRunner` uses them on the first iteration's inserts. Subsequent auto-loop iterations stay server-id (see 🚫 below). Shipped in `5c864ac`.
- **Messages — nudge flow** — `Conversation.send` generates the id, `/api/messages/nudge` uses it, 23505 is idempotent. Shipped in `5c864ac`.
- **Projects** — `workspace.createProject` generates the id, optimistic insert, rollback on failure. Shipped in `5c864ac`.
- **File comments row itself (`file_comments.id`)** — optional `commentId` on the POST. Shipped in `5c864ac`.
- **Legacy applyInsert fallback removed** — every optimistic row now carries a deterministic id; the role+text fuzzy-match is dead code and was removed in `5c864ac`.

### 🚫 Exempt — the rule says server-authored

Each of these was checked against the decision rule and failed the client-needs-the-id-pre-confirmation test. Revisit if a future flow changes that.

- **Assistant messages on auto-loop iterations 2+** — The server decides when to run iteration N+1 (evaluator feedback or auto-loop tick). The client has no optimistic row waiting, no FK to satisfy, no route to update. It observes the row via realtime on arrival. **Trigger to revisit:** if we ever add a UI that pre-provisions iteration slots (we don't today).
- **Notice messages (merge / supervisor / verify-run)** — `role='notice'`, authored by scripted server flows. The client has no template for when a notice will fire. **Trigger to revisit:** if a client-initiated flow starts asking for a specific notice slot (unlikely).
- **`service_instances`** — Id comes from the runtime registry via `upsert({ onConflict: "id" })`. This is functionally the same pattern — deterministic + idempotent — just with the id source being a server-side process instead of the browser. **Trigger to revisit:** a UI flow that spawns an instance directly (today: registry-spawned only, triggered by agent tool calls).
- **`project_services`** — Primary natural key is `(project_id, name)`; the `id` column is incidental. Upsert on the natural key covers idempotency. **Trigger to revisit:** if anything ever links by `project_services.id` (today: nothing does; could drop the column in a future cleanup).

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
