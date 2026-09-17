// REPORTED: "Ensure income (from transactions page and salary) is part of
// pending balance — currently when adding a transfer from family member
// of +100, this is not reflected in the summary page pending figure, but
// it does display in the ledger."
//
// Reproduced live before the fix: a +£100 pending transfer moved
// Projected from £100.82 to £200.82 and appeared in the ledger list, but
// Pending sat unchanged at -£511.93.
//
// CAUSE: Home.tsx's pendingOutgoingTotal filtered on `direction === 'out'`
// by design, on the reasoning that salary is already reflected in
// Projected so counting it in Pending too would make Pending read as
// "net cash flow" rather than "money due to go out". In practice that
// made a logged income entry look like the app had simply missed it.
//
// FIX: pendingNetTotal counts both directions. There was never any
// double-counting to worry about — Projected is computed independently in
// projection.ts and doesn't read this function at all. The netting also
// buys a genuinely useful invariant, asserted throughout below:
//
//     Current balance + Pending === Projected
//
// for every horizon. That's what makes the hero's three figures
// reconcilable by eye, which the outgoings-only version never allowed.

import { computeProjection } from '../src/lib/projection'
import { isLedgerTransaction, signedAmount } from '../src/lib/runningBalance'
import { INCOME_CATEGORY_ID, BILLS_CATEGORY_ID } from '../src/types/ledger'
import type { AppDataV2, PayCycleConfig, Person, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = typeof actual === 'number' && typeof expected === 'number' && tolerance > 0 ? Math.abs(actual - expected) <= tolerance : a === e
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${e}, got ${a}`)
}

const round2 = (n: number) => Math.round(n * 100) / 100

// The exact function under test, mirrored from Home.tsx.
function pendingNetTotal(transactions: Transaction[]): number {
  return round2(transactions.filter((t) => t.status === 'pending' && isLedgerTransaction(t)).reduce((sum, t) => sum + signedAmount(t), 0))
}
// The old behaviour, kept only to demonstrate the difference.
function pendingOutgoingOnly(transactions: Transaction[]): number {
  return -transactions.filter((t) => t.status === 'pending' && isLedgerTransaction(t) && t.direction === 'out').reduce((sum, t) => sum + t.amount, 0)
}

const txn = (over: Partial<Transaction> & Pick<Transaction, 'id' | 'date' | 'amount' | 'direction' | 'type'>): Transaction => ({
  categoryId: BILLS_CATEGORY_ID,
  paymentMethod: 'direct_debit',
  status: 'pending',
  location: 'personal',
  ownerId: 'me',
  ...over,
})

// ---- 1. The reported case ----
const bill = txn({ id: 't1', date: '2026-08-29', amount: 40, direction: 'out', type: 'expense' })
const familyTransfer = txn({ id: 't2', date: '2026-09-01', amount: 100, direction: 'in', type: 'income', categoryId: INCOME_CATEGORY_ID, personId: 'me', note: 'Transfer from family member' })

check('Old behaviour ignored the +£100 transfer entirely (the reported bug)', pendingOutgoingOnly([bill, familyTransfer]), -40)
check('Pending now nets the transfer against the outgoing', pendingNetTotal([bill, familyTransfer]), 60)
check('With outgoings only, Pending is still negative as expected', pendingNetTotal([bill]), -40)

// ---- 2. Salary counts too, not just ad-hoc income ----
const salary = txn({ id: 't3', date: '2026-09-14', amount: 2938.18, direction: 'in', type: 'salary', categoryId: INCOME_CATEGORY_ID, personId: 'me' })
check('A pending salary payday is part of Pending', pendingNetTotal([bill, salary]), 2898.18)
check('Income from BOTH sources (salary and a logged transfer) is included', pendingNetTotal([bill, salary, familyTransfer]), 2998.18)

// ---- 3. Cleared items are never counted — they belong to the balance ----
const clearedIncome = txn({ id: 't4', date: '2026-08-01', amount: 500, direction: 'in', type: 'income', status: 'cleared' })
check('A CLEARED income entry is excluded (it is already in the balance, counting it here would double it)', pendingNetTotal([familyTransfer, clearedIncome]), 100)

// ---- 4. credit_card_spend is still excluded ----
// It never reaches the personal ledger at all (see types/ledger.ts), so
// widening the direction filter must not accidentally let it in.
const cardSpend = txn({ id: 't5', date: '2026-09-02', amount: 75, direction: 'out', type: 'credit_card_spend', creditCardId: 'card-1' })
check('credit_card_spend is still excluded from Pending', pendingNetTotal([familyTransfer, cardSpend]), 100)

// A payment TOWARD a card is real cash out and must still count.
const cardPayment = txn({ id: 't6', date: '2026-09-14', amount: 200, direction: 'out', type: 'credit_card_payment', creditCardId: 'card-1' })
check('A credit card PAYMENT is still counted (real cash leaving the account)', pendingNetTotal([cardPayment]), -200)

// ---- 5. The invariant, against a real projection ----
const person: Person = {
  id: 'me',
  name: 'Me',
  color: '#ff5b4c',
  salaryHistory: [
    {
      id: 'snap-1',
      personId: 'me',
      effectiveFrom: '2026-01-01',
      grossAnnual: 56650,
      taxCode: '374L',
      studentLoanPlan: 'none',
      payFrequency: 'monthly',
      deductions: [],
    },
  ],
  salaryOverrides: [],
}
const payCycle: PayCycleConfig = {
  personId: 'me',
  openingBalance: 612.75,
  openingBalanceDate: '2026-08-22',
  paydayDayOfMonth: 14,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 14,
}
const data: AppDataV2 = {
  primaryPersonId: 'me',
  people: [person],
  categories: [],
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  transactions: [familyTransfer],
  payCycles: [payCycle],
  pensions: [],
  scenarios: [],
}
const asOf = new Date(2026, 7, 22)

for (const horizon of ['current_cycle', 'three_cycles'] as const) {
  const projection = computeProjection(data, 'me', payCycle, horizon, asOf)
  const pending = pendingNetTotal(projection.transactions)
  check(
    `[${horizon}] Current balance + Pending === Projected (the invariant the outgoings-only version could not satisfy)`,
    round2(projection.clearedBalance + pending),
    round2(projection.projectedBalance),
    0.01,
  )
}

// And the same invariant must hold with NO income at all, so the change
// can't be said to have merely traded one inconsistency for another.
const noIncomeData: AppDataV2 = { ...data, transactions: [], people: [{ ...person, salaryHistory: [] }] }
const noIncomeProjection = computeProjection(noIncomeData, 'me', payCycle, 'current_cycle', asOf)
check(
  'The invariant still holds when there is no income at all',
  round2(noIncomeProjection.clearedBalance + pendingNetTotal(noIncomeProjection.transactions)),
  round2(noIncomeProjection.projectedBalance),
  0.01,
)

// ---- 6. The transfer really does move Projected, not just Pending ----
const withoutTransfer = computeProjection({ ...data, transactions: [] }, 'me', payCycle, 'current_cycle', asOf)
const withTransfer = computeProjection(data, 'me', payCycle, 'current_cycle', asOf)
check('A +£100 pending transfer raises Projected by exactly £100', round2(withTransfer.projectedBalance - withoutTransfer.projectedBalance), 100)
check('...and raises Pending by exactly £100 too (they now move together)', round2(pendingNetTotal(withTransfer.transactions) - pendingNetTotal(withoutTransfer.transactions)), 100)

console.log(failures === 0 ? '\nAll pending-net checks passed.' : `\n${failures} pending-net check(s) failed.`)
if (failures > 0) process.exit(1)
