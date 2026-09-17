// UAT 2026-09-08 — Summary page "Cycle-end totals" extended to a credit
// card's own swipe card, per Adam's own spec: the card follows its OWN
// accounting periods (bounded by paymentDayOfMonth), not the household's
// pay cycle, and uses its own STATEMENT window (if configured) rather
// than plain calendar dates to decide which period a spend belongs to.
//
// Exact repro from the spec: a card with paymentDayOfMonth 14,
// statementStartDay 19, statementEndDay 18. A spend on 9 Sept falls
// inside the window 19 Aug–18 Sept, which is due NOT on 14 Sept (the
// very next payment date, which the naive "which calendar month is this
// date in" reading would suggest) but on 14 Oct — the payment date the
// 19 Aug–18 Sept window's own close actually feeds.

import { creditCardCyclePeriods, buildCreditCardCycleSections, recordCreditCardSpend, recordCreditCardLumpPayment } from '../src/lib/creditCards'
import type { CreditCard, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

let windowCard: CreditCard = {
  id: 'card-1',
  name: 'Statement Window Visa',
  categoryId: 'cat-cc',
  color: '#8b5cf6',
  interestRatePercent: 20,
  currentBalance: 0,
  balanceAsOfDate: '2026-08-01',
  minimumPayment: { type: 'percent_of_balance', percent: 5 },
  paymentDayOfMonth: 14,
  statementStartDay: 19,
  statementEndDay: 18,
  ownerId: 'adam',
  lumpPayments: [],
  active: true,
}
const spend = recordCreditCardSpend(windowCard, 20, '2026-09-09', 'test spend')
windowCard = spend.updatedCard
const windowTransactions: Transaction[] = [{ ...spend.transaction, id: 't0' }]

// "today" = 8 Sept 2026, per this session's own convention.
const today = new Date(2026, 8, 8)
const cycles = creditCardCyclePeriods(windowCard, today, 4) // current + 3 more, matching THREE_CYCLES_AHEAD

check('4 periods returned for "next 3 cycles" (current + 3 more)', cycles.length, 4)
check('Current cycle is due 14 Sept (the very next payment date from today)', cycles[0].dueDate.toDateString(), new Date(2026, 8, 14).toDateString())
check('...and its own spend window is 19 Jul–18 Aug (BEFORE the 9 Sept spend)', cycles[0].windowEnd.toDateString(), new Date(2026, 7, 18).toDateString())
check('Second period is due 14 Oct — the payment date the 19 Aug–18 Sept window actually feeds', cycles[1].dueDate.toDateString(), new Date(2026, 9, 14).toDateString())
check('...spanning 19 Aug–18 Sept, exactly the window in Adam\'s own spec', cycles[1].windowStart.toDateString(), new Date(2026, 7, 19).toDateString())
check('...to 18 Sept', cycles[1].windowEnd.toDateString(), new Date(2026, 8, 18).toDateString())

const sections = buildCreditCardCycleSections(windowCard, windowTransactions, cycles)
check('The 9 Sept spend does NOT appear under the 14 Sept ("this cycle") section', sections[0].rows.length, 0)
check('...it appears under the 14 Oct section instead (its statement window\'s own due date)', sections[1].rows.some((r) => r.date === '2026-09-09'), true)
check('...NOT under the 14 Sept section\'s own due-date row either', sections[0].rows.some((r) => r.date === '2026-09-09'), false)

// A generated (not-yet-materialized) minimum charge for the 14 Oct due
// date must show up too — "we also need to make sure minimum charges
// appear in this same swipe card ledger."
check('A projected minimum charge appears for the 14 Oct due date', sections[1].rows.some((r) => r.type === 'credit_card_payment' && r.date === '2026-10-14'), true)
// And it must not ALSO leak into the following (14 Nov) section, even
// though 14 Oct numerically sits inside that section's own spend window
// (19 Sept–18 Oct).
check('...and does NOT double-count into the following (14 Nov) section', sections[2].rows.filter((r) => r.date === '2026-10-14').length, 0)

// Each section's closing figure is the real balance DUE on its own due
// date (via cardBalanceAsOf), not a naive sum of its own rows (which
// would miss interest).
check('The 14 Sept section (no spend yet) closes at £0', sections[0].closingBalance, 0)
// BUGFIX (2026-09-09, statement-window grace-timing) — this used to
// assert `> 20` (interest already posted by 14 Oct), which encoded the
// very bug this fix corrects: 14 Oct is this spend's genuine FIRST due
// date under the statement-window rule (its window, 19 Aug-18 Sept,
// hadn't even closed by the raw-calendar 14 Sept date), so real grace
// applies — the closing figure must be EXACTLY £20, not inflated by a
// cycle of interest that was never actually due yet. See
// verify-credit-card-amortization-deadlock.ts's "Statement-window grace"
// checks for the same repro asserted directly against cardBalanceAsOf.
check('The 14 Oct section closes at EXACTLY £20 (real grace period — its genuine first due date, no interest yet)', sections[1].closingBalance, 20)

// ---- Fallback: no statement window configured — spend counts toward the very next payment date, plain and simple ----
let plainCard: CreditCard = { ...windowCard, id: 'card-2', statementStartDay: undefined, statementEndDay: undefined }
const plainSpend = recordCreditCardSpend(plainCard, 20, '2026-09-09', 'test spend')
plainCard = plainSpend.updatedCard
const plainTransactions: Transaction[] = [{ ...plainSpend.transaction, id: 't1' }]
const plainCycles = creditCardCyclePeriods(plainCard, today, 1)
const plainSections = buildCreditCardCycleSections(plainCard, plainTransactions, plainCycles)
check('With no statement window, the 9 Sept spend counts toward the very next (14 Sept) due date', plainSections[0].rows.some((r) => r.date === '2026-09-09'), true)

// ---- Clearing in full still zeroes out future sections, same as the info modal ----
let clearedCard = windowCard
const overpay = recordCreditCardLumpPayment(clearedCard, sections[1].closingBalance, '2026-10-14', 'Statement cleared')
clearedCard = overpay.updatedCard
const clearedTransactions = [...windowTransactions, { ...overpay.transaction, id: 't2' }]
const clearedSections = buildCreditCardCycleSections(clearedCard, clearedTransactions, cycles)
check('After clearing the 14 Oct balance in full, the 14 Nov section closes at £0', clearedSections[2].closingBalance, 0)

// ---- 2026-09-09 UAT retest — a lump payment dated on a due date must group with THAT cycle, not the following one ----
// Root cause: payments aren't window-gated (they apply immediately),
// but the general row filter used windowStart/windowEnd (a spend-only
// concept) as its bound — a payment dated between a window's close and
// its own due date (routine on a statement-window card) fell into the
// NEXT cycle's section instead of the one it actually cleared.
check('...and the "Statement cleared" payment itself appears in the 14 Oct section (the cycle it clears)', clearedSections[1].rows.some((r) => r.date === '2026-10-14' && r.type === 'credit_card_payment'), true)
check('...NOT in the following 14 Nov section', clearedSections[2].rows.some((r) => r.date === '2026-10-14'), false)

console.log(failures === 0 ? '\nAll credit-card cycle-totals checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
