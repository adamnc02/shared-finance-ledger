// "Manage upcoming payments" redesign (2026-09-10) — Pension (call site
// #6 in the redesign doc's inventory) gained the same single-occurrence
// ("just a single payment") amount-write mechanism Bills/Transfers/
// recurring overpayments already had: resolvePensionOccurrenceAmount
// (the missing resolveOccurrenceAmount-equivalent — the schedule walker
// already respected occurrenceOverrides' .amount, but nothing display-
// side checked it before this) and applyPensionSingleOccurrenceAmountChange
// (the new write function, mirroring schedule.ts's
// applyTemplateSingleOccurrenceAmountChange). Verifies the same
// properties that file's own verify script covers, against Pension.

import { generatePensionTransactions, resolvePensionOccurrenceAmount, applyPensionSingleOccurrenceAmountChange } from '../src/lib/pensionLedger'
import type { Pension } from '../src/types/ledger'
import { addMonths } from 'date-fns'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const pension: Pension = {
  id: 'p1',
  personId: 'me',
  name: 'Test Pension',
  amount: 500,
  frequency: 'monthly',
  anchorDate: '2026-06-01',
  active: true,
  adjustForNonWorkingDay: false,
  cycleStartFollowsPayday: false,
}

const rangeStart = new Date('2026-06-01')
const rangeEnd = addMonths(rangeStart, 6)

// ─────────────────────────────────────────────────────────────────────
// A single-occurrence override affects exactly one date, both via the
// resolver (display) and the real generator (ledger) — resolver and
// generator must agree.
// ─────────────────────────────────────────────────────────────────────
const overrideDate = '2026-08-01'
const patch = applyPensionSingleOccurrenceAmountChange(pension, 999, overrideDate)
const overridden: Pension = { ...pension, ...patch }
const transactions = generatePensionTransactions(overridden, rangeStart, rangeEnd)

check('resolvePensionOccurrenceAmount reflects the override at its own date', resolvePensionOccurrenceAmount(overridden, overrideDate), 999)
check('The real ledger (generatePensionTransactions) agrees with the resolver', transactions.find((t) => t.date === overrideDate)?.amount, 999)
check('The month before is completely unaffected', transactions.find((t) => t.date === '2026-07-01')?.amount, 500)
check('The month after reverts to the standing amount — the override does not leak forward', transactions.find((t) => t.date === '2026-09-01')?.amount, 500)
check('resolvePensionOccurrenceAmount for an un-overridden date falls back to the standing amount', resolvePensionOccurrenceAmount(overridden, '2026-09-01'), 500)
check('The standing amount is completely untouched', overridden.amount, 500)
check('No amountHistory/amountEffectiveFrom was touched', { history: overridden.amountHistory, effectiveFrom: overridden.amountEffectiveFrom }, { history: undefined, effectiveFrom: undefined })

// ─────────────────────────────────────────────────────────────────────
// Merges onto an existing date-move override for the same slot, rather
// than clobbering it — identical contract to schedule.ts's
// applyTemplateSingleOccurrenceAmountChange.
// ─────────────────────────────────────────────────────────────────────
const movedPension: Pension = { ...pension, occurrenceOverrides: [{ originalDate: overrideDate, date: '2026-08-15' }] }
const mergedPatch = applyPensionSingleOccurrenceAmountChange(movedPension, 777, overrideDate)
check('Merging an amount override onto an existing date-move override keeps the moved date', mergedPatch.occurrenceOverrides, [{ originalDate: overrideDate, date: '2026-08-15', amount: 777 }])

// ─────────────────────────────────────────────────────────────────────
// A pension that's already paused at a date (deleted: true) and then
// gets a single-occurrence amount write on the SAME date — merges onto
// the existing entry (same "merge, don't clobber" contract as the
// date-move case above), so the resulting entry carries BOTH
// deleted: true and the new amount. Deliberately NOT a way to un-pause a
// date — walkPensionOccurrences still skips any entry with
// deleted: true regardless of amount, identical to
// schedule.ts's applyTemplateSingleOccurrenceAmountChange against a
// paused Bill occurrence. Un-pausing stays the pause checklist's own job.
// ─────────────────────────────────────────────────────────────────────
const pausedPension: Pension = { ...pension, occurrenceOverrides: [{ originalDate: overrideDate, deleted: true }] }
const editedWhilePaused = applyPensionSingleOccurrenceAmountChange(pausedPension, 600, overrideDate)
check('Merging an amount edit onto an existing paused entry keeps the pause marker', editedWhilePaused.occurrenceOverrides, [{ originalDate: overrideDate, deleted: true, amount: 600 }])
const stillPausedTransactions = generatePensionTransactions({ ...pausedPension, ...editedWhilePaused }, rangeStart, rangeEnd)
check('...and the occurrence stays paused (no transaction generated for that date) despite the amount edit', stillPausedTransactions.some((t) => t.date === overrideDate), false)

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll pension-single-occurrence-amount checks passed.')
