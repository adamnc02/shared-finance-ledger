// State that survives leaving a page and coming back, and resets on a fresh
// app load.
//
// A page's useState is thrown away when the router unmounts it, so a view
// choice made on Home (Show cleared, the horizon, which card is in front)
// snapped back to its default every time another tab was visited. This keeps
// the value in module memory instead: it lives exactly as long as the loaded
// app, so a reload or a relaunch from the Home Screen starts from the
// defaults again.
//
// 🚨 Deliberately NOT localStorage or sessionStorage. Both outlive a reload
// (sessionStorage does on iOS too, for a tab or a Home Screen app restored
// from the background), so the default view would stop being the default.
// And never for ledger data: this is view state, per device, never synced.

import { useCallback, useState, type SetStateAction } from 'react'

const store = new Map<string, unknown>()

/** `useState`, keyed, whose value outlives the component until the app is reloaded. `key` must be unique across the app — prefix it with the page. */
export function useAppSessionState<T>(key: string, initial: T): [T, (value: SetStateAction<T>) => void] {
  const [value, setValue] = useState<T>(() => (store.has(key) ? (store.get(key) as T) : initial))
  const set = useCallback(
    (next: SetStateAction<T>) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        store.set(key, resolved)
        return resolved
      })
    },
    [key],
  )
  return [value, set]
}
