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
// 2026-09-23 — a SECOND method is added below, not a
// replacement: once the week-aligned window spans
// MEDIAN_SPEND_HISTORY_DAYS (42 = 6 whole weeks), the forecast is built
// from the MEDIAN of the window's own per-week totals instead of the
// pooled daily rate. Tests 20-27 pin both paths AND the boundary between
// them, because the real risk here isn't the median arithmetic — it's
// that an account silently changes method, and therefore changes a
// number the user has already learned to read, with no release to blame
// it on. Every one of the 19 tests above still passes UNCHANGED, which
// is itself the assertion that the change is purely additive for
// accounts below the bar.
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
  MEDIAN_SPEND_HISTORY_DAYS,
  medianWeeklySpend,
  MIN_SPEND_HISTORY_DAYS,
  spendForecastMethod,
  weekAlignedWindowStart,
  weeklySpendTotals,
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

// ════════════════════════════════════════════════════════════════════
// 2026-09-23 — THE MEDIAN METHOD
// ════════════════════════════════════════════════════════════════════
//
// All fixtures below clamp the window by dating their earliest matching
// expense deliberately, since `rawWindowStart` trims the natural
// 3-cycles-back start forward to the earliest real transaction. With
// asOf = 10 Oct 2026:
//   2026-08-16 -> a 56-day (8 whole week) window, Aug16..Oct10
//   2026-08-30 -> a 42-day (6 whole week) window — EXACTLY the threshold
//   2026-09-06 -> a 35-day (5 whole week) window — one week BELOW it
// Each is verified against the implementation's own helpers rather than
// asserted from hand-done calendar arithmetic.

const futureCycle = { start: new Date(2026, 9, 25), end: new Date(2026, 10, 24) } // Oct25..Nov24 = 31 days
const currentCycle31 = { start: new Date(2026, 8, 25), end: new Date(2026, 9, 24) } // Sep25..Oct24 = 30 days

/** The pooled-mean answer for `futureCycle` over whatever fixture is passed — the CONTROL every median test below is measured against. Uses `dailySpendRate` directly, which this change leaves completely untouched, so it still reports exactly what the app would have shown before 2026-09-23. */
function meanAnswerForFutureCycle(data: AppDataV2): number {
  return round2(dailySpendRate(data, personalScope, 'p1', asOf) * 31)
}

// ── 20. The window shapes these fixtures rely on are what the implementation actually resolves ──
{
  check('MEDIAN_SPEND_HISTORY_DAYS is 42 — six whole weeks (Adam, 2026-09-23)', MEDIAN_SPEND_HISTORY_DAYS, 42)
  const eightWeeks = dataWith([expense('e1', '2026-08-16', 100, 'personal')])
  check('a fixture whose earliest expense is 2026-08-16 gives an 8-week window', daysOfSpendHistory(eightWeeks, personalScope, 'p1', asOf), 56)
  const sixWeeks = dataWith([expense('e1', '2026-08-30', 100, 'personal')])
  check('...2026-08-30 gives exactly the 42-day threshold', daysOfSpendHistory(sixWeeks, personalScope, 'p1', asOf), 42)
  const fiveWeeks = dataWith([expense('e1', '2026-09-06', 100, 'personal')])
  check('...2026-09-06 gives 35 days, one week below it', daysOfSpendHistory(fiveWeeks, personalScope, 'p1', asOf), 35)
}

