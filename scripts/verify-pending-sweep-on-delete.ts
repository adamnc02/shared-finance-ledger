// Pending-transaction sweep on delete — confirmed 2026-09 session (item 3):
// "all pending transactions are deleted, with only cleared items retained
// as historic fact, and immutable." Tests the four sweep helpers directly
// (LedgerContext.tsx) rather than through the full React context, since
// they're pure functions over a transaction list.
//
// UAT Batch 4 (2026-09-04): a cleared transaction dated TODAY is the one
// exception to "immutable" — also swept away. Every sweep helper takes an
// explicit asOfIso so this is testable without depending on the real
// calendar date.
//
// 2026-10-10: the exception is now the whole edit window (lib/editWindow.ts,
// 5 days), not just today. A recurring payment deleted the day after it
// cleared used to stay in the ledger, Coin Jar round-up and all, with its
// generator gone and nothing left to reach it by. The fixtures' default
// cleared date is therefore well outside the window (16 days back), so
// "cleared survives" still tests history; the window's own boundary is
// checked at the end.

import { sweepPendingForLoan, sweepPendingForCreditCard, sweepPendingForSavingsPot, sweepPendingForSource } from '../src/context/LedgerContext'
import type { Loan, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const ASOF = '2026-09-04'

function txn(overrides: Partial<Transaction>): Transaction {
  return {
    id: overrides.id ?? 'txn',
    date: '2026-08-19',
    amount: 100,
    direction: 'out',
    categoryId: 'cat-1',
    paymentMethod: 'direct_debit',
    status: 'pending',
    type: 'loan_payment',
    location: 'personal',
    ownerId: 'me',
    ...overrides,
  }
}

// ── Loans — the trickiest sweep, since a one-off overpayment's sourceId
// is the overpayment's own id, not the loan's. ──
const loan: Loan = {
  id: 'loan-1',
  name: 'Car loan',
  monthlyPayment: 200,
  termMonths: 24,
  startDate: '2026-01-01',
  principal: 4000,
  categoryId: 'cat-1',
  location: 'personal',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [{ id: 'op-1', date: '2026-09-10', amount: 300 }],
  active: true,
}
const loanTxns: Transaction[] = [
  txn({ id: 't1', status: 'pending', sourceType: 'loan', sourceId: 'loan-1' }), // regular pending payment
  txn({ id: 't2', status: 'cleared', sourceType: 'loan', sourceId: 'loan-1' }), // regular CLEARED payment — must survive
  txn({ id: 't3', status: 'pending', sourceType: 'loan_recurring_overpayment', sourceId: 'loan-1' }),
  txn({ id: 't4', status: 'pending', sourceType: 'loan_overpayment', sourceId: 'op-1' }), // sourceId is the OVERPAYMENT's id, not the loan's
  txn({ id: 't5', status: 'cleared', sourceType: 'loan_overpayment', sourceId: 'op-1' }), // cleared overpayment — must survive
  txn({ id: 't6', status: 'pending', sourceType: 'loan_settlement', sourceId: 'loan-1' }),
  txn({ id: 't7', status: 'pending', sourceType: 'loan', sourceId: 'other-loan' }), // unrelated loan — must survive
  txn({ id: 't8', status: 'cleared', date: ASOF, sourceType: 'loan', sourceId: 'loan-1' }), // cleared but dated TODAY — removed
]
const afterLoanSweep = sweepPendingForLoan(loanTxns, loan, ASOF)
check('Pending regular loan payment removed', afterLoanSweep.some((t) => t.id === 't1'), false)
check('Cleared regular loan payment survives (historic fact)', afterLoanSweep.some((t) => t.id === 't2'), true)
check('Pending recurring-overpayment-derived payment removed', afterLoanSweep.some((t) => t.id === 't3'), false)
check('Pending one-off overpayment removed, matched via the OVERPAYMENT id not the loan id', afterLoanSweep.some((t) => t.id === 't4'), false)
check('Cleared one-off overpayment survives', afterLoanSweep.some((t) => t.id === 't5'), true)
check('Pending settlement removed', afterLoanSweep.some((t) => t.id === 't6'), false)
check('An unrelated loan\'s pending transaction is untouched', afterLoanSweep.some((t) => t.id === 't7'), true)
check('Cleared-but-dated-TODAY loan payment is removed too (Batch 4 exception)', afterLoanSweep.some((t) => t.id === 't8'), false)

// ── Credit cards — single direct FK field, covers minimum charges
// (no sourceType at all), lump payments, and spend uniformly. ──
const cardTxns: Transaction[] = [
  txn({ id: 'c1', status: 'pending', type: 'credit_card_payment', creditCardId: 'card-1' }), // generated minimum, no sourceType
  txn({ id: 'c2', status: 'cleared', type: 'credit_card_payment', creditCardId: 'card-1' }),
  txn({ id: 'c3', status: 'pending', type: 'credit_card_payment', creditCardId: 'card-1', sourceType: 'credit_card_lump_payment', sourceId: 'lp-1' }),
  txn({ id: 'c4', status: 'pending', type: 'credit_card_spend', creditCardId: 'card-1', direction: 'out' }),
  txn({ id: 'c5', status: 'pending', type: 'credit_card_payment', creditCardId: 'other-card' }),
  txn({ id: 'c6', status: 'cleared', date: ASOF, type: 'credit_card_payment', creditCardId: 'card-1' }), // cleared but dated TODAY — removed
]
const afterCardSweep = sweepPendingForCreditCard(cardTxns, 'card-1', ASOF)
check('Pending generated minimum charge removed', afterCardSweep.some((t) => t.id === 'c1'), false)
check('Cleared minimum charge survives', afterCardSweep.some((t) => t.id === 'c2'), true)
check('Pending lump payment removed', afterCardSweep.some((t) => t.id === 'c3'), false)
check('Pending spend removed', afterCardSweep.some((t) => t.id === 'c4'), false)
check('Another card\'s pending transaction untouched', afterCardSweep.some((t) => t.id === 'c5'), true)
check('Cleared-but-dated-TODAY card payment is removed too (Batch 4 exception)', afterCardSweep.some((t) => t.id === 'c6'), false)

// ── Savings pots — same direct-FK shape as credit cards. ──
const potTxns: Transaction[] = [
  txn({ id: 's1', status: 'pending', type: 'savings_deposit', savingsPotId: 'pot-1' }),
  txn({ id: 's2', status: 'cleared', type: 'savings_deposit', savingsPotId: 'pot-1' }),
  txn({ id: 's3', status: 'pending', type: 'savings_interest', savingsPotId: 'pot-1', sourceType: 'savings_pot', sourceId: 'pot-1' }),
  txn({ id: 's4', status: 'pending', type: 'savings_deposit', savingsPotId: 'other-pot' }),
  txn({ id: 's5', status: 'cleared', date: ASOF, type: 'savings_deposit', savingsPotId: 'pot-1' }), // cleared but dated TODAY — removed
]
const afterPotSweep = sweepPendingForSavingsPot(potTxns, 'pot-1', ASOF)
check('Pending deposit removed', afterPotSweep.some((t) => t.id === 's1'), false)
check('Cleared deposit survives', afterPotSweep.some((t) => t.id === 's2'), true)
check('Pending generated interest removed', afterPotSweep.some((t) => t.id === 's3'), false)
check('Another pot\'s pending transaction untouched', afterPotSweep.some((t) => t.id === 's4'), true)
check('Cleared-but-dated-TODAY savings deposit is removed too (Batch 4 exception, and the direct root fix for the stray-pot-balance bug)', afterPotSweep.some((t) => t.id === 's5'), false)

// ── RecurringTemplate / Pension — sourceType+sourceId only. ──
const templateTxns: Transaction[] = [
  txn({ id: 'r1', status: 'pending', type: 'bill_payment', sourceType: 'recurring_template', sourceId: 'template-1' }),
  txn({ id: 'r2', status: 'cleared', type: 'bill_payment', sourceType: 'recurring_template', sourceId: 'template-1' }),
  txn({ id: 'r3', status: 'pending', type: 'bill_payment', sourceType: 'recurring_template', sourceId: 'other-template' }),
  txn({ id: 'r4', status: 'cleared', date: ASOF, type: 'bill_payment', sourceType: 'recurring_template', sourceId: 'template-1' }), // cleared but dated TODAY — removed
]
const afterTemplateSweep = sweepPendingForSource(templateTxns, 'recurring_template', 'template-1', ASOF)
check('Pending bill payment removed', afterTemplateSweep.some((t) => t.id === 'r1'), false)
check('Cleared bill payment survives', afterTemplateSweep.some((t) => t.id === 'r2'), true)
check('Another template\'s pending transaction untouched', afterTemplateSweep.some((t) => t.id === 'r3'), true)
check('Cleared-but-dated-TODAY bill payment is removed too (inside the edit window)', afterTemplateSweep.some((t) => t.id === 'r4'), false)

const pensionTxns: Transaction[] = [
  txn({ id: 'p1', status: 'pending', type: 'pension_income', sourceType: 'pension', sourceId: 'pension-1', direction: 'in' }),
  txn({ id: 'p2', status: 'cleared', type: 'pension_income', sourceType: 'pension', sourceId: 'pension-1', direction: 'in' }),
]
const afterPensionSweep = sweepPendingForSource(pensionTxns, 'pension', 'pension-1', ASOF)
check('Pending pension payment removed', afterPensionSweep.some((t) => t.id === 'p1'), false)
check('Cleared pension payment survives', afterPensionSweep.some((t) => t.id === 'p2'), true)

// ── The edit window's boundary (2026-10-10). ASOF 4 Sep: 31 Aug–4 Sep are
// inside (5 days, today included), 30 Aug is the first day outside. The
// Cigs shape: a recurring payment cleared YESTERDAY, its generator deleted
// today. Control: the same row 5 days back is history and survives. ──
const windowTxns: Transaction[] = [
  txn({ id: 'w1', status: 'cleared', date: '2026-09-03', type: 'expense', sourceType: 'recurring_template', sourceId: 'template-1', amount: 75, roundedFrom: 74.85, roundingPotId: 'jar' }),
  txn({ id: 'w2', status: 'cleared', date: '2026-08-31', type: 'expense', sourceType: 'recurring_template', sourceId: 'template-1' }),
  txn({ id: 'w3', status: 'cleared', date: '2026-08-30', type: 'expense', sourceType: 'recurring_template', sourceId: 'template-1' }),
]
const afterWindowSweep = sweepPendingForSource(windowTxns, 'recurring_template', 'template-1', ASOF)
check('Cleared YESTERDAY, generator deleted today: removed (the Cigs bug)', afterWindowSweep.some((t) => t.id === 'w1'), false)
check('Cleared 4 days back (last day inside the window): removed', afterWindowSweep.some((t) => t.id === 'w2'), false)
check('Cleared 5 days back (first day outside the window): survives as history', afterWindowSweep.some((t) => t.id === 'w3'), true)

if (failures > 0) {
  console.log(`\n${failures} pending-transaction sweep check(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll pending-transaction sweep checks passed.')
}
