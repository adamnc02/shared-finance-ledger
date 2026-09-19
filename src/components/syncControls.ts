// SYNC APP ONLY. What the boot sequence (SyncRoot) offers the screens inside
// it. Its own module so AccountModal doesn't have to import SyncRoot, which
// imports AccountModal (a cycle through a lazily-loaded module).

import { createContext, useContext } from 'react'

export interface SyncControls {
  userId: string
  email: string
  householdId: string
  /** Clear this device's copy and boot again (after joining a household, or a household change). */
  restart: (line?: string) => void
  /** Disconnect and reconnect: the stream subscription is kept, so this re-requests it. */
  forceSync: () => Promise<void>
}

export const SyncControlsContext = createContext<SyncControls | null>(null)

export function useSyncControls(): SyncControls {
  const ctx = useContext(SyncControlsContext)
  if (!ctx) throw new Error('useSyncControls must be used inside SyncRoot')
  return ctx
}
