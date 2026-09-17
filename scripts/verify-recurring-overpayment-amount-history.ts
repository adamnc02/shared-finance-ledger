// Unified effective-dating work (2026-09-09) — LoanRecurringOverpayment
// gains real historized effective-dating for its own `amount` (mirroring
// Loan.monthlyPayment/RecurringTemplate.amount), PLUS a genuine single-
// occurrence override (amountOverrides) for "just a single payment" — a
// concept Adam explicitly wanted for recurring overpayments even though he
// ruled it out for a loan's own monthlyPayment. Verifies: a permanent
// ("all future") change only reaches periods on/after the effective date,
// a single-occurrence override affects exactly the one date it's keyed to
// and nothing else (before or after), and an override takes precedence
// over whatever the standing history would otherwise resolve to on that
// exact date.

import { buildLoanSchedule, resolveRecurringOverpaymentAmount, applyRecurringOverpaymentAmountChange, applyRecurringOverpaymentSingleAmountOverride } from '../src/lib/ledgerLoans'
import { SANTANDER_FIXTURE } from '../src/lib/interestConventions'
import type { Loan, LoanRecurringOverpayment } from '../src/types/ledger'

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

const baseSchedule = buildLoanSchedule(baseLoan)

const recurring: LoanRecurringOverpayment = {
  startDate: baseSchedule[0].date,
  amount: { type: 'fixed', amount: 40 },
  recastMode: 'reduce_term',
}
const loanWithRecurring: Loan = { ...baseLoan, recurringOverpayment: recurring }
const baseline = buildLoanSchedule(loanWithRecurring)

// ─────────────────────────────────────────────────────────────────────
// Permanent ("all future") change
// ─────────────────────────────────────────────────────────────────────
const effectiveFromDate = baseline[5].date
const permanentChanged: LoanRecurringOverpayment = { ...recurring, ...applyRecurringOverpaymentAmountChange(recurring, { type: 'fixed', amount: 100 }, effectiveFromDate) }
check('amountHistory records the OLD amount, anchored to the overpayment startDate', permanentChanged.amountHistory, [{ effectiveFrom: recurring.startDate, amount: { type: 'fixed', amount: 40 } }])
check('resolveRecurringOverpaymentAmount before the effective date still returns the OLD amount', resolveRecurringOverpaymentAmount(permanentChanged, baseline[4].date), { type: 'fixed', amount: 40 })
check('resolveRecurringOverpaymentAmount on/after the effective date returns the NEW amount', resolveRecurringOverpaymentAmount(permanentChanged, effectiveFromDate), { type: 'fixed', amount: 100 })

const permanentSchedule = buildLoanSchedule({ ...baseLoan, recurringOverpayment: permanentChanged })
check(
  'Periods before the effective date match the no-change baseline exactly',
  permanentSchedule.slice(0, 5).every((e, i) => e.recurringOverpaymentApplied === baseline[i].recurringOverpaymentApplied && e.balanceAfter === baseline[i].balanceAfter),
  true,
)
check('The period AT the effective date applies the new £100 overpayment', permanentSchedule[5].recurringOverpaymentApplied, 100)
check('A later period also keeps applying the new £100 overpayment', permanentSchedule[6].recurringOverpaymentApplied, 100)

// ─────────────────────────────────────────────────────────────────────
// Single-occurrence override — affects exactly one date, nothing else
// ─────────────────────────────────────────────────────────────────────
const overrideDate = baseline[3].date
const withOverride: LoanRecurringOverpayment = { ...recurring, ...applyRecurringOverpaymentSingleAmountOverride(recurring, { type: 'fixed', amount: 500 }, overrideDate) }
const overrideSchedule = buildLoanSchedule({ ...baseLoan, recurringOverpayment: withOverride })

check('The override date applies the overridden £500 amount', overrideSchedule[3].recurringOverpaymentApplied, 500)
check('The period BEFORE the override date is completely unaffected (still the standing £40)', overrideSchedule[2].recurringOverpaymentApplied, baseline[2].recurringOverpaymentApplied)
check('The period AFTER the override date reverts to the standing £40 — the override does not leak forward', overrideSchedule[4].recurringOverpaymentApplied, baseline[4].recurringOverpaymentApplied)
check('The standing amount/history is completely untouched by a single-occurrence override', withOverride.amount, recurring.amount)
check('...and amountHistory stays undefined too', withOverride.amountHistory, undefined)

// An override on the SAME exact date as an amountHistory entry takes
// precedence over the history resolution.
const overrideOverHistory: LoanRecurringOverpayment = {
  ...permanentChanged,
  ...applyRecurringOverpaymentSingleAmountOverride(permanentChanged, { type: 'fixed', amount: 999 }, effectiveFromDate),
}
check('An override on the exact date an amountHistory change also takes effect wins outright', resolveRecurringOverpaymentAmount(overrideOverHistory, effectiveFromDate), { type: 'fixed', amount: 999 })

// ─────────────────────────────────────────────────────────────────────
// UAT 2026-09-09 (retest-bills-just-single/all-future-samedate) — same
// "frozen" bug as schedule.ts's amountHistory: a PERMANENT change must
// clear any amountOverrides entry it reaches, not leave it frozen at the
// old one-off value forever.
// ─────────────────────────────────────────────────────────────────────
const withOverrideAtDate: LoanRecurringOverpayment = { ...recurring, ...applyRecurringOverpaymentSingleAmountOverride(recurring, { type: 'fixed', amount: 999 }, overrideDate) }
const supersedingPermanent: LoanRecurringOverpayment = { ...withOverrideAtDate, ...applyRecurringOverpaymentAmountChange(withOverrideAtDate, { type: 'fixed', amount: 200 }, overrideDate) }
check('A permanent change effective ON the overridden date supersedes it', resolveRecurringOverpaymentAmount(supersedingPermanent, overrideDate), { type: 'fixed', amount: 200 })
check('The now-superseded override entry is actually removed, not left dangling', supersedingPermanent.amountOverrides, [])

const earlierOverride: LoanRecurringOverpayment = { ...recurring, ...applyRecurringOverpaymentSingleAmountOverride(recurring, { type: 'fixed', amount: 999 }, baseline[0].date) }
const laterPermanentUnaffectedEarlier: LoanRecurringOverpayment = { ...earlierOverride, ...applyRecurringOverpaymentAmountChange(earlierOverride, { type: 'fixed', amount: 200 }, effectiveFromDate) }
check('An override dated BEFORE the permanent change\'s effective date is left untouched', laterPermanentUnaffectedEarlier.amountOverrides, [{ date: baseline[0].date, amount: { type: 'fixed', amount: 999 } }])

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll recurring-overpayment-amount-history checks passed.')
