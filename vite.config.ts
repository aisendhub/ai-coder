import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [
          // Order matters: decorators MUST run before class-properties.
          ["@babel/plugin-proposal-decorators", { version: "legacy" }],
          ["@babel/plugin-transform-class-properties", { loose: true }],
        ],
      },
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // BACKEND_PORT lets `npm run start` point Vite at a non-default backend port
  // (3082) so it can run side-by-side with `npm run dev` (3001) without
  // colliding. Falls back to 3001 for the default `npm run dev` flow.
  // VITE_PORT overrides the dev-server port for either flow.
  server: {
    port: process.env.VITE_PORT ? Number(process.env.VITE_PORT) : undefined,
    // Bind IPv4 localhost explicitly. The default can land on ::1 only, which
    // lets another project's dev server take 127.0.0.1:5173 at the same time,
    // and then `localhost` resolves to whichever one the client picks.
    host: process.env.VITE_HOST ?? "127.0.0.1",
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.BACKEND_PORT ?? "3001"}`,
        // Keep the browser origin so AnyOAuth's origin check sees
        // http://localhost:5173 on /api/auth/session.
        changeOrigin: false,
        ws: true,
      },
      "/auth": {
        target: `http://localhost:${process.env.BACKEND_PORT ?? "3001"}`,
        changeOrigin: false,
      },
      "/rest/v1": {
        target: process.env.POSTGREST_URL ?? "http://127.0.0.1:5434",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/rest\/v1/, ""),
      },
    },
  },
})
