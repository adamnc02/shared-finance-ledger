import { generateTransactionsForTemplate, newRecurringTemplate } from '../src/lib/schedule'
import { buildLoanSchedule, summarizeLoan, applyLoanOverpayment, nominalTotalPayable, generateLoanPaymentTransactions } from '../src/lib/ledgerLoans'
import { dedupeKey } from '../src/lib/projection'
import { computeMinimumPaymentAmount, generateMinimumPaymentTransactions, recordCreditCardSpend, recordCreditCardLumpPayment, totalPaidForCard, cardBalanceAsOf, withLiveBalance } from '../src/lib/creditCards'
import { summarizeByPaymentMethod } from '../src/lib/paymentMethodSummary'
import { CREDIT_CARD_CATEGORY_ID } from '../src/types/ledger'
import type { CreditCard, Loan, Transaction } from '../src/types/ledger'

let failures = 0
const round2 = (n: number) => Math.round(n * 100) / 100
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok =
    typeof actual === 'number' && typeof expected === 'number'
      ? Math.abs(actual - expected) <= tolerance
      : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// ---- 1. Recurring template schedule generation ----
const monthlyRent = newRecurringTemplate({
  name: 'Rent',
  amount: 900,
  categoryId: 'home',
  paymentMethod: 'standing_order',
  frequency: 'monthly',
  anchorDate: '2026-01-31', // day 31 — should clamp in shorter months
  location: 'personal',
  ownerId: 'me',
  payee: 'me',
  payeeSharePercent: 100,
})
const rentOccurrences = generateTransactionsForTemplate(monthlyRent, new Date(2026, 0, 1), new Date(2026, 3, 30)).map((t) => t.date)
check('Monthly rent (anchor day 31) generates Jan–Apr, clamped in Feb/Apr', rentOccurrences, [
  '2026-01-31',
  '2026-02-28', // 2026 is not a leap year
  '2026-03-31',
  '2026-04-30',
])

const fortnightly = newRecurringTemplate({
  name: 'Cleaner',
  amount: 40,
  categoryId: 'maintenance',
  paymentMethod: 'bank_transfer',
  frequency: 'every_n_weeks',
  intervalWeeks: 2,
  anchorDate: '2026-06-01',
  location: 'personal',
  ownerId: 'me',
  payee: 'me',
  payeeSharePercent: 100,
})
const fortnightlyOccurrences = generateTransactionsForTemplate(fortnightly, new Date(2026, 5, 1), new Date(2026, 6, 31)).map((t) => t.date)
check('Every-2-weeks template generates the expected dates', fortnightlyOccurrences, [
  '2026-06-01',
  '2026-06-15',
  '2026-06-29',
  '2026-07-13',
  '2026-07-27',
])

const paused = newRecurringTemplate({
  name: 'Paused gym',
  amount: 30,
  categoryId: 'fitness',
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-01-01',
  location: 'personal',
  ownerId: 'me',
  payee: 'me',
  payeeSharePercent: 100,
})
paused.active = false
check('An inactive template generates nothing', generateTransactionsForTemplate(paused, new Date(2026, 0, 1), new Date(2026, 11, 31)).length, 0)

// ---- 2. Loan schedule + native overpayments ----
const loan: Loan = {
  id: 'loan-1',
  name: 'Car finance',
  principal: 3000, // 0%-equivalent (principal = monthlyPayment × termMonths) — this test suite is about overpayment/recurring-overpayment mechanics, not interest, which has its own dedicated fixtures in verify-interest-conventions.ts / verify-loan-amortisation.ts
  monthlyPayment: 250,
  termMonths: 12,
  startDate: '2026-01-15',
  categoryId: 'car',
  location: 'personal',
  ownerId: 'me',
  payee: 'me',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
}
check('nominalTotalPayable = monthly × term', nominalTotalPayable(loan), 3000)

