# ai-coder desktop (Tauri)

Thin Tauri 2 shell. It does **not** bundle the Node server, Postgres, or
PostgREST. It opens a native window, finds the local ai-coder server, and loads
the existing web UI from it.

```
Tauri window (WKWebView / WebView2 / WebKitGTK)
  └─ http://localhost:5173 or :3001
       └─ the same Hono + Vite app you already run
```

## Run

Start the local stack in one terminal:

```sh
npm run dev          # Postgres :5433, PostgREST :5434, Hono :3001, Vite :5173
```

Start the desktop shell in another:

```sh
npm run desktop:dev
```

Or start both:

```sh
npm run desktop:dev:stack
```

The launcher probes `:5173` first, then `:3001` (and `127.0.0.1` variants). It
remembers the last working URL. You can also type a URL and press Connect.

## Build

```sh
npm run desktop:build        # release .app + .dmg
npm run desktop:build:debug  # debug bundle
npm run desktop:check        # cargo check only
```

Artifacts land in `src-tauri/target/release/bundle/` (or `debug/bundle/`).

The built app still expects the local server to be running. That is the
tradeoff of the thin-shell design: no Node/Postgres packaging, but the app is
not a one-click standalone install.

## Login

The desktop app does **not** run Google OAuth inside the webview. It uses the
system browser:

1. The app calls `POST /api/auth/desktop/start` and gets a short-lived nonce.
2. It opens `/auth/desktop/login/<provider>?nonce=…` in the default browser via
   the Tauri `open_external` command.
3. The system browser completes AnyOAuth + Google, then lands on
   `/auth/desktop/complete`, which marks the nonce complete.
4. The app polls `/api/auth/desktop/status`, exchanges the one-time token at
   `/api/auth/desktop/exchange`, and receives its own signed desktop session
   cookie.
5. Reloads use `/api/auth/session` with that cookie.

The `open_external` command only accepts `localhost` / `127.0.0.1` URLs.
The system-browser tab can be closed once it says “Signed in”.

If the handoff page is not reached, verify the app URL and the
`desktop-remote` Tauri capability both use the same host (`localhost` or
`127.0.0.1`).

## What is intentionally not here

- No bundled Node runtime, `node-pty`, or OpenCode SQLite.
- No bundled Postgres/PostgREST.
- No server lifecycle management, auto-update, code signing, or notarization
  yet.
- No Tauri IPC in the web page (`withGlobalTauri` is off). The UI is a plain
  web app talking to its own local server.

## Cross-platform

The Tauri config is platform-neutral. Build on macOS for `.app`/`.dmg`, on
Windows for `.msi`/`.exe`, and on Linux for `.deb`/`.AppImage`. Only the macOS
build has been run so far.
