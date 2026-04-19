// Lightweight Shiki wrapper:
// - Fine-grained core (no full-language bundle pulled in)
// - JS regex engine (no Oniguruma WASM)
// - Themes loaded once; languages lazy-loaded on first use and cached as
//   separate chunks via static dynamic imports
// - Singleton highlighter shared across the app

import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

let highlighterPromise: Promise<HighlighterCore> | null = null
const loadedLangs = new Set<string>()
const loadingLangs = new Map<string, Promise<void>>()

const THEME_LIGHT = "github-light"
const THEME_DARK = "github-dark"

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [
        import("shiki/themes/github-light.mjs"),
        import("shiki/themes/github-dark.mjs"),
      ],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    })
  }
  return highlighterPromise
}

// Static map of language loaders. Each entry becomes its own lazy chunk,
// fetched only when that language is first highlighted.
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
}

// Map common file extensions → Shiki language id. Returning null skips highlighting.
export function languageForPath(path: string): string | null {
  if (path.toLowerCase().endsWith("dockerfile")) return "docker"
  const ext = path.split(".").pop()?.toLowerCase()
  if (!ext) return null
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    jsonc: "jsonc",
    md: "markdown",
    mdx: "mdx",
    css: "css",
    scss: "scss",
    html: "html",
    svg: "xml",
    xml: "xml",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    php: "php",
    sql: "sql",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    lua: "lua",
    vue: "vue",
    svelte: "svelte",
  }
  const lang = map[ext]
  return lang && lang in LANG_LOADERS ? lang : null
}

async function ensureLanguage(lang: string): Promise<boolean> {
  if (loadedLangs.has(lang)) return true
  const inFlight = loadingLangs.get(lang)
  if (inFlight) {
    await inFlight
    return loadedLangs.has(lang)
  }
  const loader = LANG_LOADERS[lang]
  if (!loader) return false
  const task = (async () => {
    try {
      const hl = await getHighlighter()
      const mod = (await loader()) as { default: Parameters<HighlighterCore["loadLanguage"]>[0] }
      await hl.loadLanguage(mod.default)
      loadedLangs.add(lang)
    } catch (err) {
      console.warn(`[highlight] failed to load language "${lang}":`, err)
    } finally {
      loadingLangs.delete(lang)
    }
  })()
  loadingLangs.set(lang, task)
  await task
  return loadedLangs.has(lang)
}

/** Highlight `code` in the given language. Returns sanitized HTML for both
 *  light and dark themes (Shiki's dual-theme output uses CSS vars driven by
 *  `.dark` on a parent). Returns null if the language isn't supported. */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
  const ok = await ensureLanguage(lang)
  if (!ok) return null
  const hl = await getHighlighter()
  return hl.codeToHtml(code, {
    lang,
    themes: { light: THEME_LIGHT, dark: THEME_DARK },
    defaultColor: false, // emit CSS vars so the consumer controls theme switching
  })
}
