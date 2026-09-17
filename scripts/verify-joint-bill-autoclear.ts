// Regression test for the 2026-09-15 bugfix — a joint-location recurring
// bill/loan (Adam's report: "Barkin Bistro" re-added from scratch with a
// single-occurrence amount override) never cleared in the Joint ledger no
// matter how far past its date. Root cause: autoClearDuePayments' Step 2
// only ever materialized `location: 'personal'` bill/loan templates —
// nothing materialized a `location: 'joint'` one, so
// computeJointAccountProjection only ever saw generateTransactionsForTemplate's
// hardcoded `status: 'pending'`, forever. Covers a plain joint bill, a
// joint bill with an occurrence override (the exact reported scenario),
// and a joint-location loan.
import { autoClearDuePayments } from '../src/lib/autoClear'
import { defaultCategories } from '../src/lib/categories'
import { BILLS_CATEGORY_ID } from '../src/types/ledger'
import type { AppDataV2, Loan, PayCycleConfig, Person, RecurringTemplate } from '../src/types/ledger'

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

const person: Person = {
  id: 'me',
  name: 'Me',
  color: '#ff5b4c',
  salaryHistory: [],
  salaryOverrides: [],
}

// Mirrors the reported "Barkin Bistro" template: joint-location bill,
// monthly, with a single-occurrence amount override for this month.
const jointBillWithOverride: RecurringTemplate = {
  id: 'bill-barkin',
  name: 'Barkin Bistro',
  amount: 60.35,
  categoryId: BILLS_CATEGORY_ID,
  paymentMethod: 'standing_order',
  frequency: 'monthly',
  anchorDate: '2026-09-14',
  location: 'joint',
  payee: 'me',
  payeeSharePercent: 50,
  ownerId: '',
  active: true,
  occurrenceOverrides: [{ originalDate: '2026-09-14', amount: 40.39 }],
}

const plainJointBill: RecurringTemplate = {
  id: 'bill-virgin',
  name: 'Virgin',
  amount: 38.2,
  categoryId: BILLS_CATEGORY_ID,
  paymentMethod: 'standing_order',
  frequency: 'monthly',
  anchorDate: '2026-09-06',
  location: 'joint',
  payee: 'me',
  payeeSharePercent: 100,
  ownerId: '',
  active: true,
}

const jointLoan: Loan = {
  id: 'loan-joint',
  name: 'Joint Car Loan',
  principal: 5000,
  monthlyPayment: 150,
  termMonths: 36,
  apr: 0,
  startDate: '2026-06-01',
  lender: 'Bank',
  categoryId: BILLS_CATEGORY_ID,
  location: 'joint',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  active: true,
  overpayments: [],
}

const data: AppDataV2 = {
  people: [person],
  categories: defaultCategories(),
  recurringTemplates: [jointBillWithOverride, plainJointBill],
  loans: [jointLoan],
  creditCards: [],
  transactions: [],
  payCycles: [payCycle],
  pensions: [],
  scenarios: [],
  primaryPersonId: 'me',
  jointAccount: { openingBalance: 200, openingBalanceDate: '2026-09-01' },
}

// asOf = the day after the reported scenario's "today" (2026-09-15), so
// both the 14th's bill and the 6th's bill and the loan's first payment
// (2026-07-01 onward, monthly) are all in the past.
const asOf = new Date(2026, 8, 15) // 2026-09-15

const settled = autoClearDuePayments(data, asOf)

check('autoClearDuePayments actually changed something (joint bills were pending forever before this fix)', settled !== data, true)

const barkin = settled.transactions.find((t) => t.sourceId === 'bill-barkin' && t.date === '2026-09-14')
check('Barkin Bistro (joint, with an occurrence override) is materialized', !!barkin, true)
check('Barkin Bistro is cleared, not pending', barkin?.status, 'cleared')
check('Barkin Bistro used the override amount (40.39), not the standing amount (60.35)', barkin?.amount, 40.39)

const virgin = settled.transactions.find((t) => t.sourceId === 'bill-virgin' && t.date === '2026-09-06')
check('A plain joint bill with no override also materializes', !!virgin, true)
check('Plain joint bill is cleared', virgin?.status, 'cleared')

const jointLoanPayment = settled.transactions.find((t) => t.sourceId === 'loan-joint' && t.date <= '2026-09-15')
check('A joint-location loan payment also materializes', !!jointLoanPayment, true)
check('Joint loan payment is cleared', jointLoanPayment?.status, 'cleared')

// Idempotency: running again over the same settled data should find
// nothing new to do (same reference back), same guarantee every other
// autoClear step already relies on.
const secondPass = autoClearDuePayments(settled, asOf)
check('Second pass is a no-op (idempotent)', secondPass === settled, true)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll checks passed.')
}
