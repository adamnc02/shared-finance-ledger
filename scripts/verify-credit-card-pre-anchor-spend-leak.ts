// Regression test for the 2026-09-16 bugfix — Adam's own repro: a new
// card (opening balance £0 as of 9 Sept, statement window 19th-18th, due
// the 14th) with a historic spend dated BEFORE the card's own anchor
// (10 Aug, correctly excluded from the balance) kept regenerating a
// "minimum charge" for 14 Oct even after Adam manually cleared that due
// balance in full via the Borrowing page's Clear button.
//
// Root cause: generateMinimumPaymentTransactions' pendingSpend/
// pendingSpendForStatement lists filtered only on `t.date > rangeStart`,
// unlike cardBalanceAsOf's own `t.date >= card.balanceAsOfDate` floor
// that the function's OWN opening balance is correctly seeded from a few
// lines above. Whenever a caller's rangeStart lands before the card's
// anchor — routine in production: autoClear.ts passes the PERSON's
// pay-cycle start, unrelated to any one card's own opening date — a
// transaction dated between rangeStart and the card's real anchor (the
// 10 Aug spend, here) leaked into the forward simulation as real debt,
// even though it had already been correctly excluded from the opening
// figure.
import { generateMinimumPaymentTransactions, recordCreditCardLumpPayment } from '../src/lib/creditCards'
import type { CreditCard, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const card: CreditCard = {
  id: 'card-1',
  name: 'Test Card',
  categoryId: 'category-shopping',
  color: '#fff',
  interestRatePercent: 9,
  currentBalance: 0,
  balanceAsOfDate: '2026-09-09',
  minimumPayment: { type: 'fixed', amount: 25 },
  paymentDayOfMonth: 14,
  statementStartDay: 19,
  statementEndDay: 18,
  ownerId: 'me',
  lumpPayments: [],
  active: true,
}

function spend(id: string, date: string, amount: number): Transaction {
  return { id, date, amount, direction: 'out', categoryId: 'category-shopping', paymentMethod: 'card', status: 'cleared', type: 'credit_card_spend', location: 'personal', ownerId: 'me', creditCardId: 'card-1' }
}

// Adam's exact spend history: a historic pre-anchor spend, plus two real
// spends inside the card's own window (both land in the 14 Oct due
// period per the 19th-18th statement window).
const historicPreAnchorSpend = spend('t-historic', '2026-08-10', 50)
const spend10Sep = spend('t1', '2026-09-10', 25)
const spend16Sep = spend('t2', '2026-09-16', 30)

// autoClear.ts's REAL call shape: rangeStart is the PERSON's pay-cycle
// opening date, not this card's own — deliberately set well before the
// card's 9 Sept anchor (and before the 10 Aug historic spend too), same
// as it would be for any household whose pay-cycle history predates a
// newly-added card.
const rangeStart = new Date(2026, 0, 1) // 1 Jan 2026
const asOf = new Date(2026, 9, 20) // 20 Oct 2026 — after the 14 Oct due date

// ── 1. Without any manual clear yet: the 14 Oct minimum should reflect ONLY the £55 of real, in-window spend — not £105 (including the leaked £50 historic spend) ──
{
  const generated = generateMinimumPaymentTransactions(card, rangeStart, asOf, [historicPreAnchorSpend, spend10Sep, spend16Sep])
  const oct14 = generated.filter((t) => t.date === '2026-10-14')
  const totalOct14 = oct14.reduce((sum, t) => sum + t.amount, 0)
  check('14 Oct minimum charge total is £25 (the fixed minimum), not inflated by the leaked £50 historic spend', totalOct14, 25)
  assertNoPreAnchorCharge(generated)
}

// ── 2. After Adam's manual Clear — via the REAL mechanism the Borrowing page's Clear button actually uses (recordCreditCardLumpPayment, which updates BOTH card.lumpPayments and logs the matching transaction) — for the full £55 owed: NO further minimum charge should be generated for that period ──
{
  const { updatedCard, transaction } = recordCreditCardLumpPayment(card, 55, '2026-10-14', 'Statement cleared')
  const clearPayment: Transaction = { ...transaction, id: 't-clear' }
  const generated = generateMinimumPaymentTransactions(updatedCard, rangeStart, asOf, [historicPreAnchorSpend, spend10Sep, spend16Sep, clearPayment])
  const oct14Charges = generated.filter((t) => t.date === '2026-10-14')
  check('after Clear logs the full £55 owed (via the real recordCreditCardLumpPayment path), NO further minimum charge is generated for that date — this is the exact reported bug', oct14Charges.length, 0)
  assertNoPreAnchorCharge(generated)
}

function assertNoPreAnchorCharge(generated: Omit<Transaction, 'id'>[]) {
  const beforeAnchor = generated.filter((t) => t.date < card.balanceAsOfDate)
  check('no charge is ever generated dated before the card\'s own opening (balanceAsOfDate) — the card did not exist yet', beforeAnchor.length, 0)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll checks passed.')
}
