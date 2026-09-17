// UAT 2026-09-10 (recurring-payday-date-editing, Bug A) — Adam's own
// repro, live: a recurring transfer from Current Account to the Bills
// pot, set to "follow payday," payday on the 31st, "exclude weekends/
// bank holidays" on, budgeting cycle following pay. The REAL generated
// transaction correctly resolved backward off a weekend/month-end, but
// "Manage upcoming payments" (templateOccurrencePreviews/
// scheduledTemplateDates) showed a DIFFERENT, wrong date for the exact
// same occurrence — because schedule.ts's walkOccurrences never applied
// the payday/cycle-start resolution generateTransactionsForTemplate
// applied separately, after the fact, only for itself.
//
// This script asserts the fix: generateTransactionsForTemplate,
// templateOccurrencePreviews, and scheduledTemplateDates now all agree
// on every date, for both a followsPayday and a followsCycleStart
// transfer — rather than hand-deriving the expected resolved dates
// (upcomingPaydays' "next payday strictly AFTER the raw date" semantics
// mean a raw date can roll forward by a full extra pay period, which is
// pre-existing behaviour this fix does not change — only PARITY across
// surfaces is what's being fixed), generateTransactionsForTemplate's own
// output is treated as ground truth for the walk, and the other two are
// asserted to agree with it exactly.
//
// Separately, and independently of walkOccurrences entirely, this
// verifies the specific edge case the prompt doc calls out: a payday
// that's simultaneously a weekend AND at month-end. Adam's payday is the
// 31st; 31 October 2026 is a SATURDAY, so the resolved October payday
// must walk back to Friday 30 October — checked directly against
// upcomingPaydays, not through the walk, so a bug in the walk's own
// month-cursor logic can't accidentally hide a bug in the underlying
// payday math (or vice versa).

