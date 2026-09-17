// The offline LedgerStore: a thin wrapper over lib/ledgerStorage.ts's
// existing load/save, not a rewrite. Same key, same migration, same
// JSON.stringify format, same error handling (log, never throw).
//
// 🚨 `personal-ledger` has real, unbacked-up data under
// 'ledger:app-data-v2:v1'. verify-ledger-store.ts proves this store reads
// and writes that key byte-for-byte as before.

import { STORAGE_KEY, loadLedgerData, saveLedgerData } from '../ledgerStorage'
import type { LedgerStore } from './LedgerStore'

export interface LocalStorageLedgerStoreOptions {
  /** Defaults to the browser's `localStorage`, looked up on each call, never at import. */
  storage?: Storage
  /** Defaults to 'ledger:app-data-v2:v1'. */
  key?: string
}

export function createLocalStorageLedgerStore({ storage, key = STORAGE_KEY }: LocalStorageLedgerStoreOptions = {}): LedgerStore {
  return {
    load: () => loadLedgerData(storage, key),
    save: (next) => saveLedgerData(next, storage, key),
  }
}

export const localStorageLedgerStore = createLocalStorageLedgerStore()
