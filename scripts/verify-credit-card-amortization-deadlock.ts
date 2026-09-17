// UAT 2026-09-08 (8-bug9.2-minimum-charges-stop, retest of the earlier
// Batch 8 fix): Adam reproduced the same "perpetual sub-£0.02 minimum
// charge" symptom again after this session's NEGLIGIBLE_BALANCE fix had
// already landed — paying a card off in full on its due date, then
// logging a further overpayment, still left minimum charges of a few
// pence generating every month indefinitely.
//
// Root-caused as a DIFFERENT mechanism than the earlier fixed-point-near-
// zero bug: NEGLIGIBLE_BALANCE (£0.02) only snaps a balance that's
// ALREADY tiny. It never fires for a percent-of-balance minimum stuck on
// a small-but-not-tiny balance (well above £0.02) where the rounded
// minimum payment doesn't even cover the interest this cycle accrues —
// a genuine amortisation deadlock, not a near-zero rounding artefact.
// E.g. a 5% APR card with a 1%-of-balance minimum and a £1.23 balance:
// interest rounds the balance UP to £1.24, the 1% minimum rounds to
// exactly £0.01, and paying it leaves £1.23 — right back where the cycle
// started, forever, generating a real (if tiny) "Minimum Charge"
// transaction every single month. Pure rounding, not the minimum policy
// itself, is what breaks it here (the unrounded 1% of £1.24 — 1.24p — is
// genuinely more than the interest that accrued, so it SHOULD have
// covered it).
//
// Fixed by comparing each cycle's post-payment balance against what the
// balance stood at BEFORE that cycle's interest was even applied: if the
// computed minimum wouldn't leave the balance any lower than that, the
// whole remaining balance is charged instead of the non-progressing
// minimum. Applied in both generateMinimumPaymentTransactions (the real
// generator behind every ledger/projection minimum-charge row) and
// computeMinimumPaymentAmount (the single-point "what's due" query).
//
// UAT 2026-09-08, found running the full verify-*.ts suite for the first
// time in a while — this guard was ALSO firing for a genuine, real-world
// debt trap: a FIXED minimum (or a percent mathematically too small for
// the rate, e.g. 1% against a 30%-APR/~2.2%-monthly card) smaller than
// the interest accruing is completely real credit-card behaviour — the
// balance is SUPPOSED to grow, forever (pre-existing
// verify-ledger-phase2.ts's own debt-trap test, silently broken by this
// guard for months without the full suite having been re-run). Narrowed
// to only fire when a percent_of_balance minimum's UNROUNDED theoretical
// amount would have exceeded that cycle's interest — i.e. only when
// rounding, not the policy itself, is what erased the progress. A fixed
// minimum, or a percent genuinely too small for the rate, is left alone.

// UAT 2026-09-08, second retest — Adam reproduced a DIFFERENT deadlock on
// a statement-window card (statementStartDay/statementEndDay set): a spend
// lands in the true running balance (workingBalance) immediately, but the
// figure the minimum is actually sized off (statementBalance) only picks
// it up once its own window closes — the two can permanently diverge, and
// workingBalance can deadlock on its own even while statementBalance is
// still (very slowly) shrinking, since the original guard only ever
// checked statementBalance. Exact repro: a card with statementStartDay 19/
// statementEndDay 18/paymentDayOfMonth 14, a £20 spend, then a same-amount
// overpayment — workingBalance got stuck oscillating at 60-61p forever
// (£0.60 minus a 1p minimum, regrown back to £0.61 by interest) while
// statementBalance alone crept down 1p/month, decades from zero. Fixed by
// checking BOTH balances' own before-interest progress, and paying off
// whichever is larger when either deadlocks.
//
// UAT 2026-09-08, fourth item — Adam asked for a real interest-free grace
// period on new purchases: no interest at all if the account enters a
// billing cycle already fully paid off, only starting once a balance is
// genuinely being carried (exactly how a real UK card works — this app
// previously had none at all, an explicitly documented simplification).
// Implemented via a `balanceEnteringCycle` snapshot, frozen at whatever
// carried in from the END of the previous cycle, checked before applying
// each cycle's interest, in both cardBalanceAsOf and
// generateMinimumPaymentTransactions. Two follow-up bugs found and fixed
// while building this: (1) skipping applyMonthlyInterest entirely for a
// grace cycle also skipped its own negligible-balance-snap side effect,
// resurrecting the pre-Batch-8 stuck-forever-at-a-penny bug for a
// lingering residual with no new spend — fixed by snapping separately.
// (2) statementBalance was initially given its OWN entering-cycle check,
// but that figure is deliberately LAGGED behind workingBalance on a
// statement-window card (a spend can sit in workingBalance for a cycle
// before its own window closes and it reaches statementBalance at all) —
// gating it on its own lagged value granted grace it hadn't earned,
// silently stranding real debt in workingBalance once a same-day payment
// (sized to the correctly-interest-inflated workingBalance) also zeroed
// the incorrectly-interest-free statementBalance. Fixed by gating BOTH
// balances on workingBalance's entering value alone — grace is a fact
// about the real account, not an artefact of the window-tracking figure.

