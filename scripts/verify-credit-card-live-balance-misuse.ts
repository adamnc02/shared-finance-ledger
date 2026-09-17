// Regression test for the 2026-09-16 bugfix — Adam-reported, a real
// backup: an EXISTING card (real spend/payment history spanning weeks)
// showed "Clear" logging DOUBLE the true balance due (£182.48 instead of
// £91.24), and the card's own edit form kept showing a lingering
// "outstanding balance" after clearing.
//
// Root cause: withLiveBalance(card, transactions, asOfDate) returns
// `{ ...card, currentBalance: cardBalanceAsOf(card, transactions, asOfDate) }`
// — it updates currentBalance to the LIVE computed figure but leaves
// balanceAsOfDate at the card's ORIGINAL anchor. cardBalanceAsOf/
// generateMinimumPaymentTransactions both start their own simulation from
// `card.currentBalance` and then REPLAY every real transaction from
// `card.balanceAsOfDate` onward on top of it — so feeding a "live" card
// back into either of them double-counts every transaction between the
// anchor and asOfDate, because that same activity is already baked into
// the live currentBalance AND gets replayed a second time.
//
// Two real call sites in src/pages/Loans.tsx (CreditCardLedgerModal and
// CreditCardDueSection) were doing exactly this — passing the LIVE `card`
// where they should pass `storedCard`. This test doesn't exercise the
// React wiring directly (that's covered by app-level Playwright testing
// in the session's own notes) — it demonstrates the underlying mechanism
// at the function level, so the misuse pattern itself has a permanent,
// fast-running regression guard: withLiveBalance's own result must never
// be fed back into cardBalanceAsOf/generateMinimumPaymentTransactions/
// anything built on them.
import { buildCreditCardDueOverviewRows, withLiveBalance } from '../src/lib/creditCards'
import type { CreditCard, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const card: CreditCard = {
  id: 'card-1',
  name: 'Santander',
  categoryId: 'category-credit-card',
  color: '#14b8a6',
  interestRatePercent: 0,
  currentBalance: 0,
  balanceAsOfDate: '2026-08-17',
  minimumPayment: { type: 'percent_of_balance', percent: 100 },
  paymentDayOfMonth: 14,
  ownerId: 'me',
  lumpPayments: [],
  active: true,
  minimumPaymentOverrides: [{ date: '2026-09-14', amount: 228.07 }],
}

function spend(id: string, date: string, amount: number): Transaction {
  return { id, date, amount, direction: 'out', categoryId: 'category-credit-card', paymentMethod: 'card', status: 'cleared', type: 'credit_card_spend', location: 'personal', ownerId: 'me', creditCardId: 'card-1' }
}
function chargePayment(id: string, date: string, amount: number): Transaction {
  return { id, date, amount, direction: 'out', categoryId: 'category-credit-card', paymentMethod: 'direct_debit', status: 'cleared', type: 'credit_card_payment', location: 'personal', ownerId: 'me', creditCardId: 'card-1', note: 'Santander - Minimum Charge' }
}

// Adam's exact numbers: £228.07 of spend before the 14 Sept due date, a
// real materialized payment covering it in full that same day, then
// £91.24 more spend logged (2 Sep, 4 Sep, 10 Sep) genuinely still owed
// for the NEXT due date (14 Oct).
const transactions: Transaction[] = [
  spend('s1', '2026-08-18', 4.5),
  spend('s2', '2026-08-19', 86),
  spend('s3', '2026-08-19', 54.7),
  spend('s4', '2026-08-21', 25.89),
  spend('s5', '2026-08-24', 1),
  spend('s6', '2026-08-24', 9.29),
  spend('s7', '2026-08-24', 8.74),
  spend('s8', '2026-08-24', 13.2),
  spend('s9', '2026-08-24', 24.75),
  chargePayment('p1', '2026-09-14', 228.07),
  spend('s10', '2026-09-02', 38.4),
  spend('s11', '2026-09-04', 4),
  spend('s12', '2026-09-10', 48.84),
]

const asOf = new Date(2026, 8, 15) // 15 Sept 2026

// ── 1. The correct path: buildCreditCardDueOverviewRows given the STORED card ──
{
  const rows = buildCreditCardDueOverviewRows(card, transactions, asOf)
  const oct14 = rows.find((r) => r.date === '2026-10-14')
  check('storedCard: 14 Oct balance due is the real £91.24 owed, not doubled', oct14?.balanceDue, 91.24)
}

// ── 2. THE BUG, demonstrated directly: the same call, but with a LIVE card instead ──
{
  const liveCard = withLiveBalance(card, transactions, asOf)
  const rows = buildCreditCardDueOverviewRows(liveCard, transactions, asOf)
  const oct14 = rows.find((r) => r.date === '2026-10-14')
  // Documents the exact failure mode this fix removed from the two real call
  // sites — this assertion PASSING confirms the misuse pattern still produces
  // the doubled figure if anyone ever reintroduces it; it is not itself the
  // "fixed" state (see check 1 above for that).
  check('REGRESSION DOCUMENTATION — feeding withLiveBalance\'s own result back in still doubles the figure (91.24 -> 182.48); this is exactly why the two real call sites were switched to storedCard', oct14?.balanceDue, 182.48)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll checks passed.')
}
