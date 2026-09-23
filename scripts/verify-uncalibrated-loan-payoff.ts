// 2026-09-23 — REGRESSION: clearing an UNCALIBRATED loan showed £0 monthly benefit.
//
// 🚨 The condition is "has never been CALIBRATED", not "has no interest". A
// loan only gets `calibratedMonthlyRate` from a CONFIDENT fit in "Calibrate
// interest" (ledgerLoans.ts: a low-confidence fit deliberately leaves it
// unset). So a loan entered normally — total, monthly payment, first payment
// date — and never calibrated is affected, whatever its real interest rate.
// A loan calibrated to a rate of exactly 0 is NOT affected.
// Real blast radius: Adam's live "Monzo" loan (£195/mo) was affected; both of
// mum's loans are calibrated and were not.
//
// Such a loan has no amortisation schedule: `simulateScenarioLoan` and `baselineLoanSchedule` both return
// empty. `buildDebtImpacts`' `stateAt()` then fell back to
// `currentLoanMonthlyCost(loan)` — the loan's ORIGINAL payment — for the
// "after" state as well as the "before", so before === after and
// `monthlyCashChange` was always 0.
//
// Loans WITH a rate were never affected, which is why it survived from the
// 2026-09-17 What-if rewrite to 2026-09-23. The two checks in scripts/verify.ts
// that caught it live in the one file the sweep glob `verify-*.ts` does not
// match; this file is named so it IS swept.
//
// Control: the same loan WITH a calibrated rate, which must keep working.
import type { AppData, Loan, Scenario } from '../src/types/ledger'
import { calculateScenarioImpact, calculateHouseholdScenarioImpact } from '../src/lib/scenarios'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const people = [
  { id: 'adam', name: 'Adam', salary: 3000, payFrequency: 'monthly', payDayOfMonth: 25, sharePercent: 50 },
  { id: 'ella', name: 'Ella', salary: 2000, payFrequency: 'monthly', payDayOfMonth: 25, sharePercent: 50 },
]
const baseLoan = {
  id: 'joint-loan', name: 'Joint loan', firstPaymentDate: '2027-01-01',
  totalAmount: 1200, monthlyPayment: 100, location: 'joint',
  ownerId: '', payee: 'adam', payeeSharePercent: 50,
} as unknown as Loan

const dataWith = (loan: Loan): AppData =>
  ({ people, loans: [loan], bills: [], creditCards: [], savingsPots: [], transactions: [] } as unknown as AppData)

const payOff = (value: number): Scenario =>
  ({ id: 's1', name: 'Clear the loan', includeInCumulative: true,
     actions: [{ id: 'a1', type: 'pay_off_loan', label: '', value, loanAllocations: [{ loanId: 'joint-loan' }] }] } as unknown as Scenario)

// ---- 1. The regression itself: an interest-free loan, cleared in full ----
const freeData = dataWith(baseLoan)
const freeAdam = calculateScenarioImpact(payOff(1200), freeData, 'adam', 1000)
const freeHouse = calculateHouseholdScenarioImpact(payOff(1200), freeData, 1000)
check('uncalibrated loan cleared: the payer sees his 50% share freed up', freeAdam.monthlyImpact, 50)
check('uncalibrated loan cleared: the household sees the FULL payment freed up', freeHouse.monthlyImpact, 100)
check('uncalibrated loan cleared: it reads as fully paid off', freeAdam.debtImpacts?.[0]?.fullyPaidOff, true)
check('uncalibrated loan cleared: nothing left owing', freeAdam.debtImpacts?.[0]?.balanceAfterAll, 0)
check('uncalibrated loan cleared: the one-off cash is the lump sum', freeAdam.oneOffCashImpact, -1200)

// ---- 2. A PARTIAL lump: the payment drops but the loan is not cleared ----
const partial = calculateHouseholdScenarioImpact(payOff(400), freeData, 1000)
check('uncalibrated loan, partial lump: not fully paid off', partial.debtImpacts?.[0]?.fullyPaidOff, false)
check('uncalibrated loan, partial lump: £800 still owing', partial.debtImpacts?.[0]?.balanceAfterAll, 800)
check('uncalibrated loan, partial lump: the monthly payment is unchanged while the balance covers it', partial.monthlyImpact, 0)

// ---- 3. A lump BIGGER than the balance still clears it, and no more ----
const over = calculateHouseholdScenarioImpact(payOff(5000), freeData, 1000)
check('uncalibrated loan, oversized lump: fully paid off', over.debtImpacts?.[0]?.fullyPaidOff, true)
check('uncalibrated loan, oversized lump: full payment freed, not more', over.monthlyImpact, 100)

// ---- 4. CONTROL: the same loan WITH interest must be unaffected ----
const rateLoan = { ...baseLoan, calibratedMonthlyRate: 0.004 } as unknown as Loan
const zeroRateLoan = { ...baseLoan, calibratedMonthlyRate: 0 } as unknown as Loan
const rateHouse = calculateHouseholdScenarioImpact(payOff(1200), dataWith(rateLoan), 1000)
check('CONTROL: a CALIBRATED loan still frees its full payment', rateHouse.monthlyImpact, 100)

// A loan calibrated to ZERO interest is a different thing from an
// uncalibrated one, and must behave like any other calibrated loan.
const zeroHouse = calculateHouseholdScenarioImpact(payOff(1200), dataWith(zeroRateLoan), 1000)
check('CONTROL: a loan calibrated to 0% behaves like any calibrated loan', zeroHouse.monthlyImpact, 100)

// ---- 5. CONTROL: no action at all changes nothing ----
const noop = calculateHouseholdScenarioImpact(
  ({ id: 's0', name: 'Nothing', includeInCumulative: true, actions: [] } as unknown as Scenario), freeData, 1000)
check('CONTROL: an empty scenario moves nothing', noop.monthlyImpact, 0)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
