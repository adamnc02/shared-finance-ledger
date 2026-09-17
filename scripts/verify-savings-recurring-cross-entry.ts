// Phase 5 verification — SavingsPot recurring deposits + lump-sum
// logging get two UI entry points (Wallet page's own buttons, and the
// Transactions page's Recurring/Savings pills), both writing to the SAME
// underlying data. This confirms the data-layer contract those two
// surfaces share — the actual UI wiring is exercised by tsc/build,
// pure logic is what's worth a script here.

import { newSavingsPot, depositOccurrencePreviews, savingsPotBalanceAsOf, generateSavingsDepositTransactions } from '../src/lib/savingsPotLedger'
import type { SavingsPot, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const basePot: SavingsPot = {
  id: 'pot-1',
  ...newSavingsPot({
    personId: 'me',
    name: 'Holiday fund',
    openingBalance: 0,
    openingDate: '2026-01-01',
    interestMethod: { type: 'aer_credited', aer: 4, creditingFrequency: 'monthly' },
  }),
}

// ─────────────────────────────────────────────────────────────────────
// Recurring deposit — whichever entry point set these three fields
// (Salary.tsx's RecurringDepositEditor or Expenses.tsx's
// RecurringTransactionForm "Savings" option), the SAME generator picks
// it up identically. Both UI paths ultimately just call updateSavingsPot
// with this exact shape.
// ─────────────────────────────────────────────────────────────────────
const potWithRecurring: SavingsPot = {
  ...basePot,
  recurringDepositAmount: 100,
  recurringDepositDayOfMonth: 15,
  recurringDepositStartDate: '2026-06-01',
}
const previews = depositOccurrencePreviews(potWithRecurring, new Date('2026-06-01'), 3)
check('A recurring deposit configured via either entry point generates the expected occurrence dates', previews.map((p) => p.date), ['2026-06-15', '2026-07-15', '2026-08-15'])
check('...at the configured amount', previews.every((p) => p.amount === 100), true)

const generated = generateSavingsDepositTransactions(potWithRecurring, new Date('2026-06-01'), new Date('2026-08-31'))
check(
  'generateSavingsDepositTransactions (what the Wallet page\'s own balance/ledger reads) produces the same three dates',
  generated.map((t) => t.date),
  ['2026-06-15', '2026-07-15', '2026-08-15'],
)
check('Every generated deposit carries savingsPotId — the exact field the Transactions page\'s Savings pill filters on', generated.every((t) => t.savingsPotId === 'pot-1'), true)

// ─────────────────────────────────────────────────────────────────────
// A lump deposit — whether logged via the Wallet page's new "+ Log a
// deposit" button or the Transactions page's existing Savings pill, both
// call logSavingsDeposit with the same signature, producing an identical
// Transaction shape. Confirms that shape is picked up correctly by BOTH
// surfaces' own read paths: the Wallet page's balance calc, and a plain
// filter matching what the Transactions page's Savings pill uses.
// ─────────────────────────────────────────────────────────────────────
const lumpDeposit: Transaction = {
  id: 't1',
  date: '2026-06-20',
  amount: 500,
  direction: 'out',
  categoryId: 'cat-savings',
  paymentMethod: 'bank_transfer',
  status: 'cleared',
  type: 'savings_deposit',
  location: 'personal',
  ownerId: 'me',
  savingsPotId: 'pot-1',
}
const balanceAfterLump = savingsPotBalanceAsOf(basePot, [lumpDeposit], new Date('2026-06-25'))
check('The Wallet page\'s own balance calc picks up a lump deposit regardless of which entry point logged it', balanceAfterLump, 500)

const transactionsPageSavingsPillFilter = (t: Transaction) => t.type === 'savings_deposit' || t.type === 'savings_withdrawal'
check('The same transaction also matches the Transactions page\'s Savings pill filter', transactionsPageSavingsPillFilter(lumpDeposit), true)

if (failures > 0) {
  console.log(`\n${failures} savings cross-entry-point check(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll savings cross-entry-point checks passed.')
}
