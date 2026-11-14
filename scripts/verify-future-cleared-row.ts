// A cleared row dated in the future: the Current balance and the running
// balance disagree by its amount.
//
// The Personal hero's "Current balance" is computeProjection's
// clearedBalance: the opening balance plus EVERY cleared row, unbounded by
// date. The ledger list's running balance is a fold in date order. A row
// that is cleared but dated next week is counted by the first today and by
// the second only next week, so the two figures on one screen differ by
// exactly that row. On a real backup (14 Nov 2026) a £250 expense dated
// 20 Nov was stored cleared: Current balance £2,062.31, running balance at
// today £2,312.31.
//
// How the row got there: status is set from the date when a row is
// CREATED (today or earlier → cleared, later → pending), and editing the
// date only merged the new date in. A row added as today and then moved to
// next week kept 'cleared'. Auto-clear only ever moves pending → cleared,
// so nothing moved it back.
//
// The fix has two halves, both asserted here:
//  1. reopenIfRedatedToFuture — an edit that moves a cleared row after
//     today makes it pending (LedgerContext.updateTransaction calls it).
//  2. reopenFutureClearedRows — the first step of autoClearDuePayments,
//     so a row already stored that way is reopened on load, and auto-clear
//     clears it again on its own date.
//
// The clock is pinned to the backup's day: computeProjection and the
// generators read the wall clock.
import { readFileSync } from 'node:fs'
import { autoClearDuePayments, reopenFutureClearedRows, reopenIfRedatedToFuture } from '../src/lib/autoClear'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { computeProjection } from '../src/lib/projection'
import { isLedgerTransaction, signedAmount } from '../src/lib/runningBalance'
import { compareByDateSalaryFirst } from '../src/lib/cycleSummary'
import { toLocalIsoDate as toIso } from '../src/lib/date'
import type { AppDataV2, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const FIXTURES = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures'
const BACKUP = `${FIXTURES}/finance-ledger-backup-2026-11-14-mum.json`
const ROW_ID = 'Lmwhrt4j'
const AS_OF_ISO = '2026-11-14'

const PINNED_NOW = new Date(2026, 10, 14, 12).getTime()
const RealDate = Date
class PinnedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(PINNED_NOW)
    else super(...(args as [string | number | Date]))
  }
  static now() {
    return PINNED_NOW
  }
}
globalThis.Date = PinnedDate as unknown as DateConstructor
check('(control) the clock really is pinned', toIso(new Date()), AS_OF_ISO)

const load = (path: string): AppDataV2 => migrateLedgerData(JSON.parse(readFileSync(path, 'utf8')))
const raw = load(BACKUP)

/** Current balance minus the running balance at today, as Home renders them. */
function heroGap(data: AppDataV2): number {
  const payCycle = data.payCycles.find((pc) => pc.personId === data.primaryPersonId)!
  const projection = computeProjection(data, data.primaryPersonId, payCycle, 'current_cycle')
  let running = projection.openingBalance
  let runningAtToday = projection.openingBalance
  for (const t of projection.transactions.filter(isLedgerTransaction).sort(compareByDateSalaryFirst)) {
    running += signedAmount(t)
    if (t.date <= AS_OF_ISO) runningAtToday = running
  }
  // Only the rows dated today or earlier that are still pending separate the
  // two figures legitimately; after auto-clear there are none.
  return Math.round((projection.clearedBalance - runningAtToday) * 100) / 100
}

// ── The real row, and the control ──
const row = raw.transactions.find((t) => t.id === ROW_ID)
check('(control) the backup holds the £250 row, cleared and dated 20 Nov', row && { date: row.date, amount: row.amount, status: row.status }, { date: '2026-11-20', amount: 250, status: 'cleared' })
check('(control) without the fix, the Current balance is £250 below the running balance', heroGap(autoClearWithoutReopen(raw)), -250)

/** autoClearDuePayments as it ran before the fix: every step except the reopen. */
function autoClearWithoutReopen(data: AppDataV2): AppDataV2 {
  const futureCleared = data.transactions.filter((t) => t.status === 'cleared' && t.date > AS_OF_ISO).map((t) => t.id)
  const settled = autoClearDuePayments(data, new Date())
  return { ...settled, transactions: settled.transactions.map((t) => (futureCleared.includes(t.id) ? { ...t, status: 'cleared' } : t)) }
}

// ── Half 2: reopened on load ──
const healed = autoClearDuePayments(raw, new Date())
check('the row is pending after auto-clear', healed.transactions.find((t) => t.id === ROW_ID)?.status, 'pending')
check('no cleared row is dated after today', healed.transactions.filter((t) => t.status === 'cleared' && t.date > AS_OF_ISO).length, 0)
check('the hero and the running balance agree', heroGap(healed), 0)
check('a second pass changes nothing (no write loop)', autoClearDuePayments(healed, new Date()) === healed, true)
const before = new Map(raw.transactions.map((t) => [t.id, t.status]))
check(
  'no other stored row changed status except pending → cleared for rows already due',
  healed.transactions.filter((t) => before.has(t.id) && t.id !== ROW_ID && t.status !== before.get(t.id) && !(before.get(t.id) === 'pending' && t.date <= AS_OF_ISO)).map((t) => t.id),
  [],
)
// On its own date the row clears again.
const onTheDay = autoClearDuePayments(healed, new Date(2026, 10, 20, 12))
check('on 20 Nov auto-clear clears it again', onTheDay.transactions.find((t) => t.id === ROW_ID)?.status, 'cleared')

// No write on load for a ledger with nothing to reopen: the helper returns
// the same reference, so the sync store sees no change.
for (const f of ['finance-ledger-backup-2026-09-15.json', 'finance-ledger-backup-2026-09-22-PROD.json', 'finance-ledger-backup-2026-10-06-mum.json', 'finance-ledger-backup-2026-11-08-mum.json']) {
  const d = load(`${FIXTURES}/${f}`)
  const day = f.match(/\d{4}-\d{2}-\d{2}/)![0]
  check(`${f}: nothing to reopen, same reference`, reopenFutureClearedRows(d, day) === d, true)
}

// ── Half 1: an edit that moves the date ──
const base: Transaction = { id: 'x', date: '2026-11-14', amount: 10, direction: 'out', categoryId: 'c', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'p' }
check('cleared, moved to next week → pending', reopenIfRedatedToFuture({ ...base, date: '2026-11-20' }, { date: '2026-11-20' }, AS_OF_ISO).status, 'pending')
check('cleared, moved to yesterday → stays cleared', reopenIfRedatedToFuture({ ...base, date: '2026-11-13' }, { date: '2026-11-13' }, AS_OF_ISO).status, 'cleared')
check('cleared, moved to today → stays cleared', reopenIfRedatedToFuture(base, { date: AS_OF_ISO }, AS_OF_ISO).status, 'cleared')
check('pending, moved to next week → stays pending', reopenIfRedatedToFuture({ ...base, status: 'pending', date: '2026-11-20' }, { date: '2026-11-20' }, AS_OF_ISO).status, 'pending')
check('an edit without a date leaves status alone', reopenIfRedatedToFuture(base, { note: 'x' }, AS_OF_ISO) === base, true)

if (failures > 0) {
  console.log(`\nFAIL: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
