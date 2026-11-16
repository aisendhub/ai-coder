import test from "node:test"
import assert from "node:assert/strict"
import { OpenCodeEventMapper, type OpenCodeEvent } from "./events.ts"

const SESSION = "ses_test_session"
const mapper = () =>
  new OpenCodeEventMapper({
    sessionId: SESSION,
    model: "deepseek/deepseek-flash",
    cwd: "/tmp/project",
  })

function assistantContent(msg: any): any[] {
  assert.equal(msg.type, "assistant")
  return msg.message.content
}

function toolResult(msg: any): any {
  assert.equal(msg.type, "user")
  return msg.message.content[0]
}

test("systemInit carries the runtime session id, model and cwd", () => {
  const init = mapper().systemInit() as any
  assert.equal(init.type, "system")
  assert.equal(init.subtype, "init")
  assert.equal(init.session_id, SESSION)
  assert.equal(init.model, "deepseek/deepseek-flash")
  assert.equal(init.cwd, "/tmp/project")
})

test("text deltas stream as assistant text, and text.ended does not duplicate", () => {
  const m = mapper()
  const first = m.handle({
    type: "session.text.delta",
    data: { sessionID: SESSION, assistantMessageID: "msg_1", ordinal: 0, delta: "Hel" },
  })
  const second = m.handle({
    type: "session.text.delta",
    data: { sessionID: SESSION, assistantMessageID: "msg_1", ordinal: 0, delta: "lo" },
  })
  assert.deepEqual(assistantContent(first.messages[0]), [{ type: "text", text: "Hel" }])
  assert.deepEqual(assistantContent(second.messages[0]), [{ type: "text", text: "lo" }])

  const ended = m.handle({
    type: "session.text.ended",
    data: { sessionID: SESSION, assistantMessageID: "msg_1", ordinal: 0, text: "Hello" },
  })
  assert.equal(ended.messages.length, 0)
})

test("text.ended emits when no delta was seen", () => {
  const m = mapper()
  const out = m.handle({
    type: "session.text.ended",
    data: { sessionID: SESSION, assistantMessageID: "msg_1", ordinal: 0, text: "final text" },
  })
  assert.deepEqual(assistantContent(out.messages[0]), [{ type: "text", text: "final text" }])
})

test("reasoning deltas map to thinking blocks and dedupe ended", () => {
  const m = mapper()
  const delta = m.handle({
    type: "session.reasoning.delta",
    data: { sessionID: SESSION, assistantMessageID: "msg_1", ordinal: 0, delta: "think" },
  })
  assert.deepEqual(assistantContent(delta.messages[0]), [
    { type: "thinking", thinking: "think" },
  ])
  const ended = m.handle({
    type: "session.reasoning.ended",
    data: { sessionID: SESSION, assistantMessageID: "msg_1", ordinal: 0, text: "think" },
  })
  assert.equal(ended.messages.length, 0)
})

test("tool.input.started + tool.called produce a named tool_use", () => {
  const m = mapper()
  m.handle({
    type: "session.tool.input.started",
    data: { sessionID: SESSION, assistantMessageID: "msg_1", id: "call_1", name: "write" },
  })
  const out = m.handle({
    type: "session.tool.called",
    data: {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_1",
      input: { path: "hello.txt", content: "hello" },
      executed: false,
    },
  })
  assert.deepEqual(assistantContent(out.messages[0]), [
    {
      type: "tool_use",
      id: "call_1",
      name: "Write",
      input: { path: "hello.txt", content: "hello", file_path: "hello.txt" },
    },
  ])
})

test("tool.success and tool.failed produce tool_result messages", () => {
  const m = mapper()
  const ok = m.handle({
    type: "session.tool.success",
    data: {
      sessionID: SESSION,
      id: "call_1",
      content: [{ type: "text", text: "Created file successfully" }],
    },
  })
  assert.deepEqual(toolResult(ok.messages[0]), {
    type: "tool_result",
    tool_use_id: "call_1",
    is_error: false,
    content: "Created file successfully",
  })

  const failed = m.handle({
    type: "session.tool.failed",
    data: {
      sessionID: SESSION,
      id: "call_2",
      error: { type: "runtime", message: "permission denied" },
    },
  })
  assert.deepEqual(toolResult(failed.messages[0]), {
    type: "tool_result",
    tool_use_id: "call_2",
    is_error: true,
    content: "permission denied",
  })
})

test("usage.updated is carried into the terminal result", () => {
  const m = mapper()
  m.handle({
    type: "session.step.started",
    data: {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      agent: "build",
      model: { providerID: "deepseek", id: "deepseek-flash" },
      started: 1,
    },
  })
  m.handle({
    type: "session.usage.updated",
    data: {
      sessionID: SESSION,
      cost: 0.00123,
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 1, write: 0 } },
    },
  })
  const done = m.handle({
    type: "session.execution.succeeded",
    data: { sessionID: SESSION },
  })
  assert.equal(done.done, "success")
  const result = m.resultMessage("success", null, 42) as any
  assert.equal(result.type, "result")
  assert.equal(result.subtype, "success")
  assert.equal(result.is_error, false)
  assert.equal(result.total_cost_usd, 0.00123)
  assert.equal(result.num_turns, 1)
  assert.equal(result.duration_ms, 42)
  assert.deepEqual(result.usage, {
    input: 10,
    output: 4,
    reasoning: 2,
    cache: { read: 1, write: 0 },
  })
})

test("terminal result prefers authoritative session info over streamed usage", () => {
  const m = mapper()
  const result = m.resultMessage(
    "success",
    { cost: 0.5, tokens: { input: 100, output: 50 } },
    10
  ) as any
  assert.equal(result.total_cost_usd, 0.5)
  assert.deepEqual(result.usage, { input: 100, output: 50 })
})

test("idle before execution.started is ignored; idle after it completes", () => {
  const m = mapper()
  assert.equal(m.handle({ type: "session.idle", data: { sessionID: SESSION } }).done, undefined)
  m.handle({ type: "session.execution.started", data: { sessionID: SESSION } })
  assert.equal(
    m.handle({ type: "session.idle", data: { sessionID: SESSION } }).done,
    "success"
  )
})

test("execution.failed and interrupted produce terminal states", () => {
  const failed = mapper().handle({
    type: "session.execution.failed",
    data: { sessionID: SESSION, error: { type: "provider", message: "rate limited" } },
  })
  assert.equal(failed.done, "error")
  assert.equal(failed.error?.message, "rate limited")

  const interrupted = mapper().handle({
    type: "session.execution.interrupted",
    data: { sessionID: SESSION, reason: "user" },
  })
  assert.equal(interrupted.done, "aborted")
})

test("duplicate terminal events are ignored", () => {
  const m = mapper()
  m.handle({ type: "session.execution.started", data: { sessionID: SESSION } })
  assert.equal(
    m.handle({ type: "session.execution.succeeded", data: { sessionID: SESSION } }).done,
    "success"
  )
  assert.equal(
    m.handle({ type: "session.idle", data: { sessionID: SESSION } }).done,
    undefined
  )
})

test("unknown events and permission.asked are inert for the mapper", () => {
  const m = mapper()
  assert.equal(m.handle({ type: "session.renamed", data: { sessionID: SESSION } }).messages.length, 0)
  assert.equal(
    m.handle({
      type: "permission.asked",
      data: { sessionID: SESSION, id: "perm_1", action: "edit", resources: ["*"] },
    }).messages.length,
    0
  )
})
