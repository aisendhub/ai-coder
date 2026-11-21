#!/usr/bin/env bash
# Make sure the ai-coder stack is up, starting whatever is missing. Called by
# the desktop shell on launch (and usable by hand).
#
#   npm run dev:ensure
#
# - API on :3001 — started detached if it is not answering.
# - Web UI — Vite may have to fall back to another port if :5173 belongs to
#   another project, so we look for the page that identifies itself as
#   ai-coder and record its URL in ~/.local/state/ai-coder/web-url for the
#   desktop launcher.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${AI_CODER_STATE_DIR:-$HOME/.local/state/ai-coder}"
WEB_LOG="${AI_CODER_WEB_LOG:-$HOME/Library/Logs/ai-coder-web.log}"
API="http://127.0.0.1:${PORT:-3001}"
PORTS=(5173 5174 5175 5176 5177 5178 5179 5180)

mkdir -p "$STATE_DIR" "$(dirname "$WEB_LOG")"

# Same descriptor-limit problem for Vite's file watchers when this script runs
# from the desktop app instead of a terminal.
ulimit -n "${AI_CODER_NOFILE_LIMIT:-60000}" 2>/dev/null || true

api_ok() {
  curl -fsS -m 2 "$API/api/health" >/dev/null 2>&1
}

postgrest_ok() {
  curl -fsS -m 2 "http://127.0.0.1:${POSTGREST_PORT:-5434}/" >/dev/null 2>&1
}

postgres_ok() {
  nc -z -w 1 127.0.0.1 "${PGPORT:-5433}" >/dev/null 2>&1
}

is_ai_coder_web() {
  # Vite binds ::1 on macOS, so probe `localhost` (and IPv4 as a fallback)
  # rather than assuming 127.0.0.1.
  local port="$1"
  local host
  for host in localhost 127.0.0.1; do
    if curl -fsS -m 2 "http://${host}:${port}/" 2>/dev/null | grep -q "<title>ai-coder</title>"; then
      return 0
    fi
  done
  return 1
}

find_web() {
  local port
  for port in "${PORTS[@]}"; do
    if is_ai_coder_web "$port"; then
      echo "http://localhost:$port"
      return 0
    fi
  done
  return 1
}

# ── Data layer ─────────────────────────────────────────────────────────────
if ! pgrep -x postgrest >/dev/null 2>&1 && ! postgrest_ok; then
  if postgres_ok; then
    echo "starting PostgREST…"
    PG_LOG="${AI_CODER_PG_LOG:-$HOME/Library/Logs/ai-coder-postgrest.log}"
    cd "$ROOT" || exit 1
    nohup bash scripts/dev-postgrest.sh </dev/null >>"$PG_LOG" 2>&1 &
    disown 2>/dev/null || true
    for _ in $(seq 1 20); do
      postgrest_ok && break
      sleep 0.5
    done
    postgrest_ok || echo "PostgREST did not come up; see $PG_LOG" >&2
  else
    echo "Postgres is not listening on ${PGPORT:-5433}; start it (npm run db:setup covers the first install)" >&2
  fi
fi

# ── API ────────────────────────────────────────────────────────────────────
if ! api_ok; then
  echo "starting the API server…"
  if ! bash "$ROOT/scripts/restart-server.sh"; then
    echo "could not start the API server; see ~/Library/Logs/ai-coder-server.log" >&2
  fi
fi

# ── Web UI ─────────────────────────────────────────────────────────────────
WEB="$(find_web || true)"
if [ -z "$WEB" ]; then
  echo "starting the web UI…"
  echo "--- $(date) starting vite ---" >>"$WEB_LOG"
  cd "$ROOT" || exit 1
  nohup ./node_modules/.bin/vite </dev/null >>"$WEB_LOG" 2>&1 &
  disown 2>/dev/null || true
  for _ in $(seq 1 60); do
    WEB="$(find_web || true)"
    [ -n "$WEB" ] && break
    sleep 0.5
  done
fi

if [ -z "$WEB" ]; then
  echo "web UI did not come up; see $WEB_LOG" >&2
  exit 1
fi

printf '%s\n' "$WEB" >"$STATE_DIR/web-url"
echo "web ui: $WEB"
echo "api:    $API"
api_ok || exit 1
