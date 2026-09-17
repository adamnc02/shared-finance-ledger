// UAT 2026-09-09 (ed-overpay-just-single) — two related bugs found on a
// loan that's PAID FROM A POT but whose RECURRING OVERPAYMENT is
// independently redirected to 'personal' (LoanRecurringOverpayment.location
// overriding the loan's own location, a documented, deliberate feature):
//
// 1. projection.ts/autoClear.ts's per-person loan loop pre-filtered by
//    `loan.location === 'personal'`, which excluded this loan entirely —
//    so its personal-funded overpayment never appeared on the Home page
//    or materialized at all, even though it should show up there exactly
//    like any other personal outgoing.
// 2. LoanRecurringOverpayment.location had no picker-first/retroactive-
//    rewrite mechanism at all (a flat, non-effective-dated setting) —
//    Adam's own call reversed that ("Location should be treated the same
//    as amount for recurring overpayments"), so
//    reassignLoanRecurringOverpaymentTransactions now exists to do the
//    same "cleared ones included" retroactive rewrite Bills'/Loans' own
//    location changes already do.

import { computeProjectionToDate } from '../src/lib/projection'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { reassignLoanRecurringOverpaymentTransactions } from '../src/lib/ledgerLoans'
import { defaultCategories } from '../src/lib/categories'
import { SANTANDER_FIXTURE } from '../src/lib/interestConventions'
import type { AppDataV2, Loan, PayCycleConfig, Person, Pot, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const payCycle: PayCycleConfig = {
  personId: 'me',
  openingBalance: 1000,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 1,
}
const person: Person = { id: 'me', name: 'Me', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [] }
const billsPot: Pot = { id: 'pot-bills', personId: 'me', name: 'Bills', openingBalance: 500, openingDate: '2026-01-01', active: true }

// A loan paid from the Bills pot, but its recurring overpayment is
// independently redirected to Personal.
const loan: Loan = {
  id: 'loan-1',
  name: 'Car loan',
  categoryId: 'cat-loans',
  location: 'pot',
  potId: 'pot-bills',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
  principal: SANTANDER_FIXTURE.principal,
  monthlyPayment: SANTANDER_FIXTURE.contractualPayment,
  termMonths: SANTANDER_FIXTURE.termMonths,
  startDate: '2026-07-02',
  advanceDate: SANTANDER_FIXTURE.advanceDate,
  interestConventionId: 'flat_monthly',
  calibratedMonthlyRate: SANTANDER_FIXTURE.empiricalMonthlyRate,
  recurringOverpayment: { startDate: '2026-08-02', amount: { type: 'fixed', amount: 50 }, location: 'personal', recastMode: 'reduce_term' },
}

const data: AppDataV2 = {
  people: [person],
  categories: defaultCategories(),
  recurringTemplates: [],
  loans: [loan],
  creditCards: [],
  transactions: [],
  payCycles: [payCycle],
  pensions: [],
  scenarios: [],
  pots: [billsPot],
  primaryPersonId: 'me',
}

// ─────────────────────────────────────────────────────────────────────
// 1. The personal-funded overpayment is visible in the LIVE projection
//    (Home page) even though the loan's own location is 'pot'.
// ─────────────────────────────────────────────────────────────────────
const asOf = new Date(2026, 8, 15) // mid-Sept — a couple of overpayment occurrences should have landed
const horizonEnd = new Date(2026, 9, 15)
const projection = computeProjectionToDate(data, 'me', payCycle, horizonEnd, asOf)
const personalOverpaymentRows = projection.transactions.filter((t) => t.sourceType === 'loan_recurring_overpayment' && t.location === 'personal')
check('The personal-funded recurring overpayment appears in the live Home-page projection, despite the loan itself being pot-located', personalOverpaymentRows.length > 0, true)
check('Every one of those rows is genuinely personal, not leaking the pot-located regular payment alongside it', personalOverpaymentRows.every((t) => t.sourceType === 'loan_recurring_overpayment'), true)

// ─────────────────────────────────────────────────────────────────────
// 2. The same overpayment materializes into the real ledger via
//    autoClearDuePayments, not just the live preview.
// ─────────────────────────────────────────────────────────────────────
const settled = autoClearDuePayments(data, asOf)
const materializedOverpayments = settled.transactions.filter((t) => t.sourceType === 'loan_recurring_overpayment' && t.sourceId === 'loan-1')
check('The recurring overpayment actually materializes into the real ledger (not just the live preview)', materializedOverpayments.length > 0, true)
check('...and every materialized row is correctly personal-located', materializedOverpayments.every((t) => t.location === 'personal'), true)
check('The loan\'s own regular payment is NOT accidentally pulled into the personal ledger too (it stays pot-funded)', settled.transactions.some((t) => t.sourceType === 'loan' && t.sourceId === 'loan-1' && t.location === 'personal'), false)

// ─────────────────────────────────────────────────────────────────────
// 3. reassignLoanRecurringOverpaymentTransactions — the new retroactive
//    rewrite mechanism, mirroring reassignTransactionsForLocationChange.
// ─────────────────────────────────────────────────────────────────────
const existing: Transaction[] = [
  { id: 't1', date: '2026-08-02', amount: 50, direction: 'out', categoryId: 'cat-loans', paymentMethod: 'direct_debit', status: 'cleared', type: 'loan_payment', location: 'personal', ownerId: 'me', sourceType: 'loan_recurring_overpayment', sourceId: 'loan-1' },
  { id: 't2', date: '2026-09-02', amount: 50, direction: 'out', categoryId: 'cat-loans', paymentMethod: 'direct_debit', status: 'pending', type: 'loan_payment', location: 'personal', ownerId: 'me', sourceType: 'loan_recurring_overpayment', sourceId: 'loan-1' },
  { id: 't3', date: '2026-07-02', amount: 410.29, direction: 'out', categoryId: 'cat-loans', paymentMethod: 'direct_debit', status: 'cleared', type: 'loan_payment', location: 'pot', potId: 'pot-bills', ownerId: 'me', sourceType: 'loan', sourceId: 'loan-1' },
]
const rewritten = reassignLoanRecurringOverpaymentTransactions(existing, 'loan-1', '2026-09-01', 'pot', 'pot-bills')
check('A transaction dated ON/AFTER effectiveFrom is rewritten to the new location — cleared or pending, doesn\'t matter', rewritten.find((t) => t.id === 't2')?.location, 'pot')
check('A transaction dated BEFORE effectiveFrom is left completely untouched, even though it\'s cleared', rewritten.find((t) => t.id === 't1')?.location, 'personal')
check('The loan\'s own regular payment (a different sourceType) is never touched by this function', rewritten.find((t) => t.id === 't3')?.location, 'pot')

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll overpayment-location-independence checks passed.')
