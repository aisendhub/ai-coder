// Agent-response hooks — generic side-effect registry that runs every time
// a new assistant message arrives from the conversation stream (optimistic
// runTurn completion OR Supabase realtime INSERT/UPDATE on messages).
//
// Why it exists: the agent occasionally emits structured control blocks
// in its reply — currently only `<run-services>` / `<run-manifest>`, but
// the pattern will grow (verify-run, follow-up actions, etc). Instead of
// scattering "if (text.includes(…))" branches across components, the
// conversation model fires `runAgentResponseHooks` once per incoming
// message and each hook subscribes to the pattern it cares about.
//
// Hooks are side-effect only: they usually dispatch a `CustomEvent` on
// `window` which panels/components listen for. Keeping this boundary
// narrow means we can add a new hook without touching the message model
// or any rendering code.

type HookContext = {
  conversationId: string
  projectId: string | null
  messageId: string | null
  /** Best-effort: previous message text on UPDATE, `""` on INSERT. Lets
   *  a hook skip re-firing for a block that was already present on a
   *  prior update (edits / streaming partials). */
  priorText?: string
}

type AgentResponseHook = {
  /** Short stable id for logging. */
  name: string
  /** The hook itself. Runs synchronously or returns a Promise — either way,
   *  the caller does not await. Throwing is fine; errors are logged and
   *  other hooks still run. */
  run(text: string, ctx: HookContext): void | Promise<void>
}

const hooks: AgentResponseHook[] = []

export function registerAgentResponseHook(hook: AgentResponseHook): void {
  // Idempotent: re-registering a hook with the same name replaces the
  // previous entry. Useful for HMR and for tests that wire fresh hooks.
  const idx = hooks.findIndex((h) => h.name === hook.name)
  if (idx >= 0) hooks[idx] = hook
  else hooks.push(hook)
}

export function runAgentResponseHooks(text: string, ctx: HookContext): void {
  if (!text) return
  for (const hook of hooks) {
    try {
      const maybe = hook.run(text, ctx)
      if (maybe && typeof (maybe as Promise<void>).catch === "function") {
        ;(maybe as Promise<void>).catch((err: unknown) => {
          console.warn(`[agent-hook] ${hook.name} failed:`, err)
        })
      }
    } catch (err) {
      console.warn(`[agent-hook] ${hook.name} threw:`, err)
    }
  }
}

export type { AgentResponseHook, HookContext }
