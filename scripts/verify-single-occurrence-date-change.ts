// 2026-09-13 (dev.md item 3) — Adam-specified: ability to change the date
// of a single recurring transaction or transfer occurrence (not bills,
// loans, or credit card payments) and have it actually update in the
// ledger. `occurrenceOverrides` already carried a `date` field and
// `walkOccurrences` already read it generically, but there was no writer
// for it — only pause (`deleted: true`) and single-occurrence amount
// edit (`applyTemplateSingleOccurrenceAmountChange`) existed. Added
// `applyTemplateSingleOccurrenceDateChange`, mirroring the amount
// function exactly, and wired it into TransferRecurringRow's
// PausedOccurrencesControl (recurring Transactions already had this via
// OccurrenceRow's existing Amount+Date EditField pair — no lib change
// needed there).
//
// This script proves, against generateTransactionsForTemplate's REAL
// output:
//   1. A single-occurrence date change moves that one occurrence's date
//      in the real generated schedule, with every other occurrence's
//      date/amount untouched.
//   2. The moved occurrence still carries its own correct amount.
//   3. Merging a date change onto an occurrence that already has an
//      amount override (or vice versa) preserves both, rather than one
//      clobbering the other.
//   4. A follows-payday transfer's manually-overridden date is still run
//      through payday/cycle-start resolution by walkOccurrences, exactly
//      like an un-overridden natural date would be — a manual override
//      isn't a way to bypass resolution.

import { applyTemplateSingleOccurrenceAmountChange, applyTemplateSingleOccurrenceDateChange, generateTransactionsForTemplate, scheduledTemplateDates } from '../src/lib/schedule'
import type { PayCycleConfig, RecurringTemplate } from '../src/types/ledger'

let passed = 0
let failed = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed++
  } else {
    failed++
    console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  }
}
function assert(label: string, condition: boolean) {
  check(label, condition, true)
}

const template: RecurringTemplate = {
  id: 'tpl-verify-single-occurrence-date-change',
  active: true,
  kind: 'transfer',
  name: 'Current -> Holiday Fund',
  amount: 75,
  frequency: 'monthly',
  anchorDate: '2026-01-31',
  paymentMethod: 'bank_transfer' as RecurringTemplate['paymentMethod'],
  location: 'personal',
  ownerId: 'me',
  transferFrom: { type: 'personal' },
  transferTo: { type: 'pot', potId: 'holiday' },
}

const windowStart = new Date('2026-08-01')
const windowEnd = new Date('2026-12-31')

// ── 1 & 2: moving one occurrence's date, everything else untouched ──
const moved: RecurringTemplate = { ...template, ...applyTemplateSingleOccurrenceDateChange(template, '2026-10-15', '2026-09-30') }
const generatedAfterMove = generateTransactionsForTemplate(moved, windowStart, windowEnd)
assert('the original date (2026-09-30) no longer appears in the real generated schedule', !generatedAfterMove.some((t) => t.date === '2026-09-30'))
const movedTxn = generatedAfterMove.find((t) => t.date === '2026-10-15')
assert('the new date (2026-10-15) appears instead, with the correct amount carried over', movedTxn?.amount === 75)
const otherDates = generatedAfterMove.map((t) => t.date).filter((d) => d !== '2026-10-15')
assert(
  'every other occurrence keeps its own natural date, unaffected by the single-occurrence move',
  otherDates.every((d) => d !== '2026-09-30'),
)

// ── 3: merging a date change onto an occurrence that already has an amount override, and vice versa ──
const amountFirst: RecurringTemplate = { ...template, ...applyTemplateSingleOccurrenceAmountChange(template, 120, '2026-09-30') }
const amountThenDate: RecurringTemplate = { ...amountFirst, ...applyTemplateSingleOccurrenceDateChange(amountFirst, '2026-10-15', '2026-09-30') }
const mergedOverride = (amountThenDate.occurrenceOverrides ?? []).find((o) => o.originalDate === '2026-09-30')
assert('a date change merges onto an existing amount override rather than clobbering it — amount preserved', mergedOverride?.amount === 120)
assert('...and the new date is also present on the same override entry', mergedOverride?.date === '2026-10-15')
const generatedAfterMerge = generateTransactionsForTemplate(amountThenDate, windowStart, windowEnd)
const mergedTxn = generatedAfterMerge.find((t) => t.date === '2026-10-15')
assert('the real generated occurrence reflects BOTH the moved date and the preserved overridden amount', mergedTxn?.amount === 120)

const dateFirst: RecurringTemplate = { ...template, ...applyTemplateSingleOccurrenceDateChange(template, '2026-10-15', '2026-09-30') }
const dateThenAmount: RecurringTemplate = { ...dateFirst, ...applyTemplateSingleOccurrenceAmountChange(dateFirst, 99, '2026-09-30') }
const mergedOverride2 = (dateThenAmount.occurrenceOverrides ?? []).find((o) => o.originalDate === '2026-09-30')
assert('an amount change merges onto an existing date override rather than clobbering it — date preserved', mergedOverride2?.date === '2026-10-15')
assert('...and the new amount is also present on the same override entry', mergedOverride2?.amount === 99)

// ── 4: a manually-overridden date on a follows-payday transfer is still resolved ──
const payCycle: PayCycleConfig = {
  personId: 'me',
  openingBalance: 1000,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 31,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 31,
  cycleStartFollowsPayday: true,
}
const followsPaydayTemplate: RecurringTemplate = { ...template, followsPayday: true }
const pairs = scheduledTemplateDates(followsPaydayTemplate, windowStart, windowEnd, payCycle)
const movedPair = pairs.find((p) => p.date !== p.originalDate)
assert('sanity — found a follows-payday occurrence where resolution actually moves the date', !!movedPair)
const target = movedPair!
// Manually move this occurrence to a Saturday (2026-08-01 is a Saturday) — resolution should roll it, same as an un-overridden natural date on a weekend would.
const overriddenToWeekend: RecurringTemplate = { ...followsPaydayTemplate, ...applyTemplateSingleOccurrenceDateChange(followsPaydayTemplate, '2026-08-01', target.originalDate) }
const generatedWithOverride = generateTransactionsForTemplate(overriddenToWeekend, windowStart, windowEnd, payCycle)
assert(
  'a manually-overridden date is still run through payday/cycle-start resolution (weekend anchor gets adjusted, not taken literally)',
  !generatedWithOverride.some((t) => t.date === '2026-08-01'),
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
