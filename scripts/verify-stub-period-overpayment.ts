import { buildLoanSchedule, applyLoanOverpayment } from '../src/lib/ledgerLoans'
import type { Loan } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

// The exact real scenario reported: Santander loan advanced 7 Feb 2025,
// first contractual payment not due until 15 Mar 2025 — and a real,
// genuine overpayment logged 24 Feb, squarely in that gap. This used to
// vanish from the schedule entirely: sameMonth() only ever compares an
// overpayment's month against the loan's OWN scheduled payment months,
// which start at the first payment and never look backward, so a date
// in an earlier month could never match, for the lifetime of the loop.
const loan: Loan = {
  id: 'mum-personal',
  name: 'Santander Loan (Mum)',
  principal: 15000,
  monthlyPayment: 290.2,
  termMonths: 60,
  startDate: '2025-03-15',
  advanceDate: '2025-02-07',
  categoryId: 'x',
  location: 'personal',
  ownerId: 'p1',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
  interestConventionId: 'flat_monthly',
  calibratedMonthlyRate: 0.00508,
}

const { updatedLoan } = applyLoanOverpayment(loan, 40, '2025-02-24')
const schedule = buildLoanSchedule(updatedLoan)

check('The stub-period overpayment is NOT silently dropped — it appears somewhere in the schedule', schedule.some((e) => e.overpaymentApplied > 0), true)
check('Specifically, it lands on the very first scheduled payment (the earliest period it could possibly apply to)', schedule[0].overpaymentApplied, 40)
check('It does not also get double-applied to any later period', schedule.slice(1).every((e) => e.overpaymentApplied === 0), true)
check(
  'The balance after period 1 reflects both the regular payment AND the overpayment (15000 - period1 capital - 40)',
  schedule[0].balanceAfter,
  Math.round((15000 - (290.2 - schedule[0].interestApplied) - 40) * 100) / 100,
)

// Sanity check against the ORIGINAL bug: before this fix, ALL of these
// would have reported overpaymentApplied === 0 everywhere, and the total
// interest paid over the life of the loan would be higher than it should
// be, since the balance never actually dropped by the £40.
const totalOverpaid = schedule.reduce((sum, e) => sum + e.overpaymentApplied, 0)
check('The full £40 is accounted for exactly once across the whole schedule', totalOverpaid, 40)

// An overpayment logged in a month that DOES have a matching scheduled
// payment (the normal, already-working case) must be completely
// unaffected by this fix — same-month matching still applies as before.
const normalOverpayment = applyLoanOverpayment(loan, 100, '2025-04-20').updatedLoan
const normalSchedule = buildLoanSchedule(normalOverpayment)
check('A normal (non-stub) overpayment still applies in its own matching month, unaffected by this fix', normalSchedule[1].overpaymentApplied, 100)
check('...and does NOT also leak into the first period', normalSchedule[0].overpaymentApplied, 0)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll stub-period-overpayment checks passed.')
