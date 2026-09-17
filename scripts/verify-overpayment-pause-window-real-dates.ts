// UAT 2026-09-09 (retest2-overpay-single-no-reamortise note) — the
// "manage paused payments" window for a recurring overpayment had the
// SAME real-vs-loan-date mixup as the "which payment" picker (fixed in
// scripts/verify-overpayment-picker-real-dates.ts): scheduledLoanRecurringOverpaymentDates
// returned the LOAN's own schedule dates directly, not the overpayment's
// own real dates. Fixed via scheduledLoanRecurringOverpaymentRealDates,
// which returns both.

import { scheduledLoanRecurringOverpaymentRealDates, setPausedLoanRecurringOverpaymentDates, recurringOverpaymentForDate } from '../src/lib/ledgerLoans'
import type { Loan } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// Same "21st vs 2nd" fixture as verify-recurring-overpayment-real-date.ts /
// verify-overpayment-picker-real-dates.ts.
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

const rangeStart = new Date(2026, 6, 1)
const rangeEnd = new Date(2026, 11, 31)
const window = scheduledLoanRecurringOverpaymentRealDates(loan, rangeStart, rangeEnd)

check('The window shows the overpayment\'s own real dates (21st), not the loan\'s payment date (2nd)', window.every((e) => e.date.endsWith('-21')), true)
check('None of the window\'s real dates are the loan\'s own 2nd-of-month payment date', window.some((e) => e.date.endsWith('-02')), false)

// Pausing via the REAL date (what the UI shows) must actually take
// effect internally (keyed by periodDate).
const augEntry = window.find((e) => e.date === '2026-08-21')!
const merged = setPausedLoanRecurringOverpaymentDates({ ...loan }, window.map((e) => e.periodDate), [augEntry.periodDate])
check('Pausing (via the translated periodDate) actually lands in pausedDates', merged?.pausedDates, [augEntry.periodDate])

const pausedLoan: Loan = { ...loan, recurringOverpayment: { ...loan.recurringOverpayment!, pausedDates: merged?.pausedDates } }
// recurringOverpaymentForDate compares against the LOAN's own period
// date internally — confirms the pause genuinely suppresses the
// overpayment for that period once wired through periodDate correctly.
check('The paused period genuinely stops generating an overpayment', recurringOverpaymentForDate(pausedLoan, augEntry.periodDate, 5000), 0)

// ─────────────────────────────────────────────────────────────────────
// UAT 2026-09-09 (retest3-overpay-pause-still-works) — THE ACTUAL
// REPORTED BUG: after pausing a date and saving, that one row's own
// DISPLAY reverted from the overpayment's real date (21st) back to the
// loan's own payment date (2nd), while every other (unpaused) row
// stayed correct. Root cause: recurringOverpaymentRealDates gated on
// `entry.recurringOverpaymentApplied > 0`, and a paused period always
// resolves to 0 there — so a paused period got no real-date mapping at
// all, and callers fell back to the loan's own period date for that one
// row. Fixed by gating on the overpayment's active date WINDOW instead
// of whether it actually applied that period.
// ─────────────────────────────────────────────────────────────────────
const windowAfterPause = scheduledLoanRecurringOverpaymentRealDates(pausedLoan, rangeStart, rangeEnd)
check('The now-PAUSED period still shows its own real date (21st), not the loan\'s payment date (2nd) — the exact reported bug', windowAfterPause.find((e) => e.periodDate === augEntry.periodDate)?.date, '2026-08-21')
check('Every OTHER (still-unpaused) row is unaffected', windowAfterPause.every((e) => e.date.endsWith('-21')), true)

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll overpayment-pause-window-real-dates checks passed.')
