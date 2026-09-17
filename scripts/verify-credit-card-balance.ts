// The reported bug, and the model that replaces it.
//
// REPORTED: logging a payment from the Borrowing page showed the pie
// chart "only half done" — the amount paid went up, but the outstanding
// amount didn't come down — and the Borrowing page's own balance didn't
// clear at all. Only the ledger looked right.
//
// ROOT CAUSE (reproduced live in the browser before any fix): the edit
// panel seeds a local draft from the card once, on mount. Logging a
// payment reduced card.currentBalance to £1,400, but the draft still
// held £1,600. The Save button sits directly under the payment form, so
// pressing it — the natural next action — wrote £1,600 straight back,
// while the payment transaction stayed. `paid` was derived from
// transactions (so it moved); `currentBalance` was stored (so it
// reverted). Hence "half done".
//
// FIX: currentBalance is now an immutable ANCHOR as at balanceAsOfDate,
// and what's owed is derived by replaying activity forward from it
// (cardBalanceAsOf). Re-saving the anchor is idempotent, so the clobber
// is impossible rather than merely patched.

import { cardBalanceAsOf, withLiveBalance, recordCreditCardSpend, recordCreditCardLumpPayment, totalPaidForCard, generateMinimumPaymentTransactions } from '../src/lib/creditCards'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { toLocalIsoDate } from '../src/lib/date'
import { CREDIT_CARD_CATEGORY_ID } from '../src/types/ledger'
import type { AppDataV2, CreditCard, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = typeof actual === 'number' && typeof expected === 'number' && tolerance > 0 ? Math.abs(actual - expected) <= tolerance : a === e
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${e}, got ${a}`)
}

const card: CreditCard = {
  id: 'card-1',
  name: 'Natwest',
  categoryId: CREDIT_CARD_CATEGORY_ID,
  color: '#8b5cf6',
  interestRatePercent: 0,
  currentBalance: 1600,
  balanceAsOfDate: '2026-08-22',
  minimumPayment: { type: 'fixed', amount: 200 },
  paymentDayOfMonth: 14,
  ownerId: 'me',
  lumpPayments: [],
  active: true,
}

const payment = (date: string, amount: number, id: string, lump = true, cardId = 'card-1'): Transaction => ({
  id,
  date,
  amount,
  direction: 'out',
  categoryId: CREDIT_CARD_CATEGORY_ID,
  paymentMethod: 'bank_transfer',
  status: 'cleared',
  type: 'credit_card_payment',
  location: 'personal',
  ownerId: 'me',
  creditCardId: cardId,
  ...(lump ? { sourceType: 'credit_card_lump_payment' as const, sourceId: 'lp-1' } : {}),
})

// ---- 1. THE EXACT REPORTED SCENARIO ----
const today = new Date(2026, 7, 22)
const paid200 = [payment('2026-08-22', 200, 'tx-1')]

check('Balance with no activity is just the anchor', cardBalanceAsOf(card, [], today), 1600)
check('A payment logged TODAY reduces the balance immediately (same-day payments count as completed)', cardBalanceAsOf(card, paid200, today), 1400)

// The clobber itself: re-saving the panel's draft, which carries the
// anchor unchanged. Under the old model this restored £1,600 and erased
// the payment. Now it's a no-op, which is the entire point.
const resaved: CreditCard = { ...card, currentBalance: card.currentBalance, balanceAsOfDate: card.balanceAsOfDate }
check('Re-saving the edit panel does NOT erase the payment (the clobber that caused the bug)', cardBalanceAsOf(resaved, paid200, today), 1400)
check('...and is idempotent — saving repeatedly never drifts', cardBalanceAsOf({ ...resaved }, paid200, today), 1400)

// Both halves of the pie now come from the same transaction list under
// the same rule, so they cannot disagree the way they did.
const paidToDate = totalPaidForCard('card-1', paid200, today)
const outstanding = cardBalanceAsOf(card, paid200, today)
check('Pie: paid to date', paidToDate, 200)
check('Pie: outstanding', outstanding, 1400)
check('Pie halves stay consistent — paid + outstanding equals the original anchor', paidToDate + outstanding, 1600)

// ---- 2. The as-of date is a genuine floor ----
const activityStraddling = [payment('2026-08-21', 500, 'tx-old'), payment('2026-08-22', 200, 'tx-1')]
check('A payment dated BEFORE the anchor is ignored — already inside the stated figure', cardBalanceAsOf(card, activityStraddling, today), 1400)
check('A payment dated in the FUTURE is not counted yet', cardBalanceAsOf(card, [payment('2026-09-01', 300, 'tx-future')], today), 1600)
check('...and does count once its date arrives', cardBalanceAsOf(card, [payment('2026-09-01', 300, 'tx-future')], new Date(2026, 8, 1)), 1300)

// ---- 3. Spend ----
const spend = recordCreditCardSpend(card, 50, '2026-08-25')
check('recordCreditCardSpend leaves the anchor untouched', spend.updatedCard.currentBalance, 1600)
check('Spend increases the derived balance', cardBalanceAsOf(card, [{ ...spend.transaction, id: 'tx-spend' }], new Date(2026, 7, 25)), 1650)
check('A spend never counts as "paid"', totalPaidForCard('card-1', [{ ...spend.transaction, id: 'tx-spend' }], new Date(2026, 7, 25)), 0)

// ---- 4. No double-counting: clearing has no side effect any more ----
// clearTransaction.ts (applyClearSideEffects) was deleted on 2026-09-17 with
// the legacy savingsEntries: its only remaining branch was the savings-goal
// one. Clearing is a pure status flip, so the derived balance is the single figure.
check('The derived balance after the payment is the single, correct figure', cardBalanceAsOf(card, paid200, today), 1400)

// ---- 5. Interest posts on billing dates after the anchor, once each ----
const interestCard: CreditCard = { ...card, id: 'card-i', currentBalance: 1000, balanceAsOfDate: '2026-08-14', interestRatePercent: 22.9, minimumPayment: { type: 'fixed', amount: 0 } }
check('No billing date crossed yet — no interest', cardBalanceAsOf(interestCard, [], new Date(2026, 7, 20)), 1000)
check('Interest is NOT charged on the anchor date itself (a stated balance already includes that day\'s statement interest)', cardBalanceAsOf(interestCard, [], new Date(2026, 7, 14)), 1000)
const oneCycle = cardBalanceAsOf(interestCard, [], new Date(2026, 8, 14))
check('One billing date crossed — exactly one cycle of interest', oneCycle, 1017.33, 0.01)
const twoCycles = cardBalanceAsOf(interestCard, [], new Date(2026, 9, 14))
check('Two billing dates crossed — compounds, not doubled', twoCycles, 1034.96, 0.02)
check('Interest for a date posts BEFORE that date\'s payment, matching a real statement', cardBalanceAsOf(interestCard, [payment('2026-09-14', 100, 'tx-p', false, 'card-i')], new Date(2026, 8, 14)), 917.33, 0.01)

// ---- 6. withLiveBalance feeds everything downstream ----
const live = withLiveBalance(card, paid200, today)
check('withLiveBalance swaps in the derived figure', live.currentBalance, 1400)
check('...without mutating the original card object', card.currentBalance, 1600)

// ---- 7. Generation starts from the balance as at RANGE START ----
// Deterministic given its arguments — deliberately not "as of today",
// which made the function wall-clock dependent and, worse, would
// double-subtract a payment dated between rangeStart and today that had
// already been materialized into the derived balance.
const genCard: CreditCard = { ...card, id: 'card-g', currentBalance: 1000, balanceAsOfDate: '2026-08-01', interestRatePercent: 0, minimumPayment: { type: 'percent_of_balance', percent: 10 } }
const gen = generateMinimumPaymentTransactions(genCard, new Date(2026, 8, 1), new Date(2026, 10, 30), [payment('2026-08-20', 500, 'tx-pre', true, 'card-g')])
check('A payment before rangeStart is reflected in the starting balance: first minimum is 10% of £500, not £1000', gen[0].amount, 50)
const genNoActivity = generateMinimumPaymentTransactions(genCard, new Date(2026, 8, 1), new Date(2026, 10, 30), [])
check('...and with no activity, 10% of the full £1000', genNoActivity[0].amount, 100)
check('Generation is deterministic — same arguments, same result', generateMinimumPaymentTransactions(genCard, new Date(2026, 8, 1), new Date(2026, 10, 30), []).map((t) => t.amount), genNoActivity.map((t) => t.amount))

// A logged lump payment inside the simulated window is folded in, and is
// NOT double-counted against one already inside the starting balance.
const lumpCard: CreditCard = { ...genCard, lumpPayments: [{ id: 'lp-x', date: '2026-08-20', amount: 500 }] }
const genLump = generateMinimumPaymentTransactions(lumpCard, new Date(2026, 8, 1), new Date(2026, 10, 30), [payment('2026-08-20', 500, 'tx-pre', true, 'card-g')])
check('A lump payment before rangeStart is not subtracted twice (once via the anchor replay, once via lumpPayments)', genLump[0].amount, 50)

// ---- 8. Migration off the legacy shape ----
// The anchor must be TODAY, because a legacy currentBalance has already
// been decremented by every payment that cleared. Any earlier anchor
// would make the replay subtract those same payments again.
const todayIso = toLocalIsoDate(new Date())
const legacyCard = { ...card, currentBalance: 1400 } as Partial<CreditCard>
delete legacyCard.balanceAsOfDate
const legacy = { people: [], categories: [], recurringTemplates: [], loans: [], creditCards: [legacyCard], pensions: [], transactions: [], payCycles: [], scenarios: [], primaryPersonId: '' } as unknown as AppDataV2
const migrated = migrateLedgerData(legacy)
check('Migration backfills balanceAsOfDate to today', migrated.creditCards[0].balanceAsOfDate, todayIso)
check('Migration preserves the stored figure when there is no activity today', migrated.creditCards[0].currentBalance, 1400)
check('Migrated card derives the same balance it displayed before (no silent jump on upgrade)', cardBalanceAsOf(migrated.creditCards[0], [], new Date()), 1400)

// A payment dated TODAY had already been subtracted under the old model,
// and the replay counts anything dated on or before today — so it must
// be unwound back out of the anchor, or it lands twice.
const legacyWithTodayPayment = {
  ...legacy,
  creditCards: [legacyCard],
  transactions: [payment(todayIso, 200, 'tx-today')],
} as unknown as AppDataV2
const migrated2 = migrateLedgerData(legacyWithTodayPayment)
check("Today's already-applied payment is unwound out of the anchor", migrated2.creditCards[0].currentBalance, 1600)
check('...so the derived balance still reads £1,400, not £1,200 (the double-count this guards against)', cardBalanceAsOf(migrated2.creditCards[0], migrated2.transactions, new Date()), 1400)

const migratedTwice = migrateLedgerData(migrated2)
check('Migration is idempotent — running it again changes nothing', migratedTwice.creditCards[0].currentBalance, 1600)

// ---- 9. Delete/edit a logged payment ----
// No hand-rolled balance reversal any more: removing the transaction IS
// the reversal, which is why those three reversal branches could go.
check('Removing the payment transaction restores the balance automatically', cardBalanceAsOf(card, [], today), 1600)
const edited = recordCreditCardLumpPayment(card, 300, '2026-08-22')
check('Editing to a larger amount needs no reversal step either', cardBalanceAsOf(card, [{ ...edited.transaction, id: 'tx-e' }], today), 1300)

console.log(failures === 0 ? '\nAll credit card balance checks passed.' : `\n${failures} credit card balance check(s) failed.`)
if (failures > 0) process.exit(1)
