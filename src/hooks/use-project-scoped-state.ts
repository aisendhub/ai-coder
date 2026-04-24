import { useEffect, useState, type Dispatch, type SetStateAction } from "react"

/** Same contract as `usePersistentState`, but the storage key is scoped
 *  to `(projectId, subKey)` so each project gets its own value.
 *
 *  Re-reads from localStorage whenever `projectId` changes — usePersistentState
 *  only reads on mount, so changing its key would strand the old value on
 *  the new key. This hook flips state correctly on project switch.
 *
 *  Null projectId (no active project yet) falls back to the initial value
 *  without touching storage, so we don't pollute a `null` key bucket. */
export function useProjectScopedState<T>(
  projectId: string | null,
  subKey: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const key = projectId ? `ai-coder:p:${projectId}:${subKey}` : null

  const [state, setState] = useState<T>(() => readInitial(key, initial))

  // When projectId changes, pull the value for the new project from storage.
  useEffect(() => {
    setState(readInitial(key, initial))
    // `initial` is captured intentionally — we don't want consumers needing
    // to memoize it to avoid resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (!key) return
    try {
      window.localStorage.setItem(key, JSON.stringify(state))
    } catch {
      /* quota / disabled storage — drop silently */
    }
  }, [key, state])

  return [state, setState]
}

function readInitial<T>(key: string | null, initial: T): T {
  if (!key || typeof window === "undefined") return initial
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return initial
    return JSON.parse(raw) as T
  } catch {
    return initial
  }
}
