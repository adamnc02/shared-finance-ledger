// Verifies the "average spend forecast" feature. Methodology history:
// 2026-09-13 "trailing 3-cycle mean of non-empty cycles" -> 2026-09-14
// single daily-rate (totalMatchingSpend / window days, window ending
// TODAY not the latest transaction's own date, window-start clamped to
// the earliest matching transaction for a new account) -> 2026-09-15
// (Adam-reported, a real joint-account backup — see this file's own
// "MINIMUM HISTORY GUARD" and "WEEK ALIGNMENT" sections below for why):
// a household that shops in a weekly burst (one big Saturday run) could
// get a forecast built from as little as a single day's real spend the
// moment that one shop happened, extrapolating a single weekend's total
// across a whole month. Two fixes, both required before a forecast shows
// at all: (1) the window must span at least MIN_SPEND_HISTORY_DAYS (14)
// raw days, not just contain one matching transaction; (2) the window
// actually used to compute the rate is trimmed to a whole number of
// 7-day weeks (dropping only the oldest partial days), so every
// day-of-week is represented the same number of times regardless of
// which day the window happens to start on.
//
// Several 2026-09-14 tests that specifically exercised "a brand new
// account with just a few days of history still gets a real, unclamped
// rate" are REPLACED rather than kept passing — that's the exact
// real-world scenario this session's fix exists to block. See git
// history for the superseded versions.
//
// Still verifies, unchanged since 2026-09-13: the per-cycle reduction
// math (forecastSpendForCycle), and that the window is NOT bound by
// either ledger's own opening-balance date (Adam's own rebalancing
// scenario). Still verifies, unchanged since 2026-09-14: the
// first-logged-cycle guard (a cycle never forecasts against its own
// partial data reflected back onto itself).

import { differenceInCalendarDays } from 'date-fns'
import { previousCycles } from '../src/lib/projection'
import {
  averageAdHocSpendForCycle,
  dailySpendRate,
  daysOfSpendHistory,
  forecastSpendForCycle,
  hasAnyMatchingSpend,
  hasSpendHistory,
  MIN_SPEND_HISTORY_DAYS,
  weekAlignedWindowStart,
  type SpendScope,
} from '../src/lib/averageSpendForecast'
import { toLocalIsoDate as iso } from '../src/lib/date'
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
function round2(n: number) {
  return Math.round(n * 100) / 100
}

const payCycle: PayCycleConfig = {
  personId: 'p1',
  openingBalance: 1000,
  // 2026-09 — deliberately set well AFTER some of the fixture's ad-hoc
  // expenses below, to prove the window genuinely ignores this bound
  // (Adam's own rebalancing scenario).
  openingBalanceDate: '2026-09-01',
  paydayDayOfMonth: 25,
  paydayAdjustForNonWorkingDay: false,
  cycleStartDayOfMonth: 25,
}

function expense(id: string, date: string, amount: number, location: 'personal' | 'joint', ownerId = 'p1'): Transaction {
  return {
    id,
    date,
    amount,
    direction: 'out',
    categoryId: 'cat-food',
    paymentMethod: 'card',
    status: 'cleared',
    type: 'expense',
    location,
    ownerId,
  }
}

function dataWith(transactions: Transaction[]): AppDataV2 {
  return {
    primaryPersonId: 'p1',
    people: [{ id: 'p1', name: 'Test', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [] }],
    categories: [],
    recurringTemplates: [],
    loans: [],
    creditCards: [],
    transactions,
    payCycles: [payCycle],
    pensions: [],
    savingsPots: [],
    scenarios: [],
  } as unknown as AppDataV2
}

const asOf = new Date(2026, 9, 10) // 10 Oct 2026 — mid-cycle, well after openingBalanceDate
const personalScope: SpendScope = { location: 'personal', ownerId: 'p1' }

// The RAW window this whole file's asOf/payCycle combination resolves
// to — derived from previousCycles itself (not hand-computed calendar
// arithmetic), same boundary dailySpendRate's own implementation starts
// from. `alignedWindowStart`/`windowDays` are what dailySpendRate
// ACTUALLY computes the rate over, once trimmed to a whole number of
// weeks — computed via the same exported `weekAlignedWindowStart` the
// implementation itself uses, so these never drift apart.
const windowStart = previousCycles(dataWith([]), 'p1', 3, asOf)[2].start
const alignedWindowStart = weekAlignedWindowStart(windowStart, asOf)
const windowDays = differenceInCalendarDays(asOf, alignedWindowStart) + 1