const schedule = buildLoanSchedule(loan)
check('12-month loan produces exactly 12 schedule entries with no overpayments', schedule.length, 12)
check('Final balance reaches exactly zero', schedule.at(-1)?.balanceAfter, 0)
check('First payment date matches startDate', schedule[0].date, '2026-01-15')

const { updatedLoan, transaction: overpaymentTxn } = applyLoanOverpayment(loan, 1000, '2026-03-20', 'Bonus overpayment')
const scheduleWithOverpayment = buildLoanSchedule(updatedLoan)
check('A £1000 overpayment in month 3 shortens the schedule below 12 months', scheduleWithOverpayment.length < 12, true)
check('Overpayment is applied in the March entry, not April', scheduleWithOverpayment[2].overpaymentApplied, 1000)
check('Overpayment transaction is a cleared loan_payment', overpaymentTxn.status, 'cleared')
check('Overpayment transaction links back via sourceType', overpaymentTxn.sourceType, 'loan_overpayment')

const summary = summarizeLoan(updatedLoan, new Date(2026, 1, 1)) // as-of 1 Feb, before the overpayment lands
check('summarizeLoan as-of Feb 1 (before overpayment) has monthsRemaining reflecting the shorter post-overpayment schedule', summary.monthsRemaining, scheduleWithOverpayment.filter((e) => e.date > '2026-02-01').length)

// ---- 3. Credit card minimum payment + compounding percent ----
// interestRatePercent: 0 — this test group is about the percent-of-balance
// mechanic itself, isolated from interest (which has its own dedicated
// test group further down).
const card: CreditCard = {
  id: 'card-1',
  name: 'Amex',
  categoryId: CREDIT_CARD_CATEGORY_ID,
  color: '#8b5cf6',
  interestRatePercent: 0,
  currentBalance: 1000,
  balanceAsOfDate: '2026-06-01',
  minimumPayment: { type: 'percent_of_balance', percent: 5 },
  paymentDayOfMonth: 10,
  ownerId: 'me',
  lumpPayments: [],
  active: true,
}
check('5% of £1000 balance', computeMinimumPaymentAmount(card), 50)

// Rewritten for the derived-balance model. NEITHER recordCreditCardSpend
// NOR recordCreditCardLumpPayment writes to currentBalance any more —
// the stored figure is an immutable anchor and the transactions they
// produce are what move the balance. `withLiveBalance` is the read that
// the whole app now goes through, so that's what these assert against.
const bigSpend = recordCreditCardSpend(card, 200, '2026-06-01')
check('recordCreditCardSpend leaves the stored anchor untouched', bigSpend.updatedCard.currentBalance, 1000)
const spendTxn: Transaction = { ...bigSpend.transaction, id: 'tx-spend' }
const cardAfterSpend = withLiveBalance(card, [spendTxn], new Date(2026, 5, 1))
check('Spend increases the derived balance', cardAfterSpend.currentBalance, 1200)
check('5% minimum payment recalculates against the NEW higher balance, not cached', computeMinimumPaymentAmount(cardAfterSpend), 60)

const lumpResult = recordCreditCardLumpPayment(card, 60, '2026-06-10')
check('recordCreditCardLumpPayment alone does NOT reduce the stored anchor', lumpResult.updatedCard.currentBalance, 1000)
const minPayTxn: Transaction = { ...lumpResult.transaction, id: 'tx-1' }
// Read as of the 9th: the payment is dated the 10th, so it hasn't
// happened yet — only the spend counts.
check('A payment dated in the future is not yet reflected in the derived balance', withLiveBalance(card, [spendTxn, minPayTxn], new Date(2026, 5, 9)).currentBalance, 1200)
const cardAfterMinPayment = withLiveBalance(card, [spendTxn, minPayTxn], new Date(2026, 5, 10))
check('On its date, paying the minimum reduces the derived balance', cardAfterMinPayment.currentBalance, 1140)
check('Next cycle\'s 5% minimum is now LOWER than the previous cycle\'s (compounds down as balance shrinks)', computeMinimumPaymentAmount(cardAfterMinPayment) < 60, true)
check('Specifically, 5% of the new £1140 balance', computeMinimumPaymentAmount(cardAfterMinPayment), 57)

