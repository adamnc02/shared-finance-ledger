import { summarizeLoanProgress } from '../src/lib/ledgerLoans'
import type { Loan } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

const loan: Loan = {
  id: 'test',
  name: 'Santander Loan',
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

// After exactly 2 real payments — the person's own hand-worked example
// from this conversation: 9846.96 - (2 x 410.29) = 9026.38 nominal
// remaining, and 8400 - (300.03 + 303.97) = 7796 capital remaining.
const progress = summarizeLoanProgress(loan, new Date('2026-08-18'))

check('totalPaid matches 2 real payments', progress.totalPaid, 820.58)
check('nominalRemaining matches the person\'s own hand-calculation to within a penny of schedule rounding', Math.abs(progress.nominalRemaining - 9026.38) < 0.02, true)
check('capitalRemaining matches the real reconciled balance', Math.abs(progress.capitalRemaining - 7796) < 0.02, true)
check('percentPaid is cash-progress (paid/totalBalance), not principal-progress', Math.abs(progress.percentPaid - 8.333) < 0.01, true)
check('nominalRemaining is always >= capitalRemaining (future interest not yet accrued makes the nominal figure the bigger of the two)', progress.nominalRemaining >= progress.capitalRemaining, true)

// A fully-paid-off (inactive/settled) loan shouldn't produce a negative
// or NaN nominalRemaining even if totalPaid slightly overshoots totalBalance
// due to rounding on the final payment.
const settled: Loan = { ...loan, active: false }
const settledProgress = summarizeLoanProgress(settled, new Date('2028-07-01'))
check('A settled loan does not show a negative nominal remaining', settledProgress.nominalRemaining >= 0, true)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll loan-progress checks passed.')