// ── 1. previousCycles: 3 cycles immediately before "now"'s, tiling with no gaps ──
{
  const cycles = previousCycles(dataWith([]), 'p1', 3, asOf)
  assert('previousCycles returns exactly 3 cycles', cycles.length === 3)
  for (let i = 0; i < cycles.length - 1; i++) {
    const laterEnd = iso(cycles[i].start)
    const earlierEnd = iso(cycles[i + 1].end)
    assert(`previousCycles[${i + 1}] ends the day before previousCycles[${i}] starts`, new Date(earlierEnd) < new Date(laterEnd))
  }
  assert('the most recent previousCycle ends before "now"\'s own cycle starts', cycles[0].end < asOf)
}

// ── 2. dailySpendRate: total matching spend / inclusive window days (window start..today) ──
{
  const data = dataWith([
    expense('e1', iso(alignedWindowStart), 500, 'personal'), // right at the ACTUAL (week-aligned) window's own start
    expense('e2', '2026-08-10', 300, 'personal'),
  ])
  const rate = dailySpendRate(data, personalScope, 'p1', asOf)
  check('dailySpendRate = totalMatchingSpend / window days (week-aligned window start..today, inclusive)', round2(rate * windowDays), 800)
}

// ── 3. dailySpendRate is 0 with zero matching history in the window ──
{
  check('dailySpendRate with no matching history is 0', dailySpendRate(dataWith([]), personalScope, 'p1', asOf), 0)
}

// ── 4. Adam's own correction: the window ends at TODAY, not the latest matching transaction's own date ──
{
  // A single transaction dated right at the window's start, nothing since
  // — under the OLD "cycle start -> max transaction date" wording this
  // would give days=1 and rate=100; the agreed correction is that every
  // no-spend day between then and today still counts, pulling the rate
  // DOWN towards (but never all the way to) 0.
  const data = dataWith([expense('e1', iso(alignedWindowStart), 100, 'personal')])
  const rate = dailySpendRate(data, personalScope, 'p1', asOf)
  check("no-spend days since the last transaction pull the rate down — window end is TODAY, not the transaction's own date", round2(rate * windowDays), 100)
  assert('REGRESSION GUARD — rate is nowhere near 100/day (would be, under the superseded "max transaction date" wording)', rate < 100 / windowDays + 0.01 && rate > 0)
}

// ── 5. hasSpendHistory: gates on ANY matching transaction in the window, regardless of amount ──
{
  assert('hasSpendHistory is false with zero matching transactions anywhere in the window', !hasSpendHistory(dataWith([]), personalScope, 'p1', asOf))
  const data = dataWith([expense('e1', iso(windowStart), 50, 'personal')])
  assert('hasSpendHistory is true once at least one matching transaction exists in the window', hasSpendHistory(data, personalScope, 'p1', asOf))
}

// ── 5b. MINIMUM HISTORY GUARD (2026-09-15, Adam-reported — a real joint
// account with only a handful of days of history showed a forecast built
// entirely from one weekend's shopping burst): hasSpendHistory now
// requires the window to span at least MIN_SPEND_HISTORY_DAYS (14) raw
// days, not just contain a single matching transaction. ──
{
  const daysAgo = (n: number) => iso(new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate() - n))

  const threeDays = dataWith([expense('e1', daysAgo(2), 300, 'personal')]) // history starts 3 days ago (inclusive)
  assert('a 3-day-old account is blocked — well under the 14-day minimum', !hasSpendHistory(threeDays, personalScope, 'p1', asOf))

  const thirteenDays = dataWith([expense('e1', daysAgo(12), 300, 'personal')]) // 13 days inclusive
  assert('a 13-day-old account is still blocked — one day short of the minimum', !hasSpendHistory(thirteenDays, personalScope, 'p1', asOf))

  const fourteenDays = dataWith([expense('e1', daysAgo(13), 300, 'personal')]) // exactly 14 days inclusive
  assert('a 14-day-old account (exactly the minimum) is allowed', hasSpendHistory(fourteenDays, personalScope, 'p1', asOf))

  // hasAnyMatchingSpend/daysOfSpendHistory distinguish "no history at all" from "some, just not
  // enough yet" — the pair the toggle's own help text relies on to show the right message.
  assert('hasAnyMatchingSpend is false with zero matching transactions', !hasAnyMatchingSpend(dataWith([]), personalScope))
  assert('hasAnyMatchingSpend is true even when there is not yet enough history to forecast from', hasAnyMatchingSpend(threeDays, personalScope))
  check('daysOfSpendHistory reports the actual raw span for a genuinely new account', daysOfSpendHistory(threeDays, personalScope, 'p1', asOf), 3)
  assert(
    'daysOfSpendHistory with ZERO matching transactions reports the natural (un-clamped) window span, not 0 — documented quirk, callers must check hasAnyMatchingSpend separately',
    daysOfSpendHistory(dataWith([]), personalScope, 'p1', asOf) >= MIN_SPEND_HISTORY_DAYS,
  )
}