const fixedCard: CreditCard = { ...card, id: 'card-2', minimumPayment: { type: 'fixed', amount: 25 } }
check('Fixed minimum payment ignores balance entirely', computeMinimumPaymentAmount(fixedCard), 25)
const nearlyPaidOffCard: CreditCard = { ...fixedCard, currentBalance: 10 }
check('Fixed minimum payment never exceeds the remaining balance', computeMinimumPaymentAmount(nearlyPaidOffCard), 10)

const spendResult = recordCreditCardSpend(card, 50, '2026-06-01')
check('credit_card_spend transaction never touches location/ownerId inconsistently — stays personal', spendResult.transaction.location, 'personal')
check('credit_card_spend gets the reserved built-in category', spendResult.transaction.categoryId, CREDIT_CARD_CATEGORY_ID)

const generatedPayments = generateMinimumPaymentTransactions(card, new Date(2026, 0, 1), new Date(2026, 2, 31))
check('3 months of generated minimum payments (Jan/Feb/Mar), all pending', generatedPayments.every((t) => t.status === 'pending'), true)
check('Generated minimum payments do not include a sourceId (not linked to a specific lump payment)', generatedPayments.every((t) => t.sourceId === undefined), true)

const { transaction: lumpTxn } = recordCreditCardLumpPayment(card, 500, '2026-06-15', 'Paid off half')
check('Lump payment transaction is negative-sign eligible (direction out) so it shows on the Personal card', lumpTxn.direction, 'out')
check('Lump payment transaction links to the specific lump payment record', typeof lumpTxn.sourceId, 'string')

const paidSoFar = totalPaidForCard('card-1', [
  { ...lumpTxn, id: 'x1' } as Transaction,
  { ...lumpTxn, id: 'x2', amount: 100 } as Transaction,
  { ...spendResult.transaction, id: 'x3' } as Transaction, // a spend — must NOT count as "paid"
])
check('totalPaidForCard sums only credit_card_payment transactions, excluding spend', paidSoFar, 600)

// ---- 4. Payment method summary ----
const txns: Transaction[] = [
  { id: '1', date: '2026-06-01', amount: 50, direction: 'out', categoryId: 'food', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'me' },
  { id: '2', date: '2026-06-02', amount: 30, direction: 'out', categoryId: 'food', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'me' },
  { id: '3', date: '2026-06-03', amount: 900, direction: 'out', categoryId: 'home', paymentMethod: 'standing_order', status: 'cleared', type: 'bill_payment', location: 'personal', ownerId: 'me' },
  { id: '4', date: '2026-06-04', amount: 2000, direction: 'in', categoryId: 'income', paymentMethod: 'bank_transfer', status: 'cleared', type: 'salary', location: 'personal', ownerId: 'me' },
]
const byMethod = summarizeByPaymentMethod(txns)
check('3 distinct payment methods used in the sample (cash, direct_debit unused -> excluded)', byMethod.length, 3)
const cardRow = byMethod.find((r) => r.paymentMethod === 'card')
check('Card total is the two card expenses combined, negative', cardRow?.total, -80)
check('Card count is 2', cardRow?.count, 2)
const bankTransferRow = byMethod.find((r) => r.paymentMethod === 'bank_transfer')
check('Bank transfer total is positive (salary, direction in)', bankTransferRow?.total, 2000)

// ---- 5. Recurring overpayments ----
const loanWithFixedRecurring: Loan = {
  ...loan,
  recurringOverpayment: { startDate: '2026-02-01', amount: { type: 'fixed', amount: 100 } },
}
const fixedSchedule = buildLoanSchedule(loanWithFixedRecurring)
check('No recurring overpayment applied in month 1 (before its startDate)', fixedSchedule[0].recurringOverpaymentApplied, 0)
check('£100 fixed recurring overpayment applied from month 2 onward', fixedSchedule[1].recurringOverpaymentApplied, 100)
check('Fixed recurring overpayment shortens the loan below the original 12 months', fixedSchedule.length < 12, true)

