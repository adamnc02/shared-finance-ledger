// D3 verification — ledgerLoans.ts's core engine upgrade to true
// amortisation (loan-amortisation-engine scope, handoff build step 3).
// Exercises the full Loan -> buildLoanSchedule/summarizeLoan path (not
// just the standalone convention maths already covered by
// verify-interest-conventions.ts) against both real reconciled fixtures.

import { buildLoanSchedule, summarizeLoan, nominalTotalPayable, resolveLoanRateAndConvention } from '../src/lib/ledgerLoans'
import { aprToMonthlyRate, backSolveMonthlyRate, SANTANDER_FIXTURE, MONZO_FIXTURE } from '../src/lib/interestConventions'
import type { Loan } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const baseLoan = {
  id: 'fixture-loan',
  name: 'Fixture loan',
  categoryId: 'cat-loans',
  location: 'personal' as const,
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
}

// ─────────────────────────────────────────────────────────────────────
// 1. Santander fixture, CALIBRATED (interestConventionId + calibratedMonthlyRate
//    set, simulating what a future calibration-modal session will persist).
// ─────────────────────────────────────────────────────────────────────
const santanderLoan: Loan = {
  ...baseLoan,
  id: 'santander',
  name: 'Santander loan',
  principal: SANTANDER_FIXTURE.principal,
  monthlyPayment: SANTANDER_FIXTURE.contractualPayment,
  termMonths: SANTANDER_FIXTURE.termMonths,
  startDate: SANTANDER_FIXTURE.firstPaymentDate,
  advanceDate: SANTANDER_FIXTURE.advanceDate,
  interestConventionId: 'flat_monthly',
  calibratedMonthlyRate: SANTANDER_FIXTURE.empiricalMonthlyRate,
}

const santanderSchedule = buildLoanSchedule(santanderLoan)
check('Santander schedule: first entry lands on the real first payment date', santanderSchedule[0]?.date, SANTANDER_FIXTURE.firstPaymentDate)
check("Santander schedule: first entry's interest matches the real first statement line (stub period, day-count-insensitive)", santanderSchedule[0]?.interestApplied, SANTANDER_FIXTURE.statementLines[0].interest, 0.05)
check("Santander schedule: second entry's interest matches the real second statement line", santanderSchedule[1]?.interestApplied, SANTANDER_FIXTURE.statementLines[1].interest, 0.05)
check('Santander schedule: balance after 2 real payments matches the real reconciled figure (£7,796.00)', santanderSchedule[1]?.balanceAfter, SANTANDER_FIXTURE.balanceAfterTwoRealPayments, 0.1)
check(
  'Santander schedule: balance after 2 payments is NOT the old flat model\'s figure (proves real interest is genuinely being applied, not a leftover flat calculation)',
  Math.abs((santanderSchedule[1]?.balanceAfter ?? 0) - SANTANDER_FIXTURE.oldFlatModelRemainingAfterTwoPayments) > 1000,
  true,
)

// ─────────────────────────────────────────────────────────────────────
// 2. Santander fixture, UNCALIBRATED — scope §13's "must not silently
//    degrade to something worse than no calibration at all" baseline.
// ─────────────────────────────────────────────────────────────────────
const santanderBaseline: Loan = { ...santanderLoan, interestConventionId: undefined, calibratedMonthlyRate: undefined }
const { monthlyRate: baselineRate, convention: baselineConvention } = resolveLoanRateAndConvention(santanderBaseline)
check('Uncalibrated loan: falls back to the flat-monthly baseline convention', baselineConvention.id, 'flat_monthly')
check(
  'Uncalibrated loan: back-solved rate matches backSolveMonthlyRate(principal, payment, term) directly',
  baselineRate,
  backSolveMonthlyRate(SANTANDER_FIXTURE.principal, SANTANDER_FIXTURE.contractualPayment, SANTANDER_FIXTURE.termMonths),
  0.000001,
)
const santanderBaselineSchedule = buildLoanSchedule(santanderBaseline)
check(
  "Uncalibrated loan: schedule's first-period interest is still very close to the real statement line, needing zero statement data",
  santanderBaselineSchedule[0]?.interestApplied,
  SANTANDER_FIXTURE.statementLines[0].interest,
  0.1,
)