// ── 5c. WEEK ALIGNMENT: weekAlignedWindowStart trims only the OLDEST partial days, never touches the asOfDate end, and is a no-op once the span is already a whole number of weeks ──
{
  const start = new Date(2026, 0, 1) // 1 Jan 2026
  const endNotAWholeWeek = new Date(2026, 0, 20) // 20 days inclusive (1..20) — not a multiple of 7
  const aligned = weekAlignedWindowStart(start, endNotAWholeWeek)
  const alignedSpan = differenceInCalendarDays(endNotAWholeWeek, aligned) + 1
  check('a non-whole-week span gets trimmed down to the nearest whole number of weeks', alignedSpan, 14)
  assert('the trim moves the START forward (drops the oldest days) — the end nearest asOfDate is untouched', aligned.getTime() > start.getTime())

  const wholeWeekEnd = new Date(2026, 0, 14) // 1..14 inclusive = 14 days, already a whole 2 weeks
  const alignedWhole = weekAlignedWindowStart(start, wholeWeekEnd)
  check('a span that is ALREADY a whole number of weeks is returned unchanged', iso(alignedWhole), iso(start))
}

// Every test below that isn't ITSELF about window-clamping (section 16)
// pins the window's start with a zero-amount anchor expense dated
// exactly at the natural windowStart — matching scope, so it doesn't
// trip the NEW earliest-transaction clamp (section 16), and £0 so it
// never changes any of these tests' own total-spend expectations. Without
// it, these tests' own earliest transaction (often well after
// windowStart) would clamp the window itself, making the fixed global
// `windowDays` constant used in each `check` below silently wrong.
function anchor(location: 'personal' | 'joint', ownerId = 'p1'): Transaction {
  return expense('e-anchor', iso(windowStart), 0, location, ownerId)
}

// ── 6. Rebalancing: ad-hoc expenses dated BEFORE payCycle.openingBalanceDate still count ──
{
  // Both predate payCycle.openingBalanceDate ('2026-09-01') —
  // computeProjection would exclude both from a real balance calculation,
  // but this window must NOT.
  const data = dataWith([
    anchor('personal'),
    expense('e1', '2026-08-10', 100, 'personal'), // before openingBalanceDate
    expense('e2', '2026-07-10', 100, 'personal'), // before openingBalanceDate
  ])
  const rate = dailySpendRate(data, personalScope, 'p1', asOf)
  assert('REGRESSION GUARD — ad-hoc expenses dated before payCycle.openingBalanceDate still feed the rate (not silently excluded)', rate > 0)
  check('rate correctly built from pre-rebalance history alone', round2(rate * windowDays), 200)
}

// ── 7. What counts as "spend": only ad-hoc type:'expense', location:'personal', ownerId matches ──
{
  const otherOwner: Transaction = expense('e-other', '2026-09-10', 999, 'personal', 'p2')
  const income: Transaction = { ...expense('e-income', '2026-09-10', 999, 'personal'), type: 'income', direction: 'in' }
  const billPayment: Transaction = { ...expense('e-bill', '2026-09-10', 999, 'personal'), type: 'bill_payment' }
  const cardSpend: Transaction = { ...expense('e-card', '2026-09-10', 999, 'personal'), type: 'credit_card_spend' }
  const jointExpense: Transaction = expense('e-joint', '2026-09-10', 999, 'joint')
  const realOne = expense('e-real', '2026-09-10', 50, 'personal')
  const data = dataWith([anchor('personal'), otherOwner, income, billPayment, cardSpend, jointExpense, realOne])
  const rate = dailySpendRate(data, personalScope, 'p1', asOf)
  check('only the genuine ad-hoc personal expense counts — other owner/income/bill/card-spend/joint all excluded', round2(rate * windowDays), 50)
}