const loanWithPercentRecurring: Loan = {
  ...loan,
  recurringOverpayment: { startDate: '2026-01-15', amount: { type: 'percent_of_balance', percent: 10 } },
}
const percentSchedule = buildLoanSchedule(loanWithPercentRecurring)
check('10% recurring overpayment in month 1 is 10% of the POST-scheduled-payment balance (£2750 → £275)', percentSchedule[0].recurringOverpaymentApplied, 275)
check(
  'Month 2\'s 10% recurring overpayment is smaller than month 1\'s — recalculated against the now-lower balance, not cached',
  percentSchedule[1].recurringOverpaymentApplied < percentSchedule[0].recurringOverpaymentApplied,
  true,
)

const loanWithEndDate: Loan = {
  ...loan,
  recurringOverpayment: { startDate: '2026-01-15', endDate: '2026-02-28', amount: { type: 'fixed', amount: 50 } },
}
const endDateSchedule = buildLoanSchedule(loanWithEndDate)
check('Recurring overpayment applies within its window (month 1)', endDateSchedule[0].recurringOverpaymentApplied, 50)
check('Recurring overpayment applies within its window (month 2)', endDateSchedule[1].recurringOverpaymentApplied, 50)
check('Recurring overpayment stops applying once past its endDate (month 3)', endDateSchedule[2]?.recurringOverpaymentApplied ?? 0, 0)

const recurringTxns = generateLoanPaymentTransactions(loanWithFixedRecurring, new Date(2026, 1, 1), new Date(2026, 1, 28))
// Was folded into a single transaction (amount 350 = 250 scheduled + 100
// recurring, with a note explaining the inclusion) — confirmed as a real
// bug, not the intended design: a person testing this directly found
// their recurring overpayment silently inflating the regular payment's
// amount rather than showing as its own line in their ledger, which was
// inconsistent with a one-off logged overpayment already always getting
// its own transaction, and with the loan ledger modal already treating
// all three kinds (regular/ad-hoc/recurring) as distinct row types. Now
// generates two separate transactions, same as the ledger modal already
// modelled internally — see generateLoanPaymentTransactions's own comment.
check('The recurring overpayment now generates its OWN separate transaction, not folded into the regular payment', recurringTxns.length, 2)
const regularTxn = recurringTxns.find((t) => t.sourceType === 'loan')
const recurringTxn = recurringTxns.find((t) => t.sourceType === 'loan_recurring_overpayment')
check('The regular payment transaction is exactly the scheduled amount, not inflated', regularTxn?.amount, 250)
check('The recurring overpayment transaction is exactly the recurring amount, on its own', recurringTxn?.amount, 100)
check('The recurring overpayment transaction carries a note explaining what it is', recurringTxn?.note?.includes('recurring overpayment'), true)
check('The two transactions dedupe independently (distinct sourceType, same date) rather than colliding', dedupeKey(regularTxn!) !== dedupeKey(recurringTxn!), true)

const oneOffOverpaymentTxn = applyLoanOverpayment(loan, 500, '2026-03-20').transaction
check('A one-off logged overpayment is STILL its own separate transaction, unaffected by the recurring-overpayment folding change', oneOffOverpaymentTxn.amount, 500)

