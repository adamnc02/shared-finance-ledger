import { buildCreditCardMinimumChargeRows, generateMinimumPaymentTransactions } from '../src/lib/creditCards'
import type { CreditCard, Transaction } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

const card: CreditCard = {
  id: 'card1',
  name: 'Amex',
  categoryId: 'x',
  color: '#8b5cf6',
  interestRatePercent: 20,
  currentBalance: 1000,
  balanceAsOfDate: '2026-07-01',
  minimumPayment: { type: 'fixed', amount: 50 },
  paymentDayOfMonth: 15,
  ownerId: 'p1',
  lumpPayments: [],
  active: true,
}

const asOf = new Date(2026, 7, 19) // 19 Aug 2026

// ── Row building: stored + generated, deduped, spend/lump excluded ────
const storedPastCharge: Transaction = {
  id: 't1',
  date: '2026-07-15',
  amount: 50,
  direction: 'out',
  categoryId: 'x',
  paymentMethod: 'direct_debit',
  status: 'cleared',
  type: 'credit_card_payment',
  location: 'personal',
  ownerId: 'p1',
  creditCardId: 'card1',
  note: 'Amex - Minimum Charge',
  // no sourceType — a materialized minimum charge, not a lump payment
}
const lumpPayment: Transaction = {
  id: 't2',
  date: '2026-07-20',
  amount: 200,
  direction: 'out',
  categoryId: 'x',
  paymentMethod: 'bank_transfer',
  status: 'cleared',
  type: 'credit_card_payment',
  location: 'personal',
  ownerId: 'p1',
  creditCardId: 'card1',
  sourceType: 'credit_card_lump_payment',
  sourceId: 'lp1',
}
const spend: Transaction = {
  id: 't3',
  date: '2026-07-10',
  amount: 30,
  direction: 'out',
  categoryId: 'x',
  paymentMethod: 'card',
  status: 'cleared',
  type: 'credit_card_spend',
  location: 'personal',
  ownerId: 'p1',
  creditCardId: 'card1',
}

const rows = buildCreditCardMinimumChargeRows(card, [storedPastCharge, lumpPayment, spend], asOf)
check('A lump payment (sourceType set) is excluded from minimum-charge rows', rows.some((r) => r.date === '2026-07-20'), false)
check('A spend transaction is excluded from minimum-charge rows', rows.some((r) => r.date === '2026-07-10'), false)
check('The stored minimum charge IS included, and marked materialized', rows.find((r) => r.date === '2026-07-15')?.materialized, true)
check('A future date has a generated (non-materialized) row', rows.find((r) => r.date === '2026-08-15')?.materialized, false)
check('Rows are in ascending date order', rows.every((r, i) => i === 0 || rows[i - 1].date <= r.date), true)

// ── Override mechanism: a future (non-materialized) date respects the override ──
const cardWithOverride: CreditCard = { ...card, minimumPaymentOverrides: [{ date: '2026-09-15', amount: 75 }] }
const generatedWithOverride = generateMinimumPaymentTransactions(cardWithOverride, new Date(2026, 7, 1), new Date(2026, 10, 1))
check('An override for a not-yet-materialized date replaces the computed amount', generatedWithOverride.find((t) => t.date === '2026-09-15')?.amount, 75)
check('A date without an override still uses the normal computed amount', generatedWithOverride.find((t) => t.date === '2026-08-15')?.amount, 50)

// ── An override still feeds into the running balance for subsequent compounding (percent-of-balance card) ──
const percentCard: CreditCard = { ...card, minimumPayment: { type: 'percent_of_balance', percent: 10 } }
const normalSchedule = generateMinimumPaymentTransactions(percentCard, new Date(2026, 7, 1), new Date(2026, 9, 1))
const overriddenPercentCard: CreditCard = { ...percentCard, minimumPaymentOverrides: [{ date: '2026-08-15', amount: 500 }] } // a much bigger-than-normal payment
const overriddenSchedule = generateMinimumPaymentTransactions(overriddenPercentCard, new Date(2026, 7, 1), new Date(2026, 9, 1))
check(
  "A large override on one period genuinely reduces the balance the NEXT period compounds against (next min payment is smaller than it would otherwise be)",
  overriddenSchedule.find((t) => t.date === '2026-09-15')!.amount < normalSchedule.find((t) => t.date === '2026-09-15')!.amount,
  true,
)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll credit-card-minimum-charge checks passed.')
