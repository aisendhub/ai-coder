import { invoke } from "@tauri-apps/api/core"

// The desktop shell is a thin Tauri wrapper around the same web app. It marks
// itself with ?desktop=1 on launch; main.tsx persists that in localStorage.
// In a normal browser these helpers fall back to window.open.

const DESKTOP_KEY = "ai-coder:desktop"

export function isDesktopShell(): boolean {
  try {
    if (localStorage.getItem(DESKTOP_KEY) === "1") return true
  } catch {
    // ignore storage errors
  }
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  )
}

export function markDesktopShell(): void {
  try {
    localStorage.setItem(DESKTOP_KEY, "1")
  } catch {
    // ignore storage errors
  }
}

/** Open a URL in the system browser. The Rust command only accepts local
 *  ai-coder URLs; anything else falls back to window.open. */
export async function openExternal(url: string): Promise<void> {
  if (isDesktopShell()) {
    try {
      await invoke("open_external", { url })
      return
    } catch (err) {
      console.error("[desktop] open_external failed", err)
    }
  }
  window.open(url, "_blank", "noopener,noreferrer")
}

/** Restart the local API server. Only the desktop shell can do this; in a
 *  browser the caller falls back to telling the user to run the npm script. */
export async function restartServer(): Promise<string> {
  if (!isDesktopShell()) {
    throw new Error("restart is only available in the desktop app")
  }
  return invoke<string>("restart_server")
}