import { generateTransactionsForTemplate, templateOccurrencePreviews, scheduledTemplateDates } from '../src/lib/schedule'
import { upcomingPaydays } from '../src/lib/salaryLedger'
import type { RecurringTemplate, PayCycleConfig } from '../src/types/ledger'

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed++
  } else {
    failed++
    console.error(`✗ ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  }
}

function assert(label: string, condition: boolean) {
  check(label, condition, true)
}

// ── Fixture: Adam's exact repro — payday on the 31st, weekends/bank
// holidays excluded, budgeting cycle follows pay. ──────────────────────
const payCycle: PayCycleConfig = {
  personId: 'me',
  openingBalance: 1000,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 31,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 31,
  cycleStartFollowsPayday: true,
}

const followsPaydayTemplate: RecurringTemplate = {
  id: 'tpl-follows-payday',
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

const followsCycleStartTemplate: RecurringTemplate = {
  ...followsPaydayTemplate,
  id: 'tpl-follows-cycle',
  followsPayday: false,
  followsCycleStart: true,
}

const windowStart = new Date('2026-08-01')
const windowEnd = new Date('2026-12-31')

for (const template of [followsPaydayTemplate, followsCycleStartTemplate]) {
  const label = template.followsPayday ? 'follows-payday' : 'follows-cycle-start'

  // generateTransactionsForTemplate is the pre-existing, known-correct
  // path (Adam's real transaction already lands right) — used here as
  // ground truth for what the OTHER two surfaces must now also produce.
  const generated = generateTransactionsForTemplate(template, windowStart, windowEnd, payCycle).map((t) => t.date)
  const previews = templateOccurrencePreviews(template, windowStart, generated.length, payCycle).map((p) => p.date)
  // UAT 2026-09-11 (manage-upcoming-payments-override-key-bug) —
  // scheduledTemplateDates now returns { originalDate, date } pairs; only
  // .date (the resolved/displayed date) is comparable to generated/previews.
  const scheduled = scheduledTemplateDates(template, windowStart, windowEnd, payCycle).map((s) => s.date)

  assert(`${label}: sanity — at least one occurrence resolved in the window`, generated.length >= 4)
  check(`${label}: templateOccurrencePreviews agrees with generateTransactionsForTemplate`, previews, generated)
  check(`${label}: scheduledTemplateDates agrees with generateTransactionsForTemplate`, scheduled, generated)

  // Without the fix, previews/scheduled would show the raw NATURAL walk
  // (Aug 31, Sep 30, Oct 31, Nov 30, Dec 31) instead — assert the fixed
  // output is genuinely different from that naive walk, so this test
  // can't pass by accident if the resolution silently stopped applying.
  const naturalWalk = ['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31'].slice(0, generated.length)
  assert(`${label}: resolved dates actually differ from the naive natural walk (the exact bug being fixed)`, JSON.stringify(previews) !== JSON.stringify(naturalWalk))
}

// ── Adam's own specific worry: a payday that's simultaneously a weekend
// AND at month-end. Checked directly against upcomingPaydays, independent
// of the walk. ───────────────────────────────────────────────────────────
const octoberResolvedPayday = upcomingPaydays(payCycle, new Date('2026-10-01'), 1)[0]
assert('31 Oct 2026 is a Saturday (month-end + weekend collision)', new Date('2026-10-31T00:00:00').getDay() === 6)
check('October payday resolves back to Friday 30 Oct (weekend AND month-end simultaneously)', octoberResolvedPayday?.toISOString().slice(0, 10), '2026-10-30')

// ── occurrenceOverrides keying: a per-occurrence override must still be
// found by its UNRESOLVED originalDate after payday resolution is
// applied to the displayed date, and the override's amount/deleted flag
// must apply even though the DISPLAYED date has moved. ──────────────────
const templateWithAmountOverride: RecurringTemplate = {
  ...followsPaydayTemplate,
  id: 'tpl-override',
  // "Just this one payment" override keyed to the natural September
  // occurrence — its resolved/displayed date is a different month
  // entirely (per the payday-rolls-forward semantics above), so this
  // proves the override key isn't accidentally being matched against
  // the resolved date instead.
  occurrenceOverrides: [{ originalDate: '2026-09-30', amount: 999 }],
}
// As of 1 Oct, not 1 Sep (2026-09-17): occurrences are now range-checked by
// the date they're PAID (verify-follows-payday-range.ts). The 31 Aug slot is
// paid on 30 Sep, so on 1 Sep IT is the next payment; the natural-Sept slot
// (paid 30 Oct) is next only once 30 Sep has passed.
const septPreview = templateOccurrencePreviews(templateWithAmountOverride, new Date('2026-10-01'), 1, payCycle)[0]
assert('override matched: previews[0] is the natural Sept occurrence', septPreview?.originalDate === '2026-09-30')
check('override amount applied despite the displayed date having moved', septPreview?.amount, 999)
assert('override does not corrupt originalDate reported back (stays the natural date)', septPreview?.originalDate === '2026-09-30')
assert('override does not prevent payday resolution of the DISPLAYED date', septPreview?.date !== '2026-09-30')

// ── scheduledTemplateDates keeps ignoring occurrenceOverrides (a paused
// date must still surface as a pause-picker candidate) even while now
// applying payday resolution too. ──────────────────────────────────────
const templateWithPause: RecurringTemplate = {
  ...followsPaydayTemplate,
  id: 'tpl-paused',
  occurrenceOverrides: [{ originalDate: '2026-09-30', deleted: true }],
}
const scheduledIgnoringPause = scheduledTemplateDates(templateWithPause, windowStart, windowEnd, payCycle)
const unpausedScheduled = scheduledTemplateDates(followsPaydayTemplate, windowStart, windowEnd, payCycle)
check('scheduledTemplateDates ignores the pause entirely (same candidate list paused or not)', scheduledIgnoringPause, unpausedScheduled)
// The pair shape's .originalDate must ALSO be identical paused-or-not
// (it's the natural key occurrenceOverrides/walkOccurrences use — payday
// resolution must never disturb it), independent of the .date check above.
check(
  'scheduledTemplateDates original (natural) dates also ignore the pause entirely',
  scheduledIgnoringPause.map((s) => s.originalDate),
  unpausedScheduled.map((s) => s.originalDate),
)
// templateOccurrencePreviews always returns exactly `count` items (it
// keeps walking further out to fill the count, it doesn't stop at
// `windowEnd`) — so a dropped occurrence shows up as the WHOLE list
// shifting by one, not a shorter list. Identify the exact resolved date
// September's pause removes, then assert the paused list no longer
// contains it (while the unpaused list does, at the same count).
const unpausedPreviewsSept = templateOccurrencePreviews(followsPaydayTemplate, new Date('2026-10-01'), 1, payCycle) // see septPreview above
const septResolvedDate = unpausedPreviewsSept[0]?.date
const pausedPreviewDates = templateOccurrencePreviews(templateWithPause, windowStart, 6, payCycle).map((p) => p.date)
const unpausedPreviewDates = templateOccurrencePreviews(followsPaydayTemplate, windowStart, 6, payCycle).map((p) => p.date)
assert('sanity — the unpaused list actually contains the date the pause is expected to remove', unpausedPreviewDates.includes(septResolvedDate!))
assert('templateOccurrencePreviews (pause-aware) drops the resolved date the paused September occurrence would have produced', !pausedPreviewDates.includes(septResolvedDate!))

// ── No payCycle supplied: falls back to the natural date untouched, same
// as before this fix, for any existing caller that doesn't have one to
// hand. ─────────────────────────────────────────────────────────────────
const naturalDates = ['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']
check('generateTransactionsForTemplate with no payCycle falls back to natural walked dates', generateTransactionsForTemplate(followsPaydayTemplate, windowStart, windowEnd).map((t) => t.date), naturalDates)
check('templateOccurrencePreviews with no payCycle falls back to natural walked dates', templateOccurrencePreviews(followsPaydayTemplate, windowStart, naturalDates.length).map((p) => p.date), naturalDates)
check(
  'scheduledTemplateDates with no payCycle falls back to natural walked dates',
  scheduledTemplateDates(followsPaydayTemplate, windowStart, windowEnd).map((s) => s.date),
  naturalDates,
)

// ── A non-transfer kind (bill/transaction) ignores followsPayday/
// followsCycleStart entirely at the engine level, even if somehow set,
// even WITH a payCycle supplied — unaffected by this fix, per
// schedule.ts's own long-standing comment. ───────────────────────────────
const billTemplate: RecurringTemplate = { ...followsPaydayTemplate, id: 'tpl-bill', kind: 'bill' }
check('a bill-kind template ignores followsPayday even with a payCycle supplied', generateTransactionsForTemplate(billTemplate, windowStart, windowEnd, payCycle).map((t) => t.date), naturalDates)
check('templateOccurrencePreviews: a bill-kind template ignores followsPayday even with a payCycle supplied', templateOccurrencePreviews(billTemplate, windowStart, naturalDates.length, payCycle).map((p) => p.date), naturalDates)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
