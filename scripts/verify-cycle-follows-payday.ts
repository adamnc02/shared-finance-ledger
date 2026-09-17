// Verifies PayCycleConfig.cycleStartFollowsPayday — the override that
// makes the budgeting cycle boundary track the RESOLVED payday (weekend /
// bank-holiday adjustment included) instead of a fixed day of the month.
//
// The reason this needs its own script rather than an extra case in
// verify-ledger.ts: the whole point of the override is the DIFFERENCE
// between the two boundary models on the dates where they disagree, and
// those dates only exist because of the weekend/bank-holiday walk-back.
// Setting cycleStartDayOfMonth === paydayDayOfMonth looks like it should
// achieve the same thing and provably does not — that equivalence (and
// its failure) is asserted directly below.

import { cycleBoundsForDate, cycleOffset, resolvePayday, isWorkingDay } from '../src/lib/payCycle'
import { computeProjection } from '../src/lib/projection'
import { toLocalIsoDate } from '../src/lib/date'
import type { AppDataV2, PayCycleConfig, Transaction } from '../src/types/ledger'

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

const iso = (d: Date) => toLocalIsoDate(d)

// ── Fixtures ────────────────────────────────────────────────────────────
// Payday on the 28th. In 2026, 28 February is a SATURDAY, so the resolved
// payday walks back to Friday 27 February — the exact kind of drift the
// override exists to follow.

const followsPayday: PayCycleConfig = {
  personId: 'p1',
  openingBalance: 0,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 28,
  cycleStartFollowsPayday: true,
}

const fixedDay: PayCycleConfig = { ...followsPayday, cycleStartFollowsPayday: false }

// ── 1. The premise: 28 Feb 2026 really is a non-working day ─────────────

assert('28 Feb 2026 is not a working day (Saturday)', !isWorkingDay(new Date(2026, 1, 28)))
check('resolved Feb 2026 payday walks back to the 27th', iso(resolvePayday(2026, 1, 28, true)), '2026-02-27')
// March 2026's 28th is a Saturday too, so it also walks back — which is
// what makes February's cycle END on the 26th rather than the 27th below.
check('resolved Mar 2026 payday also walks back (28th is a Saturday)', iso(resolvePayday(2026, 2, 28, true)), '2026-03-27')
check('resolved Apr 2026 payday needs no adjustment (28th is a Tuesday)', iso(resolvePayday(2026, 3, 28, true)), '2026-04-28')

// ── 2. The bug being fixed: same day number is NOT the same boundary ────
// This is the reported behaviour — matching cycleStartDayOfMonth to
// paydayDayOfMonth leaves the boundary "locked in" on the nominal date
// while the real payday moves.

const fixedFeb = cycleBoundsForDate(new Date(2026, 1, 27), fixedDay)
check('FIXED: 27 Feb (real payday) still sits in the PREVIOUS cycle', iso(fixedFeb.start), '2026-01-28')
check('FIXED: ...which does not end until 27 Feb itself', iso(fixedFeb.end), '2026-02-27')

const followsFeb = cycleBoundsForDate(new Date(2026, 1, 27), followsPayday)
check('FOLLOWS: 27 Feb (real payday) OPENS its own cycle', iso(followsFeb.start), '2026-02-27')
check('FOLLOWS: ...running to the day before the next (also adjusted) payday', iso(followsFeb.end), '2026-03-26')

assert(
  'the two models genuinely disagree on payday itself — matching the day numbers is not equivalent',
  iso(fixedFeb.start) !== iso(followsFeb.start),
)

// ── 3. Unadjusted months are identical under both models ────────────────
// The override must only change things on the dates where the payday
// actually drifted; an ordinary month has to be untouched.

const fixedApr = cycleBoundsForDate(new Date(2026, 3, 28), fixedDay)
const followsApr = cycleBoundsForDate(new Date(2026, 3, 28), followsPayday)
check('unadjusted month: same start under both models', iso(fixedApr.start), iso(followsApr.start))
check('unadjusted month: start is the 28th', iso(followsApr.start), '2026-04-28')

// ── 4. Every date lands in exactly one cycle, and that cycle contains it ─
// The scan-neighbouring-months implementation exists because the
// fixed-day "is ref past this month's boundary?" branch is unsound once
// a boundary can resolve backward into the previous month. Walking a
// full year day by day is the direct test of that.

const dayOneCoverage: PayCycleConfig = { ...followsPayday, paydayDayOfMonth: 1 }
let coverageFailures = 0
let contiguityFailures = 0
let previousEnd: string | null = null
const seenStarts = new Set<string>()

for (let d = new Date(2026, 0, 1); d < new Date(2027, 0, 1); d.setDate(d.getDate() + 1)) {
  const ref = new Date(d)
  const bounds = cycleBoundsForDate(ref, dayOneCoverage)
  if (iso(bounds.start) > iso(ref) || iso(bounds.end) < iso(ref)) coverageFailures++
  if (previousEnd !== null && iso(bounds.start) !== previousEnd) {
    // Only a NEW cycle should ever appear, and it must start the day
    // after the previous one ended.
    if (!seenStarts.has(iso(bounds.start))) {
      const dayAfter = new Date(previousEnd)
      dayAfter.setDate(dayAfter.getDate() + 1)
      if (iso(dayAfter) !== iso(bounds.start)) contiguityFailures++
    }
  }
  seenStarts.add(iso(bounds.start))
  previousEnd = iso(bounds.end)
}