// ── 8. Cross-contamination guard: joint expense never feeds Personal rate, and vice versa ──
{
  const jointScope: SpendScope = { location: 'joint' }
  const data = dataWith([anchor('personal'), anchor('joint'), expense('e1', '2026-09-10', 500, 'joint'), expense('e2', '2026-09-10', 300, 'personal')])
  check('CROSS-CONTAMINATION GUARD — a location:joint expense never feeds the Personal rate', round2(dailySpendRate(data, personalScope, 'p1', asOf) * windowDays), 300)
  check('CROSS-CONTAMINATION GUARD — a location:personal expense never feeds the Joint rate', round2(dailySpendRate(data, jointScope, 'p1', asOf) * windowDays), 500)
}

// ── 9. Joint scope has no ownerId filter — either person's logged joint expense counts ──
{
  const jointScope: SpendScope = { location: 'joint' }
  const data = dataWith([anchor('joint'), expense('e1', '2026-09-10', 100, 'joint', 'p1'), expense('e2', '2026-08-10', 200, 'joint', 'p2')])
  const rate = dailySpendRate(data, jointScope, 'p1', asOf)
  check('Joint rate includes ad-hoc expenses logged by EITHER owner (no ownerId filter)', round2(rate * windowDays), 300)
}

// ── 10. averageAdHocSpendForCycle: the daily rate scaled by EACH cycle's own actual length ──
{
  const data = dataWith([expense('e1', iso(alignedWindowStart), windowDays, 'personal')]) // rate = 1/day exactly
  const shortCycle = { start: new Date(2026, 10, 1), end: new Date(2026, 10, 30) } // 30 days
  const longCycle = { start: new Date(2026, 10, 1), end: new Date(2026, 11, 1) } // 31 days
  check('averageAdHocSpendForCycle scales a 30-day cycle by 30', averageAdHocSpendForCycle(data, personalScope, 'p1', shortCycle, asOf), 30)
  check("averageAdHocSpendForCycle scales a 31-day cycle by ITS OWN length (31), not a fixed constant", averageAdHocSpendForCycle(data, personalScope, 'p1', longCycle, asOf), 31)
}

// ── 11. averageAdHocSpendForCycle is 0 when there's no history to build a rate from ──
{
  const cycle = { start: new Date(2026, 10, 1), end: new Date(2026, 10, 30) }
  check('averageAdHocSpendForCycle with no matching history anywhere is 0', averageAdHocSpendForCycle(dataWith([]), personalScope, 'p1', cycle, asOf), 0)
}

// ── 12. Adam's own worked example: £800 average, £250 already scheduled -> £550 forecast ──
{
  const cycle = { start: new Date(2026, 9, 25), end: new Date(2026, 10, 24) } // a future cycle
  const data = dataWith([expense('e1', '2026-11-05', 150, 'personal'), expense('e2', '2026-11-10', 100, 'personal')]) // £250 already logged this future cycle
  const { forecastAmount, realSpend } = forecastSpendForCycle(data, personalScope, 800, cycle)
  check("Adam's worked example — realSpend correctly totals the £250 already scheduled", realSpend, 250)
  check("Adam's worked example — forecast reduces from £800 to £550", forecastAmount, 550)
}

// ── 13. Forecast clamps to 0 when real spend meets or exceeds the average (never negative) ──
{
  const cycle = { start: new Date(2026, 9, 25), end: new Date(2026, 10, 24) }
  const data = dataWith([expense('e1', '2026-11-05', 900, 'personal')])
  const { forecastAmount, realSpend } = forecastSpendForCycle(data, personalScope, 800, cycle)
  check('real spend already exceeding the average clamps the forecast to 0, not negative', forecastAmount, 0)
  check('realSpend is still reported accurately even when it exceeds the average', realSpend, 900)
}

// ── 14. Forecast with zero real spend this cycle equals the average outright ──
{
  const cycle = { start: new Date(2026, 9, 25), end: new Date(2026, 10, 24) }
  const { forecastAmount, realSpend } = forecastSpendForCycle(dataWith([]), personalScope, 800, cycle)
  check('no real spend this cycle -> forecast equals the average unreduced', forecastAmount, 800)
  check('realSpend is 0', realSpend, 0)
}