// ── 21. WEEKLY BUCKETING: the window splits into whole 7-day buckets, each holding its own week's TOTAL ──
{
  // Seven ordinary £100 weeks and one deliberate £1,500 outlier (week 4)
  // — a gift, an appliance, a rare big shop. This is the fixture the
  // whole change exists for.
  const data = dataWith([
    expense('w1', '2026-08-16', 100, 'personal'),
    expense('w2', '2026-08-23', 100, 'personal'),
    expense('w3', '2026-08-30', 100, 'personal'),
    expense('w4', '2026-09-08', 1500, 'personal'), // THE OUTLIER, inside week 4 (Sep6..Sep12)
    expense('w5', '2026-09-13', 100, 'personal'),
    expense('w6', '2026-09-20', 100, 'personal'),
    expense('w7', '2026-09-27', 100, 'personal'),
    expense('w8', '2026-10-04', 100, 'personal'),
  ])
  check('weeklySpendTotals returns one bucket per whole week, OLDEST FIRST', weeklySpendTotals(data, personalScope, 'p1', asOf), [100, 100, 100, 1500, 100, 100, 100, 100])
  check('the median of those buckets is an ordinary week, NOT the outlier', medianWeeklySpend(data, personalScope, 'p1', asOf), 100)
  check('spendForecastMethod reports the median path is what ran', spendForecastMethod(data, personalScope, 'p1', asOf), 'median')

  // ── THE HEADLINE ASSERTION, and its control ──
  const medianAnswer = averageAdHocSpendForCycle(data, personalScope, 'p1', futureCycle, asOf)
  const meanAnswer = meanAnswerForFutureCycle(data)
  check('MEDIAN: the typical week (£100) scaled by the cycle (31/7)', medianAnswer, 442.86)
  check('CONTROL — the pooled MEAN over the SAME fixture is visibly dragged by the outlier', meanAnswer, 1217.86)
  assert('the mean is dragged to nearly 3x the median answer — this is the bug being fixed', meanAnswer > medianAnswer * 2.5)

  // The sharpest statement of "not dragged": the median's answer over a
  // fixture WITH the outlier is identical to the mean's answer over the
  // same fixture WITHOUT it. The outlier week is ignored, not smeared.
  const withoutOutlier = dataWith([
    expense('w1', '2026-08-16', 100, 'personal'),
    expense('w2', '2026-08-23', 100, 'personal'),
    expense('w3', '2026-08-30', 100, 'personal'),
    expense('w4', '2026-09-08', 100, 'personal'), // an ordinary week instead
    expense('w5', '2026-09-13', 100, 'personal'),
    expense('w6', '2026-09-20', 100, 'personal'),
    expense('w7', '2026-09-27', 100, 'personal'),
    expense('w8', '2026-10-04', 100, 'personal'),
  ])
  check('the median WITH the outlier == the mean WITHOUT it — the outlier week is ignored, not smeared', medianAnswer, meanAnswerForFutureCycle(withoutOutlier))
}

// ── 22. 🚨 THE UNIT IS A WEEK'S TOTAL, NOT A TRANSACTION AMOUNT ──
{
  // Eight £100 weeks, but week 1 is five £20 shops instead of one £100
  // one. A median of individual TRANSACTION amounts would answer a
  // different question entirely (the typical size of a shop, ignoring
  // how many a week contains) and would look perfectly plausible.
  const data = dataWith([
    expense('a1', '2026-08-16', 20, 'personal'),
    expense('a2', '2026-08-17', 20, 'personal'),
    expense('a3', '2026-08-18', 20, 'personal'),
    expense('a4', '2026-08-19', 20, 'personal'),
    expense('a5', '2026-08-20', 20, 'personal'),
    expense('w2', '2026-08-23', 100, 'personal'),
    expense('w3', '2026-08-30', 100, 'personal'),
    expense('w4', '2026-09-06', 100, 'personal'),
    expense('w5', '2026-09-13', 100, 'personal'),
    expense('w6', '2026-09-20', 100, 'personal'),
    expense('w7', '2026-09-27', 100, 'personal'),
    expense('w8', '2026-10-04', 100, 'personal'),
  ])
  check('five £20 shops in one week is a £100 WEEK, not five £20 data points', weeklySpendTotals(data, personalScope, 'p1', asOf), [100, 100, 100, 100, 100, 100, 100, 100])
  check('the median is £100 (the typical WEEK)', medianWeeklySpend(data, personalScope, 'p1', asOf), 100)
  check('so the forecast is £442.86', averageAdHocSpendForCycle(data, personalScope, 'p1', futureCycle, asOf), 442.86)
  // The control: what the wrong implementation would have produced. The
  // median of the twelve transaction amounts is (20 + 100) / 2 = £60,
  // which scaled by 31/7 gives £265.71.
  assert('CONTROL — a median of TRANSACTION amounts would have given £265.71, and does not', averageAdHocSpendForCycle(data, personalScope, 'p1', futureCycle, asOf) !== 265.71)
}

