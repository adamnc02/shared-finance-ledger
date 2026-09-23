// SYNC APP ONLY. PROMPT-16 Part E (2026-09-22) — a boot step that has not
// finished after a while says so, and names the likely cause.
//
// Signing a third account into the test app hung for ever on "Preparing this
// device…". `powerSyncDb.disconnectAndClear()` never returned because Listly
// was open in another tab: OPFS locks are per ORIGIN, not per app, every app
// here lives on adamnc02.github.io, and OPFSCoopSyncVFS waits rather than
// failing — no error, no timeout, nothing in the console
// (MIGRATION-LESSONS §64). Auth, RLS, membership and the stream were all
// checked against the live database first, and all four were healthy.
//
// 🚨 The cost was the SILENCE, not the wait. So this changes the MESSAGE,
// never the operation: the clear must still complete, because a half-cleared
// database belonging to the previous user is far worse than a slow one.
// `warnIfSlow` resolves with exactly what the work resolves with, whenever
// that is; `onSlow` fires once, only if the work is still pending after
// `afterMs`. verify-slow-operation.ts pins both halves and the control (no
// deadline: the message never changes).

export const SLOW_CLEAR_AFTER_MS = 10_000

export const SLOW_CLEAR_LINE =
  'Still preparing this device… Another tab or installed app on this site (Listly, or another copy of the ledger) may be holding the local database. Close it and this will continue by itself.'

export function warnIfSlow<T>(work: Promise<T>, afterMs: number, onSlow: () => void): Promise<T> {
  if (!Number.isFinite(afterMs)) return work // no deadline: the control
  let settled = false
  const timer = setTimeout(() => {
    if (!settled) onSlow()
  }, afterMs)
  return work.finally(() => {
    settled = true
    clearTimeout(timer)
  })
}