// ── 15. Forecast now reaches the CURRENT cycle too — same reduction math applies to a cycle containing "today" ──
{
  const currentCycle = { start: new Date(2026, 8, 25), end: new Date(2026, 9, 24) } // Sep25..Oct24, contains asOf (10 Oct)
  const data = dataWith([expense('e1', '2026-10-01', 200, 'personal')]) // already logged this (current) cycle
  const { forecastAmount, realSpend } = forecastSpendForCycle(data, personalScope, 500, currentCycle)
  check('forecastSpendForCycle applies the exact same reduction math whether the cycle is current or future', forecastAmount, 300)
  check('realSpend for the current cycle counts only what is dated within it', realSpend, 200)
}

// ── 16. WINDOW CLAMP (Adam-reported, a real new-account backup): the window's start clamps to the earliest matching transaction when that's LATER than the natural 3-cycles-back start ──
{
  // 21 days (exactly 3 whole weeks — a no-op for week-alignment, keeping
  // this test focused purely on the clamp) of real history, well after
  // the natural windowStart, clears the 2026-09-15 minimum-history gate
  // on its own — simulates an account that's a few weeks old, not brand
  // new. Under an unclamped window, this same £300 would have been
  // diluted across the FULL natural windowDays (mostly empty days that
  // predate any real history), producing an artificially tiny rate.
  const recentStart = new Date(2026, 8, 20) // 20 Sep — 21 days before asOf (10 Oct), inclusive
  const data = dataWith([expense('e1', iso(recentStart), 300, 'personal')])
  assert('21 days of real history clears the minimum-history gate', hasSpendHistory(data, personalScope, 'p1', asOf))
  const rate = dailySpendRate(data, personalScope, 'p1', asOf)
  const clampedWindowDays = differenceInCalendarDays(asOf, recentStart) + 1 // 21
  check("WINDOW CLAMP — rate is built only from the earliest matching transaction's own date forward", round2(rate * clampedWindowDays), 300)
  assert('WINDOW CLAMP REGRESSION GUARD — rate is meaningfully higher than the old (unclamped) full-window dilution would have given', rate > 300 / windowDays)
}

// ── 17. FIRST-LOGGED-CYCLE GUARD (Adam-specified): a cycle whose own window is the very first with any matching history gets NO forecast at all — averaging that cycle's own partial data back onto its own remaining days would be circular ──
{
  const currentCycle = { start: new Date(2026, 8, 25), end: new Date(2026, 9, 24) } // Sep25..Oct24, contains asOf
  // 27 Sep — exactly 14 days (the new minimum) before asOf (10 Oct), and
  // already a whole number of weeks, so week-alignment is a no-op and
  // doesn't trim this fixture's own only transaction out of the window.
  const data = dataWith([expense('e1', '2026-09-27', 300, 'personal')]) // the ONLY matching history, dated inside currentCycle itself
  assert('dailySpendRate is nonzero — real history genuinely exists', dailySpendRate(data, personalScope, 'p1', asOf) > 0)
  check(
    'FIRST-LOGGED-CYCLE GUARD — averageAdHocSpendForCycle is 0 for the cycle that IS the first one with any history, even though the daily rate itself is not',
    averageAdHocSpendForCycle(data, personalScope, 'p1', currentCycle, asOf),
    0,
  )
}

// ── 18. Once a COMPLETED prior cycle has real history, the guard stops applying — including to the current cycle ──
{
  const currentCycle = { start: new Date(2026, 8, 25), end: new Date(2026, 9, 24) }
  const data = dataWith([
    expense('e1', '2026-08-01', 300, 'personal'), // a PRIOR, already-completed cycle
    expense('e2', '2026-10-01', 100, 'personal'), // the current cycle
  ])
  assert(
    'the current cycle is no longer the first-ever logged one, so it gets a real forecast again',
    averageAdHocSpendForCycle(data, personalScope, 'p1', currentCycle, asOf) > 0,
  )
}

// ── 19. The guard is per-cycle, not a blanket disable — a FUTURE cycle is still forecastable even while the CURRENT cycle is the first-ever logged one ──
{
  const currentCycle = { start: new Date(2026, 8, 25), end: new Date(2026, 9, 24) }
  const futureCycle = { start: new Date(2026, 9, 25), end: new Date(2026, 10, 24) }
  const data = dataWith([expense('e1', '2026-09-27', 300, 'personal')]) // only within currentCycle — see test 17's comment on this date
  check('the current cycle (the first-ever one) is blocked', averageAdHocSpendForCycle(data, personalScope, 'p1', currentCycle, asOf), 0)
  assert('a FUTURE cycle still gets a real, nonzero forecast', averageAdHocSpendForCycle(data, personalScope, 'p1', futureCycle, asOf) > 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
