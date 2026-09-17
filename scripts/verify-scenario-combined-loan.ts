// Verifies the Bug 8 fix (App_Dev.md "Bugs", 2026-09 session — "lump sum
// was 2000, remaining after shows 0" / no monthly-cash impact showing for
// either a reduce_payment lump sum or a recurring overpayment). Root
// cause: ScenarioLoanOutcome.remainingAfterEvents/effectiveMonthlyPayment
// are anchored to the schedule entry at the CHRONOLOGICALLY LAST event
// supplied to simulateScenarioLoan — for a combined scenario (a lump sum
// AND a recurring overpayment on the same loan), the recurring
// overpayment's own 600-month materialization means that "last event" is
// always ~50 years out, by which point the loan is long paid off,
// collapsing both figures to (near) zero regardless of what any
// INDIVIDUAL action on the loan actually did on its own date. The fix
// (scheduleEntryAsOf) reads the combined schedule at each action's OWN
// date instead of the outcome's single terminal anchor.

import { simulateScenarioLoan, scheduleEntryAsOf, type ScenarioLoanEvent } from '../src/lib/loans'
import { toLocalIsoDate } from '../src/lib/date'
import { addMonths } from 'date-fns'
import type { Loan } from '../src/types/models'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 1) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : actual === expected
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}
function checkTrue(label: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${label}`)
  if (!cond) failures++
}

// A Tesco-like loan (bridged shape — calibratedMonthlyRate always set for
// anything reaching lib/loans.ts in the live app, per Loan.calibratedMonthlyRate's
// own comment in types/models.ts).
const loan: Loan = {
  id: 'loan-tesco',
  name: 'Tesco',
  firstPaymentDate: '2026-09-01',
  totalAmount: 7374.55,
  monthlyPayment: 264,
  location: 'personal',
  ownerId: 'ella',
  payee: '',
  payeeSharePercent: 100,
  calibratedMonthlyRate: 0.089 / 12, // back-solved-equivalent flat monthly rate from an 8.9% APR
}

const lumpDate = '2026-09-17'
const overpaymentStart = '2026-10-01'

// Exactly what scenarios.ts's own action-processing loop builds: the
// £2000 lump sum (reduce_payment) as ONE event, plus the £100/month
// recurring overpayment materialized as 600 monthly events (reduce_term)
// — the same combined per-loan event list a real "Combined (1 scenario)"
// with both actions produces.
const events: ScenarioLoanEvent[] = [{ date: lumpDate, amount: 2000, recastMode: 'reduce_payment' }]
const start = new Date(overpaymentStart)
for (let i = 0; i < 600; i++) {
  events.push({ date: toLocalIsoDate(addMonths(start, i)), amount: 100, recastMode: 'reduce_term' })
}

const outcome = simulateScenarioLoan(loan, events)
checkTrue('Combined outcome has a real schedule', outcome.hasSchedule)

// The OLD bug, demonstrated directly: the outcome-level anchor fields are
// tied to the chronologically last (~50-years-out) event, so they
// collapse to the loan's eventual payoff state — genuinely ~0 — no
// matter what the £2000 lump sum alone actually did on 2026-09-17. This
// isn't asserting new behaviour; it's confirming *why* reading those two
// fields directly was always going to be wrong for a combined scenario,
// so the fix below is reading from the right place instead.
checkTrue('(Root cause) remainingAfterEvents collapses to ~0 — the loan is long paid off by the 50-years-out anchor', outcome.remainingAfterEvents < 50)

// The FIX: reading the schedule at each action's own date.
const asOfLump = scheduleEntryAsOf(outcome.schedule, lumpDate)
checkTrue('scheduleEntryAsOf finds an entry for the lump sum\'s own date', !!asOfLump)
checkTrue('Balance right after the £2000 lump sum is a real, non-trivial figure (not 0, not the full original balance either)', !!asOfLump && asOfLump.balanceAfter > 3000 && asOfLump.balanceAfter < 7374.55)
checkTrue('Monthly payment right after the lump sum (reduce_payment) is genuinely LOWER than the original £264', !!asOfLump && asOfLump.scheduledPayment < 264 && asOfLump.scheduledPayment > 0)

const asOfOverpaymentStart = scheduleEntryAsOf(outcome.schedule, overpaymentStart)
checkTrue('scheduleEntryAsOf finds an entry for the recurring overpayment\'s own start date', !!asOfOverpaymentStart)
checkTrue('Balance right after the overpayment starts is a real, non-trivial figure', !!asOfOverpaymentStart && asOfOverpaymentStart.balanceAfter > 0 && asOfOverpaymentStart.balanceAfter < 7374.55)

// Sanity check: scheduleEntryAsOf on a SINGLE-event outcome (no combined
// pollution) should agree with the outcome's own terminal anchor — this
// confirms the fix doesn't change anything for the common (single-action)
// case, only the previously-broken multi-action-on-the-same-loan one.
const singleEventOutcome = simulateScenarioLoan(loan, [{ date: lumpDate, amount: 2000, recastMode: 'reduce_payment' }])
const soloAsOfLump = scheduleEntryAsOf(singleEventOutcome.schedule, lumpDate)
check('Single-action case: scheduleEntryAsOf agrees with the outcome\'s own remainingAfterEvents', soloAsOfLump?.balanceAfter, singleEventOutcome.remainingAfterEvents, 0.01)
check('Single-action case: scheduleEntryAsOf agrees with the outcome\'s own effectiveMonthlyPayment', soloAsOfLump?.scheduledPayment, singleEventOutcome.effectiveMonthlyPayment, 0.01)

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
