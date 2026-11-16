import test from "node:test"
import assert from "node:assert/strict"
import type { AgentRunOptions } from "../provider.ts"
import {
  createOpenCodeProvider,
  normalizePrompt,
  permissionsFor,
  type OpenCodeEvent,
  type OpenCodeHost,
  type OpenCodeRunOptions,
} from "./index.ts"

type Calls = {
  create: any[]
  get: any[]
  prompt: any[]
  switchModel: any[]
  interrupt: any[]
  permission: any[]
  subscribe: any[]
  instructions: any[]
  modelList: any[]
}

function eventStream(events: OpenCodeEvent[]) {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<OpenCodeEvent> {
      yield { type: "server.connected" }
      for (const event of events) yield event
    },
  }
}

function hangingStream(events: OpenCodeEvent[]) {
  return {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next(): Promise<IteratorResult<OpenCodeEvent>> {
          if (index === 0) {
            index += 1
            return { value: { type: "server.connected" }, done: false }
          }
          if (index <= events.length) {
            const value = events[index - 1]
            index += 1
            return { value, done: false }
          }
          return new Promise<IteratorResult<OpenCodeEvent>>(() => {})
        },
        async return(): Promise<IteratorResult<OpenCodeEvent>> {
          return { value: undefined, done: true }
        },
      }
    },
  }
}

function makeHost(
  events: OpenCodeEvent[],
  opts: { sessionID?: string; cost?: number } = {}
): { host: OpenCodeHost; calls: Calls } {
  const calls: Calls = {
    create: [],
    get: [],
    prompt: [],
    switchModel: [],
    interrupt: [],
    permission: [],
    subscribe: [],
    instructions: [],
    modelList: [],
  }
  const sessionID = opts.sessionID ?? "ses_fake_session"
  const host: OpenCodeHost = {
    sessions: {
      async create(input) {
        calls.create.push(input)
        return { id: sessionID, model: input.model }
      },
      async get(input) {
        calls.get.push(input)
        return {
          id: input.sessionID,
          cost: opts.cost ?? 0.004,
          tokens: { input: 12, output: 4, reasoning: 0, cache: { read: 1, write: 0 } },
          model: { providerID: "deepseek", id: "deepseek-flash" },
        }
      },
      async prompt(input) {
        calls.prompt.push(input)
        return { id: "msg_user" }
      },
      async switchModel(input) {
        calls.switchModel.push(input)
      },
      async interrupt(input) {
        calls.interrupt.push(input)
        return { interrupted: true }
      },
    },
    events: {
      subscribe(options) {
        calls.subscribe.push(options)
        return eventStream(events)
      },
    },
    permission: {
      async reply(input) {
        calls.permission.push(input)
      },
    },
    model: {
      async list(input) {
        calls.modelList.push(input)
        return {
          data: [
            {
              providerID: "deepseek",
              id: "deepseek-flash",
              modelID: "deepseek-flash",
              name: "DeepSeek V4.1 Flash",
              limit: { context: 1048576, output: 393216 },
              enabled: true,
            },
          ],
        }
      },
    },
    experimental: {
      session: {
        instructions: {
          entry: {
            async put(input) {
              calls.instructions.push(input)
            },
          },
        },
      },
    },
  }
  return { host, calls }
}

function baseOpts(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "hello",
    cwd: "/tmp/project",
    permissionMode: "bypassPermissions",
    settingSources: [],
    ...overrides,
  }
}