// ---- 6. Credit card minimum payments genuinely compound across MULTIPLE months in a single generation call ----
// The reported bug: generateMinimumPaymentTransactions used to compute
// every month's amount from one static balance snapshot, so a
// percent-of-balance card showed the exact same figure for every future
// month instead of shrinking.
// interestRatePercent: 0 here deliberately — this test group is
// specifically about compounding driven by the MINIMUM PAYMENTS
// themselves across multiple months, isolated from interest (which has
// its own dedicated test group below).
const compoundingCard: CreditCard = {
  id: 'card-compound', name: 'Amex', categoryId: CREDIT_CARD_CATEGORY_ID, color: '#8b5cf6',
  interestRatePercent: 0, currentBalance: 500, balanceAsOfDate: '2026-08-01',
  minimumPayment: { type: 'percent_of_balance', percent: 5 },
  paymentDayOfMonth: 6, ownerId: 'me', lumpPayments: [], active: true,
}
const threeMonthsNoRepayment = generateMinimumPaymentTransactions(compoundingCard, new Date(2026, 7, 1), new Date(2026, 9, 31))
check('3 months generated in one call, no repayment', threeMonthsNoRepayment.length, 3)
check('Month 1: 5% of £500', threeMonthsNoRepayment[0].amount, 25)
check('Month 2: 5% of £475 (compounds down from month 1, NOT the same static £25 again)', threeMonthsNoRepayment[1].amount, 23.75)
check('Month 3: 5% of £451.25 (continues compounding)', threeMonthsNoRepayment[2].amount, 22.56)
check(
  'The generated transaction carries the card\'s own name with " - Minimum Charge" appended (not just falling back to the Credit Card category)',
  threeMonthsNoRepayment[0].note,
  'Amex - Minimum Charge',
)

// A lump payment logged for a date BEFORE the next minimum-payment date
// (but still in the future relative to "today") must be folded into
// that next minimum's calculation.
//
// Computed relative to "today", not hardcoded to a fixed calendar year —
// generateMinimumPaymentTransactions filters card.lumpPayments by
// `lp.date > today` internally (reading the REAL system clock, not a
// passed-in asOf), so a hardcoded "future" date silently stops being
// future once real time actually reaches it — confirmed as exactly what
// happened here (this used to be pinned to Aug 2026, which was
// comfortably future when written but is no longer, now that real time
// has caught up to it). Anchoring to next month, every time this runs,
// keeps it genuinely future forever, however many days pass between
// runs.
const lumpToday = new Date()
const lumpGenStart = new Date(lumpToday.getFullYear(), lumpToday.getMonth() + 1, 1) // 1st of next month — always after today
const lumpGenEnd = new Date(lumpToday.getFullYear(), lumpToday.getMonth() + 4, 0) // end of the 3rd month from there
const lumpDateIso = `${lumpGenStart.getFullYear()}-${String(lumpGenStart.getMonth() + 1).padStart(2, '0')}-20` // the 20th of the starting month — between day-6 payments in month 1 and month 2

const { updatedCard: cardWithFutureRepayment } = recordCreditCardLumpPayment(compoundingCard, 100, lumpDateIso)
const withRepayment = generateMinimumPaymentTransactions(cardWithFutureRepayment, lumpGenStart, lumpGenEnd)
const noRepaymentForSameWindow = generateMinimumPaymentTransactions(compoundingCard, lumpGenStart, lumpGenEnd)
const month1Balance = round2(500 * 0.05) // 5% of the starting £500, unaffected by a repayment landing after this month
const month2StartingBalance = round2(500 - month1Balance - 100) // month 1's payment + the £100 lump, both off the original £500
check('Month 1 (before the repayment date) is unaffected: still 5% of £500', withRepayment[0].amount, noRepaymentForSameWindow[0].amount)
check('Month 2 (after the repayment): 5% of the balance after month 1\'s payment AND the £100 lump payment', withRepayment[1].amount, round2(month2StartingBalance * 0.05))
check('Month 3 continues compounding from the post-repayment balance', withRepayment[2].amount, round2((month2StartingBalance - withRepayment[1].amount) * 0.05))

