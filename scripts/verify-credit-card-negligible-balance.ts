// Batch 8, Bug 9.2 (2026-09-07, Adam-reported): "By logging this
// overpayment on the date my new balance is due, it should remove
// upcoming minimum charges, but instead they remained as a value of
// below £0.02 for all future months, despite the card being cleared on
// the due date."
//
// Root cause, found empirically (see UAT-TRACKER.md's Batch 8 entry for
// the full trace): a percent_of_balance minimum payment applied to a
// tiny leftover balance eventually rounds DOWN to exactly £0.00
// (round2(balance * percent / 100)) — at that point `if (amount > 0)`
// skips generating a minimum-charge transaction entirely, so nothing
// ever pays the remaining balance off. But `applyMonthlyInterest`'s old
// guard was `balance <= 0`, so a still-technically-positive residual
// (e.g. £0.01) kept compounding interest forever, and — because
// round2(0.01 * (1 + monthlyRate)) rounds straight back down to £0.01 —
// it landed on a stable, self-sustaining fixed point: EXACTLY £0.01
// (or £0.02, depending on the numbers), shown as owed indefinitely, with
// no further minimum charge ever generated to actually clear it, and (in
// a real cardBalanceAsOf replay against a longer-lived card, not just
// this synthetic fixed point) able to slowly grow again from there once
// rounding tips it back over a whole extra penny.
//
// Fixed via a single NEGLIGIBLE_BALANCE (£0.02) threshold, applied in
// both applyMonthlyInterest and minimumPaymentForBalance: once a
// balance is at or below it, it's treated as fully paid off — snapped to
// exactly £0, no further interest, no further minimum charge. This
// script proves the exact stuck-fixed-point scenario is fixed: a card
// with a genuinely negligible leftover balance and no further activity
// must show £0 both immediately and years later, not a value that
// persists (or grows) forever.

import { cardBalanceAsOf, applyMonthlyInterest, minimumPaymentForBalance } from '../src/lib/creditCards'
import type { CreditCard } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// ---- 1. The exact stuck-fixed-point repro: a card left with a £0.01 residual ----
const stuckCard: CreditCard = {
  id: 'card-1',
  name: 'Visa',
  categoryId: 'cat-cc',
  color: '#8b5cf6',
  interestRatePercent: 20,
  currentBalance: 0.01,
  balanceAsOfDate: '2027-11-14',
  minimumPayment: { type: 'percent_of_balance', percent: 5 },
  paymentDayOfMonth: 14,
  ownerId: 'adam',
  lumpPayments: [],
  active: true,
}
check('A £0.01 residual with no further activity shows £0 shortly after (not stuck at £0.01)', cardBalanceAsOf(stuckCard, [], new Date(2028, 0, 1)), 0)
check('...still £0 five years later (not slowly regrowing via compounded interest on the stuck residual)', cardBalanceAsOf(stuckCard, [], new Date(2033, 0, 1)), 0)
check('...still £0 a full decade later', cardBalanceAsOf(stuckCard, [], new Date(2036, 0, 1)), 0)

// ---- 2. The underlying guards directly ----
check('applyMonthlyInterest snaps a negligible balance (£0.01) to exactly £0', applyMonthlyInterest(0.01, 20), 0)
check('applyMonthlyInterest snaps exactly-at-threshold (£0.02) to £0 too', applyMonthlyInterest(0.02, 20), 0)
check('minimumPaymentForBalance charges nothing against a negligible balance', minimumPaymentForBalance({ type: 'percent_of_balance', percent: 5 }, 0.01), 0)

// ---- 3. Regression guard — a genuinely real, non-negligible balance is NOT affected ----
check('A real £5 balance still accrues interest normally (not incorrectly snapped)', applyMonthlyInterest(5, 20) > 5, true)
check('A real £5 balance still generates a real minimum payment', minimumPaymentForBalance({ type: 'percent_of_balance', percent: 5 }, 5), 0.25)
check('A real £100 balance, fixed £25 minimum, is unaffected by the negligible-balance guard', minimumPaymentForBalance({ type: 'fixed', amount: 25 }, 100), 25)

console.log(failures === 0 ? '\nAll credit-card negligible-balance checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
