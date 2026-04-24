# ai-coder

Chat UI for Claude Code running on the host VM with per-project working directories and agentic editing.

- **Frontend**: Vite + React + TypeScript + Tailwind v4 + shadcn
- **Backend**: Node + Hono, streams SSE from the Claude Agent SDK
- **Database**: Supabase Postgres (RLS on every table)
- **LLM**: `@anthropic-ai/claude-agent-sdk` spawning the `claude` CLI

## Docs

- [CLAUDE.md](CLAUDE.md) — conventions and guardrails for anyone (human or agent) working in this repo
- [docs/PLAN.md](docs/PLAN.md) — what we're building and why
- [docs/STACK.md](docs/STACK.md) — architecture, migrations, deployment, secrets
- [docs/PROGRESS.md](docs/PROGRESS.md) — live checklist of what's done and next

## Architectural rules worth reading before writing code

- **Client generates primary-key UUIDs** for every row it creates (conversations, messages, comments, …). Server persists with the client-supplied id; realtime echoes upgrade the optimistic row by id match. See [docs/ARCHITECTURE-CLIENT-IDS.md](docs/ARCHITECTURE-CLIENT-IDS.md). This is why comments can link `message_id` deterministically and why a chat created from the URL bar renders before the server responds.
- **RLS is on for every table.** Service-role key server-side only; anon key client-side.
- **One Agent SDK session per conversation.** `conversations.session_id` is the resume handle.
- **Projects own the cwd.** All conversations in a project inherit `projects.cwd`; task worktrees override per-conversation.

## Local dev

```sh
npm install
claude /login              # uses your Claude Code subscription for the Agent SDK
npm run dev                # Vite :5173 + Hono :3001
npm test                   # resolver tests + any others in server/*.test.ts
```

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
