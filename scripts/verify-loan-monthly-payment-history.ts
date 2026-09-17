// Unified effective-dating work (2026-09-09) — Loan.monthlyPayment gains a
// real history mechanism (monthlyPaymentEffectiveFrom/monthlyPaymentHistory)
// mirroring RecurringTemplate.amountHistory, resolved per-period in
// buildLoanSchedule via resolveMonthlyPayment. Verifies: past periods are
// unaffected by a later payment change, periods on/after the effective
// date use the new payment, and a loan carrying BOTH a monthlyPaymentHistory
// entry and an active reduce_payment recast resolves per Adam's own call —
// the recast wins from the point it fires, history entries after that point
// are ignored.

import { buildLoanSchedule, applyLoanMonthlyPaymentChange, resolveMonthlyPayment } from '../src/lib/ledgerLoans'
import { SANTANDER_FIXTURE } from '../src/lib/interestConventions'
import type { Loan } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const baseLoan: Loan = {
  id: 'santander',
  name: 'Santander loan',
  categoryId: 'cat-loans',
  location: 'personal',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
  principal: SANTANDER_FIXTURE.principal,
  monthlyPayment: SANTANDER_FIXTURE.contractualPayment,
  termMonths: SANTANDER_FIXTURE.termMonths,
  startDate: SANTANDER_FIXTURE.firstPaymentDate,
  advanceDate: SANTANDER_FIXTURE.advanceDate,
  interestConventionId: 'flat_monthly',
  calibratedMonthlyRate: SANTANDER_FIXTURE.empiricalMonthlyRate,
}

const baselineSchedule = buildLoanSchedule(baseLoan)

// ─────────────────────────────────────────────────────────────────────
// (a)/(b) A payment increase effective from period 5's date leaves
// periods before it untouched, and periods on/after it use the new
// payment.
// ─────────────────────────────────────────────────────────────────────
const effectiveFromDate = baselineSchedule[5].date
const patch = applyLoanMonthlyPaymentChange(baseLoan, baseLoan.monthlyPayment + 50, effectiveFromDate)
const changedLoan: Loan = { ...baseLoan, ...patch }
const changedSchedule = buildLoanSchedule(changedLoan)

check('monthlyPaymentHistory records the OLD payment, anchored to the loan startDate', changedLoan.monthlyPaymentHistory, [{ effectiveFrom: baseLoan.startDate, amount: baseLoan.monthlyPayment }])
check('resolveMonthlyPayment before the effective date still returns the OLD payment', resolveMonthlyPayment(changedLoan, baselineSchedule[4].date), baseLoan.monthlyPayment)
check('resolveMonthlyPayment on/after the effective date returns the NEW payment', resolveMonthlyPayment(changedLoan, effectiveFromDate), baseLoan.monthlyPayment + 50)

check(
  'Periods before the effective date match the no-history baseline exactly',
  changedSchedule.slice(0, 5).every((e, i) => e.scheduledPayment === baselineSchedule[i].scheduledPayment && e.balanceAfter === baselineSchedule[i].balanceAfter),
  true,
)
check(
  'Periods on/after the effective date use the new (higher) payment, so the balance is drawn down faster than the baseline',
  changedSchedule[6].balanceAfter < baselineSchedule[6].balanceAfter,
  true,
)
check('The schedule pays off sooner (or the same) than the no-history baseline, since every later period pays more', changedSchedule.length <= baselineSchedule.length, true)

// ─────────────────────────────────────────────────────────────────────
// (d) A loan with BOTH a monthlyPaymentHistory entry AND an active
// reduce_payment recast — the recast wins from the point it fires;
// later monthlyPaymentHistory entries are ignored from then on.
// ─────────────────────────────────────────────────────────────────────
const recastDate = baselineSchedule[2].date
// A history entry effective AFTER the recast fires — should be ignored
// once the recast is active, per Adam's own call.
const historyAfterRecastDate = baselineSchedule[8].date
const recastAndHistoryLoan: Loan = {
  ...baseLoan,
  ...applyLoanMonthlyPaymentChange(baseLoan, baseLoan.monthlyPayment + 200, historyAfterRecastDate),
  overpayments: [{ id: 'o1', date: recastDate, amount: 1000, recastMode: 'reduce_payment' }],
}
const recastAndHistorySchedule = buildLoanSchedule(recastAndHistoryLoan)
// Compare against the SAME recast with no history entry at all — if the
// history entry after the recast date is genuinely ignored, the two
// schedules must be identical.
const recastOnlyLoan: Loan = { ...baseLoan, overpayments: [{ id: 'o1', date: recastDate, amount: 1000, recastMode: 'reduce_payment' }] }
const recastOnlySchedule = buildLoanSchedule(recastOnlyLoan)
check(
  'Once a reduce_payment recast is active, a later monthlyPaymentHistory entry has zero effect on the schedule',
  recastAndHistorySchedule.every((e, i) => e.scheduledPayment === recastOnlySchedule[i]?.scheduledPayment && e.balanceAfter === recastOnlySchedule[i]?.balanceAfter),
  true,
)
check('...and the schedule still reaches exactly zero (recast keeps converging normally)', recastAndHistorySchedule.at(-1)!.balanceAfter, 0)

// A history entry effective BEFORE the recast fires still applies for
// the periods between its own effective date and the recast.
const historyBeforeRecastLoan: Loan = {
  ...baseLoan,
  ...applyLoanMonthlyPaymentChange(baseLoan, baseLoan.monthlyPayment + 50, baselineSchedule[0].date),
  overpayments: [{ id: 'o1', date: recastDate, amount: 1000, recastMode: 'reduce_payment' }],
}
const historyBeforeRecastSchedule = buildLoanSchedule(historyBeforeRecastLoan)
check(
  'A monthlyPaymentHistory entry effective BEFORE the recast fires still raises the payment for the periods up to the recast',
  historyBeforeRecastSchedule[1].scheduledPayment,
  baseLoan.monthlyPayment + 50,
)

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll loan-monthly-payment-history checks passed.')
