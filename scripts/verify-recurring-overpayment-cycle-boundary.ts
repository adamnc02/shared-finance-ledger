import { computeProjection } from '../src/lib/projection'
import { defaultLedgerData } from '../src/lib/ledgerStorage'
import type { AppDataV2, PayCycleConfig, Loan } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

// The exact real scenario reported: pay cycle starting on the 31st (so
// "This cycle" runs 31 Jul -> 30 Aug), a loan with its own payment date
// on the 2nd, and a recurring overpayment on the 21st. The recurring
// overpayment's real date (21 Aug) falls comfortably inside "This
// cycle" — but the LOAN PERIOD it gets aggregated into for interest
// purposes (2 Sep, the loan's own next contractual payment) does not.
// generateLoanPaymentTransactions used to filter by the schedule
// entry's own date BEFORE remapping to the real display date, so the
// whole entry was discarded before its real date was ever checked —
// "This cycle" showed nothing, "Next 3 cycles" showed it correctly.
const base = defaultLedgerData()
const personId = base.primaryPersonId
const payCycle: PayCycleConfig = {
  personId,
  openingBalance: 0,
  openingBalanceDate: '2026-07-31',
  paydayDayOfMonth: 31,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 31,
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
  ownerId: personId,
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
  interestConventionId: 'daily_simple',
  calibratedMonthlyRate: 0.006961643808621076,
  recurringOverpayment: { startDate: '2026-08-21', amount: { type: 'fixed', amount: 50 }, recastMode: 'reduce_term' },
}

const data: AppDataV2 = { ...base, payCycles: [payCycle], loans: [loan] }
const today = new Date(2026, 7, 20) // 20 Aug 2026

const thisCycle = computeProjection(data, personId, payCycle, 'current_cycle', today)
const next3 = computeProjection(data, personId, payCycle, 'three_cycles', today)

check("'This cycle' horizon end is genuinely 30 Aug (confirms the day-31 cycle config is set up as intended)", thisCycle.horizonEnd, '2026-08-30')
check(
  "'This cycle' now correctly includes the 21 Aug recurring overpayment — this is the exact reported bug (used to be empty here)",
  thisCycle.transactions.some((t) => t.sourceType === 'loan_recurring_overpayment' && t.date === '2026-08-21'),
  true,
)
check(
  "'Next 3 cycles' still includes it too, consistently (this direction already worked before the fix)",
  next3.transactions.some((t) => t.sourceType === 'loan_recurring_overpayment' && t.date === '2026-08-21'),
  true,
)
check(
  "The loan's own regular payment (2 Sep, genuinely outside 'This cycle') correctly does NOT appear in 'This cycle' — the fix didn't loosen that boundary by accident",
  thisCycle.transactions.some((t) => t.sourceType === 'loan' && t.date === '2026-09-02'),
  false,
)
check("...but it DOES appear in 'Next 3 cycles', as expected", next3.transactions.some((t) => t.sourceType === 'loan' && t.date === '2026-09-02'), true)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll cycle-boundary-visibility checks passed.')
