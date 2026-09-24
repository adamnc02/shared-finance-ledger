// The cycle statement's test fixture — ENTIRELY FICTIONAL, and it must
// stay that way.
//
// 🚨 Every ledger repo is PUBLIC and a commit is permanent. A backup
// carries ~100 free-text values naming two real people's banks, insurers,
// subscriptions and merchants, so a fixture seeded from one could never be
// removed again. The statement round's original hand-built reference was
// deleted on 2026-09-24 for exactly that reason (real data must never reach a repo). These
// names, dates and figures are invented.
//
// Shared by verify-cycle-statement.ts, verify-cycle-statement-matches-home.ts
// and verify-statement-picker.ts so all three describe the same app — a
// disagreement between them is then a real disagreement, not two fixtures.

import { defaultPayCycleConfig } from '../src/lib/ledgerStorage'
import type { AppDataV2, CreditCard, Loan, Person, RecurringTemplate, Transaction } from '../src/types/ledger'

/** "Today" for every statement test. Mid-cycle, so there is history behind it and schedule ahead of it. */
export const ASOF = new Date(2026, 8, 24) // 24 Sep 2026

export const CATEGORIES = [
  { id: 'cat-income', name: 'Income', icon: 'Wallet', iconColor: '#2f8f5b' },
  { id: 'cat-groceries', name: 'Groceries', icon: 'ShoppingCart', iconColor: '#c2410c' },
  { id: 'cat-home', name: 'Home', icon: 'House', iconColor: '#1d4ed8' },
  { id: 'cat-repayment', name: 'Repayment', icon: 'Banknote', iconColor: '#7c3aed' },
  { id: 'cat-card', name: 'Card', icon: 'CreditCard', iconColor: '#be123c' },
] as unknown as AppDataV2['categories']

const me: Person = { id: 'p1', name: 'Alex', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [] }
const other: Person = { id: 'p2', name: 'Sam', color: '#4c8bff', salaryHistory: [], salaryOverrides: [] }

/** Payday on the 14th, so cycles run 14th → 13th — the shape the statement's cycle bands are drawn from. */
export const PAY_CYCLE = {
  ...defaultPayCycleConfig('p1'),
  openingBalance: 38.43,
  openingBalanceDate: '2026-09-14',
  paydayDayOfMonth: 14,
  cycleStartDayOfMonth: 14,
  paydayAdjustForNonWorkingDay: false,
}

const otherCycle = { ...defaultPayCycleConfig('p2'), openingBalance: 0, openingBalanceDate: '2026-09-14', paydayDayOfMonth: 14, cycleStartDayOfMonth: 14 }

function txn(over: Partial<Transaction> & Pick<Transaction, 'id' | 'date' | 'amount' | 'direction' | 'type'>): Transaction {
  return {
    categoryId: 'cat-groceries',
    paymentMethod: 'card',
    status: 'cleared',
    location: 'personal',
    ownerId: 'p1',
    ...over,
  } as Transaction
}

const transactions: Transaction[] = [
  // ── The current cycle, already cleared ──
  txn({ id: 't1', date: '2026-09-14', amount: 2938.89, direction: 'in', type: 'salary', categoryId: 'cat-income', note: 'Salary', personId: 'p1' }),
  txn({ id: 't2', date: '2026-09-15', amount: 74.2, direction: 'out', type: 'expense', note: 'Weekly shop' }),
  txn({ id: 't3', date: '2026-09-18', amount: 42.5, direction: 'out', type: 'expense', note: 'Weekly shop' }),
  // Two rows dated TODAY — the template highlights today, and highlights
  // the "Still to come" band instead when nothing is dated today.
  txn({ id: 't4', date: '2026-09-24', amount: 18.75, direction: 'out', type: 'expense', note: 'Weekly shop' }),
  txn({ id: 't5', date: '2026-09-24', amount: 9.99, direction: 'out', type: 'expense', categoryId: 'cat-home', note: 'Streaming' }),
  // ── Still to come, this cycle ──
  txn({ id: 't6', date: '2026-10-02', amount: 128.4, direction: 'out', type: 'expense', status: 'pending', categoryId: 'cat-home', note: 'Council tax' }),
  // ── Joint ──
  txn({ id: 'j1', date: '2026-09-16', amount: 220, direction: 'out', type: 'expense', location: 'joint', categoryId: 'cat-home', note: 'Energy' }),
  txn({ id: 'j2', date: '2026-10-16', amount: 220, direction: 'out', type: 'expense', status: 'pending', location: 'joint', categoryId: 'cat-home', note: 'Energy' }),
  // ── Card activity ──
  txn({ id: 'cc1', date: '2026-09-19', amount: 63.2, direction: 'out', type: 'credit_card_spend', creditCardId: 'card1', categoryId: 'cat-card', note: 'Fuel' }),
]

/** A monthly bill, so the window past the current cycle has generated occurrences in it rather than only stored ones. */
const rent: RecurringTemplate = {
  id: 'tpl-rent',
  name: 'Rent',
  amount: 650,
  categoryId: 'cat-home',
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-09-28',
  anchorDayOfMonth: 28,
  location: 'personal',
  ownerId: 'p1',
  payee: 'Landlord',
  payeeSharePercent: 100,
  active: true,
  kind: 'bill',
} as unknown as RecurringTemplate

/** A loan with real interest AND an overpayment — the overpayment is 100% capital and zero interest, which is the clearest demonstration of why the split is worth showing (the capital/interest columns). */
const loan: Loan = {
  id: 'car',
  name: 'Car Finance',
  principal: 6000,
  monthlyPayment: 171.93,
  termMonths: 36,
  startDate: '2026-04-28',
  advanceDate: '2026-04-14',
  categoryId: 'cat-repayment',
  location: 'personal',
  ownerId: 'p1',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [{ date: '2026-10-20', amount: 250 }],
  active: true,
  interestConventionId: 'daily_simple',
  calibratedMonthlyRate: 0.005,
} as unknown as Loan

const card: CreditCard = {
  id: 'card1',
  name: 'Kestrel',
  categoryId: 'cat-card',
  color: '#be123c',
  interestRatePercent: 21.9,
  currentBalance: 412.6,
  balanceAsOfDate: '2026-09-14',
  minimumPayment: { type: 'percent_of_balance', percent: 100 },
  paymentDayOfMonth: 8,
  ownerId: 'p1',
  active: true,
  lumpPayments: [],
  statementEndDay: 26,
} as unknown as CreditCard

/** A joint bill, so the deck actually offers a Joint card — buildDeck gates it on a joint template or an active joint loan existing, not on joint transactions. */
const energy: RecurringTemplate = {
  id: 'tpl-energy',
  name: 'Energy',
  amount: 220,
  categoryId: 'cat-home',
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-09-16',
  anchorDayOfMonth: 16,
  location: 'joint',
  ownerId: 'p1',
  payee: 'Energy supplier',
  payeeSharePercent: 50,
  active: true,
  kind: 'bill',
} as unknown as RecurringTemplate

export function statementFixture(): AppDataV2 {
  return {
    primaryPersonId: 'p1',
    people: [me, other],
    categories: CATEGORIES,
    recurringTemplates: [rent, energy],
    loans: [loan],
    creditCards: [card],
    pensions: [],
    savingsPots: [],
    pots: [],
    transactions,
    payCycles: [PAY_CYCLE, otherCycle],
    scenarios: [],
    jointAccount: { openingBalance: 500, openingBalanceDate: '2026-09-14' },
  } as unknown as AppDataV2
}
