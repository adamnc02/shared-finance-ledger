// Checks for the Summary page's pop-down breakdown card (income /
// outgoings / available) and for the salary-first ordering rule in the
// group-by-list, order-by-date ledger view. Both are plain functions over
// a transaction list, so this exercises them directly — no DOM.

import { computeCycleSummary, compareByDateSalaryFirst, compareByDateDescSalaryFirst } from '../src/lib/cycleSummary'
import type { Transaction } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

let seq = 0
function txn(over: Partial<Transaction>): Transaction {
  return {
    id: `t${seq++}`,
    date: '2026-08-10',
    amount: 100,
    direction: 'out',
    categoryId: 'category-bills',
    paymentMethod: 'direct_debit',
    status: 'pending',
    type: 'bill_payment',
    location: 'personal',
    ownerId: 'p1',
    ...over,
  }
}

// ── The breakdown card's own arithmetic ──────────────────────────────

const transactions: Transaction[] = [
  // Income: a cleared salary that's already landed, a bonus alongside it,
  // and an ad-hoc income entry logged on the Expenses page.
  txn({ type: 'salary', direction: 'in', amount: 2400, status: 'cleared', date: '2026-08-01' }),
  txn({ type: 'bonus', direction: 'in', amount: 300, status: 'cleared', date: '2026-08-01' }),
  txn({ type: 'income', direction: 'in', amount: 50, status: 'pending', date: '2026-08-15' }),
  // Outgoings across all three buckets.
  txn({ paymentMethod: 'standing_order', amount: 800, status: 'cleared', date: '2026-08-02' }), // rent
  txn({ paymentMethod: 'standing_order', amount: 120, status: 'pending', date: '2026-08-20' }),
  txn({ paymentMethod: 'direct_debit', amount: 60, status: 'pending', date: '2026-08-18' }),
  // A loan overpayment generates as bank_transfer, but must still land in
  // the DD bucket — "include loans in DD".
  txn({ type: 'loan_payment', paymentMethod: 'bank_transfer', amount: 200, status: 'pending', date: '2026-08-22' }),
  txn({ type: 'loan_payment', paymentMethod: 'direct_debit', amount: 340, status: 'pending', date: '2026-08-25' }),
  txn({ type: 'expense', paymentMethod: 'cash', amount: 45, status: 'pending', date: '2026-08-19' }),
  // credit_card_spend never reaches the personal ledger at all — it must
  // not inflate the outgoings total (isLedgerTransaction filters it).
  txn({ type: 'credit_card_spend', paymentMethod: 'card', amount: 999, status: 'pending', creditCardId: 'c1' }),
]

// Opening 500, plus cleared: +2400 +300 -800 = 2400.
const clearedBalance = 2400
const summary = computeCycleSummary(transactions, clearedBalance)

check('Salary income folds the bonus in with the salary', summary.income.salary, 2700)
check('Ad-hoc income is reported separately', summary.income.other, 50)
check('Income total is salary + bonus + ad-hoc income', summary.income.total, 2750)

check('Standing orders bucket sums only standing orders', summary.outgoings.standingOrder, 920)
check('Direct debits bucket includes loans paid by bank transfer', summary.outgoings.directDebit, 600)
check('Other outgoings covers cash/card/bank transfer', summary.outgoings.other, 45)
check('Outgoings total excludes credit_card_spend', summary.outgoings.total, 1565)

check('Current balance is passed straight through', summary.currentBalance, 2400)

// Available counts only STILL-PENDING movement on top of the balance:
// +50 -120 -60 -200 -340 -45 = -715.
check('Available is balance plus pending in, less pending out', summary.available, 1685)

// The invariant that makes the figure trustworthy: `available` must equal
// what computeProjection independently reports as projectedBalance
// (clearedBalance + all pending within the horizon). If the two ever
// disagree, the card is contradicting the hero sitting right above it.
const pendingDelta = transactions
  .filter((t) => t.status === 'pending' && t.type !== 'credit_card_spend')
  .reduce((sum, t) => sum + (t.direction === 'in' ? t.amount : -t.amount), 0)
check('Available matches an independent cleared + pending fold (the hero card figure)', summary.available, clearedBalance + pendingDelta)

// The deliberately-NOT-true identity, pinned so it can't be "fixed" by
// accident: naively adding the window totals double-counts the salary
// that's already cleared into the balance.
check(
  'Balance + income total - outgoings total is NOT the available figure (already-cleared items would count twice)',
  clearedBalance + summary.income.total - summary.outgoings.total !== summary.available,
  true,
)

// Empty ledger — every figure zero, available falls back to the balance.
const empty = computeCycleSummary([], 123.45)
check('An empty window zeroes every total', [empty.income.total, empty.outgoings.total], [0, 0])
check('An empty window leaves available at the current balance', empty.available, 123.45)

// ── Salary-first ordering ────────────────────────────────────────────

// Two bills and a salary all due the same day, deliberately fed in with
// the salary LAST — the real-world case being fixed (payday and bills
// sharing a date), where a plain date sort left the ordering to whatever
// order the generators happened to emit.
const sameDay: Transaction[] = [
  txn({ id: 'bill-a', date: '2026-08-31', amount: 300 }),
  txn({ id: 'bill-b', date: '2026-08-31', amount: 150 }),
  txn({ id: 'pay', date: '2026-08-31', type: 'salary', direction: 'in', amount: 2400 }),
]

check(
  'Salary sorts first among items sharing its date',
  sameDay.slice().sort(compareByDateSalaryFirst).map((t) => t.id),
  ['pay', 'bill-a', 'bill-b'],
)

check(
  'Salary still sorts first within its date in the reverse-chronological cleared list',
  sameDay.slice().sort(compareByDateDescSalaryFirst).map((t) => t.id),
  ['pay', 'bill-a', 'bill-b'],
)

// Dates still dominate — the salary-first rule is a tie-break within one
// date, not a global "salary always at the top".
const acrossDays: Transaction[] = [
  txn({ id: 'pay', date: '2026-08-31', type: 'salary', direction: 'in', amount: 2400 }),
  txn({ id: 'early-bill', date: '2026-08-05', amount: 90 }),
]
check(
  'A bill earlier in the month still sorts above a later salary',
  acrossDays.slice().sort(compareByDateSalaryFirst).map((t) => t.id),
  ['early-bill', 'pay'],
)
check(
  'Reverse-chronological order still puts the later salary first across dates',
  acrossDays.slice().sort(compareByDateDescSalaryFirst).map((t) => t.id),
  ['pay', 'early-bill'],
)

// The running balance this ordering exists to protect: folding the
// same-day list in order must never dip below the opening figure just
// because a bill was listed above the salary funding it.
let running = 100
const lows: number[] = []
for (const t of sameDay.slice().sort(compareByDateSalaryFirst)) {
  running += t.direction === 'in' ? t.amount : -t.amount
  lows.push(running)
}
check('Rolling balance never dips below the opening figure on payday', Math.min(...lows) >= 100, true)
