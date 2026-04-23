// Single export barrel for the runtime module. Chat/agent code must only
// import from here — never reach into internals directly.
// See docs/RUNTIME.md § Separation.

import { registerRunner } from "./registry.ts"
import { localProcessRunner } from "./runners/local-process.ts"
import { localDockerRunner } from "./runners/local-docker.ts"

// Register runners on module load. Order doesn't matter; the list is a map.
// local-docker is registered even when docker isn't installed — availability
// is probed lazily at start time.
registerRunner(localProcessRunner)
registerRunner(localDockerRunner)

export {
  detect,
  mergeManifest,
  logRuntimeEvent,
} from "./manifest.ts"

export type {
  Stack,
  PackageManager,
  Healthcheck,
  RunManifest,
  ManifestOverride,
  RuntimeEvent,
} from "./manifest.ts"

export {
  startService,
  stopService,
  stopServiceAndWait,
  getService,
  listServices,
  getLogHistory,
  subscribeLogs,
  removeService,
  shutdownAll,
  installShutdownHook,
  registerRunner,
  listRunners,
  getRunnersInfo,
  RuntimeError,
} from "./registry.ts"

export type {
  ServiceStatus,
  ServiceScope,
  ServiceSnapshot,
  LogSubscription,
  StartOptions,
  RunnerInfo,
} from "./registry.ts"

export type { LogLine } from "./ring-buffer.ts"
export type { Runner, RunnerId, RunnerHandle } from "./runners/types.ts"

export { generateDockerfile } from "./dockerfile.ts"
export type { DockerfileResult } from "./dockerfile.ts"
