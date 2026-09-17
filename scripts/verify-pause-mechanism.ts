// Phase 4 verification — pause mechanism generalization (2026-09 session).
// Extends SavingsPot's own multi-select date-pause checklist (no separate
// resume flow) to Bills, Pensions, and loan recurring overpayments.
// Loan recurring overpayments get an ADDITIONAL, distinct concept
// (endDate — a genuine planned stop) alongside the new pausedDates.

import { newRecurringTemplate, scheduledTemplateDates, setPausedTemplateOccurrences, generateTransactionsForTemplate } from '../src/lib/schedule'
import { newPension, scheduledPensionDates, setPausedPensionOccurrences, generatePensionTransactions } from '../src/lib/pensionLedger'
import { buildLoanSchedule, scheduledLoanRecurringOverpaymentRealDates, setPausedLoanRecurringOverpaymentDates } from '../src/lib/ledgerLoans'
import { BILLS_CATEGORY_ID, INCOME_CATEGORY_ID } from '../src/types/ledger'
import type { Loan } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// ─────────────────────────────────────────────────────────────────────
// Bills (RecurringTemplate)
// ─────────────────────────────────────────────────────────────────────
const bill = newRecurringTemplate({
  name: 'Gym',
  amount: 40,
  categoryId: BILLS_CATEGORY_ID,
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-06-15',
  location: 'personal',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
})
const billWindowStart = new Date('2026-08-01')
const billWindowEnd = new Date('2027-01-01')
// UAT 2026-09-11 (manage-upcoming-payments-override-key-bug) —
// scheduledTemplateDates now returns { originalDate, date } pairs;
// setPausedTemplateOccurrences still wants a flat string[] of the
// natural .originalDate keys.
const billWindowPairs = scheduledTemplateDates(bill, billWindowStart, billWindowEnd)
const billWindowDates = billWindowPairs.map((p) => p.originalDate)
check('scheduledTemplateDates finds the monthly 15ths in the window', billWindowDates.includes('2026-09-15') && billWindowDates.includes('2026-10-15'), true)
check('scheduledTemplateDates .date matches .originalDate when no payCycle/resolution applies (bills never follow payday)', billWindowPairs.every((p) => p.date === p.originalDate), true)

const billWithPause = { ...bill, ...setPausedTemplateOccurrences(bill, billWindowDates, ['2026-09-15']) }
const billTxnsAfterPause = generateTransactionsForTemplate(billWithPause, billWindowStart, billWindowEnd)
check('Pausing September removes exactly that occurrence', billTxnsAfterPause.some((t) => t.date === '2026-09-15'), false)
check('October is untouched by pausing September', billTxnsAfterPause.some((t) => t.date === '2026-10-15'), true)

// Unpausing (removing from the checked set) resumes it — no separate "resume" call needed
const billResumed = { ...bill, ...setPausedTemplateOccurrences(billWithPause, billWindowDates, []) }
const billTxnsAfterResume = generateTransactionsForTemplate(billResumed, billWindowStart, billWindowEnd)
check('Re-saving with nothing checked resumes September — no separate resume flow', billTxnsAfterResume.some((t) => t.date === '2026-09-15'), true)

// ─────────────────────────────────────────────────────────────────────
// Pensions
// ─────────────────────────────────────────────────────────────────────
const pension = newPension({
  personId: 'me',
  name: 'State Pension',
  amount: 500,
  frequency: 'monthly',
  anchorDate: '2026-06-01',
})
const pensionWindowDates = scheduledPensionDates(pension, billWindowStart, billWindowEnd)
const pensionWithPause = { ...pension, ...setPausedPensionOccurrences(pension, pensionWindowDates, ['2026-11-01']) }
const pensionTxnsAfterPause = generatePensionTransactions(pensionWithPause, billWindowStart, billWindowEnd)
check('Pausing a pension occurrence removes it', pensionTxnsAfterPause.some((t) => t.date === '2026-11-01'), false)
check('Adjacent pension occurrences survive', pensionTxnsAfterPause.some((t) => t.date === '2026-10-01'), true)

// ─────────────────────────────────────────────────────────────────────
// Loan recurring overpayments — endDate (genuine stop) vs pausedDates
// (ad-hoc skip) are DISTINCT concepts and must not be conflated.
// ─────────────────────────────────────────────────────────────────────
const loanWithRecurring: Loan = {
  id: 'loan-1',
  name: 'Car loan',
  monthlyPayment: 200,
  termMonths: 24,
  startDate: '2026-01-01',
  principal: 4000,
  categoryId: BILLS_CATEGORY_ID,
  location: 'personal',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
  calibratedMonthlyRate: 0.01,
  interestConventionId: 'flat_monthly',
  recurringOverpayment: { startDate: '2026-01-01', amount: { type: 'fixed', amount: 100 } },
}
const loanWindowDates = scheduledLoanRecurringOverpaymentRealDates(loanWithRecurring, new Date('2026-01-01'), new Date('2026-06-01')).map((e) => e.periodDate)
check('scheduledLoanRecurringOverpaymentRealDates finds monthly payment dates in the window', loanWindowDates.length >= 5, true)

const pausedMarch = setPausedLoanRecurringOverpaymentDates(loanWithRecurring, loanWindowDates, [loanWindowDates[2]])
const loanWithPause: Loan = { ...loanWithRecurring, recurringOverpayment: pausedMarch! }
const scheduleWithPause = buildLoanSchedule(loanWithPause)
const scheduleWithoutPause = buildLoanSchedule(loanWithRecurring)
const pausedDate = loanWindowDates[2]
const entryWithPause = scheduleWithPause.find((e) => e.date === pausedDate)
const entryWithoutPause = scheduleWithoutPause.find((e) => e.date === pausedDate)
check('A paused date applies £0 recurring overpayment that period', entryWithPause?.recurringOverpaymentApplied, 0)
check('...whereas the unpaused schedule applies the full £100 that same period', entryWithoutPause?.recurringOverpaymentApplied, 100)
check(
  'Pausing ONE date does not affect the very next scheduled one (no separate resume flow, no bleed into other periods)',
  scheduleWithPause.find((e) => e.date === loanWindowDates[3])?.recurringOverpaymentApplied,
  100,
)

// endDate is a genuinely separate mechanism — a date AFTER endDate never
// applies at all, unlike a paused date which is a one-off skip.
const loanWithEndDate: Loan = { ...loanWithRecurring, recurringOverpayment: { ...loanWithRecurring.recurringOverpayment!, endDate: loanWindowDates[1] } }
const scheduleWithEndDate = buildLoanSchedule(loanWithEndDate)
check('A date before endDate still applies', scheduleWithEndDate.find((e) => e.date === loanWindowDates[1])?.recurringOverpaymentApplied, 100)
check('A date after endDate never applies (genuine stop, not a pause)', scheduleWithEndDate.find((e) => e.date === loanWindowDates[2])?.recurringOverpaymentApplied, 0)

if (failures > 0) {
  console.log(`\n${failures} pause-mechanism check(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll pause-mechanism checks passed.')
}