// ─────────────────────────────────────────────────────────────────────
// 3. Monzo fixture, CALIBRATED (daily-simple convention)
// ─────────────────────────────────────────────────────────────────────
const monzoLoan: Loan = {
  ...baseLoan,
  id: 'monzo',
  name: 'Monzo loan',
  principal: MONZO_FIXTURE.principal,
  monthlyPayment: MONZO_FIXTURE.contractualPayment,
  termMonths: MONZO_FIXTURE.termMonths,
  startDate: MONZO_FIXTURE.firstPaymentDate,
  advanceDate: MONZO_FIXTURE.advanceDate,
  interestConventionId: 'daily_simple',
  calibratedMonthlyRate: aprToMonthlyRate(MONZO_FIXTURE.displayedApr),
}

const monzoSchedule = buildLoanSchedule(monzoLoan)
check('Monzo schedule: first entry (20-day stub) interest matches the real first statement line', monzoSchedule[0]?.interestApplied, MONZO_FIXTURE.statementLines[0].interest, 0.1)
const monzoTotalErrorFirst6 = monzoSchedule.slice(0, 6).reduce((sum, entry, i) => sum + Math.abs(entry.interestApplied - MONZO_FIXTURE.statementLines[i].interest), 0)
check('Monzo schedule: total interest error across the first 6 real periods stays within low tens of pence', monzoTotalErrorFirst6 < 1, true)

// ─────────────────────────────────────────────────────────────────────
// 4. Overpayments: 0% interest component, shortens term, reduces total
//    interest paid (scope §9, §13)
// ─────────────────────────────────────────────────────────────────────
const santanderWithOverpayment: Loan = { ...santanderLoan, overpayments: [{ id: 'op1', date: '2026-08-02', amount: 2000 }] }
const scheduleWithOverpayment = buildLoanSchedule(santanderWithOverpayment)
check('A £2000 one-off overpayment carries £0 interest itself (100% off principal, scope §9)', scheduleWithOverpayment.find((e) => e.overpaymentApplied > 0)?.overpaymentApplied, 2000)
check('The overpayment shortens the schedule below the original 24-month term', scheduleWithOverpayment.length < 24, true)
const totalInterestWithout = santanderSchedule.reduce((sum, e) => sum + e.interestApplied, 0)
const totalInterestWith = scheduleWithOverpayment.reduce((sum, e) => sum + e.interestApplied, 0)
check('The overpayment reduces total interest paid over the life of the loan', totalInterestWith < totalInterestWithout, true)

// ─────────────────────────────────────────────────────────────────────
// 5. nominalTotalPayable / summarizeLoan — real schedule-derived total,
//    stable against overpayments (used as percentRepaid's denominator)
// ─────────────────────────────────────────────────────────────────────
const nominalTotal = nominalTotalPayable(santanderLoan)
check('nominalTotalPayable is now the schedule-derived total (principal + real total interest), close to but not naively monthlyPayment × termMonths', nominalTotal, SANTANDER_FIXTURE.contractualPayment * SANTANDER_FIXTURE.termMonths, 5)
const nominalTotalWithOverpayment = nominalTotalPayable(santanderWithOverpayment)
check('nominalTotalPayable stays the SAME stable figure regardless of real overpayments already logged (a moving denominator would make percentRepaid misleading)', nominalTotalWithOverpayment, nominalTotal)

const summary = summarizeLoan(santanderLoan, new Date('2026-08-15'))
check('summarizeLoan (unchanged signature, scope §8) still returns totalPayable/remainingBalance/payoffDate/monthsRemaining', Object.keys(summary).sort(), ['monthsRemaining', 'payoffDate', 'remainingBalance', 'totalPayable'].sort())
check('summarizeLoan as-of 15 Aug (after 2 real payments) matches the reconciled balance', summary.remainingBalance, SANTANDER_FIXTURE.balanceAfterTwoRealPayments, 0.1)

// ─────────────────────────────────────────────────────────────────────
// 6. Home.tsx / pie-chart contract (scope §8): summarizeLoan(loan, futureDate)
//    still works unchanged for a future asOf date — no signature changes.
// ─────────────────────────────────────────────────────────────────────
const projectedSummary = summarizeLoan(santanderLoan, new Date('2027-01-01'))
check('summarizeLoan still accepts a future asOf date and returns a smaller remaining balance than today\'s', projectedSummary.remainingBalance < summary.remainingBalance, true)

console.log(failures === 0 ? '\nAll loan-amortisation checks passed.' : `\n${failures} loan-amortisation check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
