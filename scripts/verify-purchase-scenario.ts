// Verifies the What-if 'purchase' action end to end:
//  - the DATED figures (lib/purchaseImpact.ts) — balance on the day, and
//    the projected balance at the end of the cycle that day falls in;
//  - the UNDATED figure (lib/scenarios.ts) — a purchase is one-off cash
//    out, same as selling an asset in reverse;
//  - that the two are consistent rather than double-counting.
//
// The assertions that matter most are the ones tying purchaseImpact's
// numbers back to computeProjection's own: the entire reason
// computeProjection was refactored to sit on top of
// computeProjectionToDate is so a purchase can't quietly disagree with
// the Summary hero about what the balance is. Those are asserted
// directly (see section 2) rather than assumed.

import { computePurchaseImpacts, computePurchaseImpactsForScenarios } from '../src/lib/purchaseImpact'
import { computeProjection } from '../src/lib/projection'
import { calculateScenarioImpact } from '../src/lib/scenarios'
import { cycleBoundsForDate } from '../src/lib/payCycle'
import { toLocalIsoDate } from '../src/lib/date'
import type { AppDataV2, PayCycleConfig, Transaction } from '../src/types/ledger'
import type { AppData, Scenario } from '../src/types/models'

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

// ── Fixture ─────────────────────────────────────────────────────────────
// Cycle runs 1st–end of month. Opening balance £1,000 as at 1 Sep 2026.
// One pending bill of £200 on the 10th, one of £300 on the 25th.
// Everything is a plain stored pending Transaction so the numbers here
// are arithmetic anyone can check by hand, with no salary/loan/card
// generation in the way.

const payCycle: PayCycleConfig = {
  personId: 'p1',
  openingBalance: 1000,
  openingBalanceDate: '2026-09-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 1,
}

function tx(id: string, date: string, amount: number, status: 'cleared' | 'pending'): Transaction {
  return {
    id,
    date,
    amount,
    direction: 'out',
    type: 'expense',
    status,
    location: 'personal',
    ownerId: 'p1',
    name: id,
    categoryId: 'bills',
    paymentMethod: 'card',
  } as unknown as Transaction
}

const data: AppDataV2 = {
  primaryPersonId: 'p1',
  people: [{ id: 'p1', name: 'Test', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [] }],
  categories: [],
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  transactions: [tx('bill-a', '2026-09-10', 200, 'pending'), tx('bill-b', '2026-09-25', 300, 'pending')],
  payCycles: [payCycle],
  pensions: [],
  scenarios: [],
} as unknown as AppDataV2

const asOf = new Date(2026, 8, 5) // 5 Sep 2026

function purchaseScenario(actions: { id: string; name: string; value: number; purchaseDate: string }[]): Scenario {
  return {
    id: 'sc1',
    name: 'Buying things',
    includeInCumulative: true,
    actions: actions.map((a) => ({ id: a.id, type: 'purchase' as const, label: 'Buy something', name: a.name, value: a.value, purchaseDate: a.purchaseDate })),
  }
}

// ── 1. The core case ────────────────────────────────────────────────────
// Buy a £400 washing machine on 15 Sep. By then bill-a (£200, 10th) has
// come out but bill-b (£300, 25th) hasn't: 1000 - 200 = 800.
// After the purchase: 400. By cycle end (30 Sep) bill-b lands too:
// 800 - 300 = 500 without it, 100 with it.

const single = purchaseScenario([{ id: 'a1', name: 'Washing machine', value: 400, purchaseDate: '2026-09-15' }])
const [wm] = computePurchaseImpacts(data, 'p1', payCycle, single, asOf)

check('name carried through', wm.name, 'Washing machine')
check('balance on the day, before the purchase', wm.balanceOnDateBefore, 800)
check('balance on the day, after the purchase', wm.balanceOnDateAfter, 400)
check('cycle containing the purchase starts on the 1st', wm.cycleStart, '2026-09-01')
check('cycle containing the purchase ends on the 30th', wm.cycleEnd, '2026-09-30')
check('end-of-cycle projected balance WITHOUT the purchase', wm.cycleEndBalanceBefore, 500)
check('end-of-cycle projected balance INCLUDING the purchase', wm.cycleEndBalanceAfter, 100)
assert('a comfortably affordable purchase raises no warning on the day', !wm.goesNegativeOnDate)
assert('...nor by cycle end', !wm.goesNegativeByCycleEnd)
assert('a future date is not flagged as past', !wm.isPastDate)

// The purchase must only move the two "after" figures — the difference
// between before and after is exactly its price, at both points.
check('the purchase changes the day figure by exactly its price', wm.balanceOnDateBefore - wm.balanceOnDateAfter, 400)
check('the purchase changes the cycle-end figure by exactly its price', wm.cycleEndBalanceBefore - wm.cycleEndBalanceAfter, 400)

// ── 2. Consistency with the Summary page's own projection ───────────────
// This is the assertion the refactor exists for.

