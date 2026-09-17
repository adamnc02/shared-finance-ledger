import { calibrateLoanFromStatementLines } from '../src/lib/ledgerLoans'
import type { Loan } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

// The exact real Monzo loan reported as "did not calibrate." Confirmed
// live (Playwright against the running app) that leaving the "Advance
// date (optional)" field blank — a completely reasonable thing to do,
// it's labelled optional — makes calibration fail outright for this
// loan's real daily-weighted convention, even with 5 real statement
// lines. With the advance date filled in, the exact same lines calibrate
// confidently with only 3.
const withoutAdvanceDate: Loan = {
  id: 'monzo-no-advance',
  name: 'Monzo Loan',
  principal: 9411.13,
  monthlyPayment: 427.57,
  termMonths: 24,
  startDate: '2026-03-02',
  // advanceDate deliberately omitted
  categoryId: 'x',
  location: 'personal',
  ownerId: 'p1',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
}

const realLines = [
  { date: '2026-03-02', capital: 382.77, interest: 44.8 },
  { date: '2026-04-02', capital: 360.92, interest: 66.65 },
  { date: '2026-05-02', capital: 365.77, interest: 61.8 },
  { date: '2026-06-02', capital: 366.5, interest: 61.07 },
  { date: '2026-07-02', capital: 370.87, interest: 56.7 },
]

const resultWithout = calibrateLoanFromStatementLines(withoutAdvanceDate, realLines)
check('Without an advance date, this loan genuinely does not calibrate confidently (matches the reported bug)', resultWithout.confidence !== 'confident', true)
check(
  'The low-confidence message now specifically hints at the missing advance date, rather than leaving the person to guess',
  resultWithout.message?.includes('Advance date') ?? false,
  true,
)

const withAdvanceDate: Loan = { ...withoutAdvanceDate, id: 'monzo-with-advance', advanceDate: '2026-02-10' }
const resultWith = calibrateLoanFromStatementLines(withAdvanceDate, realLines.slice(0, 3))
check('With the advance date filled in, the SAME lender genuinely does calibrate confidently, with fewer lines needed', resultWith.confidence, 'confident')
check('...and correctly identifies as the daily-weighted convention, not the flat-monthly one', resultWith.updatedLoan.interestConventionId, 'daily_simple')
check('No advance-date hint needed once it is actually set (nothing to point at)', resultWith.message, null)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll missing-advance-date checks passed.')
