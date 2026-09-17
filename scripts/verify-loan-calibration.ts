// D6 verification — the calibration flow (loan-amortisation-engine scope
// §5.3/§5.4/§5.5): calibrateLoanFromStatementLines and
// findLenderCalibrationProfile against both real reconciled fixtures,
// the 5-line cap, the low-confidence path with scope §5.4's exact
// message text, and lender-profile reuse.

import { calibrateLoanFromStatementLines, findLenderCalibrationProfile, MAX_CALIBRATION_LINES } from '../src/lib/ledgerLoans'
import { SANTANDER_FIXTURE, MONZO_FIXTURE } from '../src/lib/interestConventions'
import type { Loan, StatementCalibrationLine } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const baseLoan = {
  id: 'loan-1',
  name: 'Test loan',
  categoryId: 'cat-loans',
  location: 'personal' as const,
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
}

// ─────────────────────────────────────────────────────────────────────
// 1. Real fixture reproduction — engine correctly identifies each real
//    loan's convention from its own real statement lines, matching
//    scope §13's explicit ask
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
  lender: 'Santander',
}
const santanderResult = calibrateLoanFromStatementLines(santanderLoan, SANTANDER_FIXTURE.statementLines)
check('Santander: calibration is confident from its own real statement lines', santanderResult.confidence, 'confident')
check('Santander: correctly identifies the flat-monthly convention', santanderResult.updatedLoan.interestConventionId, 'flat_monthly')
check('Santander: fitted rate matches the fixture\'s known empirical rate closely', santanderResult.updatedLoan.calibratedMonthlyRate, SANTANDER_FIXTURE.empiricalMonthlyRate, 0.00001)
check('Santander: raw statement lines are persisted against the loan (scope §5.3 step 2), not just a derived result', santanderResult.updatedLoan.statementCalibrationLines, SANTANDER_FIXTURE.statementLines)
check('Santander: no low-confidence message when confident', santanderResult.message, null)

const monzoLoan: Loan = {
  ...baseLoan,
  id: 'monzo',
  name: 'Monzo loan',
  principal: MONZO_FIXTURE.principal,
  monthlyPayment: MONZO_FIXTURE.contractualPayment,
  termMonths: MONZO_FIXTURE.termMonths,
  startDate: MONZO_FIXTURE.firstPaymentDate,
  advanceDate: MONZO_FIXTURE.advanceDate,
  lender: 'Monzo',
}
const monzoResult = calibrateLoanFromStatementLines(monzoLoan, MONZO_FIXTURE.statementLines)
check('Monzo: calibration is confident from its own real statement lines', monzoResult.confidence, 'confident')
check('Monzo: correctly identifies the daily-simple convention', monzoResult.updatedLoan.interestConventionId, 'daily_simple')
check('Monzo: fitted APR is close to the displayed 8.7%', Math.pow(1 + (monzoResult.updatedLoan.calibratedMonthlyRate ?? 0), 12) - 1, MONZO_FIXTURE.displayedApr, 0.002)

// Cross-check: each real loan's OWN calibration must reject the OTHER
// convention — i.e. Santander's fitted flat rate must fit its lines far
// better than daily_simple would, and vice versa (same spirit as D1's
// cross-test, now exercised through the full calibration flow).
check("Santander's own calibration wasn't accidentally daily_simple", santanderResult.updatedLoan.interestConventionId !== 'daily_simple', true)
check("Monzo's own calibration wasn't accidentally flat_monthly", monzoResult.updatedLoan.interestConventionId !== 'flat_monthly', true)

// ─────────────────────────────────────────────────────────────────────
// 2. Re-fitting uses the WHOLE accumulated set, not just the newest
//    addition (scope §5.3 step 2) — split Santander's 3 real lines
//    across two calibration calls and confirm the same result comes out
// ─────────────────────────────────────────────────────────────────────
const firstPass = calibrateLoanFromStatementLines(santanderLoan, SANTANDER_FIXTURE.statementLines.slice(0, 1))
const secondPass = calibrateLoanFromStatementLines(firstPass.updatedLoan, SANTANDER_FIXTURE.statementLines.slice(1))
check('Splitting the same 3 real lines across two calibration calls lands on the same convention as calibrating all 3 at once', secondPass.updatedLoan.interestConventionId, santanderResult.updatedLoan.interestConventionId)
check('...and a closely matching rate', secondPass.updatedLoan.calibratedMonthlyRate, santanderResult.updatedLoan.calibratedMonthlyRate, 0.0001)
check('...with all 3 lines persisted, not just the 2nd call\'s single new line', secondPass.updatedLoan.statementCalibrationLines?.length, 3)