// UAT 2026-09-08, third retest — Adam's own root-cause theory and spec: a
// "Balance due" row (the REAL statement total, not just that date's
// minimum) with its own Clear button, shown as a SEPARATE row from the
// minimum charge for the same date (not folded into it, which was the
// first, wrong attempt at this). Clearing it — a lump payment dated on/
// before the due date, for the full balanceDue figure — should zero that
// date's own minimum AND every future one, relying on
// generateMinimumPaymentTransactions's existing lump-payment-before-
// minimum-computation ordering (no separate "future charges" mechanism
// needed once the true balance is actually paid down to zero).

import {
  generateMinimumPaymentTransactions,
  computeMinimumPaymentAmount,
  cardBalanceAsOf,
  recordCreditCardSpend,
  recordCreditCardLumpPayment,
  buildCreditCardBalanceDueRows,
  buildCreditCardMinimumChargeRows,
} from '../src/lib/creditCards'
import type { CreditCard, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const deadlockedCard: CreditCard = {
  id: 'card-1',
  name: 'Deadlock Visa',
  categoryId: 'cat-cc',
  color: '#8b5cf6',
  interestRatePercent: 5,
  currentBalance: 1.23,
  balanceAsOfDate: '2026-01-14',
  minimumPayment: { type: 'percent_of_balance', percent: 1 },
  paymentDayOfMonth: 14,
  ownerId: 'adam',
  lumpPayments: [],
  active: true,
}

// ---- 1. The generator must not keep producing charges for 5 years straight ----
const fiveYearsOfCharges = generateMinimumPaymentTransactions(deadlockedCard, new Date(2026, 0, 14), new Date(2031, 0, 14), [])
check('A deadlocked £1.23 balance does NOT generate 60 straight monthly minimum charges', fiveYearsOfCharges.length < 60, true)

// ---- 2. Whatever it DOES generate must actually resolve the debt, not just restate it ----
const totalCharged = Math.round(fiveYearsOfCharges.reduce((s, t) => s + t.amount, 0) * 100) / 100
check('The generated charge(s) pay off at least the original £1.23 (accounting for interest), not just a few pence', totalCharged >= 1.23, true)

// ---- 3. The replayed balance actually reaches, and stays at, £0 ----
const chargesAsTransactions = fiveYearsOfCharges.map((t, i) => ({ ...t, id: `gen-${i}`, status: 'cleared' as const }))
check('cardBalanceAsOf reaches exactly £0 once the deadlocked balance is resolved', cardBalanceAsOf(deadlockedCard, chargesAsTransactions, new Date(2031, 0, 14)), 0)

// ---- 4. computeMinimumPaymentAmount (the single-point query) has the same guard ----
check('computeMinimumPaymentAmount pays off the whole £1.24 (post-interest) rather than a non-progressing £0.01', computeMinimumPaymentAmount(deadlockedCard), 1.24)

// ---- 5a. The statement-window divergence repro ----
let windowCard: CreditCard = {
  id: 'card-2',
  name: 'Statement Window Visa',
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
let windowTransactions: (Omit<Transaction, 'id'> & { id: string })[] = []
const spend = recordCreditCardSpend(windowCard, 20, '2026-09-09', 'test spend')
windowCard = spend.updatedCard
windowTransactions.push({ ...spend.transaction, id: 't0' })
// The exact ACCURATE due figure for this date (post-interest, whatever
// that is once the grace-period model above is factored in) — not a
// guessed flat £20 — same as what the real "Clear" button pays. A
// hand-typed £20 wouldn't necessarily fully resolve this any more since
// grace period was added: interest between the anchor and Oct 14 can
// genuinely apply now depending on exactly how many billing dates fall
// in between, same as any real card.
const dueOn1014 = buildCreditCardBalanceDueRows(windowCard, windowTransactions, new Date(2026, 8, 15)).find((r) => r.date === '2026-10-14')?.balanceDue ?? 20
const overpay = recordCreditCardLumpPayment(windowCard, dueOn1014, '2026-10-14', 'overpayment')
windowCard = overpay.updatedCard
windowTransactions.push({ ...overpay.transaction, id: 't1' })

const windowCharges = generateMinimumPaymentTransactions(windowCard, new Date(2026, 8, 1), new Date(2031, 8, 1), windowTransactions)
check('A statement-window card with a matching overpayment does NOT generate 60 straight monthly minimum charges', windowCharges.length < 60, true)
const windowAllTx = [...windowTransactions, ...windowCharges.map((t, i) => ({ ...t, id: `gen-${i}`, status: 'cleared' as const }))]
check('...and its real balance reaches exactly £0', cardBalanceAsOf(windowCard, windowAllTx, new Date(2031, 8, 1)), 0)

// ---- 6. The "Balance due" + Clear flow end to end ----
let clearCard: CreditCard = {
  id: 'card-3',
  name: 'Clear Button Visa',
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
let clearTransactions: (Omit<Transaction, 'id'> & { id: string })[] = []
const clearSpend = recordCreditCardSpend(clearCard, 20, '2026-09-09', 'test spend')
clearCard = clearSpend.updatedCard
clearTransactions.push({ ...clearSpend.transaction, id: 'c0' })

// Before clearing: the Oct 14 row should offer a real "balance due" figure.
const dueRowsBefore = buildCreditCardBalanceDueRows(clearCard, clearTransactions, new Date(2026, 8, 15))
const octRow = dueRowsBefore.find((r) => r.date === '2026-10-14')
check('A "Balance due" row exists for the Oct 14 payment date before clearing', !!octRow, true)

// Clear it — exactly what the modal's Clear button does: a lump payment
// for that row's own balanceDue, dated on the row's own date.
if (octRow) {
  const cleared = recordCreditCardLumpPayment(clearCard, octRow.balanceDue, octRow.date, 'Statement cleared')
  clearCard = cleared.updatedCard
  clearTransactions.push({ ...cleared.transaction, id: 'c1' })
}

const futureCharges = generateMinimumPaymentTransactions(clearCard, new Date(2026, 8, 1), new Date(2029, 8, 1), clearTransactions)
check('After clearing via the Balance-due row, NO further minimum charges are generated at all (not just fewer)', futureCharges.length, 0)
check('...and the real balance is exactly £0 three years later', cardBalanceAsOf(clearCard, clearTransactions, new Date(2029, 8, 1)), 0)

// ---- 5d. Statement-window grace-timing (2026-09-09, Adam's exact repro) ----
// `paymentDayOfMonth: 14, statementStartDay: 19, statementEndDay: 18` — a
// £20 spend on 9th Sept has its real first due date on 14th Oct (its
// window, Aug19-Sep18, hadn't even closed by 14th Sept), so it must be
// EXACTLY £20.00 there, not £20.31 — the bug was cardBalanceAsOf treating
// 14th Sept (the next raw paymentDayOfMonth) as the grace-relevant cycle
// boundary, one whole window too early.
let graceWindowCard: CreditCard = { ...clearCard, id: 'card-3g', currentBalance: 0, lumpPayments: [] }
const gwSpend = recordCreditCardSpend(graceWindowCard, 20, '2026-09-09', 'grace-window spend')
graceWindowCard = gwSpend.updatedCard
const gwTransactions: (Omit<Transaction, 'id'> & { id: string })[] = [{ ...gwSpend.transaction, id: 'gw0' }]
check('Statement-window grace: EXACT £20.00 due on 14th Oct (not £20.31 from interest posting a cycle early)', cardBalanceAsOf(graceWindowCard, gwTransactions, new Date(2026, 9, 14)), 20)
check('...also exactly £20 at the (real but earlier) calendar 14th Sept date — nothing was ever due there', cardBalanceAsOf(graceWindowCard, gwTransactions, new Date(2026, 8, 14)), 20)
check('...grace is LOST the cycle after the real (window-aware) due date is missed — interest now applies at 14th Nov', cardBalanceAsOf(graceWindowCard, gwTransactions, new Date(2026, 10, 14)) > 20, true)

// Paying the £20 in full by its real due date (14th Oct) re-earns grace
// for new spend going forward, same as the non-window grace fixture below
// — confirms the "lose grace entirely once revolving, real UK T&Cs"
// policy (2026-09-09, Adam-requested) also holds for a window card, not
// just the plain calendar-cycle case.
const gwPay = recordCreditCardLumpPayment(graceWindowCard, 20, '2026-10-14', 'paid in full by due date')
graceWindowCard = gwPay.updatedCard
gwTransactions.push({ ...gwPay.transaction, id: 'gw1' })
const gwSpend2 = recordCreditCardSpend(graceWindowCard, 15, '2026-10-20', 'second grace-window spend')
graceWindowCard = gwSpend2.updatedCard
gwTransactions.push({ ...gwSpend2.transaction, id: 'gw2' })
check('Paying in full by the real due date re-earns grace for the NEXT window too (statement-window card)', cardBalanceAsOf(graceWindowCard, gwTransactions, new Date(2026, 10, 14)), 15)

// ---- 5e. Regression guard — a card WITHOUT a statement window is completely unaffected ----
// Same £20-on-a-fresh-card shape as 5d, but no statementStartDay/EndDay —
// must reproduce the pre-existing (already-correct) raw-calendar grace
// behaviour byte-for-byte, since the statement-window fix above only
// activates when both window fields are set.
let noWindowCard: CreditCard = { ...clearCard, id: 'card-3n', currentBalance: 0, statementStartDay: undefined, statementEndDay: undefined, lumpPayments: [] }
const nwSpend = recordCreditCardSpend(noWindowCard, 20, '2026-09-09', 'no-window spend')
noWindowCard = nwSpend.updatedCard
const nwTransactions: (Omit<Transaction, 'id'> & { id: string })[] = [{ ...nwSpend.transaction, id: 'nw0' }]
check('No statement window: grace still applies through the very next raw calendar due date (14th Sept), £20 exactly', cardBalanceAsOf(noWindowCard, nwTransactions, new Date(2026, 8, 14)), 20)
check('No statement window: grace lost the cycle after THAT (14th Oct) since it was never window-delayed to begin with', cardBalanceAsOf(noWindowCard, nwTransactions, new Date(2026, 9, 14)) > 20, true)

// ---- 5f. Statement-window minimum-charge rows must not appear a cycle early either (2026-09-09) ----
// A second, distinct manifestation of the same root cause: a fresh card
// with no stored minimum-charge history yet always starts its
// buildCreditCardMinimumChargeRows simulation range AT asOfDate (see that
// function's own rangeStart comment) — so calling it same-day-as, or any
// time after, an unclosed purchase used to fold that purchase straight
// into the OPENING statementBalance uninspected, generating a real (if
// small) minimum-charge row on 14th Sept that shouldn't exist at all.
// Must be identical regardless of exactly when `asOfDate` falls relative
// to the spend, once it's genuinely after it.
let freshCard: CreditCard = { ...clearCard, id: 'card-3f', currentBalance: 0, lumpPayments: [] }
const freshSpend = recordCreditCardSpend(freshCard, 20, '2026-09-09', 'fresh spend')
freshCard = freshSpend.updatedCard
const freshTransactions: (Omit<Transaction, 'id'> & { id: string })[] = [{ ...freshSpend.transaction, id: 'f0' }]
const rowsAsOfBeforeSpend = buildCreditCardMinimumChargeRows(freshCard, freshTransactions, new Date(2026, 8, 1))
const rowsAsOfSpendDay = buildCreditCardMinimumChargeRows(freshCard, freshTransactions, new Date(2026, 8, 9))
const rowsAsOfMidCycle = buildCreditCardMinimumChargeRows(freshCard, freshTransactions, new Date(2026, 8, 15))
check('No minimum-charge row generated on 14th Sept (asOfDate before the spend) — first real charge is 14th Oct', rowsAsOfBeforeSpend[0]?.date, '2026-10-14')
check('...same first-charge date when asOfDate falls ON the spend day (rangeStart used to skip window-gating here)', rowsAsOfSpendDay[0]?.date, '2026-10-14')
check('...same first-charge date when asOfDate falls after the spend, mid-cycle', rowsAsOfMidCycle[0]?.date, '2026-10-14')
check('...and the amount agrees across all three asOfDates (£1.00 — 5% of £20)', rowsAsOfSpendDay[0]?.amount === rowsAsOfBeforeSpend[0]?.amount && rowsAsOfMidCycle[0]?.amount === rowsAsOfBeforeSpend[0]?.amount, true)

// ---- 5b. Regression guard — a genuinely progressing percent-of-balance minimum is unaffected ----
const healthyCard: CreditCard = { ...deadlockedCard, currentBalance: 500, minimumPayment: { type: 'percent_of_balance', percent: 5 } }
check('A real £500 balance with a real 5% minimum still pays the computed minimum, not the full balance', computeMinimumPaymentAmount(healthyCard) < 500, true)

// ---- 5c. Regression guard — a genuine debt trap is left alone, not force-resolved ----
// UAT 2026-09-08: the deadlock guard above was originally firing for
// this too (a FIXED minimum, or a percent mathematically too small for
// the rate, is real credit-card behaviour — the balance is SUPPOSED to
// grow) — this must never force-payoff a real debt trap the way it does
// a rounding-only one. Same scenario verify-ledger-phase2.ts's own
// pre-existing debt-trap test covers, checked here too as insurance
// against this specific guard regressing it again.
const fixedDebtTrapCard: CreditCard = { ...deadlockedCard, currentBalance: 500, interestRatePercent: 29.9, minimumPayment: { type: 'fixed', amount: 5 } }
const fixedDebtTrapSchedule = generateMinimumPaymentTransactions(fixedDebtTrapCard, new Date(2026, 0, 14), new Date(2026, 7, 14))
check('A £5/month FIXED minimum on a 29.9% APR card is left to genuinely grow, not force-paid-off in one go', fixedDebtTrapSchedule.every((t) => t.amount === 5), true)

const percentDebtTrapCard: CreditCard = { ...deadlockedCard, currentBalance: 500, interestRatePercent: 30, minimumPayment: { type: 'percent_of_balance', percent: 1 } }
check(
  'A 1%-of-balance minimum genuinely too small for a 30% APR (not a rounding issue) is also left alone',
  computeMinimumPaymentAmount(percentDebtTrapCard) < 500,
  true,
)

// ---- 7. Grace period on new purchases (Adam-requested, 2026-09-08) ----
// A card that enters a billing cycle with NO carried balance should pay
// no interest on spend within it, up to and including that cycle's own
// due date; missing that due date loses the grace period, same as a real
// card. anchor deliberately placed so Oct 14 is the FIRST billing date
// after it (no intervening Sept 14 cycle to complicate the read).
let graceCard: CreditCard = {
  id: 'card-4',
  name: 'Grace Period Visa',
  categoryId: 'cat-cc',
  color: '#8b5cf6',
  interestRatePercent: 20,
  currentBalance: 0,
  balanceAsOfDate: '2026-09-15',
  minimumPayment: { type: 'percent_of_balance', percent: 5 },
  paymentDayOfMonth: 14,
  ownerId: 'adam',
  lumpPayments: [],
  active: true,
}
const graceSpendResult = recordCreditCardSpend(graceCard, 20, '2026-09-20', 'test spend')
graceCard = graceSpendResult.updatedCard
const graceTransactions = [{ ...graceSpendResult.transaction, id: 'g0' }]

check('New spend accrues NO interest through its own first due date (real grace period)', cardBalanceAsOf(graceCard, graceTransactions, new Date(2026, 9, 14)), 20)
check('...still exactly £20 the day before, not creeping up early', cardBalanceAsOf(graceCard, graceTransactions, new Date(2026, 9, 13)), 20)
check('...but the grace period is lost the cycle after a missed due date — interest now applies', cardBalanceAsOf(graceCard, graceTransactions, new Date(2026, 10, 14)) > 20, true)

// Paying in FULL by the due date re-earns the grace period going forward.
let gracePaidCard = graceCard
const gracePayResult = recordCreditCardLumpPayment(gracePaidCard, 20, '2026-10-14', 'paid in full')
gracePaidCard = gracePayResult.updatedCard
const gracePaidTransactions = [...graceTransactions, { ...gracePayResult.transaction, id: 'g1' }]
const graceSpend2Result = recordCreditCardSpend(gracePaidCard, 15, '2026-10-20', 'second spend')
gracePaidCard = graceSpend2Result.updatedCard
gracePaidTransactions.push({ ...graceSpend2Result.transaction, id: 'g2' })
check('Paying in full by the due date re-earns the grace period for the NEXT cycle too', cardBalanceAsOf(gracePaidCard, gracePaidTransactions, new Date(2026, 10, 14)), 15)

// ---- 8. UAT 2026-09-09 (Adam-reported) — clearing an early due date in full must NOT wipe out a later, genuinely separate one ----
// Root cause: a lump payment sized off the TRUE running balance
// (workingBalance/`balance`, which already includes a purchase the
// moment it's spent) can be MORE than the window-gated statementBalance
// currently reflects (which only picks that purchase up once its OWN
// window closes). The old code clamped the excess away instead of
// carrying it forward as a credit, so once the delayed purchase's window
// finally closed and tried to fold in, it looked like fresh, unpaid debt
// — generating a phantom minimum charge forever, even though the true
// balance was genuinely zero.
let twoSpendCard: CreditCard = {
  id: 'card-5',
  name: 'Two Spends Visa',
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
const tsSpend1 = recordCreditCardSpend(twoSpendCard, 70, '2026-10-01', 'spend 1 -> due 14th Nov')
twoSpendCard = tsSpend1.updatedCard
let twoSpendTransactions: (Omit<Transaction, 'id'> & { id: string })[] = [{ ...tsSpend1.transaction, id: 'ts0' }]
const tsSpend2 = recordCreditCardSpend(twoSpendCard, 85, '2026-11-10', 'spend 2 -> due 14th Dec')
twoSpendCard = tsSpend2.updatedCard
twoSpendTransactions.push({ ...tsSpend2.transaction, id: 'ts1' })

const nov14Rows = buildCreditCardMinimumChargeRows(twoSpendCard, twoSpendTransactions, new Date(2026, 8, 9))
const nov14Row = nov14Rows.find((r) => r.date === '2026-11-14')
check('Before clearing: 14th Nov correctly shows the true combined balance (£70 + £85)', nov14Row?.projectedBalanceDue, 155)

const tsClear = recordCreditCardLumpPayment(twoSpendCard, nov14Row!.projectedBalanceDue, '2026-11-14', 'Statement cleared')
twoSpendCard = tsClear.updatedCard
twoSpendTransactions.push({ ...tsClear.transaction, id: 'ts2' })
const afterClearRows = buildCreditCardMinimumChargeRows(twoSpendCard, twoSpendTransactions, new Date(2026, 10, 15))
check('After clearing 14th Nov in full: NO phantom minimum charge rows appear at all (the £85 was already inside the £155 paid)', afterClearRows.length, 0)

// The partial-payment counterpart — a genuinely separate remaining debt must still show correctly.
let partialCard: CreditCard = { ...twoSpendCard, id: 'card-6', lumpPayments: [] }
const partialSpend1 = recordCreditCardSpend(partialCard, 70, '2026-10-01', 'spend 1')
partialCard = partialSpend1.updatedCard
let partialTransactions: (Omit<Transaction, 'id'> & { id: string })[] = [{ ...partialSpend1.transaction, id: 'p0' }]
const partialSpend2 = recordCreditCardSpend(partialCard, 85, '2026-11-10', 'spend 2')
partialCard = partialSpend2.updatedCard
partialTransactions.push({ ...partialSpend2.transaction, id: 'p1' })
const partialClear = recordCreditCardLumpPayment(partialCard, 70, '2026-11-14', 'Partial payment — only the first spend')
partialCard = partialClear.updatedCard
partialTransactions.push({ ...partialClear.transaction, id: 'p2' })
const dec14Row = buildCreditCardMinimumChargeRows(partialCard, partialTransactions, new Date(2026, 10, 15)).find((r) => r.date === '2026-12-14')
check('Paying only the FIRST spend at 14th Nov still leaves the SECOND (£85) genuinely due at 14th Dec', dec14Row?.projectedBalanceDue, 85)

console.log(failures === 0 ? '\nAll credit-card amortisation-deadlock checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
