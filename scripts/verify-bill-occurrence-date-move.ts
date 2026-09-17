// 2026-09-16 (Adam-reported) — moving a SINGLE occurrence's date.
//
// Two real, reproduced bugs, one root family. Reported against Bills;
// confirmed identical for recurring Transactions and recurring Transfers,
// because all three share one generator and one reconciler.
//
// B1 — the moved date never reached "Manage upcoming payments".
//   scheduledTemplateDates deliberately ignores occurrenceOverrides (a
//   paused date must still be listed so it can be UNchecked, which
//   walkOccurrences would drop) — but it ignored the override's `date`
//   too, so a moved occurrence kept displaying its old slot. Bills and
//   Transfers render that list; recurring Transactions render their
//   "Next 12 upcoming" panel from templateOccurrencePreviews, which is
//   override-aware, which is why only two of the three showed it.
//
// B2 — a SECOND move duplicated the materialized transaction. 🚨
//   reconcileRecurringTemplateTransactions re-found its stored row by
//   matching either end of a single move
//   (`o.originalDate === t.date || o.date === t.date`). After a second
//   move there are three dates and the intermediate one is recorded
//   nowhere: the row stranded at 5 Jul while the override read
//   {originalDate: 1 Jul, date: 9 Jul}. Nothing reconciled it, nothing
//   deleted it, and dedupeKey (`sourceType:sourceId:date`) saw 9 Jul as
//   unseen — so autoClearDuePayments materialized the SAME occurrence a
//   second time. Two cleared rows, both counting against the balance.
//   Moving back to the original date duplicated too.
//
// The fix: Transaction.occurrenceOriginalDate stamps the occurrence's
// natural slot onto the row, so identity no longer depends on a mutable
// date. dedupeKey is deliberately NOT changed — once the reconciler
// reliably moves the stored row onto the override's current date, the
// date-based key matches again, which keeps the blast radius off the key
// every generator in the app shares.

