// "External" runner — for processes the registry didn't spawn.
// Registered at boot when `reconcileServiceInstances` finds a persisted
// instance whose pid is still alive. The runner never calls `start` (that
// flow is meaningless — the process already exists); only `stop` matters,
// and it signals the whole process group so children die with the parent.

import type { Runner, RunnerId } from "./types.ts"

export const externalRunner: Runner = {
  id: "external" as RunnerId,
  async isAvailable(): Promise<boolean> {
    // Always available — it's not really a runner, just a stop channel
    // for pre-existing PIDs. The registry does NOT call `start()` on us.
    return true
  },
  async unavailableReason(): Promise<string> {
    return "external runner is boot-reconcile only; do not start from the UI"
  },
  async start(): Promise<never> {
    throw new Error("external runner does not spawn — use local-process")
  },
  async stop(handle): Promise<void> {
    const pid = handle.pid
    if (pid == null) return
    // Negative pid → entire process group (matches `detached:true` semantics
    // of local-process). Ignore ESRCH — if it's already gone, great.
    try {
      process.kill(-pid, "SIGTERM")
    } catch (err) {
      // ESRCH = already gone; anything else we surface via exit event.
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        throw err
      }
    }
  },
}
