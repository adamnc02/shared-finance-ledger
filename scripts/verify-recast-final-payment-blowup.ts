import { buildLoanSchedule } from '../src/lib/ledgerLoans'
import { SANTANDER_FIXTURE } from '../src/lib/interestConventions'
import type { Loan } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

// The exact real bug reported: a RECURRING reduce_payment overpayment,
// active for the whole rest of the loan, used to make periodsRemaining
// recalculate from the ALREADY-shrunk payment every single period — a
// runaway feedback loop (smaller payment implies longer payoff, recast
// to an even smaller payment for that longer horizon, repeat) totally
// decoupled from the loan's real fixed term. The outer loop still
// hard-stops at the real term regardless, so the balance hadn't been
// paying down fast enough to reach zero on schedule, and the final
// period dumped the entire shortfall into one payment. Reproduced
// directly with this exact fixture before the fix: final payment
// £2,116.95 against a run of £180-410 payments everywhere else.
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
  recurringOverpayment: { startDate: '2026-08-02', amount: { type: 'fixed', amount: 50 }, recastMode: 'reduce_payment' },
}

const schedule = buildLoanSchedule(baseLoan)
const regularPayments = schedule.map((e) => e.scheduledPayment)
const finalPayment = regularPayments.at(-1)!
const typicalPayment = baseLoan.monthlyPayment

// UAT 2026-09-09 — now genuinely reduce_term behaviour (see below): the
// recurring overpayment shrinks the balance directly every period with
// the payment held flat, so the loan finishes SOONER than its full
// contractual term, not exactly at it — that's correct reduce_term
// behaviour, not term drift (drift would mean running LONGER than the
// term, which is what the rest of this file's checks below still guard
// against).
check("The schedule finishes at or before the loan's real term (reduce_term pays off early, never late)", schedule.length <= baseLoan.termMonths, true)
check(
  'The final payment is NOT wildly larger than the regular payment (within 2x, generously) — was 2116.95 vs a ~410 baseline (5x+) before this fix',
  finalPayment < typicalPayment * 2,
  true,
)
check("Every payment across the whole schedule stays within a sane band of the original contractual payment (no blowups anywhere, not just the last period)", regularPayments.every((p) => p <= typicalPayment * 1.5), true)
// UAT 2026-09-09 (ed-overpay-just-single) — the ORIGINAL runaway-feedback
// scenario this whole script exists for can no longer happen at all: a
// recurring overpayment's recastMode is now ALWAYS ignored (Adam's own
// call — see ledgerLoans.ts buildLoanSchedule's doc comment), so this
// exact fixture (recastMode: 'reduce_payment' on a recurring
// overpayment) now behaves as reduce_term instead — payments stay
// perfectly FLAT throughout, they don't trend downward via a recomputed
// payment. That's the correct, intended behaviour, not a regression.
check("Payments stay perfectly flat throughout — a RECURRING overpayment's reduce_payment recastMode is now a no-op, not a recomputed lower figure", regularPayments.slice(1, -1).every((p) => p === typicalPayment), true)
check("The balance still reaches exactly zero by the end (nothing left dangling)", schedule.at(-1)!.balanceAfter, 0)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll recast-final-payment-blowup checks passed.')
