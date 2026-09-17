// D7 verification — the overpayment recast choice (loan-amortisation-
// engine scope §9, §11.3): reduce_term vs reduce_payment for both
// one-off and recurring overpayments, and the preview functions the
// follow-up UI step reads from before the person commits.

import { buildLoanSchedule, applyLoanOverpayment, previewOverpaymentRecast, previewRecurringOverpaymentRecast } from '../src/lib/ledgerLoans'
import { standardPayment, remainingPeriodsFor } from '../src/lib/interestConventions'
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
// 1. remainingPeriodsFor is a genuine, precise inverse of standardPayment
// ─────────────────────────────────────────────────────────────────────
const P = 7796
const r = SANTANDER_FIXTURE.empiricalMonthlyRate
const n = 23
const paymentForN = standardPayment(P, r, n)
check('remainingPeriodsFor recovers the exact period count standardPayment was computed for', remainingPeriodsFor(P, r, paymentForN), n)

// ─────────────────────────────────────────────────────────────────────
// 2. One-off overpayment: reduce_term (default) — payment unchanged,
//    term genuinely shortens (scope §9's default behaviour, unchanged
//    from before D7 — no new engine work needed for this path at all)
// ─────────────────────────────────────────────────────────────────────
const reduceTermLoan: Loan = { ...baseLoan, overpayments: [{ id: 'o1', date: '2026-08-02', amount: 1000, recastMode: 'reduce_term' }] }
const reduceTermSchedule = buildLoanSchedule(reduceTermLoan)
check('reduce_term: schedule is shorter than the no-overpayment baseline', reduceTermSchedule.length < baselineSchedule.length, true)
check('reduce_term: the regular payment stays exactly the same throughout', reduceTermSchedule.slice(2).every((e) => e.scheduledPayment === baseLoan.monthlyPayment || e.date === reduceTermSchedule.at(-1)!.date), true)

// ─────────────────────────────────────────────────────────────────────
// 3. One-off overpayment: reduce_payment — term stays close to
//    original, payment drops once and holds
// ─────────────────────────────────────────────────────────────────────
const reducePaymentLoan: Loan = { ...baseLoan, overpayments: [{ id: 'o1', date: '2026-08-02', amount: 1000, recastMode: 'reduce_payment' }] }
const reducePaymentSchedule = buildLoanSchedule(reducePaymentLoan)
check('reduce_payment: term stays within 1 period of the no-overpayment baseline (the whole point of this recast mode)', Math.abs(reducePaymentSchedule.length - baselineSchedule.length) <= 1, true)
check("reduce_payment: the payment for the period the overpayment lands on is UNCHANGED (recast takes effect from the NEXT period)", reducePaymentSchedule[1]?.scheduledPayment, baseLoan.monthlyPayment)
check('reduce_payment: the payment for the period AFTER the overpayment is genuinely lower', (reducePaymentSchedule[2]?.scheduledPayment ?? 0) < baseLoan.monthlyPayment, true)
check('reduce_payment: that lower payment then holds steady (a ONE-OFF overpayment only recasts once, not every period)', reducePaymentSchedule[2]?.scheduledPayment, reducePaymentSchedule[3]?.scheduledPayment)

// ─────────────────────────────────────────────────────────────────────
// 4. Overpayments still carry £0 interest regardless of recast mode
//    (scope §9's confirmed rule — unaffected by which recast is chosen)
// ─────────────────────────────────────────────────────────────────────
const overpaymentEntry = reducePaymentSchedule.find((e) => e.overpaymentApplied > 0)
check('An overpayment itself never carries an interest component, regardless of recast mode', overpaymentEntry?.overpaymentApplied, 1000)

