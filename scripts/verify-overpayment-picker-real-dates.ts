// UAT 2026-09-09 (retest-overpay-single-no-reamortise) — the recurring-
// overpayment editor's "which payment does this apply from" picker was
// reusing recentAndUpcomingLoanPaymentDates directly, which returns the
// LOAN's own schedule dates (e.g. always the 2nd of the month) rather
// than the recurring overpayment's own real dates (which can land on a
// completely different day — see verify-recurring-overpayment-real-date.ts's
// exact "21st vs 2nd" fixture, reused here). Confirmed as a real bug:
// picking a displayed date and committing an amount override/history
// change against it silently keyed the wrong internal date, since
// resolveRecurringOverpaymentAmount/recurringOverpaymentForDate compare
// against the LOAN's own period date, not the real display date.

import { recentAndUpcomingLoanRecurringOverpaymentDates, buildLoanSchedule, applyRecurringOverpaymentSingleAmountOverride, resolveRecurringOverpaymentAmount } from '../src/lib/ledgerLoans'
import type { Loan } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// Same fixture as verify-recurring-overpayment-real-date.ts: loan's own
// payment date is the 2nd, recurring overpayment genuinely recurs on the
// 21st.
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

const asOf = new Date(2026, 7, 1) // 1 Aug — before the first overpayment
const picker = recentAndUpcomingLoanRecurringOverpaymentDates(loan, asOf)

check('The picker shows the overpayment\'s own REAL dates (21st), not the loan\'s own payment date (2nd)', picker.every((o) => o.date.endsWith('-21')), true)
check('None of the picker dates are the loan\'s own 2nd-of-month payment date (the exact reported bug)', picker.some((o) => o.date.endsWith('-02')), false)
check('The first upcoming entry is 21 Aug', picker[0]?.date, '2026-08-21')

// The periodDate for that entry must be the underlying loan schedule's
// OWN date (2nd of the following month, since the 21st folds into the
// NEXT loan period per recurringOverpaymentRealDates's own reasoning).
const schedule = buildLoanSchedule(loan)
const augEntry = picker.find((o) => o.date === '2026-08-21')
check('periodDate correctly maps back to a real schedule entry that actually carries a recurringOverpaymentApplied > 0', schedule.some((e) => e.date === augEntry?.periodDate && e.recurringOverpaymentApplied > 0), true)

// Using periodDate (not the real display date) to write a single-
// occurrence override actually lands correctly in the engine.
const overridePatch = applyRecurringOverpaymentSingleAmountOverride(loan.recurringOverpayment!, { type: 'fixed', amount: 500 }, augEntry!.periodDate)
check('An override keyed by periodDate resolves correctly at that period', resolveRecurringOverpaymentAmount({ ...loan.recurringOverpayment!, ...overridePatch }, augEntry!.periodDate), { type: 'fixed', amount: 500 })

// Confirms the bug this fixes: keying by the REAL display date instead
// (the old, broken behaviour) would NEVER match anything real inside the
// engine, since recurringOverpaymentForDate never queries with that date.
const brokenOverridePatch = applyRecurringOverpaymentSingleAmountOverride(loan.recurringOverpayment!, { type: 'fixed', amount: 500 }, augEntry!.date)
const wouldHaveBeenBroken = schedule.every((e) => e.date !== augEntry!.date)
check('Confirms the display date never matches any real schedule entry date directly (why the old code silently failed)', wouldHaveBeenBroken, true)
void brokenOverridePatch

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll overpayment-picker-real-dates checks passed.')
