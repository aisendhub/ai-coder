// Port helpers. Solves the two ends of "the app doesn't listen on the port
// we allocated":
//
// 1. BEFORE spawn — `injectPortFlag` post-processes `manifest.start` to add
//    a framework-appropriate port flag if the command doesn't already use
//    `$PORT` or `--port/-p`. Many dev servers (Vite, Django, Rails, …) read
//    only their CLI flag, not the PORT env, so injecting PORT=N alone is
//    insufficient. Conservative: only rewrites when we recognize the
//    framework signature in the command string.
//
// 2. AFTER spawn — `extractBoundPort` sniffs each log line for the URL or
//    "listening on port N" message the app prints at startup. When it finds
//    a port different from the allocated one, the registry updates the
//    service's port/url so the UI reflects where the app actually bound.

export type PortInjectionResult = {
  command: string
  injected: boolean
  reason: string
}

// Order matters: more-specific patterns first. Each rule produces a flag to
// append, and declares whether an `npm run <script>` wrapper needs a `--`
// separator to forward the arg through to the underlying tool.
type InjectionRule = {
  match: RegExp
  flag: string
  /** Needs `--` separator when the command is `npm/pnpm/yarn/bun run <x>`. */
  needsDashesThroughRunScript: boolean
  stack?: string
}

const RULES: InjectionRule[] = [
  // Vite — IGNORES the PORT env; only respects --port.
  { match: /\bvite\b/i, flag: "--port $PORT", needsDashesThroughRunScript: true },
  // Next.js — supports PORT env AND -p. Belt & suspenders.
  {
    match: /\bnext\b\s+(dev|start)\b/i,
    flag: "-p $PORT",
    needsDashesThroughRunScript: true,
  },
  // uvicorn / FastAPI
  { match: /\buvicorn\b/i, flag: "--port $PORT", needsDashesThroughRunScript: false },
  // Django
  {
    match: /\bmanage\.py\s+runserver\b/i,
    flag: "0.0.0.0:$PORT",
    needsDashesThroughRunScript: false,
  },
  // Flask (newer CLI)
  { match: /\bflask\s+run\b/i, flag: "--port $PORT", needsDashesThroughRunScript: false },
  // Rails / bin/dev / bin/rails
  {
    match: /\b(rails\s+server|bin\/(rails|dev))\b/i,
    flag: "-p $PORT",
    needsDashesThroughRunScript: false,
  },
  // Gunicorn (Python WSGI)
  {
    match: /\bgunicorn\b/i,
    flag: "--bind 0.0.0.0:$PORT",
    needsDashesThroughRunScript: false,
  },
]

const RUN_SCRIPT_PREFIX_RE = /^(npm|pnpm|yarn|bun)\s+run\s+/i
const EXISTING_PORT_FLAG_RE = /(^|\s)(-p|--port|--bind)\b/i
const EXISTING_PORT_VAR_RE = /\$PORT\b/
// Positional host:port form some tools take (Django's runserver, uvicorn,
// rails shortcut: `0.0.0.0:8000`, `127.0.0.1:3000`, or just `:3000`).
// Anything of the form `\b(?:host)?:\d{2,5}\b` in the command means the user
// already specified the port — don't double-inject.
const EXISTING_POSITIONAL_PORT_RE = /(?:^|\s)(?:[\w.:-]+)?:\d{2,5}\b/

export function injectPortFlag(start: string): PortInjectionResult {
  const trimmed = start.trim()
  if (!trimmed) {
    return { command: start, injected: false, reason: "empty start" }
  }
  if (EXISTING_PORT_VAR_RE.test(trimmed)) {
    return { command: start, injected: false, reason: "already references $PORT" }
  }
  if (EXISTING_PORT_FLAG_RE.test(trimmed)) {
    return { command: start, injected: false, reason: "already has a port flag" }
  }
  if (EXISTING_POSITIONAL_PORT_RE.test(trimmed)) {
    return { command: start, injected: false, reason: "already has a positional host:port" }
  }

  for (const rule of RULES) {
    if (!rule.match.test(trimmed)) continue

    const isRunScript = RUN_SCRIPT_PREFIX_RE.test(trimmed)
    if (isRunScript && rule.needsDashesThroughRunScript && !/ -- /.test(trimmed)) {
      return {
        command: `${trimmed} -- ${rule.flag}`,
        injected: true,
        reason: `injected \`${rule.flag}\` via -- for npm-run-style command`,
      }
    }
    return {
      command: `${trimmed} ${rule.flag}`,
      injected: true,
      reason: `injected \`${rule.flag}\``,
    }
  }

  return {
    command: start,
    injected: false,
    reason: "no known framework pattern; assuming PORT env works",
  }
}

// Startup log patterns across common frameworks:
//   Vite        ➜  Local:   http://localhost:5173/
//   Next        - Local:        http://localhost:3000
//   Django      Starting development server at http://127.0.0.1:8000/
//   uvicorn     Uvicorn running on http://127.0.0.1:8000
//   Rails       Listening on http://0.0.0.0:3000
//   Express     Listening on port 3000
//   generic     Server running at port 3000
// Host may be:
//   - hostname / IPv4:       [^\s/:@]+
//   - bracketed IPv6:        \[[^\]]+\]   (e.g. http://[::]:4100)
const URL_PORT_RE = /https?:\/\/(?:\[[^\]]+\]|[^\s/:@]+):(\d{2,5})\b/
const LISTEN_PORT_RE =
  /\b(?:listening|running|serving|started|bound|binding|up)\b[^\n]{0,60}?\bport\b[^\n]{0,20}?(\d{2,5})\b/i
const PORT_PREFIX_RE = /\bon\s+port\s+(\d{2,5})\b/i

export function extractBoundPort(text: string): number | null {
  const stripped = stripAnsi(text)
  const match =
    stripped.match(URL_PORT_RE) ??
    stripped.match(LISTEN_PORT_RE) ??
    stripped.match(PORT_PREFIX_RE)
  if (!match) return null
  const n = parseInt(match[1], 10)
  if (!Number.isFinite(n) || n < 1024 || n > 65535) return null
  return n
}

// Minimal ANSI stripper — port-detection runs on every log line so keep it
// cheap. Matches CSI sequences (ESC [ … final-byte).
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
}
