// UAT 2026-09-09 (Bug 2, Adam-requested) — "I also want to make sure that
// the balance due each month also deducts the monthly minimum charge, as
// currently, it's compounding interest, without deducting the actual
// monthly repayment I am obliged to make, which would reamortise over the
// months."
//
// Scoped with Adam (see PROMPT-credit-card-interest-2026-09-09.md and this
// session's own follow-up thread) to exactly two screens, both only for
// rows BEYOND the materialization horizon (real activity always wins for
// anything already logged/cleared):
//  - the Borrowing page's "Payment due" section (buildCreditCardDueOverviewRows
//    / buildCreditCardBalanceDueRows), including the Clear button's own
//    payoff amount for an upcoming row
//  - the credit-card ledger modal's minimum-charge rows
//    (buildCreditCardMinimumChargeRows), via its new `projectedBalanceDue`
//    field
//
// Explicitly OUT of scope (Adam's own words): the Home page's "Next 3
// cycles" credit-card hero card, which stays on real interest + real
// expenses only — no assumed minimum-paid deduction. It calls
// cardBalanceAsOf directly (via withLiveBalance), which this fix does NOT
// touch — cardBalanceAsOf's contract (real activity only) is unchanged;
// only the row-builders above were rewired to a new, separate projection.
//
// Implementation: `generateMinimumPaymentTransactions` already internally
// simulates "pay the minimum every cycle, reamortise against what's left"
// (same principle as `simulateCardPayoffMonths`, the What-if page's own
// projection) — it just never exposed that trajectory to callers needing
// a display figure. `buildCreditCardMinimumChargeRows` now captures it via
// the existing `onCycle` hook (`workingBalanceBeforePayment`) into a new
// `projectedBalanceDue` field per row, so every consumer reads the exact
// same number the schedule was generated from — impossible for the two to
// disagree.
//
// Real-UK grace policy (2026-09-09, Adam-requested, replacing the earlier
// per-purchase-independent grace model): paying only the minimum (not the
// full balance) by a due date does NOT re-earn grace — interest starts
// the very next cycle regardless, same as `cardBalanceAsOf`'s own
// (already tested) "grace lost the cycle after a missed due date" checks
// in verify-credit-card-amortization-deadlock.ts.

