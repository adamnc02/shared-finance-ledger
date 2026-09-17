// Item e verification — Credit card accounting periods
// (SUPABASE-MIGRATION-PLAN.md backlog item e). Confirmed design:
//  - A `credit_card_spend` transaction posted AFTER a window's close
//    still shows in the card's live balance immediately, but doesn't
//    count toward that window's own minimum-payment calculation — it
//    rolls into the NEXT window's minimum instead.
//  - A lump/extra payment is NOT window-gated (confirmed against real UK
//    card practice) — it reduces what's owed immediately, same as today,
//    regardless of which window it falls in.
//  - Exactly one statement close happens between a window's own close
//    and its due date (paymentDayOfMonth, reused — no new due-date field).
//  - A card with no statementEndDay set keeps today's exact behaviour —
//    every spend counts toward the very next due date, no window gating.

import { generateMinimumPaymentTransactions } from '../src/lib/creditCards'
import { CREDIT_CARD_CATEGORY_ID } from '../src/types/ledger'
import type { CreditCard, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// Window 19th–18th, due the 14th — Adam's own worked example.
const windowedCard: CreditCard = {
  id: 'card-1',
  name: 'Barclaycard',
  categoryId: CREDIT_CARD_CATEGORY_ID,
  color: '#8b5cf6',
  interestRatePercent: 0,
  currentBalance: 1000,
  balanceAsOfDate: '2026-07-01',
  minimumPayment: { type: 'fixed', amount: 50 },
  paymentDayOfMonth: 14,
  statementStartDay: 19,
  statementEndDay: 18,
  ownerId: 'me',
  lumpPayments: [],
  active: true,
}

const spend = (date: string, amount: number, id: string): Transaction => ({
  id,
  date,
  amount,
  direction: 'out',
  categoryId: CREDIT_CARD_CATEGORY_ID,
  paymentMethod: 'card',
  status: 'cleared',
  type: 'credit_card_spend',
  location: 'personal',
  ownerId: 'me',
  creditCardId: 'card-1',
})

// ─────────────────────────────────────────────────────────────────────
// A £200 spend on the 25th of August — AFTER the window closing on the
// 18th, so it should NOT affect the minimum due on 14 Sep (tied to the
// 19 Jul–18 Aug window, which closed before the spend happened), but
// SHOULD affect the minimum due on 14 Oct (tied to the 19 Aug–18 Sep
// window, which the 25th falls inside).
// ─────────────────────────────────────────────────────────────────────
const lateSpend = [spend('2026-08-25', 200, 't1')]
const rangeStart = new Date('2026-07-15')
const rangeEnd = new Date('2026-11-01')

const withLateSpend = generateMinimumPaymentTransactions(windowedCard, rangeStart, rangeEnd, lateSpend)
const sepDue = withLateSpend.find((t) => t.date === '2026-09-14')
const octDue = withLateSpend.find((t) => t.date === '2026-10-14')

const withoutSpend = generateMinimumPaymentTransactions({ ...windowedCard, minimumPayment: { type: 'percent_of_balance', percent: 10 } }, rangeStart, rangeEnd, [])
const withSpendPercent = generateMinimumPaymentTransactions({ ...windowedCard, minimumPayment: { type: 'percent_of_balance', percent: 10 } }, rangeStart, rangeEnd, lateSpend)
const sepDuePercent = withSpendPercent.find((t) => t.date === '2026-09-14')
const sepDueBaseline = withoutSpend.find((t) => t.date === '2026-09-14')
const octDuePercent = withSpendPercent.find((t) => t.date === '2026-10-14')
const octDueBaseline = withoutSpend.find((t) => t.date === '2026-10-14')

check('A spend after the window closes does NOT change the minimum tied to that already-closed window', sepDuePercent?.amount, sepDueBaseline?.amount)
check('...but DOES change the minimum tied to the NEXT window (which the spend actually falls inside)', (octDuePercent?.amount ?? 0) > (octDueBaseline?.amount ?? 0), true)
console.log(`  (Sep due: £${sepDuePercent?.amount} vs baseline £${sepDueBaseline?.amount}; Oct due: £${octDuePercent?.amount} vs baseline £${octDueBaseline?.amount})`)

check('Sanity: both fixed-minimum due dates still generated regardless', Boolean(sepDue) && Boolean(octDue), true)

// ─────────────────────────────────────────────────────────────────────
// Lump payments are NOT window-gated — a lump payment dated AFTER the
// close but BEFORE the due date still reduces that due date's minimum.
// ─────────────────────────────────────────────────────────────────────
const cardWithLump: CreditCard = {
  ...windowedCard,
  minimumPayment: { type: 'percent_of_balance', percent: 10 },
  lumpPayments: [{ id: 'lp1', date: '2026-08-25', amount: 500 }], // after the 18 Aug close, before the 14 Sep due date
}
const withLump = generateMinimumPaymentTransactions(cardWithLump, rangeStart, rangeEnd, [])
const withoutLump = generateMinimumPaymentTransactions({ ...windowedCard, minimumPayment: { type: 'percent_of_balance', percent: 10 } }, rangeStart, rangeEnd, [])
const sepDueWithLump = withLump.find((t) => t.date === '2026-09-14')
const sepDueWithoutLump = withoutLump.find((t) => t.date === '2026-09-14')
check(
  'A lump payment dated after the window close still reduces the very next due date (not window-gated)',
  (sepDueWithLump?.amount ?? 0) < (sepDueWithoutLump?.amount ?? 0),
  true,
)

// ─────────────────────────────────────────────────────────────────────
// Backward compatibility — a card with no statementEndDay set produces
// IDENTICAL results to a card that never had this feature at all: every
// spend counts toward the very next due date, no window gating.
// ─────────────────────────────────────────────────────────────────────
const unwindowedCard: CreditCard = { ...windowedCard, statementStartDay: undefined, statementEndDay: undefined, minimumPayment: { type: 'percent_of_balance', percent: 10 } }
const unwindowedResult = generateMinimumPaymentTransactions(unwindowedCard, rangeStart, rangeEnd, lateSpend)
const unwindowedSepDue = unwindowedResult.find((t) => t.date === '2026-09-14')
check(
  'A card with no statementEndDay set: the spend counts toward the VERY NEXT due date (14 Sep), unlike the windowed card above',
  (unwindowedSepDue?.amount ?? 0) > (sepDueBaseline?.amount ?? 0),
  true,
)

if (failures > 0) {
  console.log(`\n${failures} credit-card statement-window check(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll credit-card statement-window checks passed.')
}
