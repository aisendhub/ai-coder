#!/usr/bin/env bash
# Restart the ai-coder API server (port 3001) without touching PostgREST or
# vite. Used by the desktop shell's "Restart server" action and runnable by
# hand:
#
#   npm run server:restart
#
# If the server is being watched by `tsx watch` (the normal `npm run dev`
# stack) we just touch the entry file, which makes the watcher respawn it —
# no duplicate processes. Otherwise we stop whatever owns the port and start
# a detached server, logging to ~/Library/Logs/ai-coder-server.log.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3001}"
LOG="${AI_CODER_SERVER_LOG:-$HOME/Library/Logs/ai-coder-server.log}"

healthy() {
  curl -fsS -m 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1
}

wait_for_health() {
  for _ in $(seq 1 40); do
    if healthy; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

if healthy; then
  echo "ai-coder server already healthy on :${PORT}"
  exit 0
fi

mkdir -p "$(dirname "$LOG")"

# `tsx watch` from this repo no longer owns a working server: stop it so it
# cannot fight the replacement for the port, then restart with a watcher of
# our own so editing server files still reloads.
for pid in $(pgrep -f "tsx.*watch.*server/index.ts" || true); do
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  if [ "$cwd" = "$ROOT" ]; then
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 1
for pid in $(pgrep -f "tsx.*watch.*server/index.ts" || true); do
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  if [ "$cwd" = "$ROOT" ]; then
    kill -9 "$pid" 2>/dev/null || true
  fi
done

# Stop whatever currently owns the API port.
PIDS="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN || true)"
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null || true
  sleep 1
  PIDS="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN || true)"
  if [ -n "$PIDS" ]; then
    kill -9 $PIDS 2>/dev/null || true
    sleep 1
  fi
fi

cd "$ROOT"

if [ ! -x node_modules/.bin/tsx ]; then
  echo "tsx not found in $ROOT; run npm install first" >&2
  exit 1
fi

echo "--- $(date) restarting ai-coder server on :${PORT} ---" >>"$LOG"
nohup ./node_modules/.bin/tsx watch server/index.ts >>"$LOG" 2>&1 &

if wait_for_health; then
  echo "ai-coder server is up on :${PORT} (log: ${LOG})"
  exit 0
fi

echo "ai-coder server did not come up; see ${LOG}" >&2
tail -n 20 "$LOG" >&2 || true
exit 1