// ── 23. THE BOUNDARY: one week below the threshold is byte-identical to today's answer ──
{
  // Five weeks, uneven on purpose so the two methods CANNOT agree by
  // coincidence: four £100 weeks and one £600 week. Mean -> £885.71,
  // median would have been £442.86.
  const fiveWeeks = dataWith([
    expense('w1', '2026-09-06', 100, 'personal'),
    expense('w2', '2026-09-13', 100, 'personal'),
    expense('w3', '2026-09-20', 100, 'personal'),
    expense('w4', '2026-09-27', 100, 'personal'),
    expense('w5', '2026-10-04', 600, 'personal'),
  ])
  check('35 days: the method is still the MEAN', spendForecastMethod(fiveWeeks, personalScope, 'p1', asOf), 'mean')
  check('35 days: medianWeeklySpend returns 0 — the single "does not apply" signal', medianWeeklySpend(fiveWeeks, personalScope, 'p1', asOf), 0)
  check('35 days: the answer is EXACTLY what dailySpendRate alone produces — unchanged from before 2026-09-23', averageAdHocSpendForCycle(fiveWeeks, personalScope, 'p1', futureCycle, asOf), meanAnswerForFutureCycle(fiveWeeks))
  check('35 days: and that answer is £885.71, not the median’s £442.86', averageAdHocSpendForCycle(fiveWeeks, personalScope, 'p1', futureCycle, asOf), 885.71)

  // One week later — the same shape, now 42 days — and the method flips.
  const sixWeeks = dataWith([
    expense('w0', '2026-08-30', 100, 'personal'),
    expense('w1', '2026-09-06', 100, 'personal'),
    expense('w2', '2026-09-13', 100, 'personal'),
    expense('w3', '2026-09-20', 100, 'personal'),
    expense('w4', '2026-09-27', 100, 'personal'),
    expense('w5', '2026-10-04', 600, 'personal'),
  ])
  check('42 days: the method flips to MEDIAN', spendForecastMethod(sixWeeks, personalScope, 'p1', asOf), 'median')
  check('42 days: the answer is the typical week, £442.86', averageAdHocSpendForCycle(sixWeeks, personalScope, 'p1', futureCycle, asOf), 442.86)
  check('42 days: the mean over the SAME fixture would have been £811.90', meanAnswerForFutureCycle(sixWeeks), 811.9)
}

// ── 24. Eligibility is measured on the WEEK-ALIGNED window, not the raw one ──
{
  // A raw 41-day span. `weekAlignedWindowStart` trims the 6 leftover
  // days, leaving 35 — five weeks, below the bar. Reading the RAW span
  // here would be a plausible-looking off-by-one that let the median
  // take over on five buckets.
  const data = dataWith([
    expense('w0', '2026-08-31', 100, 'personal'), // trimmed OUT by week alignment
    expense('w1', '2026-09-06', 100, 'personal'),
    expense('w2', '2026-09-13', 100, 'personal'),
    expense('w3', '2026-09-20', 100, 'personal'),
    expense('w4', '2026-09-27', 100, 'personal'),
    expense('w5', '2026-10-04', 600, 'personal'),
  ])
  check('the RAW window spans 41 days', daysOfSpendHistory(data, personalScope, 'p1', asOf), 41)
  check('...but only 5 whole weeks survive alignment', weeklySpendTotals(data, personalScope, 'p1', asOf).length, 5)
  check('so the method is still the MEAN, despite 41 >= 35 and only one day short of 42', spendForecastMethod(data, personalScope, 'p1', asOf), 'mean')
}