const projection = computeProjection(data, 'p1', payCycle, 'current_cycle', asOf)
check('cycle end matches the projection horizon', wm.cycleEnd, projection.horizonEnd)
check("end-of-cycle 'without' figure IS the hero's projected balance", wm.cycleEndBalanceBefore, projection.projectedBalance)

// A purchase dated on the cycle end itself must agree with the same figure.
const onCycleEnd = computePurchaseImpacts(data, 'p1', payCycle, purchaseScenario([{ id: 'a2', name: 'Sofa', value: 50, purchaseDate: '2026-09-30' }]), asOf)[0]
check('a purchase dated on cycle end sees the projected balance that day', onCycleEnd.balanceOnDateBefore, projection.projectedBalance)
check('...and its two "before" figures coincide', onCycleEnd.balanceOnDateBefore, onCycleEnd.cycleEndBalanceBefore)

// ── 3. Timing genuinely matters ─────────────────────────────────────────
// The same purchase, a day either side of the £300 bill on the 25th.

const before25 = computePurchaseImpacts(data, 'p1', payCycle, purchaseScenario([{ id: 'a3', name: 'TV', value: 100, purchaseDate: '2026-09-24' }]), asOf)[0]
const after25 = computePurchaseImpacts(data, 'p1', payCycle, purchaseScenario([{ id: 'a4', name: 'TV', value: 100, purchaseDate: '2026-09-26' }]), asOf)[0]

check('day before the £300 bill: balance is still 800', before25.balanceOnDateBefore, 800)
check('day after the £300 bill: balance is 500', after25.balanceOnDateBefore, 500)
check('...but both land on the same end-of-cycle figure', before25.cycleEndBalanceAfter, after25.cycleEndBalanceAfter)

// ── 4. Affordable on the day, not by cycle end ──────────────────────────
// The distinction the two warnings exist for: £700 on the 15th leaves
// £100 that day, but the £300 bill on the 25th then takes it to -£200.

const tight = computePurchaseImpacts(data, 'p1', payCycle, purchaseScenario([{ id: 'a5', name: 'Holiday', value: 700, purchaseDate: '2026-09-15' }]), asOf)[0]
check('affordable on the day', tight.balanceOnDateAfter, 100)
assert('...so no same-day warning', !tight.goesNegativeOnDate)
check('but the cycle ends short', tight.cycleEndBalanceAfter, -200)
assert('...which IS flagged', tight.goesNegativeByCycleEnd)

// And the plainly unaffordable case flags both.
const tooMuch = computePurchaseImpacts(data, 'p1', payCycle, purchaseScenario([{ id: 'a6', name: 'Car', value: 5000, purchaseDate: '2026-09-15' }]), asOf)[0]
assert('an unaffordable purchase is flagged on the day', tooMuch.goesNegativeOnDate)
assert('...and by cycle end', tooMuch.goesNegativeByCycleEnd)

// ── 5. Several purchases are CUMULATIVE, in date order ──────────────────
// Two £400 purchases: each is individually affordable, together they
// aren't. Evaluating the second against an untouched baseline would
// report £800 available on the 20th and hide that entirely.

const two = purchaseScenario([
  { id: 'b2', name: 'Fridge', value: 400, purchaseDate: '2026-09-20' },
  { id: 'b1', name: 'Sofa', value: 400, purchaseDate: '2026-09-15' },
])
const cumulative = computePurchaseImpacts(data, 'p1', payCycle, two, asOf)

check('two purchases returned', cumulative.length, 2)
check('returned in DATE order, not the order they were added', cumulative.map((p) => p.name), ['Sofa', 'Fridge'])
check('first purchase sees the untouched balance', cumulative[0].balanceOnDateBefore, 800)
check('first purchase leaves 400', cumulative[0].balanceOnDateAfter, 400)
check("second purchase sees the FIRST one's effect, not the untouched balance", cumulative[1].balanceOnDateBefore, 400)
check('second purchase leaves nothing', cumulative[1].balanceOnDateAfter, 0)
check('cycle end reflects both purchases', cumulative[1].cycleEndBalanceAfter, -300)
assert('...and the shortfall is flagged', cumulative[1].goesNegativeByCycleEnd)

// Same two purchases split across two scenarios must combine identically.
const combined = computePurchaseImpactsForScenarios(
  data,
  'p1',
  payCycle,
  [purchaseScenario([{ id: 'b1', name: 'Sofa', value: 400, purchaseDate: '2026-09-15' }]), purchaseScenario([{ id: 'b2', name: 'Fridge', value: 400, purchaseDate: '2026-09-20' }])],
  asOf,
)
check('combining two scenarios gives the same cumulative result', combined.map((p) => p.balanceOnDateAfter), [400, 0])

// ── 6. A purchase in a LATER cycle ──────────────────────────────────────
// The horizon is derived from the purchase date itself, so a purchase
// beyond the current cycle must still see every bill between now and
// then rather than an inflated balance from a horizon that stopped short.