check('every day of 2026 falls inside its own returned cycle (payday = 1st)', coverageFailures, 0)
check('cycles are contiguous — no gaps or overlaps across 2026 (payday = 1st)', contiguityFailures, 0)

// The specific case that breaks a naive implementation: 1 Nov 2026 is a
// SUNDAY, so November's payday resolves back to Friday 30 October —
// meaning October contains two boundaries and November contains none.
check('Nov 2026 payday (Sunday 1st) resolves back into October', iso(resolvePayday(2026, 10, 1, true)), '2026-10-30')
const oct31 = cycleBoundsForDate(new Date(2026, 9, 31), dayOneCoverage)
check('31 Oct 2026 sits in the cycle opened by the early 30 Oct payday', iso(oct31.start), '2026-10-30')
assert('...and that cycle genuinely contains 31 Oct', iso(oct31.end) >= '2026-10-31')

// ── 5. Bare-number form is unchanged (verify-ledger.ts's contract) ──────

const bareNumber = cycleBoundsForDate(new Date(2026, 7, 20), 14)
check('bare number form still gives fixed-day bounds (start)', iso(bareNumber.start), '2026-08-14')
check('bare number form still gives fixed-day bounds (end)', iso(bareNumber.end), '2026-09-13')

// A config WITHOUT the flag must behave exactly like the bare number —
// this is what guarantees no migration is needed for existing data.
const legacyShape = { ...fixedDay } as PayCycleConfig
delete (legacyShape as Partial<PayCycleConfig>).cycleStartFollowsPayday
const legacyBounds = cycleBoundsForDate(new Date(2026, 1, 27), legacyShape)
check('a config with the flag ABSENT behaves as fixed-day (start)', iso(legacyBounds.start), iso(fixedFeb.start))
check('a config with the flag ABSENT behaves as fixed-day (end)', iso(legacyBounds.end), iso(fixedFeb.end))

// ── 6. cycleOffset honours the override too ─────────────────────────────

// Cycles from 27 Feb: [27 Feb – 26 Mar] = 0, [27 Mar – 27 Apr] = 1,
// [28 Apr – …] = 2.
check('cycleOffset counts payday-following cycles', cycleOffset(new Date(2026, 4, 1), new Date(2026, 1, 27), followsPayday), 2)
check('cycleOffset counts the next payday-following cycle as 1', cycleOffset(new Date(2026, 3, 15), new Date(2026, 1, 27), followsPayday), 1)
check('cycleOffset is 0 within the same payday-following cycle', cycleOffset(new Date(2026, 2, 10), new Date(2026, 1, 27), followsPayday), 0)

// ── 7. End to end: the salary lands in the cycle it pays for ────────────
// The whole point of the override. Under the fixed-day model the drifted
// February payday falls in JANUARY's cycle, so January's cycle shows two
// paydays and February's shows none. Under the override each cycle has
// exactly one.

function dataWith(payCycle: PayCycleConfig): AppDataV2 {
  return {
    primaryPersonId: 'p1',
    people: [
      {
        id: 'p1',
        name: 'Test',
        color: '#ff5b4c',
        salaryHistory: [
          {
            id: 's1',
            personId: 'p1',
            effectiveFrom: '2026-01-01',
            grossAnnual: 36000,
            taxCode: '1257L',
            studentLoanPlan: 'none',
            payFrequency: 'monthly',
            deductions: [],
          },
        ],
        salaryOverrides: [],
      },
    ],
    categories: [],
    recurringTemplates: [],
    loans: [],
    creditCards: [],
    transactions: [] as Transaction[],
    payCycles: [payCycle],
    pensions: [],
    savingsPots: [],
    scenarios: [],
  } as unknown as AppDataV2
}

function salaryDatesInCurrentCycle(payCycle: PayCycleConfig, asOf: Date): string[] {
  const projection = computeProjection(dataWith(payCycle), 'p1', payCycle, 'current_cycle', asOf)
  const bounds = cycleBoundsForDate(asOf, payCycle)
  return projection.transactions
    .filter((t) => t.type === 'salary' && t.date >= iso(bounds.start) && t.date <= iso(bounds.end))
    .map((t) => t.date)
    .sort()
}

// Reference date: mid-February 2026, i.e. after the drifted payday would
// have landed under either model.
const asOfFeb = new Date(2026, 1, 27)

check('FIXED: the drifted payday shares a cycle with the previous one', salaryDatesInCurrentCycle(fixedDay, asOfFeb), [
  '2026-01-28',
  '2026-02-27',
])
check('FOLLOWS: the drifted payday opens a cycle of its own — exactly one salary in it', salaryDatesInCurrentCycle(followsPayday, asOfFeb), [
  '2026-02-27',
])

// And the general invariant across a year: never two paydays in one
// payday-following cycle, never zero.
let wrongCount = 0
for (let m = 0; m < 12; m++) {
  const probe = resolvePayday(2026, m, 28, true)
  const found = salaryDatesInCurrentCycle(followsPayday, probe)
  if (found.length !== 1) wrongCount++
}
check('FOLLOWS: every 2026 cycle contains exactly one payday', wrongCount, 0)

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\nverify-cycle-follows-payday: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
