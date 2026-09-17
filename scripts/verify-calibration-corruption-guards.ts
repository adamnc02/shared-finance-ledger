import { calibrateLoanFromStatementLines, isLoanConfidentlyCalibrated } from '../src/lib/ledgerLoans'
import type { Loan } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

const loan: Loan = {
  id: 'monzo',
  name: 'Monzo',
  principal: 9411.13,
  monthlyPayment: 427.57,
  termMonths: 24,
  startDate: '2026-03-02',
  advanceDate: '2026-02-10',
  categoryId: 'x',
  location: 'personal',
  ownerId: 'p1',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
}

// ── Bug 1: a single line is mathematically guaranteed to "fit" trivially ──
// Reproduced directly against the real reported case: capital and
// interest deliberately SWAPPED (garbage data) on a single line used to
// still report as a confident fit and corrupt the loan's real rate.
const swappedFieldLine = [{ date: '2026-03-02', capital: 44.8, interest: 382.77 }]
const afterBadSingleLine = calibrateLoanFromStatementLines(loan, swappedFieldLine)
check('A single line — even correct, let alone garbage — is never reported as confident', afterBadSingleLine.confidence !== 'confident', true)
check("...specifically because it never gets the chance to be confident: 1 line always fails the minimum-line gate first", afterBadSingleLine.confidence, 'low_first')

// ── Bug 2: a low-confidence fit must NOT overwrite the loan's real, working rate ──
check('A low-confidence attempt does NOT write a calibratedMonthlyRate at all', afterBadSingleLine.updatedLoan.calibratedMonthlyRate, undefined)
check('...nor an interestConventionId', afterBadSingleLine.updatedLoan.interestConventionId, undefined)
check("...but the raw line IS still saved, so the person's data isn't lost and more lines can be added", afterBadSingleLine.updatedLoan.statementCalibrationLines?.length, 1)
check('isLoanConfidentlyCalibrated agrees: this loan is NOT confidently calibrated after that attempt', isLoanConfidentlyCalibrated(afterBadSingleLine.updatedLoan), false)

// A loan that already had a GOOD confident calibration must not be
// downgraded just because a later low-confidence attempt was made
// (e.g. testing a hunch, or a mis-typed line) — the existing good rate
// should be left alone, not wiped out by a failed follow-up attempt.
const goodLines = [
  { date: '2026-03-02', capital: 382.77, interest: 44.8 },
  { date: '2026-04-02', capital: 360.92, interest: 66.65 },
  { date: '2026-05-02', capital: 365.77, interest: 61.8 },
]
const confidentlyCalibrated = calibrateLoanFromStatementLines(loan, goodLines)
check('A proper multi-line calibration IS confident', confidentlyCalibrated.confidence, 'confident')
check('...and DOES set a real rate', typeof confidentlyCalibrated.updatedLoan.calibratedMonthlyRate, 'number')

const previousRate = confidentlyCalibrated.updatedLoan.calibratedMonthlyRate
const previousConvention = confidentlyCalibrated.updatedLoan.interestConventionId
// Now a bad single extra line is added on top of the already-good loan.
const afterFollowUpBadLine = calibrateLoanFromStatementLines(confidentlyCalibrated.updatedLoan, [{ date: '2026-08-02', capital: 1, interest: 1000 }])
check('A low-confidence FOLLOW-UP attempt on an already-confidently-calibrated loan does not downgrade its rate', afterFollowUpBadLine.updatedLoan.calibratedMonthlyRate, previousRate)
check('...nor its convention', afterFollowUpBadLine.updatedLoan.interestConventionId, previousConvention)

// ── 2 lines: enough to escape the degenerate 1-line case, real signal ──
const twoGoodLines = goodLines.slice(0, 2)
const afterTwoLines = calibrateLoanFromStatementLines(loan, twoGoodLines)
check('2 correctly-matching lines CAN be confident (2 is the minimum, not always-blocked)', afterTwoLines.confidence, 'confident')

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll calibration-corruption-guard checks passed.')