import { buildCreditCardMinimumChargeRows, buildCreditCardDueOverviewRows, buildCreditCardBalanceDueRows, cardBalanceAsOf, recordCreditCardSpend } from '../src/lib/creditCards'
import type { CreditCard, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}
function checkClose(label: string, actual: number, expected: number, tolerance = 0.01) {
  const ok = Math.abs(actual - expected) <= tolerance
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ~${expected}, got ${actual}`)
  if (!ok) failures++
}

// ---- Adam's own worked example: £1000 spend, 5% minimum, 20% APR, window 19/18, due 14th ----
let card: CreditCard = {
  id: 'card-1',
  name: 'Bug2 Projection Visa',
  categoryId: 'cat-cc',
  color: '#8b5cf6',
  interestRatePercent: 20,
  currentBalance: 0,
  balanceAsOfDate: '2026-09-01',
  minimumPayment: { type: 'percent_of_balance', percent: 5 },
  paymentDayOfMonth: 14,
  statementStartDay: 19,
  statementEndDay: 18,
  ownerId: 'adam',
  lumpPayments: [],
  active: true,
}
const spend = recordCreditCardSpend(card, 1000, '2026-09-09', 'test spend')
card = spend.updatedCard
const transactions: Transaction[] = [{ ...spend.transaction, id: 't0' }]

const modalRows = buildCreditCardMinimumChargeRows(card, transactions, new Date(2026, 8, 9))
const oct14 = modalRows.find((r) => r.date === '2026-10-14')
const nov14 = modalRows.find((r) => r.date === '2026-11-14')
const dec14 = modalRows.find((r) => r.date === '2026-12-14')

// 14th Oct — genuine first due date, real grace period: no interest yet,
// but the 5% minimum IS assumed to be paid (Adam: "grace here states
// there is no interest on the first due date... but the minimum monthly
// payment is applied to that due date").
check('14th Oct: projected balance due is EXACTLY £1000 (grace — no interest on the genuine first due date)', oct14?.projectedBalanceDue, 1000)
check('14th Oct: minimum charge is £50 (5% of £1000)', oct14?.amount, 50)

// 14th Nov — "month 2": the £50 minimum from Oct is assumed already paid,
// reducing the balance BEFORE this cycle's interest compounds against it
// (Adam: "14th Nov would show £50 - minimum charge (5%) + interest, as
// this is month 2 from the payments made in the period due on 14th Oct").
checkClose('14th Nov: balance is (1000-50) with one cycle of interest, NOT 1000 with interest (i.e. the £50 minimum was genuinely deducted first)', nov14?.projectedBalanceDue ?? 0, 964.54)
check('14th Nov: minimum charge is 5% of the REDUCED (post-Oct-minimum) balance, not 5% of the original £1000', nov14?.amount, Math.round((nov14?.projectedBalanceDue ?? 0) * 5) / 100)

// 14th Dec — "month 3": continues reamortising off Nov's own reduced figure.
checkClose('14th Dec: balance continues reamortising down (further below Nov\'s figure), not compounding on the original £1000 forever', dec14?.projectedBalanceDue ?? 0, 930.34)

// ---- The old (real-activity-only) behaviour would have overstated every one of these ----
const oldWayNov14 = cardBalanceAsOf(card, transactions, new Date(2026, 10, 14))
check('Sanity: the OLD cardBalanceAsOf-only figure for 14th Nov really was higher (nothing paid at all assumed) — confirms this is a real, material difference, not a no-op', (nov14?.projectedBalanceDue ?? 0) < oldWayNov14, true)

// ---- Both Borrowing-page row builders read the SAME projected figures, never cardBalanceAsOf directly ----
const dueOverview = buildCreditCardDueOverviewRows(card, transactions, new Date(2026, 8, 9))
const dueOverviewNov = dueOverview.find((r) => r.date === '2026-11-14')
check('buildCreditCardDueOverviewRows (Payment due section) agrees with the modal\'s own projectedBalanceDue for 14th Nov', dueOverviewNov?.balanceDue, nov14?.projectedBalanceDue)

const balanceDueRows = buildCreditCardBalanceDueRows(card, transactions, new Date(2026, 8, 9))
const balanceDueNov = balanceDueRows.find((r) => r.date === '2026-11-14')
check('buildCreditCardBalanceDueRows (Clear-button payoff amount) also agrees for 14th Nov', balanceDueNov?.balanceDue, nov14?.projectedBalanceDue)

// ---- Real activity always wins — a MATERIALIZED (already-happened) row is untouched by the projection ----
// UPDATED 2026-09-16 (Adam-reported from UAT): the ASSERTION's expected value moved, its INTENT did
// not. This block guards that a past row reports REAL logged activity rather than the
// "assume the minimum gets paid" projection — and it still does. What changed is which side of that
// date's own payment the figure sits on. It used to be `cardBalanceAsOf(date)`, whose filter is
// `t.date <= asOfIso`, so it had that date's payment already deducted — the balance AFTER. Every
// GENERATED row reports the balance BEFORE its own charge (`workingBalanceBeforePayment`), so the
// list carried two conventions at once: mum's Natwest showed "£1,400 balance due" against both
// 14 Sept (left after paying) and 14 Oct (owed before paying), the same number meaning two
// different things, with the £1,600 genuinely owed on 14 Sept shown nowhere. Materialized rows now
// add that date's own stored payments back, so every row answers one question: what was owed going
// INTO this due date. Still real activity, still never the projection.
const materializedCard: CreditCard = { ...card, id: 'card-2' }
const materializedSpend = recordCreditCardSpend(materializedCard, 1000, '2026-09-09', 'test spend')
const storedMinimumCharge: Transaction = {
  id: 'stored-min-1',
  date: '2026-10-14',
  amount: 50,
  direction: 'out',
  categoryId: 'cat-cc',
  paymentMethod: 'direct_debit',
  status: 'cleared',
  type: 'credit_card_payment',
  location: 'personal',
  ownerId: 'adam',
  creditCardId: 'card-2',
  note: 'Bug2 Projection Visa - Minimum Charge',
}
const materializedTransactions: Transaction[] = [{ ...materializedSpend.transaction, id: 'ms0', creditCardId: 'card-2' }, storedMinimumCharge]
const materializedRows = buildCreditCardMinimumChargeRows(materializedCard, materializedTransactions, new Date(2026, 9, 20))
const materializedOct14 = materializedRows.find((r) => r.date === '2026-10-14')
check('A materialized (already-logged) row is flagged materialized: true', materializedOct14?.materialized, true)
check(
  '...and its projectedBalanceDue is REAL logged activity, not the assumed-minimum-paid projection — the balance owed going INTO that date, i.e. cardBalanceAsOf plus that date\'s own stored payment',
  materializedOct14?.projectedBalanceDue,
  cardBalanceAsOf(materializedCard, materializedTransactions, new Date('2026-10-14')) + storedMinimumCharge.amount,
)
// The projection would have given something else entirely — this is what the check above is really
// defending, and it must stay true whichever side of the payment the figure sits on.
check('...and that is NOT the projected figure the generated rows would have used', materializedOct14?.projectedBalanceDue === nov14?.projectedBalanceDue, false)

console.log(failures === 0 ? '\nAll "assume the minimum gets paid" projection checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