// ─────────────────────────────────────────────────────────────────────
// 3. The 5-line cap (scope §5.3 step 1) — engine-level backstop
// ─────────────────────────────────────────────────────────────────────
const sixLines: StatementCalibrationLine[] = [
  ...SANTANDER_FIXTURE.statementLines,
  { date: '2026-10-02', capital: 311.94, interest: 98.35 },
  { date: '2026-11-02', capital: 315.95, interest: 94.34 },
  { date: '2026-12-02', capital: 320.02, interest: 90.27 },
]
const cappedResult = calibrateLoanFromStatementLines(santanderLoan, sixLines)
check(`Even given ${sixLines.length} lines in one call, at most ${MAX_CALIBRATION_LINES} are ever stored`, cappedResult.updatedLoan.statementCalibrationLines?.length, MAX_CALIBRATION_LINES)
check('MAX_CALIBRATION_LINES is exported as exactly 5, matching scope §5.3', MAX_CALIBRATION_LINES, 5)

// ─────────────────────────────────────────────────────────────────────
// 4. Low-confidence path (scope §5.4) — a synthetic loan whose real
//    statement lines don't match either known convention, and the exact
//    two-stage message text scope §13 explicitly asks to be asserted
// ─────────────────────────────────────────────────────────────────────
const mismatchedLoan: Loan = { ...baseLoan, id: 'mismatched', principal: 5000, monthlyPayment: 300, termMonths: 18, startDate: '2026-01-02', advanceDate: '2026-01-02' }
// Deliberately erratic interest figures with no consistent relationship
// to balance or day-count under either known convention.
const erraticLines: StatementCalibrationLine[] = [
  { date: '2026-02-02', capital: 200, interest: 400 },
  { date: '2026-03-02', capital: 200, interest: 3 },
]
const lowConfidenceResult = calibrateLoanFromStatementLines(mismatchedLoan, erraticLines)
check('A loan matching neither known convention is flagged low-confidence, not silently presented as a good fit', lowConfidenceResult.confidence !== 'confident', true)
check(
  'First low-confidence result uses scope §5.4\'s exact first-stage wording',
  lowConfidenceResult.message,
  "We couldn't determine a close enough estimate on how interest rates are being calculated on this loan — these figures are the closest we could produce.",
)

// After enough lines (4+) still fitting poorly, the message changes to the "more data won't help" stage.
const moreErraticLines: StatementCalibrationLine[] = [
  { date: '2026-04-02', capital: 200, interest: 250 },
  { date: '2026-05-02', capital: 200, interest: 1 },
]
const repeatedLowConfidenceResult = calibrateLoanFromStatementLines(lowConfidenceResult.updatedLoan, moreErraticLines)
check('With 4+ lines still fitting poorly, confidence moves to the repeated (not just first) low-confidence stage', repeatedLowConfidenceResult.confidence, 'low_repeated')
check(
  'Repeated low-confidence result uses scope §5.4\'s exact second-stage wording, making clear more data won\'t help',
  repeatedLowConfidenceResult.message,
  "This still doesn't match a pattern we recognise — the estimate above is our closest fit, and adding more statements is unlikely to improve it further.",
)

// ─────────────────────────────────────────────────────────────────────
// 5. Lender-profile reuse (scope §5.3 step 5)
// ─────────────────────────────────────────────────────────────────────
const allLoans = [santanderResult.updatedLoan, monzoResult.updatedLoan]
const foundProfile = findLenderCalibrationProfile(allLoans, 'Santander')
check('findLenderCalibrationProfile finds a matching calibrated loan by lender name', foundProfile?.interestConventionId, 'flat_monthly')
check('...and carries its calibrated rate', foundProfile?.calibratedMonthlyRate, santanderResult.updatedLoan.calibratedMonthlyRate)

const caseInsensitiveMatch = findLenderCalibrationProfile(allLoans, '  santander  ')
check('Lender matching is case/whitespace-insensitive (free text typed twice)', caseInsensitiveMatch?.interestConventionId, 'flat_monthly')

const noMatch = findLenderCalibrationProfile(allLoans, 'Barclays')
check('No profile found for a lender with no calibrated loan on record', noMatch, null)

const uncalibratedLoan: Loan = { ...baseLoan, id: 'uncalibrated', principal: 1000, monthlyPayment: 100, termMonths: 10, startDate: '2026-01-01', lender: 'Nationwide' }
const noProfileYet = findLenderCalibrationProfile([...allLoans, uncalibratedLoan], 'Nationwide')
check('A loan with a matching lender but no calibration yet (calibratedMonthlyRate absent) is not offered as a profile', noProfileYet, null)

console.log(failures === 0 ? '\nAll loan-calibration checks passed.' : `\n${failures} loan-calibration check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
