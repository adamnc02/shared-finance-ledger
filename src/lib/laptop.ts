// The laptop view's rules: when the app switches to it, and what it
// remembers per device.
//
// At 1024px wide AND 500px tall, and up, the bottom pill becomes a side rail
// (components/Rail.tsx). Below that the app is the phone layout, unchanged.
//
// 🚨 The height clause is what keeps phones out. The manifest does not lock
// orientation, and an iPhone on its side is 844–932px wide, so a width-only
// query would put a phone into the laptop view. A sideways phone is under
// 500px tall; an iPad or a laptop window never is.

export const WIDE_QUERY = '(min-width: 1024px) and (min-height: 500px)'

/**
 * Per-device laptop state, never synced and never part of the ledger data.
 * All three ledger apps are served from one origin, so they share this key
 * on a device that opens more than one of them — harmless for a layout
 * preference, and the reason it must never hold anything else.
 */
export const LAPTOP_STATE_KEY = 'ledger:laptop-state:v1'

interface LaptopState {
  railExpanded?: boolean
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function read(storage: Storage | undefined): LaptopState {
  try {
    const raw = storage?.getItem(LAPTOP_STATE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? (parsed as LaptopState) : {}
  } catch {
    return {}
  }
}

/**
 * The rail is expanded unless this device has collapsed it.
 *
 * 🚨 Absent means EXPANDED, and the value is written only by the collapse
 * button (`writeRailExpanded`), never on load. Listly's first rail stored
 * its default on every first load, so a stored value stopped meaning "the
 * person chose this" — and a later change of default could not tell the two
 * apart. `scripts/verify-laptop-state.ts` holds both properties.
 */
export function readRailExpanded(storage: Storage | undefined = browserStorage()): boolean {
  return read(storage).railExpanded !== false
}

export function writeRailExpanded(expanded: boolean, storage: Storage | undefined = browserStorage()): void {
  try {
    storage?.setItem(LAPTOP_STATE_KEY, JSON.stringify({ ...read(storage), railExpanded: expanded }))
  } catch {
    // Private mode or full storage: the rail still works, it just isn't remembered.
  }
}