const nextCycleData: AppDataV2 = {
  ...data,
  transactions: [...data.transactions, tx('bill-c', '2026-10-05', 150, 'pending')],
}
const later = computePurchaseImpacts(nextCycleData, 'p1', payCycle, purchaseScenario([{ id: 'c1', name: 'Bike', value: 100, purchaseDate: '2026-10-10' }]), asOf)[0]

check('a later-cycle purchase reports ITS cycle, not the current one', [later.cycleStart, later.cycleEnd], ['2026-10-01', '2026-10-31'])
check('...and sees every intervening bill (1000-200-300-150)', later.balanceOnDateBefore, 350)
check('...leaving the right figure', later.balanceOnDateAfter, 250)

// ── 7. Past dates are marked, not hidden ────────────────────────────────

const past = computePurchaseImpacts(data, 'p1', payCycle, purchaseScenario([{ id: 'd1', name: 'Shoes', value: 20, purchaseDate: '2026-09-02' }]), asOf)[0]
assert('a past-dated purchase is flagged as past', past.isPastDate)
check('...and still reports real figures', past.balanceOnDateBefore, 1000)

// ── 8. Incomplete purchases compute to nothing rather than to zero ──────
// A missing date or a zero cost must be skipped entirely — NOT surfaced
// as a £0 purchase, which would read as a real, affordable one.

check(
  'a purchase with no date is skipped',
  computePurchaseImpacts(data, 'p1', payCycle, { id: 's', name: 'x', includeInCumulative: true, actions: [{ id: 'e1', type: 'purchase', label: '', value: 100 }] }, asOf).length,
  0,
)
check(
  'a purchase with no cost is skipped',
  computePurchaseImpacts(data, 'p1', payCycle, purchaseScenario([{ id: 'e2', name: 'x', value: 0, purchaseDate: '2026-09-15' }]), asOf).length,
  0,
)
check('a scenario with no purchases at all returns an empty list', computePurchaseImpacts(data, 'p1', payCycle, { id: 's', name: 'x', includeInCumulative: true, actions: [] }, asOf).length, 0)

// ── 9. The undated engine still counts it as one-off cash out ───────────
// lib/scenarios.ts has no calendar, but a purchase is still money
// leaving — it has to show in oneOffCashImpact exactly like any
// other one-off cost, or the existing summary silently under-reports.

const legacyData: AppData = {
  people: [{ id: 'p1', name: 'Test', color: '#ff5b4c', salary: { grossAnnual: 0, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] } }],
  bills: [],
  loans: [],
  creditCards: [],
  pensions: [],
  scenarios: [],
  primaryPersonId: 'p1',
}

const cashImpact = calculateScenarioImpact(single, legacyData, 'p1', 0)
check('a purchase is one-off cash OUT', cashImpact.oneOffCashImpact, -400)
check('...and has no recurring monthly effect', cashImpact.monthlyImpact, 0)
check('...and creates no loan/card impact rows', cashImpact.loanImpacts.length, 0)

// Sell an asset for £1,000 and spend £400 of it: net +£600.
const sellThenBuy: Scenario = {
  id: 'sc2',
  name: 'Sell then buy',
  includeInCumulative: true,
  actions: [
    { id: 'f1', type: 'sell_asset', label: 'Sell an asset', value: 1000 },
    { id: 'f2', type: 'purchase', label: 'Buy something', name: 'Washing machine', value: 400, purchaseDate: '2026-09-15' },
  ],
}
check('a purchase nets off against a sale in the same scenario', calculateScenarioImpact(sellThenBuy, legacyData, 'p1', 0).oneOffCashImpact, 600)

// ── 10. Interaction with the cycleStartFollowsPayday override ───────────
// Purchase impacts go through cycleBoundsForDate with the full config,
// so the cycle a purchase is measured against must follow the override
// rather than the fixed day.

// The override has to be STORED in data.payCycles as well as passed in:
// the app always passes the stored config (Scenarios.tsx), and the cycle
// lookup reads the stored one (resolveCycleBounds). Passing it only as the
// argument described a state the app never produces, and failed.
const followsPayday: PayCycleConfig = { ...payCycle, paydayDayOfMonth: 28, cycleStartFollowsPayday: true }
const followsPaydayData: AppDataV2 = { ...data, payCycles: [followsPayday] }
const overridden = computePurchaseImpacts(followsPaydayData, 'p1', followsPayday, purchaseScenario([{ id: 'g1', name: 'Desk', value: 50, purchaseDate: '2026-09-15' }]), asOf)[0]
const expectedBounds = cycleBoundsForDate(new Date(2026, 8, 15), followsPayday)

check('purchase cycle honours cycleStartFollowsPayday (start)', overridden.cycleStart, toLocalIsoDate(expectedBounds.start))
check('purchase cycle honours cycleStartFollowsPayday (end)', overridden.cycleEnd, toLocalIsoDate(expectedBounds.end))
assert('...and that is genuinely a different cycle from the fixed-day one', overridden.cycleEnd !== wm.cycleEnd)

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\nverify-purchase-scenario: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