// ─────────────────────────────────────────────────────────────────────
// 5. UAT 2026-09-09 (ed-overpay-just-single) — a RECURRING overpayment's
//    recastMode is now ALWAYS ignored by buildLoanSchedule; it's treated
//    as reduce_term unconditionally (Adam's own call, after a single-
//    occurrence amount override on a recurring reduce_payment overpayment
//    unexpectedly re-amortised every future contractual payment — the
//    UI no longer offers this choice for a recurring overpayment at all).
//    Confirmed even against a loan whose recurringOverpayment still has
//    recastMode: 'reduce_payment' persisted (legacy data, or a stale
//    value from before this change) — it must have zero effect.
// ─────────────────────────────────────────────────────────────────────
const recurringReducePaymentLoan: Loan = { ...baseLoan, recurringOverpayment: { startDate: '2026-08-02', amount: { type: 'fixed', amount: 50 }, recastMode: 'reduce_payment' } }
const recurringSchedule = buildLoanSchedule(recurringReducePaymentLoan)
const paymentsFromAug = recurringSchedule.slice(1, 5).map((e) => e.scheduledPayment)
check('A stored reduce_payment recastMode on a RECURRING overpayment is ignored — the payment stays fixed across periods', new Set(paymentsFromAug).size, 1)
check('...matching the loan\'s own regular monthlyPayment exactly (reduce_term behaviour), not a recomputed lower figure', paymentsFromAug.every((p) => p === baseLoan.monthlyPayment), true)

// Recurring + reduce_term (the default, and now the ONLY real behaviour for a recurring overpayment).
const recurringReduceTermLoan: Loan = { ...baseLoan, recurringOverpayment: { startDate: '2026-08-02', amount: { type: 'fixed', amount: 50 }, recastMode: 'reduce_term' } }
const recurringReduceTermSchedule = buildLoanSchedule(recurringReduceTermLoan)
check('Recurring reduce_term: the regular payment stays fixed even though a recurring overpayment is landing every period', recurringReduceTermSchedule[2]?.scheduledPayment, baseLoan.monthlyPayment)
check('A recurring overpayment stored as reduce_payment produces an IDENTICAL schedule to one stored as reduce_term — recastMode is a true no-op for recurring overpayments', recurringSchedule, recurringReduceTermSchedule)

// ─────────────────────────────────────────────────────────────────────
// 6. Preview functions: what the follow-up UI step reads BEFORE
//    committing must match what actually happens once committed
// ─────────────────────────────────────────────────────────────────────
const preview = previewOverpaymentRecast(baseLoan, 1000, '2026-08-02')
check('Preview (reduce_payment): new monthly payment matches the real committed schedule\'s post-recast payment', preview.reducePayment.newMonthlyPayment, reducePaymentSchedule[2]?.scheduledPayment)
check('Preview (reduce_term): payoff date matches the real committed schedule\'s final date', preview.reduceTerm.payoffDate, reduceTermSchedule.at(-1)?.date)
check('Preview (reduce_term): final repayment matches the real committed schedule\'s final payment', preview.reduceTerm.finalPayment, reduceTermSchedule.at(-1)?.scheduledPayment)
check("Preview doesn't mutate the original loan's overpayments", baseLoan.overpayments.length, 0)

const recurringPreview = previewRecurringOverpaymentRecast(baseLoan, { startDate: '2026-08-02', amount: { type: 'fixed', amount: 50 } })
check('Recurring preview (reduce_payment): matches the real committed recurring+reduce_payment schedule\'s post-recast payment', recurringPreview.reducePayment.newMonthlyPayment, recurringSchedule[2]?.scheduledPayment)
check('Recurring preview (reduce_term): matches the real committed recurring+reduce_term schedule\'s payoff date', recurringPreview.reduceTerm.payoffDate, recurringReduceTermSchedule.at(-1)?.date)

// ─────────────────────────────────────────────────────────────────────
// 7. applyLoanOverpayment defaults to reduce_term when recastMode isn't
//    passed (backward compatibility — every pre-D7 call site/test)
// ─────────────────────────────────────────────────────────────────────
const { overpayment: defaultOverpayment } = applyLoanOverpayment(baseLoan, 500, '2026-08-02', 'test note')
check('applyLoanOverpayment defaults recastMode to reduce_term when not specified', defaultOverpayment.recastMode, 'reduce_term')

const { overpayment: explicitOverpayment } = applyLoanOverpayment(baseLoan, 500, '2026-08-02', undefined, 'reduce_payment')
check('applyLoanOverpayment passes an explicit recastMode through', explicitOverpayment.recastMode, 'reduce_payment')

console.log(failures === 0 ? '\nAll loan-recast checks passed.' : `\n${failures} loan-recast check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
