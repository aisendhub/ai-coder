import { useEffect, useState, type Dispatch, type SetStateAction } from "react"

/** JSON-serialisable state persisted to localStorage under `key`. On first
 *  render reads the existing value (if any); writes back whenever it changes.
 *  Tolerant to quota / parse errors — falls back to the initial value and
 *  silently skips writes that throw. */
export function usePersistentState<T>(
  key: string,
  initial: T
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    if (typeof window === "undefined") return initial
    try {
      const raw = window.localStorage.getItem(key)
      if (raw == null) return initial
      return JSON.parse(raw) as T
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(state))
    } catch {
      /* quota or disabled storage — drop silently */
    }
  }, [key, state])

  return [state, setState]
}
