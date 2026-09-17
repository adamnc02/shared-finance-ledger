// UAT 2026-09-11 (manage-upcoming-payments-override-key-bug) — Adam's
// exact repro: pausing the next upcoming occurrence of a recurring
// Transfer set to follow payday (via "Manage upcoming payments") and
// saving did NOT actually skip that payment — the real schedule kept
// generating it. Root cause: scheduledTemplateDates used to return only
// the RESOLVED (payday/cycle-start-adjusted) date as a flat string[],
// which every consumer (PausedOccurrencesControl's pause toggle,
// single-occurrence amount edit, and the "currently paused" check in
// Bills.tsx/Expenses.tsx) then wrongly used as the `originalDate` key
// that occurrenceOverrides actually store and walkOccurrences actually
// looks up by. Fixed by having scheduledTemplateDates return
// { originalDate, date } pairs (mirroring RawOccurrence) and updating
// every caller to key identity/override operations off `.originalDate`.
//
// This script proves, against generateTransactionsForTemplate's REAL
// output (not just the pair list scheduledTemplateDates itself returns):
//   1. Pausing via the pair's `.originalDate` (what the fixed UI now
//      passes) actually removes that occurrence from the real generated
//      schedule.
//   2. Pausing via the pair's `.date` instead (what the BUGGY code used
//      to pass) does NOT remove it — demonstrating the exact failure
//      mode Adam hit, and that the fix genuinely depends on using the
//      right key rather than being accidentally correct either way.
//   3. `currentlyPaused`, rebuilt from occurrenceOverrides the same way
//      the UI does (Set of `.originalDate` intersected with the window),
//      correctly reflects the pause after the round-trip.
//   4. A single-occurrence amount edit keyed by `.originalDate` lands on
//      the real occurrence's actual generated amount; keyed by `.date`
//      (the old bug) it silently misses.

import {
  scheduledTemplateDates,
  setPausedTemplateOccurrences,
  applyTemplateSingleOccurrenceAmountChange,
  resolveOccurrenceAmount,
  generateTransactionsForTemplate,
} from '../src/lib/schedule'
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

// Same fixture as verify-followspayday-occurrence-dates.ts — payday on
// the 31st (rolls back off weekends/month-end), so a follows-payday
// transfer's resolved date genuinely differs from its natural anchor-
// walked date by enough to notice (e.g. natural 2026-10-31 resolves to
// Friday 2026-10-30).
const payCycle: PayCycleConfig = {
  personId: 'me',
  openingBalance: 1000,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 31,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 31,
  cycleStartFollowsPayday: true,
}

const template: RecurringTemplate = {
  id: 'tpl-verify-original-date-key',
  active: true,
  kind: 'transfer',
  name: 'Current -> Bills',
  amount: 250,
  frequency: 'monthly',
  anchorDate: '2026-01-31',
  followsPayday: true,
  paymentMethod: 'bank_transfer' as RecurringTemplate['paymentMethod'],
  location: 'personal',
  ownerId: 'me',
  transferFrom: { type: 'personal' },
  transferTo: { type: 'pot', potId: 'bills' },
}

const windowStart = new Date('2026-08-01')
const windowEnd = new Date('2026-12-31')

const pairs = scheduledTemplateDates(template, windowStart, windowEnd, payCycle)
assert('sanity — scheduledTemplateDates found occurrences in the window', pairs.length >= 4)

// Find an occurrence where resolution actually moved the date — this is
// the ONLY case where the bug is observable (Bills, and any case where
// resolved === natural, is inert either way).
const movedPair = pairs.find((p) => p.date !== p.originalDate)
assert('sanity — at least one occurrence in the window has resolved date != natural date (the bug only bites here)', !!movedPair)
const target = movedPair!
console.log(`  target occurrence: originalDate=${target.originalDate}, resolved date=${target.date}`)

// ── 1 & 2: pause via the CORRECT key (.originalDate) vs the BUGGY key (.date) ──
const windowOriginalDates = pairs.map((p) => p.originalDate)

const correctlyPausedTemplate: RecurringTemplate = {
  ...template,
  ...setPausedTemplateOccurrences(template, windowOriginalDates, [target.originalDate]),
}
const generatedAfterCorrectPause = generateTransactionsForTemplate(correctlyPausedTemplate, windowStart, windowEnd, payCycle).map((t) => t.date)
assert(
  'pausing via .originalDate (the fix) actually removes the occurrence from the REAL generated schedule',
  !generatedAfterCorrectPause.includes(target.date),
)

// The buggy old code passed the RESOLVED date as if it were the natural
// key — reproduce that exact mistake here to prove it genuinely fails,
// i.e. this isn't a test that would pass regardless of which date is used.
const buggilyPausedTemplate: RecurringTemplate = {
  ...template,
  ...setPausedTemplateOccurrences(template, windowOriginalDates, [target.date]),
}
const generatedAfterBuggyPause = generateTransactionsForTemplate(buggilyPausedTemplate, windowStart, windowEnd, payCycle).map((t) => t.date)
assert(
  'REGRESSION GUARD — pausing via .date (the pre-fix bug) fails to remove the occurrence (proves the key choice matters)',
  generatedAfterBuggyPause.includes(target.date),
)

// ── 3: currentlyPaused rebuilt the same way the UI does after the fix ──
const windowOriginalDateSet = new Set(windowOriginalDates)
const currentlyPaused = new Set(
  (correctlyPausedTemplate.occurrenceOverrides ?? []).filter((o) => o.deleted && windowOriginalDateSet.has(o.originalDate)).map((o) => o.originalDate),
)
assert('currentlyPaused (rebuilt the way Expenses.tsx/Bills.tsx now do) correctly shows the occurrence as paused after the round-trip', currentlyPaused.has(target.originalDate))

// ── 4: single-occurrence amount edit — correct key vs buggy key ──
const amountEditedCorrectly: RecurringTemplate = {
  ...template,
  ...applyTemplateSingleOccurrenceAmountChange(template, 999, target.originalDate),
}
const generatedAfterCorrectAmountEdit = generateTransactionsForTemplate(amountEditedCorrectly, windowStart, windowEnd, payCycle)
const editedTxn = generatedAfterCorrectAmountEdit.find((t) => t.date === target.date)
assert('single-occurrence amount edit keyed by .originalDate lands on the real generated occurrence', editedTxn?.amount === 999)
check('resolveOccurrenceAmount agrees (same key) after the amount edit', resolveOccurrenceAmount(amountEditedCorrectly, target.originalDate), 999)

const amountEditedBuggily: RecurringTemplate = {
  ...template,
  ...applyTemplateSingleOccurrenceAmountChange(template, 999, target.date),
}
const generatedAfterBuggyAmountEdit = generateTransactionsForTemplate(amountEditedBuggily, windowStart, windowEnd, payCycle)
const untouchedTxn = generatedAfterBuggyAmountEdit.find((t) => t.date === target.date)
assert(
  'REGRESSION GUARD — single-occurrence amount edit keyed by .date (the pre-fix bug) silently misses the real occurrence',
  untouchedTxn?.amount === template.amount,
)

// ── Sanity: an occurrence NOT reported by movedPair (or Bills, which never
// passes payCycle) has originalDate === date, so the bug is inert there —
// confirms the fix doesn't change behaviour where it never needed to. ──
const billTemplate: RecurringTemplate = { ...template, kind: 'bill', followsPayday: false }
const billPairs = scheduledTemplateDates(billTemplate, windowStart, windowEnd)
assert('a bill-kind template (or any call with no payCycle) always has originalDate === date — bug is latent/inert there', billPairs.every((p) => p.originalDate === p.date))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
