import { buildCreditCardMinimumChargeRows } from '../src/lib/creditCards'
import type { CreditCard } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

// The exact real bug reported: a BRAND NEW card (created today, no real
// payment history at all) showed a full year of entirely fictional past
// minimum charges in its ledger modal, burying "today onward" a year of
// scrolling deep — despite the card not having existed a year ago.
const freshCard: CreditCard = {
  id: 'natwest',
  name: 'NatWest',
  categoryId: 'x',
  color: '#8b5cf6',
  interestRatePercent: 15.2,
  currentBalance: 1000,
  balanceAsOfDate: '2026-08-19', // created today, per the scenario
  minimumPayment: { type: 'percent_of_balance', percent: 5 },
  paymentDayOfMonth: 25,
  ownerId: 'p1',
  lumpPayments: [],
  active: true,
}

const asOf = new Date(2026, 7, 19) // 19 Aug 2026
const rows = buildCreditCardMinimumChargeRows(freshCard, [], asOf)

check('A fresh card with NO stored history shows no rows dated before today at all', rows.every((r) => r.date >= '2026-08-19'), true)
check('...specifically, nothing from a year ago (the exact reported symptom)', rows.some((r) => r.date.startsWith('2025-08')), false)
check("This month's still-upcoming charge (25 Aug) IS still included — the fix doesn't accidentally skip the current cycle", rows.some((r) => r.date === '2026-08-25'), true)

// An ESTABLISHED card, by contrast, should still show its real past —
// anchored to its own earliest real transaction, not an arbitrary window.
const establishedCard: CreditCard = { ...freshCard, id: 'natwest2', balanceAsOfDate: '2026-03-01' }
const oldRealTransaction = {
  id: 't1',
  date: '2026-03-25',
  amount: 50,
  direction: 'out' as const,
  categoryId: 'x',
  paymentMethod: 'direct_debit' as const,
  status: 'cleared' as const,
  type: 'credit_card_payment' as const,
  location: 'personal' as const,
  ownerId: 'p1',
  creditCardId: 'natwest2',
}
const establishedRows = buildCreditCardMinimumChargeRows(establishedCard, [oldRealTransaction], asOf)
check('An established card with real history shows back to its own earliest REAL transaction', establishedRows.some((r) => r.date === '2026-03-25'), true)
check('...but still nothing before that real history begins', establishedRows.every((r) => r.date >= '2026-03-25'), true)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll fresh-card-history-window checks passed.')
