# ai-coder

Chat UI for a coding agent running on the host VM with per-project working directories and agentic editing.

- **Frontend**: Vite + React + TypeScript + Tailwind v4 + shadcn
- **Backend**: Node + Hono, streams SSE from the Claude Agent SDK
- **Database**: local Postgres + PostgREST (RLS on every table)
- **Auth**: AnyOAuth (Google/GitHub) issuing local PostgREST JWTs
- **LLM**: `@anthropic-ai/claude-agent-sdk` spawning the `claude` CLI (Anthropic or any Anthropic-compatible endpoint, e.g. DeepSeek). An OpenCode runtime is built and tested behind `LLM_PROVIDER=opencode`; it is not the default.

## Docs

- [CLAUDE.md](CLAUDE.md) — conventions and guardrails for anyone (human or agent) working in this repo
- [docs/PLAN.md](docs/PLAN.md) — what we're building and why
- [docs/LLM-PROVIDER.md](docs/LLM-PROVIDER.md) — provider seam and how to add a runtime
- [docs/OPENCODE-DEFAULT.md](docs/OPENCODE-DEFAULT.md) — DeepSeek now, OpenCode as the default runtime later
- [docs/STACK.md](docs/STACK.md) — architecture, migrations, deployment, secrets
- [docs/PROGRESS.md](docs/PROGRESS.md) — live checklist of what's done and next

## Architectural rules worth reading before writing code

- **Client generates primary-key UUIDs** for every row it creates (conversations, messages, comments, …). Server persists with the client-supplied id; realtime echoes upgrade the optimistic row by id match. See [docs/ARCHITECTURE-CLIENT-IDS.md](docs/ARCHITECTURE-CLIENT-IDS.md). This is why comments can link `message_id` deterministically and why a chat created from the URL bar renders before the server responds.
- **RLS is on for every table.** The backend mints a short-lived PostgREST JWT from the AnyOAuth session: `authenticated` for user-scoped queries, `service_role` (BYPASSRLS) for system work.
- **One Agent SDK session per conversation.** `conversations.session_id` is the resume handle.
- **Projects own the cwd.** All conversations in a project inherit `projects.cwd`; task worktrees override per-conversation.

## Local dev

```sh
npm install
cp .env.example .env       # fill in POSTGREST_JWT_SECRET and AnyOAuth credentials
npm run db:setup           # creates ai_coder + auth compat + migrations (once)
npm run dev                # PostgREST :5434 + Hono :3001 + Vite :5173
npm test                   # unit tests (includes the OpenCode adapter)
npm run test:opencode      # OpenCode adapter unit tests only
DEEPSEEK_API_KEY=... OPENCODE_E2E=1 npm run test:e2e   # real DeepSeek turn
```

AnyOAuth owns login. The project must register the exact callback
`http://localhost:5173/auth/callback`. The backend exchanges the session cookie
for a local JWT at `/api/auth/session`; `auth.users` and `auth.uid()` come from
`scripts/local-auth-compat.sql`, so the existing RLS policies keep working.

The LLM still uses the Claude Agent SDK. Run `claude /login` for Claude, or point
it at DeepSeek with the env block in `.env.example` (no runtime change).

## Desktop shell

A thin [Tauri 2](https://tauri.app) shell lives in `desktop/` + `src-tauri/`. It
loads the existing UI from the local server; it does not bundle Node, Postgres,
or PostgREST.

```sh
npm run dev                 # local stack (one terminal)
npm run desktop:dev         # Tauri window (another terminal)
# or
npm run desktop:dev:stack   # both
npm run desktop:build       # .app + .dmg
```

See [desktop/README.md](desktop/README.md) for the launcher, URL detection,
system-browser login handoff, and build output.

## Original Vite template notes

The sections below are the stock Vite + React template documentation. Kept for reference on plugin choices and lint config.

---

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
test change