// A lump payment dated AFTER the horizon being generated must not be applied early.
const farFutureDateIso = `${lumpGenStart.getFullYear() + 1}-01-15`
const { updatedCard: cardWithFarFutureRepayment } = recordCreditCardLumpPayment(compoundingCard, 100, farFutureDateIso)
const beforeThatRepayment = generateMinimumPaymentTransactions(cardWithFarFutureRepayment, lumpGenStart, lumpGenEnd)
check('A lump payment dated after the generated range does not affect any of these months', beforeThatRepayment.map((t) => t.amount), noRepaymentForSameWindow.map((t) => t.amount))

// An ALREADY-CLEARED lump payment (dated in the past) must NOT be re-applied — it's already reflected in currentBalance.
const alreadyClearedCard: CreditCard = { ...compoundingCard, currentBalance: 400, lumpPayments: [{ id: 'lp-1', date: '2026-01-01', amount: 100 }] }
const withAlreadyClearedLump = generateMinimumPaymentTransactions(alreadyClearedCard, new Date(2026, 7, 1), new Date(2026, 7, 31))
check('An already-cleared (past-dated) lump payment is NOT re-subtracted — currentBalance already reflects it', withAlreadyClearedLump[0].amount, 20) // 5% of 400, not 5% of 300

// ---- 7. Interest rate — genuinely used now, not just a stored, ignored field ----
import { monthlyInterestRate } from '../src/lib/creditCards'

check('monthlyInterestRate compounds correctly: 22.9% APR -> ~1.7332%/month (NOT the naive 22.9/12 = 1.9083%)', monthlyInterestRate(22.9) * 100, 1.7332, 0.001)
check('0% APR has a 0% monthly rate', monthlyInterestRate(0), 0)

// balanceAsOfDate pinned to the generation window's start (1 Aug). It
// matters now in a way it didn't before: generateMinimumPaymentTransactions
// derives its starting balance as at rangeStart, so an anchor sitting
// MONTHS earlier would (correctly) accrue those intervening cycles of
// 22.9% interest before the first generated payment — real behaviour,
// but not what this particular assertion is measuring.
const interestCard: CreditCard = { ...card, id: 'card-interest', currentBalance: 500, balanceAsOfDate: '2026-08-01', interestRatePercent: 22.9, minimumPayment: { type: 'percent_of_balance', percent: 5 }, paymentDayOfMonth: 15 }
check("computeMinimumPaymentAmount includes one cycle's interest, so it's MORE than the naive 5% of 500 (£25)", computeMinimumPaymentAmount(interestCard) > 25, true)
check('Specifically £25.43 (5% of £500 after one month of 22.9% APR interest)', computeMinimumPaymentAmount(interestCard), 25.43)

const interestSchedule = generateMinimumPaymentTransactions(interestCard, new Date(2026, 7, 1), new Date(2026, 9, 30))
check('3-month interest-bearing schedule: month 1', interestSchedule[0].amount, 25.43)
check('3-month interest-bearing schedule: month 2', interestSchedule[1].amount, 24.58)
check('3-month interest-bearing schedule: month 3', interestSchedule[2].amount, 23.76)

// A 0% interest card must behave EXACTLY as before this change — pure regression safety.
const zeroInterestCard: CreditCard = { ...interestCard, id: 'card-zero-interest', interestRatePercent: 0 }
const zeroInterestSchedule = generateMinimumPaymentTransactions(zeroInterestCard, new Date(2026, 7, 1), new Date(2026, 9, 30))
check('0% interest: month 1 is exactly 5% of £500, unaffected by the interest feature', zeroInterestSchedule[0].amount, 25)
check('0% interest: month 2 is exactly 5% of £475 (pure payment-driven compounding only)', zeroInterestSchedule[1].amount, 23.75)

