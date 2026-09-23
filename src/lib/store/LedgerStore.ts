// PROMPT-06 (2026-09-17) — where ledger rows go, behind one interface
// (DECISIONS-2026-09-15.md Q8 option 2).
//
// LedgerContext.tsx owns the ~70 mutations and all business logic, and only
// ever talks to a LedgerStore. The two live apps then differ in which store
// they wire in, not in LedgerContext.tsx, which must stay byte-identical in
// `personal-ledger` and `shared-finance-ledger` (DIVERGENCE.md).
//
//   LedgerStore
//     ├── localStorageLedgerStore   (personal-ledger; the test app's offline build)
//     └── powerSyncLedgerStore      (shared-finance-ledger, PROMPT-09)
//
// Decisions, and why:
// - `load` may return a value OR a Promise. localStorage resolves
//   synchronously, and LedgerProvider renders the data on the very first
//   render when it does, so the offline app gets no loading flash. Only a
//   Promise puts the provider in a loading state.
// - `load` returns MIGRATED data. migrateLedgerData runs inside the store,
//   as it always has inside the load, so the provider stays ignorant of
//   schema. `null` means "nothing stored"; the provider falls back to
//   defaultLedgerData() exactly as before.
// - `save` is called on EVERY `data` change, undebounced — today's timing.
//   A store that wants batching does it internally.
// - `save` is also called once on the first render, with `prev === next`.
//   That preserves today's write-back of the just-loaded (migrated) data,
//   the zero-risk choice for a refactor. A row-level store sees nothing
//   changed between `prev` and `next` and so writes nothing.
// - `save` receives BOTH states so a row-level store can issue narrow
//   UPDATEs of only the genuinely-changed columns (HARD RULE, Q2). It must
//   log and never throw: a failed write must not take the app down.
// - `subscribe` is optional. The provider replaces `data` with what it is
//   given, and bumps importGeneration when `wholesale` is true, exactly as
//   setData does (APP-KNOWLEDGE §1.6, the first-sync trap). The provider
//   then calls `save(delivered, prev)` like any other change, so a store
//   must recognise data it delivered itself and not write it back.
// - The provider reads the store once, on mount. Swapping the `store` prop
//   later has no effect.

import type { AppDataV2 } from '../../types/ledger'

export interface LedgerStore {
  /** The initial dataset. localStorage resolves synchronously; PowerSync won't. Already migrated. */
  load(): AppDataV2 | null | Promise<AppDataV2 | null>
  /**
   * Persist a change. Receives BOTH states so a row-level store can issue narrow UPDATEs of only the
   * genuinely-changed columns (HARD RULE, Q2). The localStorage store just writes `next`.
   */
  save(next: AppDataV2, prev: AppDataV2): void
  /**
   * Remote/wholesale changes arriving from outside this tab (a sync). Optional: localStorage has
   * none. Called with the full new dataset and whether it is a wholesale replacement (first sync),
   * which the provider treats exactly like setData — i.e. it bumps importGeneration (§1.6).
   * Returns an unsubscribe function.
   */
  subscribe?(onExternalChange: (data: AppDataV2, wholesale: boolean) => void): () => void
  /**
   * PROMPT-16 Part A (2026-09-22) — the user explicitly said "this person is me" (Wallet → People →
   * Set as me, or the sync app's "Which of these is you?"). Optional: the offline store has no
   * notion of identity beyond `primaryPersonId` and ignores it. The sync store needs it because a
   * state diff cannot tell a tap from any other save (MIGRATION-LESSONS §39): tapping the person you
   * already view changes nothing, so a diff-based store wrote no link — and a save that happened to
   * move the view could claim a partner's row with nobody tapping anything. `LedgerContext` calls
   * this BEFORE it changes `primaryPersonId`, so the next `save` carrying that id is the tap.
   */
  setPrimaryPerson?(id: string): void
}

export function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}
