// Verifies that the average spend forecast CARRIES FORWARD through the
// cycle-grouped ledger's closing balances.
//
// 🚨 THE REAL BUG THIS PREVENTS (Adam-reported 2026-09-23, during the
// median-forecast UAT, from a screenshot where two future cycles showed
// balances that were not monotonic). Home's hero caption computes "projected" as
// `projectedBalance - forecastTotal`, summing EVERY cycle's forecast, and its
// own comment says that figure must equal the last cycle section's closing
// balance. It did not. The fold re-based each cycle on the raw running
// balance and subtracted only that cycle's OWN forecast, so every closing was
// overstated by the sum of all EARLIER forecasts.
//
// On a real `personal-ledger` backup the hero said -£866.80 while the final
// cycle section said +£2,275.97 — £3,142.77 apart, opposite signs. It had
// been live since 2026-09-14 and was invisible, because a real ledger's bills
// and salary move each cycle's balance enough that every figure looks
// plausible in isolation.
//
// The CONTROL below reproduces the old behaviour explicitly and asserts it
// disagrees with the hero — so this file fails if anyone reinstates it.

import { buildCycleForecastChain } from '../src/lib/cycleForecastChain'

let passed = 0
let failed = 0
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++
  else {
    failed++
    console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(expected === undefined ? actual : actual)}`)
  }
}
function assert(label: string, condition: boolean) {
  check(label, condition, true)
}
const round2 = (n: number) => Math.round(n * 100) / 100

// Four cycles. Every real row sits in the FIRST one, which is exactly the
// shape that exposed the bug: from cycle 2 onwards `upToEnd` still finds the
// cycle-1 rows, so the old code never fell through to its `carried` branch.
const cycles = [
  { startIso: '2026-08-25', endIso: '2026-09-24' },
  { startIso: '2026-09-25', endIso: '2026-10-24' },
  { startIso: '2026-10-25', endIso: '2026-11-24' },
  { startIso: '2026-11-25', endIso: '2026-12-24' },
]
const runningByDate = [
  { date: '2026-08-27', running: -120 },
  { date: '2026-09-03', running: -240 },
  { date: '2026-09-10', running: -360 },
  { date: '2026-09-17', running: -240 },
]
const forecasts: Record<string, number> = { '2026-08-25': 51.43, '2026-09-25': 514.29, '2026-10-25': 531.43, '2026-11-25': 514.29 }
const forecastFor = (startIso: string) => forecasts[startIso] ?? 0
const forecastTotal = round2(Object.values(forecasts).reduce((a, b) => a + b, 0))

// ── 1. The chain compounds ──
{
  const chain = buildCycleForecastChain(runningByDate, cycles, forecastFor, 0)
  check('cycle 1 closing — real -240.00, less its own 51.43', chain[0].closing, -291.43)
  check('cycle 2 closing — less 51.43 AND 514.29', chain[1].closing, -805.72)
  check('cycle 3 closing — less 51.43 + 514.29 + 531.43', chain[2].closing, -1337.15)
  check('cycle 4 closing — less every forecast', chain[3].closing, -1851.44)
  assert('the closings are monotonically decreasing, which they were not before', chain.every((l, i) => i === 0 || l.closing < chain[i - 1].closing))
}

// ── 2. 🚨 THE STATED INVARIANT: the last closing IS the hero's projected figure ──
{
  const chain = buildCycleForecastChain(runningByDate, cycles, forecastFor, 0)
  const projectedBalance = -240 // what computeProjection returns over this horizon
  const heroProjected = round2(projectedBalance - forecastTotal)
  check("the hero's own arithmetic", heroProjected, -1851.44)
  check('THE INVARIANT — final section closing == hero projected', chain[chain.length - 1].closing, heroProjected)
}

// ── 3. CONTROL — the OLD fold, reproduced, and the gap it produced ──
{
  let carried = 0
  const oldClosings = cycles.map(({ startIso, endIso }) => {
    const upToEnd = runningByDate.filter((r) => r.date <= endIso)
    const realClosing = upToEnd.length > 0 ? upToEnd[upToEnd.length - 1].running : carried
    const f = forecastFor(startIso)
    const closing = f > 0 ? round2(realClosing - f) : realClosing
    carried = closing
    return closing
  })
  check('the old fold re-based every cycle on the same -240.00', oldClosings, [-291.43, -754.29, -771.43, -754.29])
  assert('the old fold disagreed with the hero', oldClosings[oldClosings.length - 1] !== round2(-240 - forecastTotal))
  check('...by exactly the sum of the three EARLIER forecasts', round2(oldClosings[3] - round2(-240 - forecastTotal)), round2(51.43 + 514.29 + 531.43))
  assert('and it was not even monotonic — cycle 4 read HIGHER than cycle 3', oldClosings[3] > oldClosings[2])
}

// ── 4. Row-level running balances are offset too, so each cycle's own sum works by eye ──
{
  const chain = buildCycleForecastChain(runningByDate, cycles, forecastFor, 0)
  check('cycle 1 has no earlier forecast to carry', chain[0].priorForecasts, 0)
  check('cycle 2 carries cycle 1s', chain[1].priorForecasts, 51.43)
  check('cycle 3 carries both', chain[2].priorForecasts, 565.72)
  check('cycle 4 carries all three', chain[3].priorForecasts, 1097.15)
  // The sum a person does by eye: this cycle's last displayed row, minus
  // this cycle's forecast row, is this cycle's closing balance.
  for (let i = 0; i < cycles.length; i++) {
    check(`cycle ${i + 1}: realClosing - own forecast == closing`, round2(chain[i].realClosing - forecastFor(cycles[i].startIso)), chain[i].closing)
  }
}

// ── 5. 🚨 The no-rows branch must not double-subtract ──
{
  // Nothing dated on or before cycle 1's end: the old code's `carried`
  // branch. `carried` is ALREADY adjusted, so taking priorForecasts off it
  // again would be the obvious-looking wrong fix.
  const later = [{ date: '2026-12-01', running: -500 }]
  const chain = buildCycleForecastChain(later, cycles, forecastFor, 1000)
  check('cycle 1 falls back to the opening balance, less its own forecast', chain[0].closing, round2(1000 - 51.43))
  check('cycle 2 also has no rows — it carries cycle 1s closing, NOT that minus 51.43 twice', chain[1].closing, round2(1000 - 51.43 - 514.29))
  check('cycle 3, still no rows', chain[2].closing, round2(1000 - 51.43 - 514.29 - 531.43))
  check('cycle 4 finally has a row (-500), less every forecast', chain[3].closing, round2(-500 - forecastTotal))
}

// ── 6. With the forecast toggle OFF, nothing moves at all ──
{
  const chain = buildCycleForecastChain(runningByDate, cycles, () => 0, 0)
  check('every closing is the plain running balance', chain.map((l) => l.closing), [-240, -240, -240, -240])
  check('and no row offset anywhere', chain.map((l) => l.priorForecasts), [0, 0, 0, 0])
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