// ── 25. 🚨 A GENUINELY £0 MEDIAN FALLS BACK TO THE MEAN — the forecast row must never silently disappear ──
{
  // Adam-confirmed 2026-09-23. Someone who does one big shop a month has
  // four £0 weeks out of six, so their middle week is £0 — and
  // buildForecastByCycle drops any cycle whose average is <= 0. Without
  // this fallback, crossing the 42-day threshold would DELETE a figure
  // they had been reading for weeks, with no release to blame.
  const monthlyShopper = dataWith([
    expense('m1', '2026-08-16', 200, 'personal'),
    expense('m2', '2026-09-13', 210, 'personal'),
  ])
  check('the window is 8 weeks, so the median method is otherwise eligible', weeklySpendTotals(monthlyShopper, personalScope, 'p1', asOf), [200, 0, 0, 0, 210, 0, 0, 0])
  check('the median week genuinely IS £0', medianWeeklySpend(monthlyShopper, personalScope, 'p1', asOf), 0)
  check('so the reported method is MEAN, not median — the caption must never claim "typical week" over a mean figure', spendForecastMethod(monthlyShopper, personalScope, 'p1', asOf), 'mean')
  const answer = averageAdHocSpendForCycle(monthlyShopper, personalScope, 'p1', futureCycle, asOf)
  assert('THE FORECAST ROW SURVIVES — a nonzero figure, not the £0 that would have deleted the row', answer > 0)
  check('...and it is exactly the pooled-mean answer, £226.96', answer, 226.96)
  check('...which is what this account showed before 2026-09-23 too', answer, meanAnswerForFutureCycle(monthlyShopper))
}

// ── 26. forecastSpendForCycle is NOT forked — it is handed a different average and nothing else ──
{
  const data = dataWith([
    expense('w1', '2026-08-16', 100, 'personal'),
    expense('w2', '2026-08-23', 100, 'personal'),
    expense('w3', '2026-08-30', 100, 'personal'),
    expense('w4', '2026-09-08', 1500, 'personal'),
    expense('w5', '2026-09-13', 100, 'personal'),
    expense('w6', '2026-09-20', 100, 'personal'),
    expense('w7', '2026-09-27', 100, 'personal'), // inside currentCycle31
    expense('w8', '2026-10-04', 100, 'personal'), // inside currentCycle31
  ])
  const average = averageAdHocSpendForCycle(data, personalScope, 'p1', currentCycle31, asOf)
  check('the median average for a 30-day cycle is £100 x 30/7', average, 428.57)
  const { forecastAmount, realSpend } = forecastSpendForCycle(data, personalScope, average, currentCycle31)
  check('real ad-hoc spend already logged in that cycle is picked up identically', realSpend, 200)
  check('and the reduction is the SAME "average minus real spend, floored at 0" rule as the mean path', forecastAmount, 228.57)
}

// ── 27. Nothing about the median path changes WHETHER a forecast shows at all — MIN_SPEND_HISTORY_DAYS is still the only gate ──
{
  const data = dataWith([
    expense('w1', '2026-08-16', 100, 'personal'),
    expense('w2', '2026-08-23', 100, 'personal'),
    expense('w3', '2026-08-30', 100, 'personal'),
    expense('w4', '2026-09-08', 1500, 'personal'),
    expense('w5', '2026-09-13', 100, 'personal'),
    expense('w6', '2026-09-20', 100, 'personal'),
    expense('w7', '2026-09-27', 100, 'personal'),
    expense('w8', '2026-10-04', 100, 'personal'),
  ])
  assert('hasSpendHistory still gates on the 14-day minimum, untouched', hasSpendHistory(data, personalScope, 'p1', asOf))
  check('MIN_SPEND_HISTORY_DAYS is still 14 — the two thresholds are independent', MIN_SPEND_HISTORY_DAYS, 14)
  // A 3-week window: past the 14-day gate, nowhere near the 42-day one.
  const threeWeeks = dataWith([expense('t1', '2026-09-20', 100, 'personal'), expense('t2', '2026-09-27', 100, 'personal'), expense('t3', '2026-10-04', 100, 'personal')])
  assert('a 3-week account still gets a forecast', hasSpendHistory(threeWeeks, personalScope, 'p1', asOf))
  check('...built by the mean, exactly as before', spendForecastMethod(threeWeeks, personalScope, 'p1', asOf), 'mean')
  check('...with no median involvement at all', medianWeeklySpend(threeWeeks, personalScope, 'p1', asOf), 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