const happyEvents: OpenCodeEvent[] = [
  { type: "session.execution.started", data: { sessionID: "ses_fake_session" } },
  {
    type: "session.step.started",
    data: {
      sessionID: "ses_fake_session",
      assistantMessageID: "msg_1",
      agent: "build",
      model: { providerID: "deepseek", id: "deepseek-flash" },
      started: 1,
    },
  },
  {
    type: "session.text.delta",
    data: { sessionID: "ses_fake_session", assistantMessageID: "msg_1", ordinal: 0, delta: "Hi" },
  },
  {
    type: "session.tool.input.started",
    data: { sessionID: "ses_fake_session", assistantMessageID: "msg_1", id: "call_1", name: "write" },
  },
  {
    type: "session.tool.called",
    data: {
      sessionID: "ses_fake_session",
      assistantMessageID: "msg_1",
      id: "call_1",
      input: { path: "a.txt", content: "x" },
      executed: false,
    },
  },
  {
    type: "session.tool.success",
    data: {
      sessionID: "ses_fake_session",
      id: "call_1",
      content: [{ type: "text", text: "ok" }],
    },
  },
  {
    type: "session.usage.updated",
    data: {
      sessionID: "ses_fake_session",
      cost: 0.003,
      tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  },
  { type: "session.execution.succeeded", data: { sessionID: "ses_fake_session" } },
]

async function collect(
  provider: ReturnType<typeof createOpenCodeProvider>,
  opts: AgentRunOptions
): Promise<any[]> {
  const out: any[] = []
  for await (const msg of provider.runAgent(opts)) out.push(msg)
  return out
}

test("runAgent creates a session, streams text/tool messages and a result", async () => {
  const { host, calls } = makeHost(happyEvents)
  const provider = createOpenCodeProvider({ createHost: async () => host })

  const messages = await collect(provider, baseOpts())

  assert.deepEqual(calls.create[0], {
    location: { directory: "/tmp/project" },
    model: { providerID: "deepseek", id: "deepseek-flash" },
    permissions: undefined,
  })
  assert.equal(calls.prompt[0].text, "hello")
  assert.equal(calls.prompt[0].delivery, "queue")
  assert.ok(calls.subscribe[0].types.includes("session.text.delta"))

  assert.equal(messages[0].type, "system")
  assert.equal((messages[0] as any).subtype, "init")
  assert.equal((messages[0] as any).session_id, "ses_fake_session")

  const text = messages.find(
    (m) => m.type === "assistant" && m.message.content[0]?.type === "text"
  ) as any
  assert.deepEqual(text.message.content, [{ type: "text", text: "Hi" }])

  const toolUse = messages.find(
    (m) => m.type === "assistant" && m.message.content[0]?.type === "tool_use"
  ) as any
  assert.equal(toolUse.message.content[0].name, "Write")
  assert.equal(toolUse.message.content[0].input.file_path, "a.txt")

  const toolResult = messages.find((m) => m.type === "user") as any
  assert.equal(toolResult.message.content[0].content, "ok")
  assert.equal(toolResult.message.content[0].is_error, false)

  const result = messages.at(-1) as any
  assert.equal(result.type, "result")
  assert.equal(result.subtype, "success")
  assert.equal(result.total_cost_usd, 0.004)
  assert.equal(result.num_turns, 1)
  assert.ok(calls.get.length >= 1)
})

test("resuming an OpenCode session switches the model when one is requested", async () => {
  const { host, calls } = makeHost(
    [
      { type: "session.execution.started", data: { sessionID: "ses_existing" } },
      {
        type: "session.text.delta",
        data: {
          sessionID: "ses_existing",
          assistantMessageID: "msg_resume",
          ordinal: 0,
          delta: "ok",
        },
      },
      { type: "session.execution.succeeded", data: { sessionID: "ses_existing" } },
    ],
    { sessionID: "ses_existing" }
  )
  const provider = createOpenCodeProvider({ createHost: async () => host })

  await collect(
    provider,
    baseOpts({ resumeSessionId: "ses_existing", model: "deepseek/deepseek-v4-pro" })
  )

  assert.equal(calls.create.length, 0)
  assert.deepEqual(calls.get[0], { sessionID: "ses_existing" })
  assert.deepEqual(calls.switchModel[0], {
    sessionID: "ses_existing",
    model: { providerID: "deepseek", id: "deepseek-v4-pro" },
  })
  assert.equal(calls.prompt[0].text, "hello")
})

test("a Claude UUID is not treated as an OpenCode session handle", async () => {
  const { host, calls } = makeHost(happyEvents)
  const provider = createOpenCodeProvider({ createHost: async () => host })

  await collect(
    provider,
    baseOpts({ resumeSessionId: "550e8400-e29b-41d4-a716-446655440000" })
  )

  assert.equal(calls.create.length, 1)
  assert.equal(calls.get[0].sessionID.includes("550e8400"), false)
})

test("system prompt append is installed as a per-session instruction", async () => {
  const { host, calls } = makeHost(happyEvents)
  const provider = createOpenCodeProvider({ createHost: async () => host })

  await collect(
    provider,
    baseOpts({ systemPrompt: { preset: "claude_code", append: "Be terse." } })
  )

  assert.deepEqual(calls.instructions[0], {
    sessionID: "ses_fake_session",
    key: "ai-coder",
    value: "Be terse.",
  })
})

test("permission.asked is answered through the callback", async () => {
  const events: OpenCodeEvent[] = [
    { type: "session.execution.started", data: { sessionID: "ses_fake_session" } },
    {
      type: "permission.asked",
      data: {
        sessionID: "ses_fake_session",
        id: "perm_1",
        action: "edit",
        resources: ["src/a.ts"],
        message: "Allow edit?",
      },
    },
    {
      type: "session.text.delta",
      data: {
        sessionID: "ses_fake_session",
        assistantMessageID: "msg_perm",
        ordinal: 0,
        delta: "done",
      },
    },
    { type: "session.execution.succeeded", data: { sessionID: "ses_fake_session" } },
  ]
  const { host, calls } = makeHost(events)
  const provider = createOpenCodeProvider({ createHost: async () => host })

  const seen: any[] = []
  const opts: OpenCodeRunOptions = {
    ...baseOpts(),
    onPermission: (req) => {
      seen.push(req)
      return "reject"
    },
  }
  await collect(provider, opts)

  assert.deepEqual(seen[0], {
    id: "perm_1",
    sessionID: "ses_fake_session",
    action: "edit",
    resources: ["src/a.ts"],
    message: "Allow edit?",
  })
  assert.deepEqual(calls.permission[0], {
    sessionID: "ses_fake_session",
    requestID: "perm_1",
    decision: "reject",
  })
})

test("execution.failed rejects the stream with the provider error", async () => {
  const events: OpenCodeEvent[] = [
    { type: "session.execution.started", data: { sessionID: "ses_fake_session" } },
    {
      type: "session.execution.failed",
      data: { sessionID: "ses_fake_session", error: { type: "provider", message: "rate limited" } },
    },
  ]
  const { host } = makeHost(events)
  const provider = createOpenCodeProvider({ createHost: async () => host })

  await assert.rejects(
    () => collect(provider, baseOpts()),
    /rate limited/
  )
})

test("abort interrupts the session and terminates with an aborted result", async () => {
  const events: OpenCodeEvent[] = [
    { type: "session.execution.started", data: { sessionID: "ses_fake_session" } },
    {
      type: "session.text.delta",
      data: { sessionID: "ses_fake_session", assistantMessageID: "msg_1", ordinal: 0, delta: "working" },
    },
  ]
  const { host, calls } = makeHost(events)
  const provider = createOpenCodeProvider({ createHost: async () => host })
  const ac = new AbortController()

  const out: any[] = []
  for await (const msg of provider.runAgent(baseOpts({ abortController: ac }))) {
    out.push(msg)
    if (msg.type === "assistant") ac.abort()
  }

  assert.ok(calls.interrupt.length >= 1)
  const result = out.at(-1) as any
  assert.equal(result.type, "result")
  assert.equal(result.subtype, "error_during_execution")
  assert.equal(result.is_error, true)
})

test("an empty successful turn is reported as an error", async () => {
  const events: OpenCodeEvent[] = [
    { type: "session.execution.started", data: { sessionID: "ses_fake_session" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_fake_session" } },
  ]
  const { host } = makeHost(events)
  const provider = createOpenCodeProvider({ createHost: async () => host })

  await assert.rejects(() => collect(provider, baseOpts()), /returned no response/)
})

test("a stalled event stream is interrupted and rejected", async () => {
  const previous = process.env.OPENCODE_STALL_TIMEOUT_MS
  process.env.OPENCODE_STALL_TIMEOUT_MS = "30"
  const { host, calls } = makeHost([])
  ;(host.events as any).subscribe = () =>
    hangingStream([
      {
        type: "session.execution.started",
        data: { sessionID: "ses_fake_session" },
      },
    ])
  const provider = createOpenCodeProvider({ createHost: async () => host })

  try {
    await assert.rejects(() => collect(provider, baseOpts()), /stopped responding/)
    assert.ok(calls.interrupt.length >= 1)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_STALL_TIMEOUT_MS
    else process.env.OPENCODE_STALL_TIMEOUT_MS = previous
  }
})

test("listModels maps the OpenCode catalog", async () => {
  const { host, calls } = makeHost([])
  const provider = createOpenCodeProvider({ createHost: async () => host })

  const models = await provider.listModels("/tmp/project")
  assert.equal(models[0].providerID, "deepseek")
  assert.equal(models[0].id, "deepseek-flash")
  assert.equal(models[0].context, 1048576)
  assert.deepEqual(calls.modelList[0], { location: { directory: "/tmp/project" } })
})

test("permissionsFor maps read-only tool allowlists and deny lists", () => {
  assert.deepEqual(
    permissionsFor(baseOpts({ allowedTools: ["Read", "Glob", "Grep"] })),
    [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ]
  )
  assert.equal(permissionsFor(baseOpts({ permissionMode: "bypassPermissions" })), undefined)
  assert.deepEqual(
    permissionsFor(baseOpts({ disallowedTools: ["Edit"] })),
    [{ action: "edit", resource: "*", effect: "deny" }]
  )
})

test("normalizePrompt extracts text and base64 attachments", async () => {
  async function* prompt() {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
      },
    }
  }
  const out = await normalizePrompt(prompt() as any)
  assert.equal(out.text, "look at this")
  assert.equal(out.files.length, 1)
  assert.equal(out.files[0].uri, "data:image/png;base64,AAAA")
  assert.deepEqual(out.files[0].source, { type: "inline" })
})
