# Runtime & Deploy — Design

How we run the user's app — locally from a worktree, and in production on a cloud platform — behind a single, minimal abstraction so the two surfaces share a UI and the core stays decoupled from any specific stack or host.

## Context

Agent-edited code has to *run somewhere*. Today that means:

1. **Locally**, from a worktree: the user wants a "Run" button in the UI that spins up `npm run dev` (or whatever the repo needs), streams logs back, and lists what's running.
2. **In production**: the same worktree eventually ships to Railway / Fly / Cloudflare / GCP / AWS. We want the same "Run" surface to also mean "Deploy", without coupling the chat UI to any one platform's SDK or config format.

Without a shared abstraction, we'd duplicate stack detection, env handling, build/start commands, and log UI per surface. Worse, every new platform adapter would touch core code.

## Prior art

- **[Nixpacks](https://nixpacks.com/)** (Railway): detects a project's stack from files on disk (`package.json`, `requirements.txt`, `go.mod`…) and emits a Dockerfile. Zero config for common stacks; `nixpacks.toml` overrides when needed. We can reuse it as a backend rather than rebuild it.
- **[Buildpacks](https://buildpacks.io/)** (Heroku / GCP Cloud Run): same idea, standardized as CNB. Heavier than Nixpacks; more ceremony.
- **[Procfile](https://devcenter.heroku.com/articles/procfile)**: a one-line-per-process manifest (`web: npm start`). Trivially portable. The spiritual ancestor of what we want as *our* manifest.
- **Railway / Fly / Vercel**: all accept "git push → we'll figure it out" or an explicit Dockerfile. The Dockerfile is the universal currency.
- **[Docker Compose](https://docs.docker.com/compose/)**: good for multi-service local dev, but too heavy and too opinionated for "run this one app".

**Convergent pattern**: a tiny declarative manifest (build cmd, start cmd, env, port) + pluggable *runners* that know how to execute it in a given environment. Dockerfile is the lingua franca for production; platform-specific config is a thin layer on top.

## Decision: one manifest, pluggable runners, Docker as the reference target

The core of this system is a **Run Manifest** — a small typed object that fully describes how to build and run one service. Every surface (local process, local container, remote deploy) consumes the same manifest via a **Runner** interface. Adapters live in their own module tree; core chat/UI never imports them directly.

### Run Manifest

```ts
type RunManifest = {
  stack: 'node' | 'bun' | 'python' | 'go' | 'ruby' | 'static' | 'docker' | 'custom'
  build?: string          // e.g. "npm ci && npm run build"
  start: string           // e.g. "npm run dev" or "node dist/server.js"
  cwd: string             // absolute path inside the worktree
  env: Record<string, string>
  port?: number           // app listens here; runner may remap
  healthcheck?: { path: string; timeoutMs: number }
  // Optional escape hatch — if present, runners should prefer it:
  dockerfile?: string     // path to a user-authored Dockerfile
}
```

Kept deliberately small. It's a Procfile with a few knobs. Anything a specific runner needs beyond this goes into that runner's own config, not the manifest.

### Runner interface

```ts
interface Runner {
  id: string              // "local-process" | "local-docker" | "railway" | "fly" | "cloudflare" | "gcp-run" | ...
  start(m: RunManifest): Promise<ServiceHandle>
  stop(h: ServiceHandle): Promise<void>
  logs(h: ServiceHandle): AsyncIterable<LogLine>
  status(h: ServiceHandle): Promise<ServiceStatus>
}
```

Every surface in the UI — "Run locally", "Deploy to Railway", "Deploy to Fly" — is just a runner selection. The manifest doesn't change.

### Detection

A separate `detect(cwd) -> RunManifest` function reads the worktree and proposes a manifest. For the first cut we lean on Nixpacks (shell out) so we don't reimplement stack sniffing. User confirms once; the confirmed manifest is cached in the DB (on `projects` or `worktrees`). AI can suggest edits, but it doesn't silently re-detect on every run.

## Minimal first cut

Ship in this order. Each step is independently useful.

1. **Manifest + detector + local process runner.** `npm/bun/python -m/go run` executed directly on the host, with a ring-buffered log stream and a services registry. No containers. This is also the primitive for the previous "run worktrees" question — same code path.
2. **Local Docker runner.** Same manifest, executed via `docker run`. Proves the manifest-to-container path works before we touch any cloud. Gives users who already have Docker a reproducible sandbox without us shipping container orchestration.
3. **Generated Dockerfile.** `nixpacks build` (or our own template) turns the manifest into a Dockerfile on disk. This is the *artifact* every cloud target consumes.
4. **First cloud runner: Railway.** We're already on Railway, and it accepts either a Dockerfile or a git push. Adapter is mostly API calls + env injection. This is the proof that "same manifest, different runner" works end-to-end.
5. **Second cloud runner: Fly.io.** `fly launch` + `fly.toml` from the manifest. Picked as runner #2 because it's the most different from Railway (machines vs. nixpacks), which stresses the abstraction.
6. **Everything else (Cloudflare Workers, GCP Cloud Run, Vercel, AWS App Runner, …) is additive.** Each is a new file in `server/runtime/deploy/`. None of them touch core.

Explicit non-goals for v1:
- No multi-service orchestration (no Compose-equivalent). One service per manifest.
- No secrets manager. Env is a flat map; platform-native secrets stores come later per adapter.
- No CI/CD pipelines, no preview envs, no rollback UI. Deploy = push + wait + stream logs.
- No autoscaling, no custom domains, no TLS config. Platform defaults only.

## Complexity weighting — why Docker-first, not platform-first

| Option | Complexity | Portability | Mirrors prod locally | Scales to N platforms |
|---|---|---|---|---|
| **A. Native everywhere** (no containers) | Low | Low | ❌ | ❌ N×M adapters |
| **B. Platform-native adapters only** (Railway.toml, fly.toml, wrangler.toml, app.yaml…) | High | Medium | ❌ | ⚠️ linear, but each adapter is bespoke |
| **C. Docker-first + thin platform adapters** ← chosen | Medium | **High** | ✅ | ✅ adapter is mostly "push image + set env" |
| **D. Kubernetes / Nomad** | Very high | High | ⚠️ | ✅ but massive overkill |

Option C wins because the Dockerfile is the *universal* artifact — every platform we care about accepts one. Platform adapters become thin (push the image, set env, map the port) instead of each one reimplementing "how to build a Node app on this platform".

The one real cost of C is that users need Docker installed for the local-container path. We mitigate this by keeping **runner #1 (local process)** fully Docker-free — it's the same `child_process.spawn` we need anyway for worktree dev servers. Docker is only required once the user wants parity with prod or wants to deploy.

## Separation — keeping this rebuildable

```
server/
  runtime/
    manifest.ts           # RunManifest type, detect(), validators
    registry.ts           # in-memory services registry + SSE log hub
    runners/
      local-process.ts    # child_process.spawn
      local-docker.ts     # docker run
      railway.ts          # Railway API
      fly.ts              # flyctl / Fly Machines API
      cloudflare.ts       # wrangler
      gcp-run.ts          # gcloud run deploy
    index.ts              # exports Runner interface + registry of runners
```

Hard rules:

- **Core (chat, agent SDK, DB) never imports a specific runner.** It only imports from `server/runtime/index.ts`. A runner can be deleted or rewritten without touching anything else.
- **Runners never import from chat/agent code.** One-way dependency.
- **The manifest is the contract.** If a runner needs info the manifest doesn't carry, either extend the manifest (and update every runner) or store the extra info in that runner's own config table — never smuggle it through a side channel.
- **No shared runner base class.** Composition over inheritance; runners are small enough that duplication is cheaper than a leaky abstraction.

If the whole approach turns out wrong, the blast radius is `server/runtime/`. Rip it out, keep the rest.

## Open questions

- **Where does the manifest live?** Per-worktree (one app per task) vs. per-project (shared across worktrees). Probably per-project with per-worktree env overrides, but TBD once the local runner lands.
- **Who owns secrets?** For local, `.env` in the worktree. For prod, platform-native (Railway Variables, Fly Secrets). We don't want to be a secrets manager.
- **Multi-service apps.** Punt until a real use case shows up. When it does, the answer is probably "multiple manifests grouped by the project", not a Compose equivalent we invented.
- **AI's role.** AI proposes the manifest on first run and can edit it later, but doesn't auto-run detection or silently change start commands. Keeps the failure mode "user sees a wrong command and fixes it" rather than "something ran that shouldn't have".
