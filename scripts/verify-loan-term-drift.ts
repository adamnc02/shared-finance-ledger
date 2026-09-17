import { buildLoanSchedule, summarizeLoan } from '../src/lib/ledgerLoans'
import type { Loan } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

// The exact real-world case reported: £8,400, 24 months, £410.29/month,
// first payment 2 Jul 2026, advance 11 May 2026 — calibrated from a
// single real statement line, which pins the rate to reproduce that one
// line exactly but isn't necessarily the same rate that clears the
// balance in precisely 24 periods. Before the fix, this schedule silently
// grew to 25 periods; the app showed "23 payments left" after 2 real
// payments instead of the correct 22.
const base: Loan = {
  id: 'test',
  name: 'Car Finance',
  principal: 8400,
  monthlyPayment: 410.29,
  termMonths: 24,
  startDate: '2026-07-02',
  advanceDate: '2026-05-11',
  categoryId: 'x',
  location: 'personal',
  ownerId: 'p1',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
}

check('Uncalibrated (back-solved) rate: schedule is exactly 24 periods', buildLoanSchedule(base).length, 24)

// A rate a hair off the exact back-solved one — exactly the kind of
// imprecision a single-statement-line calibration produces in practice.
const slightlyHigh: Loan = { ...base, interestConventionId: 'flat_monthly', calibratedMonthlyRate: 0.0132 }
const slightlyLow: Loan = { ...base, interestConventionId: 'flat_monthly', calibratedMonthlyRate: 0.013 }

check('Calibrated rate slightly HIGH: schedule is still exactly 24 periods, not 25', buildLoanSchedule(slightlyHigh).length, 24)
check('Calibrated rate slightly LOW: schedule is still exactly 24 periods, not 23', buildLoanSchedule(slightlyLow).length, 24)

const finalHigh = buildLoanSchedule(slightlyHigh).at(-1)!
const finalLow = buildLoanSchedule(slightlyLow).at(-1)!
check('The final period always clears the balance exactly to zero (imprecision absorbed there, not spilled into an extra period)', finalHigh.balanceAfter, 0)
check('Same for the slightly-low-rate case', finalLow.balanceAfter, 0)
check('The final payment amount differs from the normal £410.29 to absorb the rate imprecision (high rate -> bigger final payment)', finalHigh.scheduledPayment > 410.29, true)
check('Low rate -> smaller final payment', finalLow.scheduledPayment < 410.29, true)

// The exact reported symptom: after 2 real payments, months remaining
// must be 22, matching a genuinely fixed 24-month term — regardless of
// which of the two calibrated rates above is in play.
const asOfTwoPayments = new Date('2026-08-18')
check('monthsRemaining is 22 (not 23) with the slightly-high calibrated rate', summarizeLoan(slightlyHigh, asOfTwoPayments).monthsRemaining, 22)
check('monthsRemaining is 22 (not 23) with the slightly-low calibrated rate', summarizeLoan(slightlyLow, asOfTwoPayments).monthsRemaining, 22)
check('monthsRemaining is 22 with the uncalibrated baseline too', summarizeLoan(base, asOfTwoPayments).monthsRemaining, 22)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll loan-term-drift checks passed.')
