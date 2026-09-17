// D8 verification — the loan ledger modal's backing data (scope §10):
// buildLoanLedgerRows (one row per dated event, three-way type label,
// overpayment rows always £0 interest) and loanFinishInfo (live finish
// date vs the nominal no-overpayment schedule).

import { buildLoanLedgerRows, loanFinishInfo, buildLoanSchedule } from '../src/lib/ledgerLoans'
import { SANTANDER_FIXTURE } from '../src/lib/interestConventions'
import type { Loan } from '../src/types/ledger'

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

// ─────────────────────────────────────────────────────────────────────
// 1. No overpayments: one row per period, all "Monthly Repayment"
// ─────────────────────────────────────────────────────────────────────
const plainRows = buildLoanLedgerRows(baseLoan)
const plainSchedule = buildLoanSchedule(baseLoan)
check('With no overpayments, exactly one row per scheduled period', plainRows.length, plainSchedule.length)
check('Every row is a Monthly Repayment when there are no overpayments', plainRows.every((r) => r.type === 'Monthly Repayment'), true)
check("First row's interest matches the real first statement line (reuses buildLoanSchedule directly, not a second calculation)", plainRows[0]?.interest, SANTANDER_FIXTURE.statementLines[0].interest, 0.01)
check("First row's capital + interest sums to its amount", plainRows[0]!.capital + plainRows[0]!.interest, plainRows[0]!.amount, 0.01)

// ─────────────────────────────────────────────────────────────────────
// 2. A period with BOTH a regular payment and an overpayment becomes
//    TWO separate rows (scope §10's explicit requirement), not one
//    folded together
// ─────────────────────────────────────────────────────────────────────
const withOverpaymentLoan: Loan = { ...baseLoan, overpayments: [{ id: 'o1', date: '2026-08-02', amount: 1000, recastMode: 'reduce_term' }] }
const rowsWithOverpayment = buildLoanLedgerRows(withOverpaymentLoan)
const augustRows = rowsWithOverpayment.filter((r) => r.date === '2026-08-02')
check('August has exactly 2 rows: one Monthly Repayment, one Ad-hoc Overpayment', augustRows.length, 2)
check('One of them is the regular Monthly Repayment', augustRows.some((r) => r.type === 'Monthly Repayment'), true)
check('The other is specifically labelled Ad-hoc Overpayment, not a generic "Overpayment"', augustRows.some((r) => r.type === 'Ad-hoc Overpayment'), true)

const overpaymentRow = augustRows.find((r) => r.type === 'Ad-hoc Overpayment')!
check('The overpayment row carries the full overpayment amount', overpaymentRow.amount, 1000)
check('The overpayment row shows £0 interest (scope §9\'s confirmed rule)', overpaymentRow.interest, 0)
check('The overpayment row\'s capital equals its full amount (100% principal, no interest split)', overpaymentRow.capital, 1000)

const monthlyRowSameDate = augustRows.find((r) => r.type === 'Monthly Repayment')!
check("The regular payment row on the same date is UNCHANGED by the overpayment landing alongside it", monthlyRowSameDate.amount, plainRows[1]?.amount)

// ─────────────────────────────────────────────────────────────────────
// 3. A recurring overpayment gets its own distinct third label
// ─────────────────────────────────────────────────────────────────────
const recurringLoan: Loan = { ...baseLoan, recurringOverpayment: { startDate: '2026-08-02', amount: { type: 'fixed', amount: 50 }, recastMode: 'reduce_term' } }
const recurringRows = buildLoanLedgerRows(recurringLoan)
const recurringOverpaymentRows = recurringRows.filter((r) => r.type === 'Recurring Overpayment')
check('A recurring overpayment produces its own "Recurring Overpayment" rows, distinct from "Ad-hoc Overpayment"', recurringOverpaymentRows.length > 0, true)
check('Recurring overpayment rows also carry £0 interest', recurringOverpaymentRows.every((r) => r.interest === 0), true)

// A period with a regular payment AND a recurring overpayment is also 2 rows.
const septemberRecurringRows = recurringRows.filter((r) => r.date === '2026-09-02')
check('A period with a regular payment + a recurring overpayment is also 2 separate rows', septemberRecurringRows.length, 2)

// ─────────────────────────────────────────────────────────────────────
// 4. Balance reconstruction across exploded rows stays internally
//    consistent — the row immediately after an overpayment shows the
//    real reduced balance, not the pre-overpayment one
// ─────────────────────────────────────────────────────────────────────
const augustMonthlyRow = augustRows.find((r) => r.type === 'Monthly Repayment')!
const augustOverpaymentRow = augustRows.find((r) => r.type === 'Ad-hoc Overpayment')!
check("The Monthly Repayment row's balanceAfter is BEFORE the overpayment lands (higher than the overpayment row's)", augustMonthlyRow.balanceAfter > augustOverpaymentRow.balanceAfter, true)
check("The overpayment row's balanceAfter matches the real schedule entry's final balanceAfter for that date", augustOverpaymentRow.balanceAfter, buildLoanSchedule(withOverpaymentLoan).find((e) => e.date === '2026-08-02')?.balanceAfter)

// ─────────────────────────────────────────────────────────────────────
// 5. loanFinishInfo — live finish date vs the nominal (no-overpayment) one
// ─────────────────────────────────────────────────────────────────────
const noOverpayFinish = loanFinishInfo(baseLoan)
check('No overpayments: finish date matches the plain schedule\'s own final date', noOverpayFinish.finishDate, plainSchedule.at(-1)?.date)
check('No overpayments: 0 months early (it IS the nominal schedule)', noOverpayFinish.monthsEarly, 0)
check('No overpayments: not flagged as settled early', noOverpayFinish.settledEarly, false)

const withOverpayFinish = loanFinishInfo(withOverpaymentLoan)
check('With a real £1000 overpayment: finishes earlier than the no-overpayment baseline', withOverpayFinish.finishDate! < noOverpayFinish.finishDate!, true)
check('With a real £1000 overpayment: monthsEarly is genuinely positive', withOverpayFinish.monthsEarly > 0, true)

// ─────────────────────────────────────────────────────────────────────
// 6. A settled (inactive) loan reports its real closedDate, not a
//    schedule-predicted one — matches summarizeLoan's own D4 override
// ─────────────────────────────────────────────────────────────────────
const settledLoan: Loan = { ...baseLoan, active: false, closedDate: '2026-09-15', settledAmount: 8000 }
const settledFinish = loanFinishInfo(settledLoan)
check('A settled loan reports its real closedDate as the finish date', settledFinish.finishDate, '2026-09-15')
check('A settled loan is flagged settledEarly', settledFinish.settledEarly, true)

console.log(failures === 0 ? '\nAll loan-ledger checks passed.' : `\n${failures} loan-ledger check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