import { autoClearDuePayments } from '../src/lib/autoClear'
import { applyTemplateSingleOccurrenceDateChange, applyTemplateSingleOccurrenceAmountChange, setPausedTemplateOccurrences, scheduledTemplateDates } from '../src/lib/schedule'
import { computeProjection } from '../src/lib/projection'
import { defaultCategories } from '../src/lib/categories'
import { BILLS_CATEGORY_ID } from '../src/types/ledger'
import type { AppDataV2, PayCycleConfig, Person, Pot, RecurringTemplate, SavingsPot, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const payCycle: PayCycleConfig = {
  personId: 'me',
  openingBalance: 1000,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 1,
}
const person: Person = { id: 'me', name: 'Me', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [] }
const savingsPot: SavingsPot = { id: 'sp1', personId: 'me', name: 'Rainy day', openingBalance: 0, openingDate: '2026-01-01', active: true, color: '#888', interestMethod: { type: 'none' } as never }
const pot: Pot = { id: 'pot1', personId: 'me', name: 'Bills pot', openingBalance: 500, openingDate: '2026-01-01', active: true, color: '#999' }

const common = {
  categoryId: BILLS_CATEGORY_ID,
  paymentMethod: 'direct_debit' as const,
  frequency: 'monthly' as const,
  anchorDate: '2026-06-01',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  active: true,
}

const bill: RecurringTemplate = { ...common, id: 'bill-1', name: 'Gym', amount: 37, location: 'personal', kind: 'bill' }
const txn: RecurringTemplate = { ...common, id: 'txn-1', name: 'Netflix', amount: 12, location: 'personal', kind: 'transaction', recurringTransactionType: 'expense' }
const xfer: RecurringTemplate = {
  ...common,
  id: 'xfer-1',
  name: 'To savings',
  amount: 50,
  location: 'personal',
  kind: 'transfer',
  transferFrom: { type: 'personal' },
  transferTo: { type: 'savings', savingsPotId: 'sp1' },
}

// 2026-07-10 — the 1 Jul occurrence has already materialized into a
// stored cleared row, which is the precondition for B2. A move on a
// still-future occurrence goes through walkOccurrences and was never
// affected; that case is asserted separately below.
const asOf = new Date(2026, 6, 10)

function dataWith(templates: RecurringTemplate[], extra: Partial<AppDataV2> = {}): AppDataV2 {
  return {
    people: [person],
    categories: defaultCategories(),
    recurringTemplates: templates,
    loans: [],
    creditCards: [],
    transactions: [],
    payCycles: [payCycle],
    pensions: [],
    scenarios: [],
    primaryPersonId: 'me',
    savingsPots: [savingsPot],
    pots: [pot],
    ...extra,
  } as AppDataV2
}
const rowsFor = (d: AppDataV2, id: string): string[] => d.transactions.filter((t) => t.sourceId === id).map((t) => t.date).sort()
const move = (tpl: RecurringTemplate, to: string, slot: string): RecurringTemplate => ({ ...tpl, ...applyTemplateSingleOccurrenceDateChange(tpl, to, slot) })

// ─────────────────────────────────────────────────────────────────────
// B2 — the core repro, run identically against all three surfaces.
// ─────────────────────────────────────────────────────────────────────
for (const tpl of [bill, txn, xfer]) {
  const kind = tpl.kind!
  const s0 = autoClearDuePayments(dataWith([tpl]), asOf)
  check(`[${kind}] materializes both due occurrences`, rowsFor(s0, tpl.id), ['2026-06-01', '2026-07-01'])

  const t1 = move(tpl, '2026-07-05', '2026-07-01')
  const s1 = autoClearDuePayments({ ...s0, recurringTemplates: [t1] }, asOf)
  check(`[${kind}] move 1 (1 Jul -> 5 Jul) moves the row, no duplicate`, rowsFor(s1, tpl.id), ['2026-06-01', '2026-07-05'])

  // THE BUG: before the fix this returned three rows.
  const t2 = move(t1, '2026-07-09', '2026-07-01')
  const s2 = autoClearDuePayments({ ...s1, recurringTemplates: [t2] }, asOf)
  check(`[${kind}] move 2 (-> 9 Jul) still ONE row — the reported duplicate`, rowsFor(s2, tpl.id), ['2026-06-01', '2026-07-09'])

  // Proves the fix isn't merely "handles two moves".
  const t3 = move(t2, '2026-07-07', '2026-07-01')
  const s3 = autoClearDuePayments({ ...s2, recurringTemplates: [t3] }, asOf)
  check(`[${kind}] move 3 (-> 7 Jul) still ONE row`, rowsFor(s3, tpl.id), ['2026-06-01', '2026-07-07'])

  // Moving back to the original slot duplicated too, so "undo" was not a
  // workaround — it has its own assertion rather than riding on move 3.
  const tBack = move(t3, '2026-07-01', '2026-07-01')
  const sBack = autoClearDuePayments({ ...s3, recurringTemplates: [tBack] }, asOf)
  check(`[${kind}] moving back to the original date leaves ONE row`, rowsFor(sBack, tpl.id), ['2026-06-01', '2026-07-01'])

  check(`[${kind}] idempotent — re-running changes nothing further`, autoClearDuePayments(sBack, asOf) === sBack, true)

  // A row count alone would miss a duplicate that landed in another
  // cycle, so assert the money too. `three_cycles` rather than
  // `this_cycle` so the horizon definitely spans every date the moves
  // reach; both balances are asserted because a duplicate cleared row
  // shifts clearedBalance, and a duplicate pending one shifts only
  // projectedBalance.
  const before = computeProjection(s1, 'me', payCycle, 'three_cycles', asOf)
  const after = computeProjection(s2, 'me', payCycle, 'three_cycles', asOf)
  check(`[${kind}] cleared balance is unchanged by the second move`, after.clearedBalance, before.clearedBalance)
  check(`[${kind}] projected balance is unchanged by the second move`, after.projectedBalance, before.projectedBalance)
  check(`[${kind}] the balance actually moved when the occurrence cleared (guards the above)`, before.clearedBalance !== payCycle.openingBalance, true)
}

// ─────────────────────────────────────────────────────────────────────
// B3 — moving a CLEARED occurrence into the future must un-clear it.
//
// Adam, UAT 2026-09-16, on all three surfaces: "I created a new bill with
// a due date of yesterday, everything fine, shows up in cleared and
// affects current card balance. I moved the first payment to today, again
// all works correctly. I then moved the same payment to tomorrow, and it
// was still being counted as a cleared payment, despite the date being in
// the future now."
//
// Step 1 of autoClearDuePayments only ever moved a row pending -> cleared
// once its date arrived; nothing did the reverse. The money had
// supposedly already left the account on a date that hasn't happened.
// ─────────────────────────────────────────────────────────────────────
const yesterdayTemplates = [bill, txn, xfer].map((t) => ({ ...t, anchorDate: '2026-07-09' }))
for (const tpl of yesterdayTemplates) {
  const kind = tpl.kind!
  const row = (d: AppDataV2) => d.transactions.find((t) => t.sourceId === tpl.id)
  const openingBalance = payCycle.openingBalance

  // asOf is 2026-07-10, so the anchor (9 Jul) is "yesterday".
  const s0 = autoClearDuePayments(dataWith([tpl]), asOf)
  check(`[${kind}] B3 — due yesterday: exactly one cleared row`, [row(s0)?.date, row(s0)?.status], ['2026-07-09', 'cleared'])
  check(`[${kind}] B3 — ...and it has left the cleared balance`, computeProjection(s0, 'me', payCycle, 'three_cycles', asOf).clearedBalance < openingBalance, true)

  const toToday = { ...tpl, ...applyTemplateSingleOccurrenceDateChange(tpl, '2026-07-10', '2026-07-09') }
  const s1 = autoClearDuePayments({ ...s0, recurringTemplates: [toToday] }, asOf)
  check(`[${kind}] B3 — moved to TODAY: still cleared (today counts as due)`, [row(s1)?.date, row(s1)?.status], ['2026-07-10', 'cleared'])

  // THE BUG.
  const toTomorrow = { ...toToday, ...applyTemplateSingleOccurrenceDateChange(toToday, '2026-07-11', '2026-07-09') }
  const s2 = autoClearDuePayments({ ...s1, recurringTemplates: [toTomorrow] }, asOf)
  check(`[${kind}] B3 — moved to TOMORROW: reverts to pending`, [row(s2)?.date, row(s2)?.status], ['2026-07-11', 'pending'])
  check(`[${kind}] B3 — ...and the cleared balance is whole again`, computeProjection(s2, 'me', payCycle, 'three_cycles', asOf).clearedBalance, openingBalance)
  check(`[${kind}] B3 — ...but it is still coming, so the projection still includes it`, computeProjection(s2, 'me', payCycle, 'three_cycles', asOf).projectedBalance < openingBalance, true)
  check(`[${kind}] B3 — no duplicate was created by the un-clear`, rowsFor(s2, tpl.id).length, 1)

  // Back into the past — Step 1 must re-clear it.
  const backToPast = { ...toTomorrow, ...applyTemplateSingleOccurrenceDateChange(toTomorrow, '2026-07-09', '2026-07-09') }
  const s3 = autoClearDuePayments({ ...s2, recurringTemplates: [backToPast] }, asOf)
  check(`[${kind}] B3 — moved back into the past: clears again`, [row(s3)?.date, row(s3)?.status], ['2026-07-09', 'cleared'])
  check(`[${kind}] B3 — round trip returns the exact original balance`, computeProjection(s3, 'me', payCycle, 'three_cycles', asOf).clearedBalance, computeProjection(s0, 'me', payCycle, 'three_cycles', asOf).clearedBalance)
  check(`[${kind}] B3 — idempotent`, autoClearDuePayments(s3, asOf) === s3, true)

  // SELF-HEAL: a row already stranded by this bug (cleared, future-dated,
  // with the override already pointing at that same date, so nothing
  // changes this pass) must still be corrected. This is the shape of
  // Adam's own test data at the moment he reported it — without this, the
  // fix would only help people who move the date yet again.
  const stranded: AppDataV2 = {
    ...s2,
    transactions: s2.transactions.map((t) => (t.sourceId === tpl.id ? { ...t, status: 'cleared' as const } : t)),
    recurringTemplates: [toTomorrow],
  }
  const healed = autoClearDuePayments(stranded, asOf)
  check(`[${kind}] B3 — an ALREADY-stranded row self-heals with no further edit`, [row(healed)?.date, row(healed)?.status], ['2026-07-11', 'pending'])
}

// A future-dated occurrence that was never cleared is left alone, and a
// past-dated cleared one is not disturbed — guards against over-reach.
const untouched = autoClearDuePayments(dataWith([bill]), asOf)
check('a normal past cleared row is not un-cleared', untouched.transactions.find((t) => t.date === '2026-07-01')?.status, 'cleared')

// ─────────────────────────────────────────────────────────────────────
// B1 — scheduledTemplateDates ("Manage upcoming payments") display.
// ─────────────────────────────────────────────────────────────────────
const movedBill = move(bill, '2026-07-05', '2026-07-01')
const mup = scheduledTemplateDates(movedBill, new Date(2026, 5, 1), new Date(2026, 7, 1))
check('B1 — MUP shows the MOVED date as .date', mup.find((r) => r.originalDate === '2026-07-01')?.date, '2026-07-05')
check('B1 — ...while .originalDate stays the natural override key', mup.map((r) => r.originalDate), ['2026-06-01', '2026-07-01', '2026-08-01'])

// The pause picker's whole reason for ignoring overrides: a paused date
// must still be listed so it can be unchecked. That must survive B1.
const pausedBill: RecurringTemplate = { ...bill, ...setPausedTemplateOccurrences(bill, ['2026-06-01', '2026-07-01', '2026-08-01'], ['2026-07-01']) }
check(
  'B1 — a PAUSED occurrence is still listed (the reason overrides are ignored)',
  scheduledTemplateDates(pausedBill, new Date(2026, 5, 1), new Date(2026, 7, 1)).map((r) => r.originalDate),
  ['2026-06-01', '2026-07-01', '2026-08-01'],
)

// A followsPayday transfer is the only real case where resolved != natural.
// The moved date must still be payday-resolved, i.e. the override is
// applied BEFORE resolveTemplateOccurrenceDate, not instead of it —
// matching walkOccurrences exactly.
const paydayXfer: RecurringTemplate = { ...xfer, id: 'xfer-pd', followsPayday: true }
const movedPaydayXfer = move(paydayXfer, '2026-07-05', '2026-07-01')
const pdRow = scheduledTemplateDates(movedPaydayXfer, new Date(2026, 5, 1), new Date(2026, 7, 1), payCycle).find((r) => r.originalDate === '2026-07-01')
check('B1 — a followsPayday transfer resolves the MOVED date to the next payday', pdRow?.date, '2026-07-28')

// ─────────────────────────────────────────────────────────────────────
// Interactions — an occurrence carrying more than just a date move.
// ─────────────────────────────────────────────────────────────────────
const amountThenDate: RecurringTemplate = {
  ...bill,
  id: 'bill-both',
  ...applyTemplateSingleOccurrenceAmountChange(bill, 99, '2026-07-01'),
}
const amountThenDateMoved = move(amountThenDate, '2026-07-05', '2026-07-01')
const bothMoved = move(amountThenDateMoved, '2026-07-09', '2026-07-01')
const bothBase = autoClearDuePayments(dataWith([{ ...bill, id: 'bill-both' }]), asOf)
const bothAfter = autoClearDuePayments({ ...bothBase, recurringTemplates: [bothMoved] }, asOf)
const bothRow = bothAfter.transactions.filter((t) => t.sourceId === 'bill-both' && t.date === '2026-07-09')
check('amount override + two date moves — ONE row', bothRow.length, 1)
check('...at the overridden amount', bothRow[0]?.amount, 99)

// The shape of the UAT 2026-09-11 bill-pause-after-amount-override bug,
// applied to a date move instead.
const movedThenPaused: RecurringTemplate = { ...bothMoved, ...setPausedTemplateOccurrences(bothMoved, ['2026-06-01', '2026-07-01', '2026-08-01'], ['2026-07-01']) }
check('pausing a previously-moved occurrence keeps ONE override entry for its slot', movedThenPaused.occurrenceOverrides?.filter((o) => o.originalDate === '2026-07-01').length, 1)
check('...and that entry retains its moved date and amount', [movedThenPaused.occurrenceOverrides?.find((o) => o.originalDate === '2026-07-01')?.date, movedThenPaused.occurrenceOverrides?.find((o) => o.originalDate === '2026-07-01')?.amount], ['2026-07-09', 99])
const unpaused: RecurringTemplate = { ...movedThenPaused, ...setPausedTemplateOccurrences(movedThenPaused, ['2026-06-01', '2026-07-01', '2026-08-01'], []) }
const afterUnpause = autoClearDuePayments({ ...bothAfter, recurringTemplates: [unpaused] }, asOf)
check('unpausing it leaves ONE row, still at the moved date', rowsFor(afterUnpause, 'bill-both'), ['2026-06-01', '2026-07-09'])

// ─────────────────────────────────────────────────────────────────────
// A move on a NOT-YET-materialized occurrence — unaffected by either
// bug, and must stay that way.
// ─────────────────────────────────────────────────────────────────────
const earlyAsOf = new Date(2026, 5, 15) // 15 Jun — 1 Jul hasn't happened yet
const futureBase = autoClearDuePayments(dataWith([bill]), earlyAsOf)
check('a future occurrence has not materialized yet', rowsFor(futureBase, 'bill-1'), ['2026-06-01'])
const futureMoved = move(move(bill, '2026-07-05', '2026-07-01'), '2026-07-09', '2026-07-01')
const futureSettled = autoClearDuePayments({ ...futureBase, recurringTemplates: [futureMoved] }, asOf)
check('...and once its moved date arrives it materializes exactly once', rowsFor(futureSettled, 'bill-1'), ['2026-06-01', '2026-07-09'])

// ─────────────────────────────────────────────────────────────────────
// A pot-funded bill — potLedger builds its own existingKeys off the same
// dedupeKey, so it is a second place the duplicate could appear.
// ─────────────────────────────────────────────────────────────────────
const potBill: RecurringTemplate = { ...common, id: 'bill-pot', name: 'Pot bill', amount: 20, location: 'pot', potId: 'pot1', kind: 'bill' }
const potBase = autoClearDuePayments(dataWith([potBill]), asOf)
const potMoved = move(move(potBill, '2026-07-05', '2026-07-01'), '2026-07-09', '2026-07-01')
const potAfter = autoClearDuePayments({ ...potBase, recurringTemplates: [potMoved] }, asOf)
check('a pot-funded bill moved twice leaves ONE row', rowsFor(potAfter, 'bill-pot'), ['2026-06-01', '2026-07-09'])

// ─────────────────────────────────────────────────────────────────────
// Rows materialized BEFORE occurrenceOriginalDate existed — the real
// data path for Adam's and his mum's backups. They must reconcile via
// the legacy date match and get stamped on first sight, with nothing
// else about them touched.
// ─────────────────────────────────────────────────────────────────────
const legacyBase = autoClearDuePayments(dataWith([bill]), asOf)
const legacyData: AppDataV2 = {
  ...legacyBase,
  transactions: legacyBase.transactions.map((t) => {
    const { occurrenceOriginalDate: _drop, ...rest } = t
    return rest as Transaction
  }),
  recurringTemplates: [bill],
}
check('fixture really is unstamped', legacyData.transactions.every((t) => t.occurrenceOriginalDate === undefined), true)
const legacyStamped = autoClearDuePayments(legacyData, asOf)
check('an unstamped row is stamped with its natural slot on first pass', legacyStamped.transactions.find((t) => t.date === '2026-07-01')?.occurrenceOriginalDate, '2026-07-01')
check('...and its date/amount/status are untouched', [legacyStamped.transactions.find((t) => t.date === '2026-07-01')?.amount, legacyStamped.transactions.find((t) => t.date === '2026-07-01')?.status], [37, 'cleared'])

// An unstamped row that had ALREADY been moved once before the fix
// shipped — the slot has to come from the legacy two-way date match.
const legacyMovedTpl = move(bill, '2026-07-05', '2026-07-01')
const legacyMovedData: AppDataV2 = {
  ...legacyData,
  transactions: legacyData.transactions.map((t) => (t.date === '2026-07-01' ? { ...t, date: '2026-07-05' } : t)),
  recurringTemplates: [legacyMovedTpl],
}
const legacyMovedStamped = autoClearDuePayments(legacyMovedData, asOf)
check('an unstamped, already-moved row derives its slot from the override', legacyMovedStamped.transactions.find((t) => t.date === '2026-07-05')?.occurrenceOriginalDate, '2026-07-01')
const legacyMovedAgain = autoClearDuePayments({ ...legacyMovedStamped, recurringTemplates: [move(legacyMovedTpl, '2026-07-09', '2026-07-01')] }, asOf)
check('...and a further move on that legacy row does NOT duplicate', rowsFor(legacyMovedAgain, 'bill-1'), ['2026-06-01', '2026-07-09'])

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll checks passed')
}