// The debt-trap property: a fixed minimum payment smaller than the
// interest accruing each cycle means the balance genuinely GROWS over
// time despite payments being made — the real, important mechanic of
// minimum-payment-only credit card debt.
const debtTrapCard: CreditCard = { ...card, id: 'card-debt-trap', currentBalance: 500, balanceAsOfDate: '2026-08-01', interestRatePercent: 29.9, minimumPayment: { type: 'fixed', amount: 5 }, paymentDayOfMonth: 15 }
// Rewritten for the derived-balance model: the payments are materialized
// as real transactions and the balance is READ BACK via cardBalanceAsOf,
// rather than accumulated by repeatedly applying a side effect. Same
// property under test, sourced the way the app now actually computes it.
const debtTrapSchedule = generateMinimumPaymentTransactions(debtTrapCard, new Date(2026, 7, 1), new Date(2027, 1, 28))
const debtTrapTxns: Transaction[] = debtTrapSchedule.map((t) => ({ ...t, id: 'debt-trap-' + t.date, status: 'cleared' as const }))
check(
  "A £5/month fixed minimum on a 29.9% APR card doesn't cover the interest — the balance GROWS over 7 months of payments, from £500 to over £540",
  cardBalanceAsOf(debtTrapCard, debtTrapTxns, new Date(2027, 1, 28)) > 540,
  true,
)

// Interest is tied to the GENERATED minimum payment (the billing-cycle
// event) specifically, NOT to an arbitrary logged lump payment — a lump
// payment clearing must reduce the balance without also triggering a
// full cycle's interest.
const lumpOnlyCard: CreditCard = { ...card, id: 'card-lump-only', currentBalance: 500, interestRatePercent: 22.9 }
const lumpOnlyTxn = { date: '2026-08-15', amount: 100, direction: 'out' as const, categoryId: 'category-credit-card', paymentMethod: 'bank_transfer' as const, status: 'cleared' as const, type: 'credit_card_payment' as const, location: 'personal' as const, ownerId: 'me', creditCardId: 'card-lump-only', sourceType: 'credit_card_lump_payment' as const, sourceId: 'lump-1', id: 'tx-lump' }
// Read as of the payment date itself and anchored the same day: no
// billing date falls strictly between anchor and asOf, so no cycle
// interest posts — the lump payment reduces the balance by exactly its
// face amount. (Under the derived model, interest is a function of which
// BILLING DATES have been crossed, not of which payment triggered it,
// which is a cleaner statement of the same rule this always encoded.)
check(
  'A lump payment reduces the balance by exactly its amount, with NO interest applied (500 - 100 = 400, not 500×interest - 100)',
  cardBalanceAsOf({ ...lumpOnlyCard, balanceAsOfDate: '2026-08-15' }, [lumpOnlyTxn], new Date(2026, 7, 15)),
  400,
)

// ---- 8. totalPaidForCard correctly excludes pending (not-yet-actually-paid) transactions ----
const pendingOnlyTxn: Transaction = { id: 'tx-pending', date: '2026-09-06', amount: 100, direction: 'out', categoryId: CREDIT_CARD_CATEGORY_ID, paymentMethod: 'bank_transfer', status: 'pending', type: 'credit_card_payment', location: 'personal', ownerId: 'me', creditCardId: 'card-1' }
// totalPaidForCard is scoped BY DATE now rather than by `status` — a
// payment dated on or before today counts as paid, per the confirmed
// same-day rule. So these two are pinned with an explicit asOfDate
// either side of the transaction's own date, which is a sharper test
// than the old status flag (a stale status could previously make the
// two halves of the pie chart disagree — the reported bug).
check('A payment dated AFTER the as-of date does NOT count toward totalPaidForCard', totalPaidForCard('card-1', [pendingOnlyTxn], new Date(2026, 8, 5)), 0)
const clearedOnlyTxn: Transaction = { ...pendingOnlyTxn, id: 'tx-cleared', status: 'cleared' }
check('A payment dated ON the as-of date DOES count (same-day payments are treated as completed)', totalPaidForCard('card-1', [clearedOnlyTxn], new Date(2026, 8, 6)), 100)


process.exit(failures === 0 ? 0 : 1)
