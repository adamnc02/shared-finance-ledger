import { buildLoanLedgerRows, generateLoanPaymentTransactions } from '../src/lib/ledgerLoans'
import type { Loan } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

// The exact real scenario reported: a Monzo loan with its own payment
// date on the 2nd, and a recurring overpayment deliberately set to start
// on the 21st — genuinely wanting it to recur on the 21st of every
// month (e.g. matching payday), not the loan's own day. Every occurrence
// showed on the 2nd throughout the app instead, in both the ledger modal
// and the Home page summary.
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
  interestConventionId: 'daily_simple',
  calibratedMonthlyRate: 0.006961643808621076,
  recurringOverpayment: { startDate: '2026-08-21', amount: { type: 'fixed', amount: 100 }, recastMode: 'reduce_term' },
}

// ── Ledger modal rows ──
const recurringRows = buildLoanLedgerRows(loan).filter((r) => r.type === 'Recurring Overpayment')
check("The first recurring overpayment row is dated on the 21st (its own real date), not the 2nd (the loan's date)", recurringRows[0]?.date, '2026-08-21')
check('Every recurring overpayment row lands on the 21st of its month, consistently', recurringRows.slice(0, 6).every((r) => r.date.endsWith('-21')), true)
check('...specifically none of them are dated on the 2nd (the exact reported bug)', recurringRows.some((r) => r.date.endsWith('-02')), false)
check('Consecutive occurrences are exactly one calendar month apart', recurringRows[1]?.date, '2026-09-21')

// The full ledger stays in genuine chronological order — the recurring
// overpayment's real date can fall BEFORE the loan period it was
// aggregated into for interest purposes, and the ledger must reflect that.
const allRows = buildLoanLedgerRows(loan)
check(
  'The ledger is sorted in true chronological order, not schedule-entry order',
  allRows.map((r) => r.date).every((d, i, arr) => i === 0 || arr[i - 1] <= d),
  true,
)
const augIndex = allRows.findIndex((r) => r.date === '2026-08-21')
const beforeIt = allRows[augIndex - 1]
const afterIt = allRows[augIndex + 1]
check('The August 21st row sits between the August 2nd and September 2nd monthly repayments, exactly where it chronologically belongs', [beforeIt?.date, afterIt?.date], [
  '2026-08-02',
  '2026-09-02',
])

// ── Home page summary (generated transactions) ──
const txns = generateLoanPaymentTransactions(loan, new Date('2026-08-01'), new Date('2026-11-30')).filter((t) => t.sourceType === 'loan_recurring_overpayment')
check('Generated transactions for the Home page summary also use the real 21st, not the 2nd', txns.every((t) => t.date.endsWith('-21')), true)
// 4, not 3 — confirmed as the correct count once the range filter checks
// each occurrence's own REAL date rather than the loan period it's
// aggregated into for interest purposes: 21 Nov falls on/before the
// window's own end (30 Nov), even though the loan period it aggregates
// into (2 Dec) falls after it. This is precisely the bug that used to
// make "This cycle" show nothing for a recurring overpayment that
// "Next 3 cycles" displayed correctly — the schedule entry's OWN date
// (the 2nd of the following month) fell outside a requested window
// even when the overpayment's real date was comfortably inside it.
check('4 occurrences fall within the Aug-Nov window (21 Aug, Sep, Oct, AND Nov — the 21st is always <= the last day of its own month)', txns.map((t) => t.date), [
  '2026-08-21',
  '2026-09-21',
  '2026-10-21',
  '2026-11-21',
])

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll recurring-overpayment-real-date checks passed.')
