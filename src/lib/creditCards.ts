// Credit card calculations. Two different kinds of function live here,
// deliberately kept separate:
//  - PURE, non-mutating schedule generation (generateMinimumPaymentTransactions)
//    — same "compute what should exist, caller dedupes" contract as
//    schedule.ts / ledgerLoans.ts. These produce PENDING transactions and
//    do NOT touch currentBalance directly — the balance is derived from
//    the transactions themselves (cardBalanceAsOf), so a payment existing
//    is its whole effect once it clears (autoClear.ts).
//  - RECORDING functions (recordCreditCardSpend, recordCreditCardLumpPayment)
//    for things the user is telling the app already happened. NEITHER
//    of these writes to card.currentBalance any more — see below.
//
// THE BALANCE IS DERIVED, NOT STORED. card.currentBalance is a stated
// anchor as at card.balanceAsOfDate and is only ever changed by the
// person editing it. What the card owes right now comes from
// cardBalanceAsOf(), which replays interest and card activity forward
// from that anchor. See the comment on CreditCard in types/ledger.ts for
// the bug this replaced.

import { nanoid } from 'nanoid'
import { addDays } from 'date-fns'
import { CREDIT_CARD_CATEGORY_ID, SHARED_CARD_COLORS, type AppDataV2, type CreditCard, type CreditCardLumpPayment, type Transaction } from '../types/ledger'
import { daysBetweenInclusive, buildDailySpendSeries, type BalanceSpendGranularity, type BalanceSpendTrendSeries, type DailyBalancePoint } from './runningBalance'

const round2 = (n: number) => Math.round(n * 100) / 100
import { planReschedule, recentAndUpcomingFrom, redateStoredPayments } from './scheduleChange'
import { toLocalIsoDate as toIso, parseLocalDate } from './date'

// BUGFIX (Batch 8, 2026-09-07, Bug 9.2, Adam-reported): a percent_of_balance
// minimum payment is mathematically a fraction of whatever's left, so a
// balance approaching zero shrinks GEOMETRICALLY (£0.79 -> £0.75 -> £0.71
// -> ...) rather than ever landing on exactly zero — round2 alone doesn't
// help, since each of those figures rounds to a perfectly normal-looking
// non-zero penny amount in its own right. Concretely: Adam logged a
// payment for the FULL balance due on the card's own payment day, which
// correctly zeroed the balance for that cycle — but the interest accrual
// due the NEXT cycle (a fraction of a still-technically-positive
// leftover) kept reintroducing a few pence, and a percent-of-balance
// minimum kept charging a few pence of THAT, forever, despite the card
// being genuinely "cleared" from a real person's point of view. Once a
// balance is this negligible, treat it as paid off outright — no further
// interest compounds on it, and no further minimum charge gets generated
// for it — rather than let the two rules perpetuate a shrinking-but-
// never-quite-zero trail indefinitely. Matches Adam's own "below £0.02"
// description of the residue exactly.
const NEGLIGIBLE_BALANCE = 0.02

/**
 * The monthly rate that compounds to the given APR over a year — NOT a
 * simple APR/12 division, which understates it. E.g. 22.9% APR compounds
 * from a monthly rate of ~1.73%, not 22.9/12 ≈ 1.91% (division actually
 * overstates the simple case, but the two diverge either direction
 * depending on the rate — the point is APR/12 isn't the right monthly
 * figure either way; this is the rate that genuinely compounds back to
 * the stated APR across 12 months).
 */
export function monthlyInterestRate(interestRatePercent: number): number {
  return Math.pow(1 + interestRatePercent / 100, 1 / 12) - 1
}

/** One cycle's interest, applied to a balance. Deliberately simplified — no daily accrual, no interest-free grace period on new purchases, interest just compounds monthly against whatever the balance is at each billing cycle. Same "clearly-scoped approximation" philosophy as the tax engine's own documented simplifications elsewhere in this app. */
export function applyMonthlyInterest(balance: number, interestRatePercent: number): number {
  if (balance <= NEGLIGIBLE_BALANCE) return 0
  return round2(balance * (1 + monthlyInterestRate(interestRatePercent)))
}

/**
 * The minimum payment for a GIVEN balance — the pure calculation shared
 * by both the "what's due right now" single-point query below and the
 * forward-simulating generator further down (and, via simulateCardPayoffMonths,
 * the What-if page's card payoff/overpayment simulation).
 */
export function minimumPaymentForBalance(minimumPayment: CreditCard['minimumPayment'], balance: number): number {
  if (balance <= NEGLIGIBLE_BALANCE) return 0
  if (minimumPayment.type === 'fixed') return round2(Math.min(minimumPayment.amount, balance))
  return round2((balance * minimumPayment.percent) / 100)
}

/**
 * The amount due for this cycle, computed fresh against the card's
 * CURRENT balance — never cached. For percent_of_balance cards this is
 * exactly why: 5% of a shrinking balance shrinks in turn each cycle, so
 * caching the £ figure from an earlier cycle would silently go stale.
 *
 * Interest for the UPCOMING cycle is applied first, before the minimum
 * is calculated — real statements work the same way: interest posts to
 * the balance, THEN the minimum payment is calculated against that new,
 * interest-inflated statement balance. currentBalance itself already
 * reflects every PAST cycle's interest (derived from each prior billing
 * date, see cardBalanceAsOf) — this one
 * extra application projects one cycle further, for the payment that
 * hasn't happened yet.
 */
export function computeMinimumPaymentAmount(card: CreditCard): number {
  const balanceWithInterest = applyMonthlyInterest(card.currentBalance, card.interestRatePercent)
  const computedMinimum = minimumPaymentForBalance(card.minimumPayment, balanceWithInterest)
  // UAT 2026-09-08 (8-bug9.2-minimum-charges-stop) — same amortisation-
  // deadlock guard as generateMinimumPaymentTransactions: if the computed
  // minimum wouldn't leave the balance any lower than it stood before
  // this cycle's interest, it's not keeping pace with interest — the
  // whole remaining balance is due instead of perpetuating a residue.
  // Restricted the same way, and for the same reason, as that function's
  // own guard: only when a percent_of_balance minimum's UNROUNDED
  // theoretical amount would have exceeded this cycle's interest — i.e.
  // rounding, not the policy itself, is what erased the progress. A
  // fixed minimum (or a percent genuinely too small for the rate) is a
  // real debt trap, not a bug — the balance is meant to grow.
  const interestThisCycle = balanceWithInterest - card.currentBalance
  const roundingCouldExplainDeadlock = card.minimumPayment.type === 'percent_of_balance' && (balanceWithInterest * card.minimumPayment.percent) / 100 > interestThisCycle
  if (computedMinimum > 0 && roundingCouldExplainDeadlock && round2(balanceWithInterest - computedMinimum) >= card.currentBalance) return balanceWithInterest
  return computedMinimum
}

/**
 * The card's next minimum charge — the figure to show anywhere the app
 * says "due" or "min. due" for a card.
 *
 * Prefer this over computeMinimumPaymentAmount at every DISPLAY site.
 * computeMinimumPaymentAmount is a pure balance→minimum calculation with
 * no notion of a date, and so cannot consult minimumPaymentOverrides at
 * all. That gave the app two independent answers to one question: the
 * Loans collapsed row and the Home card widget computed their own figure
 * and ignored overrides, while the Summary page and the ledger modal
 * routed through generateMinimumPaymentTransactions and honoured them.
 * Reproduced: a card with the 14 Sep charge overridden to £100 showed
 * £100 on Summary and the modal, £228.07 on Loans and Home, in the same
 * session, from the same data.
 *
 * Routing every display site through the same generator that Summary and
 * the modal already use makes divergence structurally impossible rather
 * than merely currently-absent — an override, a lump payment landing
 * before the charge date, and the interest-then-minimum ordering are all
 * applied in exactly one place. Returns null when the card has no
 * upcoming charge at all (inactive, or nothing owed).
 */
export function nextMinimumChargeAmount(card: CreditCard, transactions: Transaction[], asOfDate: Date = new Date()): number | null {
  // 13 months, so a card whose payment day has already passed this month
  // still finds next month's, and a full year of clamping edge cases
  // (short months, Feb) can't produce an empty window.
  const rangeEnd = new Date(asOfDate.getFullYear() + 1, asOfDate.getMonth() + 1, 0)
  const upcoming = generateMinimumPaymentTransactions(card, asOfDate, rangeEnd, transactions)
  return upcoming.length > 0 ? upcoming[0].amount : null
}

/**
 * What this card ACTUALLY owes as at `asOfDate` — the single source of
 * truth for every "outstanding"/"owed"/"remaining" figure in the app.
 *
 * Replays forward from the stated anchor (card.currentBalance as at
 * card.balanceAsOfDate):
 *  - a billing cycle's interest posts on each paymentDayOfMonth STRICTLY
 *    AFTER the anchor date. Not on the anchor date itself: a stated
 *    balance for a given day already includes that day's statement
 *    interest, so charging it again would inflate the very figure the
 *    person just typed in.
 *  - card activity dated on or after the anchor date and on or before
 *    `asOfDate` is applied in date order — spend adds, payments subtract.
 *    Interest for a date is applied before that date's transactions,
 *    matching how a real statement posts interest and THEN takes the
 *    payment (and matching generateMinimumPaymentTransactions below).
 *
 * Membership is decided BY DATE, not by `status`. Per the confirmed rule,
 * a payment dated today has completed and must be reflected immediately;
 * going by date says so directly instead of depending on whether an
 * auto-clear pass has run yet and flipped a flag. A future-dated payment
 * is excluded because its date hasn't arrived, not because of its status.
 *
 * Anything dated BEFORE the anchor is ignored outright — it's already
 * inside the stated figure, exactly as an opening balance works on the
 * Salary page. This is what makes the anchor safe to re-save: writing the
 * same currentBalance back can no longer erase a payment, because the
 * payment was never inside currentBalance to begin with.
 */
export function cardBalanceAsOf(card: CreditCard, transactions: Transaction[], asOfDate: Date = new Date()): number {
  const asOfIso = toIso(asOfDate)
  const anchorIso = card.balanceAsOfDate
  const hasStatementWindow = card.statementStartDay != null && card.statementEndDay != null

  const activity = transactions
    .filter(
      (t) =>
        t.creditCardId === card.id &&
        (t.type === 'credit_card_spend' || t.type === 'credit_card_payment') &&
        t.date >= anchorIso &&
        t.date <= asOfIso,
    )
    .sort((a, b) => a.date.localeCompare(b.date))

  // Every date on which SOMETHING happens: a billing date (interest) or
  // a transaction. Walking a merged, sorted set of dates keeps the two
  // kinds of event correctly interleaved when they land in the same
  // cycle, without iterating day by day over what could be years.
  const billingDates = billingDatesBetween(card.paymentDayOfMonth, anchorIso, asOfIso)
  // BUGFIX (2026-09-09, statement-window grace-timing) — each billing
  // date's own statement-window close, so the walk below can tell WHEN a
  // window genuinely closed, not just which calendar day is due. See
  // `previousCloseSnapshot` below for why this matters. Only meaningful
  // once a window is configured; empty otherwise, leaving non-window
  // cards on the exact `balanceEnteringCycle` mechanism they always used.
  const closeDates = hasStatementWindow
    ? billingDates.map((d) => toIso(statementCloseDateForPaymentDate(card, parseLocalDate(d)))).filter((d) => d > anchorIso && d <= asOfIso)
    : []
  const allDates = [...new Set([...billingDates, ...closeDates, ...activity.map((t) => t.date)])].sort()

  let balance = card.currentBalance
  // UAT 2026-09-08 (8-bug9.2, Adam-requested grace period) — a real card
  // charges no interest on new spend at all if the account entered the
  // billing cycle already fully paid off; interest only starts (and, in
  // real cards, applies retroactively) once a balance is actually being
  // carried/revolved. `balanceEnteringCycle` is frozen at the value the
  // balance held right after the PREVIOUS billing date's own interest +
  // same-day activity — i.e. what carries INTO this cycle, before this
  // cycle's own new spend gets added — so it survives however much new
  // spend accumulates before this cycle's own billing date is reached.
  // Used directly for non-window cards; a statement-window card uses
  // `windowBalance`/`windowEnteringSnapshot` instead — see below.
  let balanceEnteringCycle = card.currentBalance
  // BUGFIX (2026-09-09, statement-window grace-timing, root cause
  // confirmed against Adam's £20/14th-Oct repro; real-UK-T&Cs grace
  // policy per Adam, same date) — `balanceEnteringCycle` above answers
  // "what carried into the last calendar billing date," which is the
  // wrong question once a statement window is involved: a purchase
  // posted after its own window's close doesn't even belong to the next
  // calendar due date at all — it rolls into the ONE AFTER that, per the
  // same statement-window rule `generateMinimumPaymentTransactions`
  // already uses for minimum-charge dates. `windowBalance` mirrors that
  // function's own `workingBalance`/`statementBalance` split: it tracks
  // the same real activity as `balance`, except new SPEND only folds in
  // once its own window has closed (via `spendQueue` below) — payments
  // still apply immediately on their own date, same as `balance`, since
  // real payments are never window-gated. `windowEnteringSnapshot` is
  // `windowBalance` as it stood right after the PREVIOUS billing date's
  // own full processing (interest + same-day activity) — i.e. genuinely
  // "was the previous statement's balance paid off by its own due date,"
  // which correctly sees a payoff dated between a window's close and its
  // due date (an earlier version of this fix, keyed off the close date
  // alone, couldn't see such a payment and wrongly kept charging interest
  // after a genuine full payoff — caught by the "re-earn grace" check in
  // verify-credit-card-amortization-deadlock.ts).
  let windowBalance = card.currentBalance
  let windowEnteringSnapshot = card.currentBalance
  const spendQueue = activity.filter((t) => t.type === 'credit_card_spend')
  let spendQueueIndex = 0
  for (const date of allDates) {
    if (billingDates.includes(date)) {
      const entering = hasStatementWindow ? windowEnteringSnapshot : balanceEnteringCycle
      if (entering > NEGLIGIBLE_BALANCE) {
        balance = applyMonthlyInterest(balance, card.interestRatePercent)
        if (hasStatementWindow) windowBalance = applyMonthlyInterest(windowBalance, card.interestRatePercent)
      } else {
        // Grace applies (nothing carried into this cycle) AND there's no
        // new spend to charge interest-free either — still snap a
        // lingering negligible-dust residual to exactly zero, same as
        // applyMonthlyInterest's own guard would have done had it run.
        // Skipping this call entirely (for the grace case) must not also
        // resurrect the pre-Batch-8 stuck-forever-at-a-penny bug. Checked
        // independently for each balance — they can genuinely differ
        // (`windowBalance` lags `balance` until a window closes). Uses
        // Math.abs — see the BUGFIX comment on `windowBalance`'s payment
        // application just below for why a genuinely negative value must
        // survive this snap, not just a tiny positive one.
        if (balance <= NEGLIGIBLE_BALANCE) balance = 0
        if (hasStatementWindow && Math.abs(windowBalance) <= NEGLIGIBLE_BALANCE) windowBalance = 0
      }
    }
    for (const t of activity.filter((a) => a.date === date)) {
      balance = t.type === 'credit_card_spend' ? round2(balance + t.amount) : round2(Math.max(0, balance - t.amount))
      // BUGFIX (2026-09-09, UAT-reported: clearing an early due date
      // wrongly zeroed a later, genuinely separate one) — deliberately
      // NOT clamped to 0 like `balance` just above. A payment sized off
      // `balance` (the true running total, e.g. via buildCreditCardDueOverviewRows'
      // Clear button) can be MORE than `windowBalance` currently reflects,
      // because `windowBalance` only picks up a purchase once its own
      // window closes — `balance` already includes it the moment it's
      // spent. Clamping here would silently discard that difference;
      // letting it go negative instead means it nets cleanly to zero once
      // the delayed purchase's window finally closes and folds it in
      // (see the spend-queue fold below), rather than that purchase
      // resurrecting a bogus "still owed" figure once it arrives.
      if (hasStatementWindow && t.type === 'credit_card_payment') windowBalance = round2(windowBalance - t.amount)
    }
    if (hasStatementWindow && closeDates.includes(date)) {
      while (spendQueueIndex < spendQueue.length && spendQueue[spendQueueIndex].date <= date) {
        windowBalance = round2(windowBalance + spendQueue[spendQueueIndex].amount)
        spendQueueIndex++
      }
    }
    if (billingDates.includes(date)) {
      balanceEnteringCycle = balance
      if (hasStatementWindow) windowEnteringSnapshot = windowBalance
    }
  }
  return round2(Math.max(0, balance))
}

/** Every paymentDayOfMonth occurrence strictly after `afterIso` and on or before `throughIso` — the dates a cycle's interest posts. Clamped to the length of each month, same rule generateMinimumPaymentTransactions uses. */
function billingDatesBetween(paymentDayOfMonth: number, afterIso: string, throughIso: string): string[] {
  const results: string[] = []
  const start = parseLocalDate(afterIso)
  const end = parseLocalDate(throughIso)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return results
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1)
  let guard = 0
  while (cursor <= end && guard < 1200) {
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
    const iso = toIso(new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(paymentDayOfMonth, daysInMonth)))
    if (iso > afterIso && iso <= throughIso) results.push(iso)
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    guard++
  }
  return results
}

/**
 * Which statement window's close a given payment date belongs to (item
 * e) — the most recent occurrence of `statementEndDay` before
 * `paymentDate`. Both days recur once a month, and Adam confirmed
 * exactly one close happens between a window's close and its own due
 * date, so this is a plain day-number comparison rather than a real walk:
 * if the close day is numerically EARLIER in the month than the payment
 * day, the relevant close already happened THIS month; otherwise (equal
 * or later) it happened the month before — matches the worked example
 * (close 18th, due 14th: 18 >= 14, so the close is the 18th of the
 * PRECEDING month). Only called once `card.statementEndDay` is set.
 */
function statementCloseDateForPaymentDate(card: CreditCard, paymentDate: Date): Date {
  const endDay = card.statementEndDay!
  const year = paymentDate.getFullYear()
  const month = paymentDate.getMonth()
  if (endDay < card.paymentDayOfMonth) {
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    return new Date(year, month, Math.min(endDay, daysInMonth))
  }
  const daysInPrevMonth = new Date(year, month, 0).getDate()
  return new Date(year, month - 1, Math.min(endDay, daysInPrevMonth))
}

/**
 * The most recent statement-window close on or before `dateIso` — used to
 * find where a fresh simulation's OPENING statement balance should be cut
 * off from (see `generateMinimumPaymentTransactions`'s `statementBalance`
 * initialisation). BUGFIX (2026-09-09, statement-window grace-timing,
 * same root cause family as the interest-timing fix): a fresh card with
 * no stored minimum-charge history yet always starts its simulation
 * range AT `asOfDate` (today) — so a purchase posted only days ago, whose
 * window genuinely hasn't closed, was being folded straight into the
 * OPENING statementBalance uninspected, since that init line used to just
 * copy `workingBalance` wholesale. Checks a small window of candidate
 * due-date months around `dateIso` (paymentDayOfMonth only shifts a
 * close's month, never which day of the month it recurs on, so a handful
 * of months either side is always enough to find the nearest one).
 */
function mostRecentStatementCloseOnOrBefore(card: CreditCard, dateIso: string): string | null {
  if (card.statementEndDay == null) return null
  const d = parseLocalDate(dateIso)
  let best: string | null = null
  for (let offset = -2; offset <= 2; offset++) {
    const year = d.getFullYear()
    const month = d.getMonth() + offset
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const candidateDue = new Date(year, month, Math.min(card.paymentDayOfMonth, daysInMonth))
    const closeIso = toIso(statementCloseDateForPaymentDate(card, candidateDue))
    if (closeIso <= dateIso && (best == null || closeIso > best)) best = closeIso
  }
  return best
}

/**
 * The card with its stored anchor swapped for the live derived balance —
 * the one thing READ sites should use. Everything downstream
 * (computeMinimumPaymentAmount, simulateCardPayoffMonths, the What-if
 * engine) already works off `currentBalance`, so handing it a card whose
 * currentBalance IS the live figure keeps all of them correct without
 * each one needing to learn about anchors and replays.
 *
 * Never persist the result: writing it back would re-anchor the card to a
 * figure that already includes activity the replay would then apply a
 * second time.
 */
export function withLiveBalance(card: CreditCard, transactions: Transaction[], asOfDate: Date = new Date()): CreditCard {
  return { ...card, currentBalance: cardBalanceAsOf(card, transactions, asOfDate) }
}

/**
 * Generates pending credit_card_payment transactions for the given
 * card's payment day, one per month in the range — genuinely SIMULATING
 * the balance forward month by month, rather than computing every
 * month's amount against a single static snapshot (which silently broke
 * compounding whenever more than one month was generated in the same
 * call: a percent-of-balance card would show the exact same minimum for
 * every future month instead of shrinking).
 *
 * Also accounts for any logged lump payment dated before a given
 * month's payment date — a repayment logged for the 20th genuinely
 * reduces what the NEXT minimum payment is calculated against, even
 * before that repayment has itself cleared. Only lump payments that
 * HAVEN'T cleared yet (dated after today) are folded into the
 * simulation — anything already cleared is already reflected in
 * card.currentBalance, the simulation's starting point, and re-applying
 * it here would double-count it.
 *
 * ITEM E — statement windows: once `card.statementEndDay` is set, each
 * due date's minimum is computed off a SEPARATE `statementBalance` that
 * only picks up real `credit_card_spend` transactions dated on/before
 * that window's own close (statementCloseDateForPaymentDate) — a
 * purchase posted after the close still shows in the card's live balance
 * immediately (via `workingBalance`/`cardBalanceAsOf` elsewhere) but
 * doesn't count toward THIS minimum, rolling into the next window's
 * instead, matching real statement mechanics. Lump payments are NOT
 * window-gated (confirmed against real UK card practice) — they reduce
 * both balances immediately, same as today. Whenever `statementEndDay`
 * is absent, `statementBalance` is kept in lockstep with `workingBalance`
 * the whole way through and never diverges, so the minimum is always
 * read from `workingBalance` as before — byte-identical output to the
 * pre-item-e behaviour for every existing card.
 */
/**
 * 2026-09-16 — a card's payment day changed from a chosen payment
 * (applyCardPaymentDayChange) generates nothing before `card.scheduleFrom`:
 * those payments are stored history, and re-creating them on the new day is
 * what used to duplicate them. Only the OUTPUT is filtered; the simulation
 * below is untouched, so every balance and cycle figure is exactly as before.
 */
export function generateMinimumPaymentTransactions(
  card: CreditCard,
  rangeStart: Date,
  rangeEnd: Date,
  transactions: Transaction[] = [],
  onCycle?: (info: { dateIso: string; statementBalanceBeforePayment: number; workingBalanceBeforePayment: number }) => void,
): Omit<Transaction, 'id'>[] {
  // BUGFIX (2026-09-16, Adam-reported: mum's Santander £91.24 due 14 Oct was
  // missing from her Personal ledger, while Borrowing showed it). PROMPT-01's
  // mechanism-6 fix (see buildCreditCardMinimumChargeRows) lived in ONE
  // caller. projection.ts passes the current cycle's start as rangeStart, and
  // her cycle starts on 14 Sep, the day her £228.07 payment cleared. The
  // simulation's opening balance already has that payment deducted
  // (cardBalanceAsOf is inclusive), then the 14 Sep cycle was charged again:
  // £0 left on a 100% card, so no October row. Guarded here so every caller
  // (projection, autoClear, nextMinimumChargeAmount, trends, cycle sections)
  // gets it. Idempotent: callers that already start the day after pass a
  // date with no stored payment on it. Compared as local ISO strings (toIso),
  // never toISOString, which gives the previous day for a BST local midnight.
  const rangeStartIso = toIso(rangeStart)
  const paymentAlreadyInOpeningBalance = transactions.some(
    (t) => t.creditCardId === card.id && t.type === 'credit_card_payment' && !t.sourceType && t.date === rangeStartIso,
  )
  const simulationStart = paymentAlreadyInOpeningBalance
    ? new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate() + 1)
    : rangeStart
  const generated = simulateMinimumPaymentTransactions(card, simulationStart, rangeEnd, transactions, onCycle)
  const from = card.scheduleFrom
  return from ? generated.filter((t) => t.date >= from) : generated
}

function simulateMinimumPaymentTransactions(
  card: CreditCard,
  rangeStart: Date,
  rangeEnd: Date,
  transactions: Transaction[] = [],
  // UAT 2026-09-08 (Summary page cycle-end totals) — an optional hook,
  // fired once per simulated cycle regardless of whether a charge ends
  // up generated (amount<=0 cycles included), carrying the STATEMENT
  // balance as it stood right before that cycle's own payment/minimum —
  // "the balance due for this period" a real statement would show,
  // which can genuinely differ from the true running balance
  // (cardBalanceAsOf) once a statement window is involved. Exists so
  // callers needing this figure (buildCreditCardCycleSections) share the
  // exact same simulation this function already runs, rather than
  // re-deriving it separately and risking the two ever disagreeing.
  onCycle?: (info: { dateIso: string; statementBalanceBeforePayment: number; workingBalanceBeforePayment: number }) => void,
): Omit<Transaction, 'id'>[] {
  if (!card.active) return []
  const results: Omit<Transaction, 'id'>[] = []

  // The simulation starts from the balance as at RANGE START — not the
  // stored anchor, and not "as of today" either.
  //
  // Not the anchor: it may be months old, with real spend and payments
  // logged since, so a percent-of-balance minimum computed off it would
  // be quoting against a debt that's already partly paid.
  //
  // Not today: rangeStart is routinely in the PAST (projection.ts
  // generates from the current cycle's start so that an occurrence
  // earlier this cycle still appears). Anchoring at today and then
  // simulating a payment dated last week would subtract that payment
  // from a balance which — if it had already been materialized — already
  // reflected it, understating every later month. Anchoring at
  // rangeStart makes the split unambiguous: everything BEFORE rangeStart
  // is inside the starting figure, everything from rangeStart onward is
  // simulated forward exactly once.
  //
  // It also makes this function deterministic given its arguments rather
  // than dependent on the wall clock, which is what let the fixtures
  // below drift as real time passed.
  const rangeStartIso = toIso(rangeStart)
  let workingBalance = cardBalanceAsOf(card, transactions, rangeStart)
  // BUGFIX (2026-09-09, statement-window grace-timing, same root cause
  // family as the interest-timing fix) — this used to just copy
  // `workingBalance` wholesale, which is wrong whenever `rangeStart`
  // lands inside a window that hasn't closed yet (routine for a fresh
  // card, or any card with no minimum-charge history stored — see
  // buildCreditCardMinimumChargeRows, which always starts rangeStart AT
  // asOfDate in that case): a purchase posted only days before rangeStart
  // would get folded straight into the OPENING statementBalance
  // uninspected, treating it as already due at the very next calendar
  // due date instead of the one its window rule actually assigns it to.
  // `mostRecentStatementCloseOnOrBefore` finds the real cutoff — the
  // opening figure is the true balance as of THAT close, not rangeStart
  // itself; anything posted between the close and rangeStart is excluded
  // here and picked up by `pendingSpendForStatement` below once its own
  // window closes during the simulation, same as any other in-range spend.
  const statementOpeningCloseIso = mostRecentStatementCloseOnOrBefore(card, rangeStartIso)
  // BUGFIX (2026-09-09, UAT-reported: clearing an early due date wrongly
  // wiped a later, genuinely separate one) — `cardBalanceAsOf` at the
  // close date only replays activity UP TO that close, so it has no way
  // to know about a real PAYMENT dated after it but on/before rangeStart
  // (e.g. a lump payment clearing an earlier balance, made a few days
  // before this fresh simulation's own rangeStart). Payments are never
  // window-gated — they apply immediately, same as the main walk's own
  // lump-payment loop below — so any dated in that gap must still reduce
  // the opening figure. Deliberately NOT clamped to 0: a payment sized
  // off the TRUE running balance (which already includes a purchase
  // whose window hasn't closed yet) can be MORE than this window-gated
  // opening figure — letting it go negative here means it nets cleanly
  // to zero once that purchase's window closes and folds in below,
  // instead of resurrecting it as fresh, unpaid debt.
  const paymentsBetweenCloseAndRangeStart =
    statementOpeningCloseIso != null
      ? transactions
          .filter((t) => t.creditCardId === card.id && t.type === 'credit_card_payment' && t.date > statementOpeningCloseIso && t.date <= rangeStartIso)
          .reduce((sum, t) => round2(sum + t.amount), 0)
      : 0
  let statementBalance =
    statementOpeningCloseIso != null ? round2(cardBalanceAsOf(card, transactions, parseLocalDate(statementOpeningCloseIso)) - paymentsBetweenCloseAndRangeStart) : workingBalance
  // Same cut, applied to logged lump payments: one dated on or before
  // rangeStart is already inside workingBalance above (its transaction
  // was replayed into it), so folding it in again here would
  // double-count. Only ones landing inside the simulated window get
  // applied by the loop below.
  const pendingLumpPayments = card.lumpPayments.filter((lp) => lp.date > rangeStartIso).sort((a, b) => a.date.localeCompare(b.date))
  let lumpIndex = 0
  // item e — real spend dated after rangeStart, needed to know how much
  // of a window's own activity should count toward ITS minimum (spend on
  // or before the close) versus roll into the next one (spend after).
  // Same "already-anchored vs still-to-simulate" cut as lump payments
  // above; spend already inside `workingBalance`/`rangeStart` needs no
  // separate handling here.
  // BUGFIX (2026-09-16, Adam-reported) — this used to filter ONLY on
  // `t.date > rangeStartIso`, unlike `cardBalanceAsOf`'s own activity
  // filter (`t.date >= card.balanceAsOfDate`) that `workingBalance`
  // above is seeded from. Whenever a caller's `rangeStart` lands BEFORE
  // the card's own opening/anchor date (routine — autoClear.ts passes
  // the PERSON's pay-cycle start, unrelated to any one card's own
  // anchor), a transaction dated between rangeStart and the card's real
  // anchor (e.g. a spend logged before the card even "opened") satisfied
  // `t.date > rangeStartIso` and got folded into workingBalance/
  // statementBalance mid-simulation as if it were real debt — even
  // though `cardBalanceAsOf` had correctly excluded that exact same
  // transaction from the OPENING figure a few lines above. The result:
  // a phantom minimum charge kept regenerating for a period that had
  // already been manually cleared, driven entirely by this leaked
  // pre-anchor transaction. Same `>= card.balanceAsOfDate` floor as
  // cardBalanceAsOf now applies here too, so pre-anchor activity can
  // never leak into the forward simulation regardless of what
  // `rangeStart` a caller passes in.
  const pendingSpend = transactions
    .filter((t) => t.creditCardId === card.id && t.type === 'credit_card_spend' && t.date >= card.balanceAsOfDate && t.date > rangeStartIso)
    .sort((a, b) => a.date.localeCompare(b.date))
  // The statement-side fold uses a WIDER list than `pendingSpend` above
  // whenever `statementOpeningCloseIso` reaches further back than
  // rangeStart — otherwise spend posted between that close and rangeStart
  // (deliberately excluded from the opening `statementBalance` above)
  // would never get folded in at all, falling through the cracks
  // permanently. Identical to `pendingSpend` when there's no window (or
  // the close coincides with rangeStart), so non-window cards are
  // unaffected.
  const pendingSpendForStatement =
    statementOpeningCloseIso != null && statementOpeningCloseIso < rangeStartIso
      ? transactions
          .filter((t) => t.creditCardId === card.id && t.type === 'credit_card_spend' && t.date >= card.balanceAsOfDate && t.date > statementOpeningCloseIso)
          .sort((a, b) => a.date.localeCompare(b.date))
      : pendingSpend
  // Two INDEPENDENT pointers into two lists that may start from different
  // dates (see `pendingSpendForStatement` above) — a spend hits
  // workingBalance (the true running balance) as soon as its own date
  // has passed, but may need to wait for a LATER iteration's window to
  // close before it's added to statementBalance (the figure minimums are
  // computed against). A single shared pointer would consume an entry
  // the moment it passed `paymentDateIso` regardless of whether it also
  // cleared `closeDateIso` that same iteration, silently losing it for
  // the later window it actually belongs to.
  let workingSpendIndex = 0
  let statementSpendIndex = 0
  // BUGFIX (2026-09-09, statement-window grace-timing; see
  // cardBalanceAsOf's identical `windowEnteringSnapshot` mechanism) —
  // `workingBalanceEnteringCycle` below answers "what did workingBalance
  // carry from the PREVIOUS calendar due date," which is the wrong
  // question once a window is involved — a purchase posted after its own
  // window's close doesn't belong to the next due date at all, so that
  // due date must not treat it as "carried debt." The real question is
  // "was the previous statement's balance paid off by ITS OWN due date" —
  // `previousStatementCloseSnapshot` is `statementBalance` exactly as it
  // stood at the END of the previous cycle's full processing (interest,
  // lump payments, minimum charge — see where it's set, right before
  // `cursor` advances), which correctly sees a payment made between a
  // window's close and its own due date. Initialised to the (now
  // window-corrected) `statementBalance` opening figure, not
  // `workingBalance` — that's the real balance as of the close BEFORE the
  // first simulated cycle, which is exactly what this variable represents
  // for every later cycle too.
  let previousStatementCloseSnapshot = statementBalance

  let cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1)
  while (cursor <= rangeEnd) {
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
    const paymentDate = new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(card.paymentDayOfMonth, daysInMonth))
    const paymentDateIso = toIso(paymentDate)
    const closeDateIso = card.statementEndDay != null ? toIso(statementCloseDateForPaymentDate(card, paymentDate)) : null
    // UAT 2026-09-08 (8-bug9.2, Adam-requested grace period) — frozen
    // BEFORE this cycle's own spend gets folded in below, so it reflects
    // what carried INTO this cycle from the end of the last one. Used
    // just below to decide whether this cycle accrues interest at all —
    // see cardBalanceAsOf's identical mechanism for the full reasoning.
    // Deliberately only tracked for workingBalance — see the interest-
    // gating block below for why statementBalance shares this same gate
    // rather than tracking its own (lagged, window-delayed) version.
    const workingBalanceEnteringCycle = workingBalance

    // Fold in any real spend dated up to this payment date into the true
    // running balance — always, regardless of window.
    while (workingSpendIndex < pendingSpend.length && pendingSpend[workingSpendIndex].date <= paymentDateIso) {
      workingBalance = round2(workingBalance + pendingSpend[workingSpendIndex].amount)
      workingSpendIndex++
    }
    // Fold spend into the statement-window balance only once ITS OWN
    // window has actually closed — `closeDateIso` here is THIS
    // iteration's close, so a spend dated after it waits for a later
    // iteration (whichever one's close finally clears it). No window
    // tracking configured at all (`closeDateIso` null) means every
    // pending spend qualifies immediately, matching workingBalance
    // exactly — the pre-item-e behaviour.
    // No window tracking configured (`closeDateIso` null) falls back to
    // paymentDateIso as the cutoff — identical pacing to workingBalance
    // above, so the two stay byte-identical the whole way through.
    const statementCutoffIso = closeDateIso ?? paymentDateIso
    while (statementSpendIndex < pendingSpendForStatement.length && pendingSpendForStatement[statementSpendIndex].date <= statementCutoffIso) {
      statementBalance = round2(statementBalance + pendingSpendForStatement[statementSpendIndex].amount)
      statementSpendIndex++
    }

    // UAT 2026-09-08 (8-bug9.2-minimum-charges-stop, retest): the
    // NEGLIGIBLE_BALANCE snap only catches a balance that's ALREADY tiny
    // — it never fires for a percent-of-balance minimum stuck on a small
    // but not-tiny balance (e.g. a few tens of pence) where the payment,
    // rounded to the nearest penny, doesn't even cover the interest this
    // cycle accrues on what's left. That's a genuine amortisation
    // deadlock, not a rounding artefact close to zero — captured here so
    // the fix generalises to any such balance, not just ones below a
    // fixed pence threshold.
    const statementBalanceBeforeInterest = statementBalance
    // UAT 2026-09-08, second retest — a statement-window card
    // (statementStartDay/statementEndDay set) can leave workingBalance
    // and statementBalance permanently diverged: a spend lands in
    // workingBalance immediately but statementBalance only picks it up
    // once its own window closes, so the minimum — always sized off
    // statementBalance — can be too small to even cover the interest
    // accruing on the LARGER true workingBalance, which then deadlocks
    // on its own, independently of statementBalance's own (possibly
    // still-progressing) figure. Both must be checked.
    const workingBalanceBeforeInterest = workingBalance

    // Interest for this cycle posts first, against the balance as it
    // stood going into the cycle — THEN any lump payments logged within
    // it reduce the balance, THEN the minimum is calculated against
    // what's left. This slightly overstates interest if a lump payment
    // landed early in the cycle (no daily precision here), which is a
    // deliberate, conservative simplification rather than an attempt at
    // exact accrual. Applied to BOTH balances identically — item e adds
    // no new interest-timing modelling of its own beyond the grace-period
    // check just above: no daily accrual, still no partial-cycle
    // proration, just an all-or-nothing "did this cycle start already
    // clear" gate (Adam-requested, 2026-09-08 — real cards charge no
    // interest on new spend at all if the account entered the cycle fully
    // paid off, only starting once a balance is actually being carried).
    // Grace applies when nothing carried in — but still snap a lingering
    // negligible-dust residual to exactly zero in that case (see
    // cardBalanceAsOf's identical comment): skipping applyMonthlyInterest
    // entirely must not resurrect the pre-Batch-8 stuck-forever-at-a-
    // penny bug for a balance that has no new spend to stay grace-free.
    // Gated on workingBalanceEnteringCycle for BOTH balances, deliberately
    // — whether the account is "carrying debt" is a fact about the real
    // account, and statementBalanceEnteringCycle is a lagged, window-
    // delayed figure that can read as zero even when workingBalance shows
    // real debt was carried in (a spend can sit in workingBalance for a
    // cycle or more before its own window closes and it reaches
    // statementBalance at all). Gating statementBalance on its OWN
    // (falsely-zero) entering value granted grace it hadn't earned —
    // confirmed empirically: a statement-window card that carried real
    // debt into a cycle got its statementBalance's interest wrongly
    // skipped while workingBalance's correctly wasn't, so a same-day lump
    // payment sized to clear the true (interest-inflated) workingBalance
    // then fully zeroed the (interest-free) statementBalance too, and the
    // no-longer-owed difference was silently left stranded in
    // workingBalance forever after.
    // BUGFIX (2026-09-09, statement-window grace-timing) — once a window
    // is configured, `workingBalanceEnteringCycle` above is the wrong
    // gate (see `previousStatementCloseSnapshot`'s declaration comment):
    // it reflects the last calendar due date, not the close of the
    // window BEFORE this one. `previousStatementCloseSnapshot` is that
    // correctly-timed figure instead. No window configured falls back to
    // `workingBalanceEnteringCycle` exactly as before — byte-identical
    // for every card that doesn't set a window.
    const enteringGate = card.statementEndDay != null ? previousStatementCloseSnapshot : workingBalanceEnteringCycle
    if (enteringGate > NEGLIGIBLE_BALANCE) {
      workingBalance = applyMonthlyInterest(workingBalance, card.interestRatePercent)
      statementBalance = applyMonthlyInterest(statementBalance, card.interestRatePercent)
    } else {
      if (workingBalance <= NEGLIGIBLE_BALANCE) workingBalance = 0
      // Math.abs — see the BUGFIX comment on the lump-payment loop just
      // below for why a genuinely negative statementBalance must survive
      // this snap, not just a tiny positive one.
      if (Math.abs(statementBalance) <= NEGLIGIBLE_BALANCE) statementBalance = 0
    }
    // Apply any still-pending lump payments dated on/before this
    // payment date, in date order, BEFORE computing this month's
    // minimum — this is what makes a repayment logged ahead of the next
    // charge date actually count toward it. NOT window-gated (item e,
    // confirmed against real practice) — applies to both balances.
    while (lumpIndex < pendingLumpPayments.length && pendingLumpPayments[lumpIndex].date <= paymentDateIso) {
      workingBalance = round2(Math.max(0, workingBalance - pendingLumpPayments[lumpIndex].amount))
      // BUGFIX (2026-09-09, UAT-reported: clearing an early due date
      // wrongly zeroed a later, genuinely separate one) — deliberately
      // NOT clamped to 0 like `workingBalance` just above. A lump payment
      // sized off the true running balance (e.g. via
      // buildCreditCardDueOverviewRows' Clear button) can be MORE than
      // `statementBalance` currently reflects, because `statementBalance`
      // only picks up a purchase once its own window closes —
      // `workingBalance` already includes it the moment it's spent.
      // Clamping here would silently discard that difference; letting it
      // go negative instead means it nets cleanly to zero once the
      // delayed purchase's window finally closes and folds it in (see the
      // statement-side spend fold above), rather than that purchase
      // resurrecting a bogus "still owed" minimum charge once it arrives.
      statementBalance = round2(statementBalance - pendingLumpPayments[lumpIndex].amount)
      lumpIndex++
    }

    if (paymentDate >= rangeStart && paymentDate <= rangeEnd) {
      // Emitted for past dates within the range too: callers
      // (projection.ts, autoClear.ts) rely on getting them so they can
      // be materialized or deduped against what already exists.
      // A per-date override (credit card ledger modal — "tap a row to
      // adjust") takes precedence over the computed figure, but still
      // feeds into workingBalance below exactly like a computed one
      // would, so later periods' compounding reflects the edit rather
      // than silently reverting to the un-overridden trajectory next
      // month.
      const override = card.minimumPaymentOverrides?.find((o) => o.date === paymentDateIso)
      const computedMinimum = minimumPaymentForBalance(card.minimumPayment, statementBalance)
      // Deadlock guard: if paying this cycle's computed minimum wouldn't
      // leave EITHER balance any lower than it stood BEFORE this cycle's
      // interest was even applied, the payment isn't keeping pace with
      // interest — pay off the larger of the two remaining balances
      // instead of perpetuating a residue that just regrows every month.
      // Checking statementBalance alone isn't enough on a statement-
      // window card (see workingBalanceBeforeInterest's own comment
      // above) — the minimum is sized off statementBalance, but
      // workingBalance is the TRUE debt, and it can be deadlocked even
      // while statementBalance is still (very slowly) progressing. An
      // explicit override is left untouched (a deliberate figure, not
      // the computed one this guard exists to correct).
      // UAT 2026-09-08 (found while adding the grace-period feature,
      // running the full verify-*.ts suite for the first time in a while)
      // — this guard was firing for a genuine, real-world debt trap too:
      // a FIXED minimum (or a percent that's mathematically too small
      // for the rate, regardless of rounding) smaller than the interest
      // accruing is completely real credit-card behaviour — the balance
      // is SUPPOSED to grow, forever, exactly as the pre-existing
      // verify-ledger-phase2.ts debt-trap test expects. That's a
      // different thing entirely from every ORIGINAL bug report here
      // (Adam's 5%-of-balance-vs-20%-APR repros), where the minimum
      // percent mathematically EXCEEDS the monthly rate — it SHOULD
      // converge — and only fails to because of rounding at small-pence
      // scale. Distinguishing the two: only a percent_of_balance minimum
      // whose UNROUNDED theoretical amount would have exceeded this
      // cycle's own interest (i.e. rounding, not the policy itself, is
      // what erased the progress) counts as a deadlock to force-resolve.
      // A fixed minimum, or a percent genuinely smaller than the rate,
      // is left alone — the balance is allowed to grow/stay flat, same
      // as any real card.
      const percent = card.minimumPayment.type === 'percent_of_balance' ? card.minimumPayment.percent : null
      const roundingCouldExplainDeadlock =
        percent != null &&
        ((statementBalance * percent) / 100 > statementBalance - statementBalanceBeforeInterest ||
          (workingBalance * percent) / 100 > workingBalance - workingBalanceBeforeInterest)
      const deadlocked =
        !override &&
        computedMinimum > 0 &&
        roundingCouldExplainDeadlock &&
        (round2(statementBalance - computedMinimum) >= statementBalanceBeforeInterest || round2(workingBalance - computedMinimum) >= workingBalanceBeforeInterest)
      const amount = override ? override.amount : deadlocked ? Math.max(statementBalance, workingBalance) : computedMinimum
      onCycle?.({ dateIso: paymentDateIso, statementBalanceBeforePayment: statementBalance, workingBalanceBeforePayment: workingBalance })
      if (amount > 0) {
        results.push({
          date: paymentDateIso,
          amount,
          direction: 'out',
          // Deliberately the fixed builtin Credit Card category, NOT
          // card.categoryId — unlike a logged spend or lump payment
          // (which carry the card's own real, freely-assignable
          // category), the generated minimum-charge payment is always
          // hardcoded to Credit Card so it reads unambiguously as "this
          // card's minimum" in the category view, distinct from whatever
          // category the card itself has been given for its own icon.
          categoryId: CREDIT_CARD_CATEGORY_ID,
          paymentMethod: 'direct_debit',
          status: 'pending',
          type: 'credit_card_payment',
          // 2026-09-16 — a card's minimum payment can be paid from a Pot
          // (CreditCard.location). Absent = Personal, as before.
          location: card.location === 'pot' && card.potId ? 'pot' : 'personal',
          potId: card.location === 'pot' && card.potId ? card.potId : undefined,
          ownerId: card.ownerId,
          creditCardId: card.id,
          // The card's own name, with "Minimum Charge" appended — without
          // this suffix, a row would show only the card's name, which
          // reads identically to a logged lump payment against the same
          // card once both sit together in the Credit Card group.
          note: `${card.name} - Minimum Charge`,
        })
        workingBalance = round2(Math.max(0, workingBalance - amount))
        // Not clamped — same reasoning as the lump-payment loop above
        // (the deadlock guard's `Math.max(statementBalance, workingBalance)`
        // amount can exceed statementBalance on its own).
        statementBalance = round2(statementBalance - amount)
      }
    }
    // BUGFIX (2026-09-09, statement-window grace-timing) — captured HERE,
    // at the very end of the cycle's full processing (interest, lump
    // payments, AND the minimum charge just deducted above), not right
    // after interest posted. An earlier version captured this mid-cycle
    // and so couldn't see a lump payment or minimum charge made later in
    // the SAME cycle — which meant a genuine full payoff between a
    // window's close and its own due date still got charged interest the
    // cycle after, wrongly, since the snapshot looked frozen-in-debt.
    // `statementBalance` here is exactly "was the previous statement paid
    // off by its own due date," the real question the NEXT cycle's grace
    // gate needs answered.
    previousStatementCloseSnapshot = statementBalance
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }
  return results
}

/**
 * Logs a purchase charged to this card, right now. Does NOT touch the
 * personal ledger at all (per the confirmed design — see the long comment on TransactionType
 * in types/ledger.ts). status is 'cleared' unless the date is in the
 * future, matching the same date-based heuristic used for other ad-hoc
 * ledger entries.
 */
export function recordCreditCardSpend(
  card: CreditCard,
  amount: number,
  date: string,
  note?: string,
): { updatedCard: CreditCard; transaction: Omit<Transaction, 'id'> } {
  // The card is returned UNCHANGED — the transaction below is the whole
  // record of the spend, and cardBalanceAsOf picks it up from there.
  const updatedCard: CreditCard = card
  const transaction: Omit<Transaction, 'id'> = {
    date,
    amount,
    direction: 'out',
    categoryId: card.categoryId,
    paymentMethod: 'card',
    status: date <= toIso(new Date()) ? 'cleared' : 'pending',
    type: 'credit_card_spend',
    location: 'personal',
    ownerId: card.ownerId,
    creditCardId: card.id,
    note,
  }
  return { updatedCard, transaction }
}

/**
 * Logs an ad-hoc/lump payment toward this card — reduces currentBalance
 * immediately (clamped to zero) and produces the matching cash-out
 * transaction that DOES appear as a negative amount on the Personal
 * card, same as any other payment against the card.
 */
/**
 * Logs an ad-hoc/lump payment toward this card. Doesn't touch
 * currentBalance directly — the derived balance (cardBalanceAsOf) picks
 * the transaction up once it clears, immediately if the date is
 * today/past, or later via the automatic date-based clearing pass. Only
 * the LumpPayment log record itself is added right away, regardless of
 * date — that's just "you told the app about this payment," not a
 * balance effect.
 */
export function recordCreditCardLumpPayment(
  card: CreditCard,
  amount: number,
  date: string,
  note?: string,
): { updatedCard: CreditCard; transaction: Omit<Transaction, 'id'>; lumpPayment: CreditCardLumpPayment } {
  const lumpPayment: CreditCardLumpPayment = { id: nanoid(8), date, amount, note }
  const updatedCard: CreditCard = {
    ...card,
    lumpPayments: [...card.lumpPayments, lumpPayment],
  }
  const transaction: Omit<Transaction, 'id'> = {
    date,
    amount,
    direction: 'out',
    categoryId: card.categoryId,
    paymentMethod: 'bank_transfer',
    status: date <= toIso(new Date()) ? 'cleared' : 'pending',
    type: 'credit_card_payment',
    location: 'personal',
    ownerId: card.ownerId,
    creditCardId: card.id,
    sourceType: 'credit_card_lump_payment',
    sourceId: lumpPayment.id,
    note,
  }
  return { updatedCard, transaction, lumpPayment }
}

/**
 * How many months until this card would be paid off making only the
 * minimum payment plus an optional fixed extra amount every month — used
 * by the What-if page to compare "as things stand" against a hypothetical
 * lump sum or recurring overpayment, the credit-card equivalent of a
 * loan's buildLoanSchedule/summarizeLoan. Genuinely simulates month by
 * month (interest compounds, and a percent-of-balance minimum shrinks as
 * the balance does) rather than a closed-form estimate — same reasoning
 * as generateMinimumPaymentTransactions above. Capped at 600 months (50
 * years) as a safety net against a balance that never reaches zero (e.g.
 * a fixed minimum smaller than the interest accruing against it).
 */
export function simulateCardPayoffMonths(card: CreditCard, extraPerMonth = 0, maxMonths = 600): { months: number; totalInterestPaid: number } {
  let balance = card.currentBalance
  let totalInterestPaid = 0
  let months = 0

  while (balance > 0 && months < maxMonths) {
    const balanceAfterInterest = applyMonthlyInterest(balance, card.interestRatePercent)
    totalInterestPaid = round2(totalInterestPaid + round2(balanceAfterInterest - balance))
    const payment = Math.min(balanceAfterInterest, round2(minimumPaymentForBalance(card.minimumPayment, balanceAfterInterest) + extraPerMonth))
    // A payment of £0 (e.g. minimum payment rounds to nothing on a tiny
    // balance, and there's no extra) would loop forever — bail out rather
    // than spin to maxMonths for a balance that's genuinely never going to
    // clear under these terms.
    if (payment <= 0) break
    balance = round2(Math.max(0, balanceAfterInterest - payment))
    months++
  }

  return { months, totalInterestPaid }
}

/**
 * Picks the first SHARED_CARD_COLORS entry not currently held by any
 * credit card/pot/savings pot, so none of them ever repeat a colour as
 * far as the palette's own size allows.
 *
 * BUGFIX (2026-09-16, Adam-reported — a brand-new card landed on the
 * exact colour an existing, untouched Bills Pot already had). This used
 * to key off `data.creditCards.length + data.pots.length +
 * data.savingsPots.length` — the current LIVE count, not a stable,
 * ever-increasing counter. Deleting any card/pot/savings pot permanently
 * decrements that count, so a later-created entity could be re-assigned
 * an index a still-existing entity already held (e.g.: Bills Pot created
 * first at index 0; some other card created after it, then deleted;
 * the next new card's count falls back to a value that recomputes to
 * index 0 again — landing it on Bills Pot's own colour, even though
 * Bills Pot itself was never touched). Scanning actual colours-in-use
 * instead is immune to deletions entirely, at the small cost of no
 * longer being a pure function of count alone. Falls back to the old
 * round-robin-by-count behaviour only once every palette colour is
 * genuinely taken (more of these entities exist than the palette has
 * colours) — collisions at that point are unavoidable, not a bug.
 */
export function pickNextSharedCardColor(data: Pick<AppDataV2, 'creditCards' | 'pots' | 'savingsPots' | 'loans'>): string {
  // Loans joined this pool on 2026-09-18 when they gained their own hero
  // card (PROMPT-08a Part C). They must be in BOTH the used-colour scan and
  // the fallback count, or a new card could be handed a colour a loan card
  // is already showing — the same class of collision the 2026-09-16 bugfix
  // above was written for.
  const usedColors = new Set([
    ...data.creditCards.map((c) => c.color),
    ...data.pots.map((p) => p.color),
    ...data.savingsPots.map((p) => p.color),
    ...(data.loans ?? []).map((l) => l.color).filter((c): c is string => !!c),
  ])
  const firstUnused = SHARED_CARD_COLORS.find((color) => !usedColors.has(color))
  if (firstUnused) return firstUnused
  const existingCount = data.creditCards.length + data.pots.length + data.savingsPots.length + (data.loans?.length ?? 0)
  return SHARED_CARD_COLORS[existingCount % SHARED_CARD_COLORS.length]
}

// ── Trends feature (2026-09-15 build; date-source fixed 2026-09-16) ─────
const CC_THREE_CYCLES_AHEAD = 3

function isCardSpend(cardId: string) {
  return (t: Transaction) => t.type === 'credit_card_spend' && t.creditCardId === cardId
}

/**
 * Builds the Credit Card's Balance/Spend trend series. Balance = the
 * card's own OUTSTANDING/owed balance over the period (Adam-confirmed
 * clarification), NOT a cash balance — sampled directly via
 * cardBalanceAsOf per day rather than folded incrementally the way a cash
 * ledger's balance is, since cardBalanceAsOf already correctly replays
 * interest/statement-window mechanics and a naive incremental sum would
 * have to reimplement all of that separately (and could drift from it).
 * cardBalanceAsOf doesn't distinguish cleared vs pending by status, only
 * by date, so there's no genuine "cleared vs projected" split to make the
 * way a cash ledger has — both DailyBalancePoint fields carry the same
 * value so the shared chart component doesn't need a credit-card special
 * case. Spend = credit_card_spend charged to this card in the period.
 *
 * JUDGMENT CALL (flagged per the prompt doc's own instruction to decide
 * and document, not leave ambiguous): the dotted forecast continuation on
 * this card's Spend view does NOT layer in averageSpendForecast.ts's
 * dailyAvg rate — that lib's SpendScope is defined for personal/joint ad-
 * hoc expense only (see its own file header), and extending it to a new
 * scope wasn't part of what Adam confirmed. The Balance view's dotted
 * portion still reads correctly as "projected" via generated future
 * minimum-charge transactions (see above); the Spend view's dotted
 * portion is a flat continuation from the last actual cumulative spend
 * figure (no further growth assumed) rather than a fabricated rate.
 */
export function buildCreditCardTrendSeries(data: AppDataV2, card: CreditCard, granularity: BalanceSpendGranularity, asOfDate: Date = new Date()): BalanceSpendTrendSeries {
  const aheadCount = granularity === 'this_cycle' ? 0 : CC_THREE_CYCLES_AHEAD
  // 2026-09-16 (Adam-reported): this used to walk the household's pay
  // cycle (creditCardHorizonCycles/creditCardPreviousCycles, since
  // removed) — the exact mismatch creditCardCyclePeriods already exists
  // to prevent for CreditCardDetail's own ledger. Now sourced from the
  // SAME statement/due-date periods the ledger itself uses, so "This
  // Cycle"/"Next 3 Cycles" here line up with what the card page shows.
  const periods = creditCardCyclePeriods(card, asOfDate, aheadCount + 1)
  const periodStart = periods[0].windowStart
  const periodEnd = periods[periods.length - 1].windowEnd
  const days = daysBetweenInclusive(periodStart, periodEnd)
  const todayIso = toIso(asOfDate)

  const generatedMinimums = generateMinimumPaymentTransactions(card, periodStart, periodEnd, data.transactions)
  const existingMinDates = new Set(data.transactions.filter((t) => t.type === 'credit_card_payment' && t.creditCardId === card.id).map((t) => t.date))
  const dedupedGenerated = generatedMinimums.filter((t) => !existingMinDates.has(t.date)).map((t, i) => ({ ...t, id: `generated:cc-trend:${i}` }))
  const activity = [...data.transactions, ...dedupedGenerated]

  const balance: DailyBalancePoint[] = days.map((date) => {
    const owed = cardBalanceAsOf(card, activity, parseLocalDate(date))
    return { date, clearedBalance: owed, projectedBalance: owed }
  })
  const spend = buildDailySpendSeries(activity, days, isCardSpend(card.id))

  const cyclesBack = aheadCount === 0 ? 1 : CC_THREE_CYCLES_AHEAD + 1
  const prevPeriodsAsc = [...creditCardPreviousCyclePeriods(card, asOfDate, cyclesBack)].reverse()
  const prevDays = daysBetweenInclusive(prevPeriodsAsc[0].windowStart, prevPeriodsAsc[prevPeriodsAsc.length - 1].windowEnd)
  const previousPeriodSpend = buildDailySpendSeries(data.transactions, prevDays, isCardSpend(card.id))

  return { granularity, days, todayIso, balance, spend, previousPeriodSpend }
}

/** Total paid to date against this card — the "paid" half of the card page's pie chart (doc addendum). Sums credit_card_payment transactions for this card from the full transaction list, since payments aren't tracked as a running total on the CreditCard itself. */
/**
 * Total ACTUALLY paid to date against this card — the "paid" half of the
 * card page's pie chart. Scoped BY DATE (on or before today), not by
 * `status`: a payment dated today is treated as done, per the confirmed
 * rule that same-day payments have completed. This is the identical test
 * cardBalanceAsOf uses to decide what counts, which is what keeps the two
 * halves of the pie consistent with each other — when they disagreed
 * (paid rising while outstanding didn't fall) the chart read as
 * half-updated, which is precisely how the bug was reported.
 */
export function totalPaidForCard(cardId: string, transactions: Transaction[], asOfDate: Date = new Date()): number {
  const todayIso = toIso(asOfDate)
  return round2(
    transactions
      .filter((t) => t.type === 'credit_card_payment' && t.creditCardId === cardId && t.date <= todayIso)
      .reduce((sum, t) => sum + t.amount, 0),
  )
}

export interface CreditCardMinimumChargeRow {
  date: string
  amount: number
  status: 'cleared' | 'pending'
  // Whether this row already exists as a real, stored Transaction — an
  // edit to a materialized row updates that transaction directly; an
  // edit to a non-materialized (still just generated/projected) row
  // writes to card.minimumPaymentOverrides instead. Both cases are
  // handled transparently by LedgerContext's updateCreditCardMinimumCharge
  // — this flag exists purely so the UI can show a subtle "already
  // happened" vs "projected" distinction if it wants to, not because the
  // edit flow itself needs the caller to know which path it'll take.
  materialized: boolean
  // BUGFIX (2026-09-09, "assume the minimum gets paid" projection,
  // Adam-requested) — the TRUE balance owed as of this due date. For a
  // materialized row this is just cardBalanceAsOf (real activity always
  // wins, unconditionally). For a projected row, cardBalanceAsOf would be
  // wrong here: it replays ONLY real, logged activity, so any due date
  // beyond the next one silently assumes NOTHING gets paid at all between
  // now and then — overstating both the balance and the interest that
  // compounds on it, since in reality the contractual minimum is paid
  // every cycle whether or not Adam has logged it (same principle
  // `simulateCardPayoffMonths`, the What-if page's own projection,
  // already uses). Sourced from `generateMinimumPaymentTransactions`'s own
  // `onCycle` hook — the exact figure ITS simulation already treats as
  // "the true running balance right before this cycle's own minimum gets
  // deducted," so this can never disagree with the schedule the rows
  // above were generated from. This is what buildCreditCardBalanceDueRows/
  // buildCreditCardDueOverviewRows (the Borrowing page's "Payment due"
  // section, and its Clear button's own payoff amount) use — never
  // cardBalanceAsOf directly for a projected row.
  projectedBalanceDue: number
}

/**
 * Every minimum-charge row for this card's ledger modal (Loans.tsx) —
 * deliberately ONLY minimum charges, never spend or lump payments, which
 * already have a full ledger on the card's own Home page detail view.
 * Combines real stored transactions (materialized: true) with generated
 * projections for anything not yet materialized, de-duplicated by date —
 * a stored transaction always wins over a generated one for the same
 * date, since it's the authoritative real record.
 */
export function buildCreditCardMinimumChargeRows(card: CreditCard, transactions: Transaction[], asOfDate: Date = new Date()): CreditCardMinimumChargeRow[] {
  const todayIso = toIso(asOfDate)
  const stored = transactions.filter((t) => t.creditCardId === card.id && t.type === 'credit_card_payment' && !t.sourceType)
  const storedDates = new Set(stored.map((t) => t.date))
  // Total stored (non-sourceType) payment on each date — added back below so
  // a materialized row reports the balance owed GOING INTO its due date,
  // the same convention generated rows use. See the BUGFIX note there.
  const storedPaymentsOnDate = new Map<string, number>()
  for (const t of stored) storedPaymentsOnDate.set(t.date, round2((storedPaymentsOnDate.get(t.date) ?? 0) + t.amount))

  // Confirmed as a real bug: a blind "1 year back" was generating a full
  // year of entirely fictional past minimum charges for a BRAND NEW
  // card with no real payment history at all — nothing to show, since
  // the card didn't exist that far back, but the modal generated rows
  // for it anyway, burying "today onward" a year of scrolling deep.
  // CreditCard has no real "created"/start date to anchor to, so the
  // honest fix is: only look as far back as there's real DATA to
  // justify it. A card with genuine stored history shows back to its
  // own earliest real transaction (so anything actually there stays
  // editable) — a fresh card with none shows nothing before today at
  // all, rather than a year of rows that never happened.
  const earliestStoredMs = stored.length > 0 ? Math.min(...stored.map((t) => parseLocalDate(t.date).getTime())) : asOfDate.getTime()
  const naiveRangeStart = new Date(Math.min(earliestStoredMs, asOfDate.getTime()))
  // BUGFIX (2026-09-16, PROMPT-01 Part A — mechanism 6, Adam-reported: his
  // mum's Santander showed a past payment row and nothing else, stranding
  // the £91.24 she genuinely still owed with no future due row to see or
  // clear it; her Natwest lost exactly one £200 instalment the same way).
  //
  // ROOT CAUSE. `generateMinimumPaymentTransactions` opens its simulation
  // from `cardBalanceAsOf(card, transactions, rangeStart)`, whose own
  // filter is `t.date <= asOfIso` — INCLUSIVE. So a real payment dated
  // exactly ON rangeStart is already deducted in the opening figure. The
  // generator's cycle loop then starts at the 1st of rangeStart's month
  // and emits a charge for every payment date passing
  // `paymentDate >= rangeStart` (line ~709) — INCLUSIVE too — so the cycle
  // whose due date IS rangeStart gets charged a second time for the very
  // payment already folded into its opening balance.
  //
  // WHY `storedDates` DOES NOT ALREADY PROTECT THIS (the subtle part — an
  // earlier analysis assumed it did, and a fix built on that assumption
  // would double-correct). The `.filter((t) => !storedDates.has(t.date))`
  // below discards the duplicate ROW, so nothing visibly wrong appears at
  // that date. But it runs AFTER the generator has returned — by which
  // point the duplicate deduction has already been applied to the
  // simulation's internal running balance, which every LATER cycle is
  // computed from. storedDates filters the display row, never the
  // deduction. On a 100%-minimum card `workingBalance` is clamped
  // (`Math.max(0, …)`), so the whole residual is swallowed and no further
  // row is ever generated; on a fixed-minimum card it silently loses
  // exactly one instalment. Same bug, two presentations.
  //
  // WHY A STATEMENT WINDOW MASKED IT. With a window, `statementBalance`
  // opens from the last close instead and is deliberately NOT clamped, so
  // the doubled payment sits as a legitimate negative (an overpayment
  // credit) and nets cleanly back to zero when the delayed spend's own
  // window closes a cycle later. Verified: window 19->18 opens the 14 Sept
  // cycle at -£100 and recovers £50 correctly at 14 Oct. That cell was
  // therefore never "protected" by different logic — it just cancels out,
  // which is why only no-window cards (both of his mum's) showed it.
  //
  // THE FIX. Start the simulation the day AFTER a payment that is already
  // inside the opening balance, restoring this function's own documented
  // contract: "everything BEFORE rangeStart is inside the starting figure,
  // everything from rangeStart onward is simulated forward exactly once."
  // Chosen over "skip any cycle in storedDates" (the generator has no
  // access to that set, and skipping a whole cycle would also skip its
  // interest posting) and over "exclude payments dated on rangeStart from
  // the opening balance" (which breaks the same contract from the other
  // side, and double-counts whenever that cycle is NOT re-simulated).
  //
  // This also makes this function agree with `buildCreditCardCycleSections`,
  // which was already correct for these cards purely because its
  // `cycles[0].windowStart` happens to fall the day after the payment —
  // the two paths now derive the same kind of rangeStart rather than
  // disagreeing about the same card on the same data.
  //
  // Guarded on a real stored payment existing at that exact date, NOT on
  // "rangeStart is a payment day": a fresh card with no stored history
  // passes rangeStart = asOfDate, and if that happens to be its payment
  // day its genuine charge must still be generated.
  //
  // Compared as ISO strings via toIso, never Date maths or toISOString —
  // in BST a local-midnight Date serialises to the PREVIOUS day, which is
  // exactly the class of seasonal bug documented in APP-KNOWLEDGE.md §2
  // (and is why this defect hid behind an accidental one-hour offset
  // until fc7a498/9d41891b; it would have surfaced unaided at the
  // 25 October GMT changeover).
  const rangeStart = storedDates.has(toIso(naiveRangeStart))
    ? new Date(naiveRangeStart.getFullYear(), naiveRangeStart.getMonth(), naiveRangeStart.getDate() + 1)
    : naiveRangeStart
  const rangeEnd = new Date(asOfDate.getFullYear() + 2, asOfDate.getMonth(), 1)
  // `transactions` MUST be passed through. Omitted, the generator falls
  // back to its default empty list, so its opening balance becomes
  // cardBalanceAsOf(card, [], rangeStart) — which with nothing to replay
  // is just the raw anchor. Reproduced: a Santander card anchored at £0
  // with £228.07 of real spend after the anchor produced NO rows at all
  // (100% of £0 fails the generator's amount > 0 guard), so the modal
  // showed an empty future for a card that genuinely owed £228.07. Any
  // figure that did appear was a manual minimumPaymentOverride being
  // echoed back, never something the modal had computed.
  //
  // BUGFIX (2026-09-09, "assume the minimum gets paid" projection) —
  // `onCycle` captures `workingBalanceBeforePayment` for every simulated
  // due date (whether or not a row ends up generated for it) — the true
  // running balance the generator's OWN simulation used right before that
  // cycle's own minimum was deducted from it. This is the "assume every
  // prior cycle's minimum got paid" figure Adam asked for, and reusing
  // this function's own internal simulation (rather than re-deriving it
  // separately) is what guarantees it can never disagree with the
  // schedule these rows themselves came from.
  const workingBalanceByDate = new Map<string, number>()
  const generated = generateMinimumPaymentTransactions(card, rangeStart, rangeEnd, transactions, ({ dateIso, workingBalanceBeforePayment }) =>
    workingBalanceByDate.set(dateIso, workingBalanceBeforePayment),
  ).filter((t) => !storedDates.has(t.date))

  const rows: CreditCardMinimumChargeRow[] = [
    // BUGFIX (2026-09-16, Adam-reported from the test-app UAT: his mum's
    // Natwest showed "£1,400 balance due" against BOTH 14 Sept and 14 Oct,
    // reading as a duplicated row).
    //
    // `projectedBalanceDue` means "the balance owed as of this due date",
    // and a GENERATED row reports it as `workingBalanceBeforePayment` — the
    // running balance as it stood immediately BEFORE that cycle's own charge
    // was deducted. A materialized row was reporting
    // `cardBalanceAsOf(t.date)`, which (filtering `t.date <= asOfIso`)
    // already has that date's payment deducted — i.e. the balance AFTER.
    //
    // Two conventions in one list. Natwest: 14 Sept showed £1400 ("left
    // after paying £200 off £1600") while 14 Oct showed £1400 ("owed before
    // paying"), the same figure meaning two different things, with the real
    // £1600 owed on 14 Sept appearing nowhere. Santander showed £91.24
    // twice, hiding the £319.31 genuinely owed before her payment.
    //
    // Adding that date's own stored payments back puts every row on the
    // generated rows' convention: what was owed GOING INTO this due date.
    // Natwest now reads 1600 → 1400 → 1200 → …, a clean monotonic schedule.
    //
    // Only non-`sourceType` payments are added back — exactly the set
    // `stored` itself is built from — so the arithmetic stays consistent
    // with the rows actually being rendered.
    //
    // Deliberately does NOT affect the Clear button: it sizes its payoff
    // from UPCOMING rows only (`isPast === false` in
    // buildCreditCardDueOverviewRows), and those are generated rows, whose
    // figure is unchanged.
    ...stored.map((t) => ({
      date: t.date,
      amount: t.amount,
      status: t.status,
      materialized: true,
      projectedBalanceDue: round2(cardBalanceAsOf(card, transactions, parseLocalDate(t.date)) + storedPaymentsOnDate.get(t.date)!),
    })),
    ...generated.map((t) => ({
      date: t.date,
      amount: t.amount,
      status: t.date <= todayIso ? ('cleared' as const) : ('pending' as const),
      materialized: false,
      projectedBalanceDue: workingBalanceByDate.get(t.date) ?? cardBalanceAsOf(card, transactions, parseLocalDate(t.date)),
    })),
  ]
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * PROMPT-01 A1 (2026-09-16, Adam-specified) — the statement window to OFFER
 * a card that has none. Adam: "Prompt the user, but default to
 * paymentDayOfMonth."
 *
 * The window closes ON the payment day and the next one opens the day
 * after, so a card paying on the 14th is offered "opens 15th, closes 14th":
 * a full month of spend, ending on the day it is paid for. Wrapped at 31.
 *
 * WHY THIS IS NOW A FREE CHOICE. An earlier analysis proposed
 * `paymentDayOfMonth + 1` because a window closing on or before the payment
 * day left a residual balance stranded. That was measuring the Part A
 * double-count, not statement mechanics: the cleared cycle was being
 * re-simulated, and only a window closing after the payment date pushed the
 * spend clear of the damage. With the root cause fixed, all 28 possible
 * closing days reconcile correctly (swept against the real backup,
 * 2026-09-16), so the default is free to be the one that is simplest to
 * explain rather than the one that dodged a bug.
 *
 * OFFERED, NEVER APPLIED SILENTLY. Adding a window to an existing card
 * retroactively moves still-PENDING spend between cycles — for Adam's mum
 * that is the desired outcome, but it must be her own explicit action.
 * Already-cleared rows never move (APP-KNOWLEDGE.md §1.1).
 */
export function defaultStatementWindowForPaymentDay(paymentDayOfMonth: number): { statementStartDay: number; statementEndDay: number } {
  const endDay = Math.max(1, Math.min(31, Math.round(paymentDayOfMonth)))
  return { statementStartDay: endDay === 31 ? 1 : endDay + 1, statementEndDay: endDay }
}

/**
 * PROMPT-01 Part C (2026-09-16, Adam-specified) — does this card's minimum
 * payment, by its own definition, always clear the whole balance?
 *
 * True only for a percent-of-balance minimum at 100% or more: whatever is
 * owed on a due date, the minimum charge for that date IS all of it, so the
 * balance always goes to zero on its own and there is nothing left for a
 * user to clear manually. Adam, 2026-09-15: the row is untappable and reads
 * "Set to Clear" — offering a Clear button there would be a no-op, and
 * offering a manual override would invite her to set a figure the engine
 * immediately supersedes.
 *
 * Deliberately NOT "the minimum happens to cover the balance this month"
 * (Adam's explicit choice, 2026-09-16). A FIXED £200 minimum against a
 * £150 balance also clears it, but that is a transient fact about one
 * cycle, not a property of the card — its Clear button and Balance due
 * rows must keep behaving exactly as they do today, which is what his
 * mum's Natwest depends on. This predicate is a statement about the card's
 * CONFIGURATION, which is why it takes no balance and no date.
 */
export function creditCardMinimumClearsFullBalance(card: CreditCard): boolean {
  return card.minimumPayment.type === 'percent_of_balance' && card.minimumPayment.percent >= 100
}

export interface CreditCardBalanceDueRow {
  date: string
  /** The full balance owed as of this date — not just that date's own
   * minimum payment. */
  balanceDue: number
}

/**
 * UAT 2026-09-08 (8-bug9.2-minimum-charges-stop, Adam's own spec, 2nd
 * design pass) — a SEPARATE row from the minimum-charge one above, shown
 * first for the same date in the ledger modal: "I see two rows per
 * payment date, first being any due balance... second row is the minimum
 * charge for the same date." Only for still-UPCOMING payment dates (a
 * past one already happened, nothing left to pre-empt) where the real
 * balance is meaningfully more than that date's own minimum — otherwise
 * there's nothing worth offering an early payoff for. Clearing this row
 * (a lump payment dated on/before this date, for at least this amount)
 * naturally zeroes that date's own minimum AND every later one too, via
 * generateMinimumPaymentTransactions's own existing lump-payment-before-
 * minimum-computation ordering — no separate "future charges" mechanism
 * needed, paying the real balance down to (near) zero is what makes every
 * later minimum compute to zero on its own.
 */
export function buildCreditCardBalanceDueRows(card: CreditCard, transactions: Transaction[], asOfDate: Date = new Date()): CreditCardBalanceDueRow[] {
  const minimumRows = buildCreditCardMinimumChargeRows(card, transactions, asOfDate)
  return minimumRows
    .filter((r) => r.status === 'pending')
    .map((r) => ({ date: r.date, balanceDue: r.projectedBalanceDue, minimum: r.amount }))
    .filter((r) => r.balanceDue > r.minimum + 0.01)
    .map((r) => ({ date: r.date, balanceDue: r.balanceDue }))
}

export interface CreditCardDueOverviewRow {
  date: string
  balanceDue: number
  /** Whether this date has already happened — a past row is informational only (no Clear action), an upcoming one can be pre-paid via onClearBalance. */
  isPast: boolean
}

/**
 * 2026-09-09 session (Adam-specified) — feeds the Borrowing page's own
 * "most recent + next 3 (or 4 if none recent) payment due dates" section
 * on the expanded credit card, mirroring the Salary page's PayPeriodsSection
 * styling. Deliberately UNFILTERED by "meaningfully more than minimum"
 * (unlike buildCreditCardBalanceDueRows above, which only surfaces dates
 * worth an early payoff nudge) — this is a plain schedule overview, every
 * due date gets its own row with the balance owed as of that date, same
 * as the info modal now shows for minimum charges alone.
 *
 * BUGFIX (2026-09-09, "assume the minimum gets paid" projection) — used
 * to read `cardBalanceAsOf` directly here, which overstated every row
 * beyond the very next one (see `CreditCardMinimumChargeRow.projectedBalanceDue`'s
 * own comment). Reads `projectedBalanceDue` instead — real activity for a
 * materialized (already-happened) row, the assumed-minimum-paid
 * projection for anything still upcoming. This is also what sizes the
 * Clear button's own payoff transaction for an upcoming row, so clearing
 * it genuinely zeroes the card rather than leaving an interest-inflated
 * residual behind.
 */
export function buildCreditCardDueOverviewRows(card: CreditCard, transactions: Transaction[], asOfDate: Date = new Date()): CreditCardDueOverviewRow[] {
  const rows = buildCreditCardMinimumChargeRows(card, transactions, asOfDate)
  return rows.map((r) => ({ date: r.date, balanceDue: r.projectedBalanceDue, isPast: r.status === 'cleared' }))
}

/** Convenience wrapper over withLiveBalance for a whole list — the shape almost every read site actually wants. Same rule applies: display/compute only, never persisted. */
export function withLiveBalances(cards: CreditCard[], transactions: Transaction[], asOfDate: Date = new Date()): CreditCard[] {
  return cards.map((card) => withLiveBalance(card, transactions, asOfDate))
}

/** This card's own paymentDayOfMonth due date falling in the given calendar month, clamped to the month's real length (short months, Feb) — same clamp generateMinimumPaymentTransactions/billingDatesBetween already use. */
function creditCardDueDateForMonth(card: CreditCard, monthCursor: Date): Date {
  const daysInMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0).getDate()
  return new Date(monthCursor.getFullYear(), monthCursor.getMonth(), Math.min(card.paymentDayOfMonth, daysInMonth))
}

/**
 * UAT 2026-09-08 (Summary page cycle-end totals, Adam-requested) — a
 * credit card's own accounting periods: bounded by consecutive PAYMENT
 * dates (paymentDayOfMonth), never the household's own pay-cycle bounds
 * — a card's due date is its own fixed, independent schedule, unrelated
 * to when anyone gets paid.
 *
 * Each period carries `dueDate` (when the payment/minimum actually posts
 * — what "the balance due for this period" means) separately from
 * `windowStart`/`windowEnd` (which real spend counts toward THIS
 * period). When `statementEndDay` is set, `windowEnd` is that period's
 * own statement close — via the exact same `statementCloseDateForPaymentDate`
 * mapping `generateMinimumPaymentTransactions` already uses for minimum-
 * charge sizing — which can land WEEKS before `dueDate` (e.g. a window
 * closing the 18th, due the 14th of the month after next); spend dated
 * in that gap belongs to the FOLLOWING period's window, not this one, so
 * `windowEnd` (not `dueDate`) is the real spend-bucketing bound. A card
 * with no statement window configured falls back to `windowEnd ===
 * dueDate` (spend up to and including the due date itself counts),
 * matching the same "no window" fallback used elsewhere.
 *
 * `count` is the caller's own concern (e.g. 1 for "this cycle", or
 * `1 + THREE_CYCLES_AHEAD` for "next 3 cycles", matching
 * projection.ts's horizonCycles convention of current-cycle-first) —
 * kept as a plain number rather than importing ProjectionHorizon/
 * THREE_CYCLES_AHEAD from projection.ts, which itself imports FROM this
 * file (generateMinimumPaymentTransactions) and would create a cycle.
 */
/** Shared by `creditCardCyclePeriods`/`creditCardPreviousCyclePeriods` — one due date in, its full period (window bounds + the due date itself) out. Factored out so the 2026-09-16 backward-walking variant (for the Trends chart's previous-period comparison) can't drift from this forward-walking one's own window math. */
function creditCardPeriodForDueDate(card: CreditCard, due: Date): { windowStart: Date; windowEnd: Date; dueDate: Date } {
  const prevMonthCursor = new Date(due.getFullYear(), due.getMonth() - 1, 1)
  const prevDue = creditCardDueDateForMonth(card, prevMonthCursor)
  const windowEnd = card.statementEndDay != null ? statementCloseDateForPaymentDate(card, due) : due
  const windowStart = card.statementEndDay != null ? addDays(statementCloseDateForPaymentDate(card, prevDue), 1) : addDays(prevDue, 1)
  return { windowStart, windowEnd, dueDate: due }
}

export function creditCardCyclePeriods(card: CreditCard, asOfDate: Date, count: number): { windowStart: Date; windowEnd: Date; dueDate: Date }[] {
  const asOfIso = toIso(asOfDate)

  // The "current" period is the one whose OWN due date hasn't happened
  // yet (today counts as not-yet-happened, same "due today is still
  // this period" convention the rest of the app uses).
  let cursor = new Date(asOfDate.getFullYear(), asOfDate.getMonth(), 1)
  let dueDate = creditCardDueDateForMonth(card, cursor)
  while (toIso(dueDate) < asOfIso) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    dueDate = creditCardDueDateForMonth(card, cursor)
  }

  const dueDates: Date[] = [dueDate]
  for (let i = 1; i < count; i++) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    dueDates.push(creditCardDueDateForMonth(card, cursor))
  }

  return dueDates.map((due) => creditCardPeriodForDueDate(card, due))
}

/**
 * 2026-09-16 (Adam-reported — the Trends chart used the household's pay
 * cycle instead of this card's own statement/due-date periods, the exact
 * same bug `creditCardCyclePeriods` was built to prevent for the ledger
 * itself). The backward-walking counterpart to `creditCardCyclePeriods` —
 * `n` periods immediately BEFORE the current one, most-recent-first (same
 * convention `creditCardPreviousCycles`/`previousCycles` already use for
 * the pay-cycle case), for the Spend view's previous-period comparison
 * line.
 */
export function creditCardPreviousCyclePeriods(card: CreditCard, asOfDate: Date, n: number): { windowStart: Date; windowEnd: Date; dueDate: Date }[] {
  const [current] = creditCardCyclePeriods(card, asOfDate, 1)
  const periods: { windowStart: Date; windowEnd: Date; dueDate: Date }[] = []
  let cursor = new Date(current.dueDate.getFullYear(), current.dueDate.getMonth(), 1)
  for (let i = 0; i < n; i++) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1)
    periods.push(creditCardPeriodForDueDate(card, creditCardDueDateForMonth(card, cursor)))
  }
  return periods
}

export interface CreditCardCycleSection {
  windowStart: Date
  windowEnd: Date
  dueDate: Date
  /** Real spend/payments whose date falls in (windowStart, windowEnd], plus
   * this period's own minimum-charge/interest row (dated exactly on
   * dueDate) if one applies — real transactions where they already
   * exist, generated/projected ones otherwise, exactly like
   * buildCreditCardMinimumChargeRows' own materialized-wins rule. */
  rows: { date: string; type: 'credit_card_spend' | 'credit_card_payment'; amount: number; status: 'cleared' | 'pending'; note?: string; sourceType?: string }[]
  /** The real balance owed as of dueDate — "the balance due for this
   * period" — via cardBalanceAsOf, not a manual fold of `rows` (interest
   * itself has no row of its own to fold, so summing rows would silently
   * omit it). */
  closingBalance: number
}

/**
 * UAT 2026-09-08 (Summary page cycle-end totals, Adam-requested) — one
 * section per credit-card cycle period, each with its own spend/payment
 * rows and its own closing (due) balance — the credit-card equivalent of
 * projection.ts's horizonCycles + Home.tsx's CycleGroupedList, but using
 * this card's own periods (see creditCardCyclePeriods) instead of the
 * household pay cycle, and a real cardBalanceAsOf query for each
 * period's closing figure instead of a running-balance fold (which
 * would miss interest, since interest has no transaction row of its
 * own). "We also need to make sure minimum charges appear in this same
 * ledger" — a period's own not-yet-materialized minimum charge is
 * generated here exactly like the info modal's ledger does, so an
 * upcoming due date's charge is visible before autoClear ever
 * materializes it into a real Transaction.
 */
export function buildCreditCardCycleSections(card: CreditCard, transactions: Transaction[], cycles: { windowStart: Date; windowEnd: Date; dueDate: Date }[]): CreditCardCycleSection[] {
  if (cycles.length === 0) return []
  const rangeStart = cycles[0].windowStart
  const rangeEnd = cycles[cycles.length - 1].dueDate

  const cardTransactions = transactions.filter((t) => t.creditCardId === card.id && (t.type === 'credit_card_spend' || t.type === 'credit_card_payment'))
  // Same materialized-wins dedupe rule as buildCreditCardMinimumChargeRows:
  // a stored (real, not-lump-payment) credit_card_payment on a given date
  // IS that date's minimum charge already actually happening — the
  // generator's own projection for that same date would just restate it.
  const storedMinimumDates = new Set(cardTransactions.filter((t) => t.type === 'credit_card_payment' && !t.sourceType).map((t) => t.date))
  // UAT 2026-09-08 — the `onCycle` hook captures the real STATEMENT
  // balance the simulation computed for each due date, regardless of
  // whether a charge ended up generated for it (a cycle with nothing due
  // pushes no row at all) — "the balance due for this period" a real
  // statement would show, which is what closingBalance below uses,
  // rather than cardBalanceAsOf's true-running-balance figure (which
  // would incorrectly include spend that hasn't reached this period's
  // own statement yet — see the type's own comment on windowEnd vs
  // dueDate for why that gap is real).
  const statementBalanceByDate = new Map<string, number>()
  const generatedMinimums = generateMinimumPaymentTransactions(card, rangeStart, rangeEnd, transactions, ({ dateIso, statementBalanceBeforePayment }) =>
    statementBalanceByDate.set(dateIso, statementBalanceBeforePayment),
  ).filter((t) => !storedMinimumDates.has(t.date))
  const todayIso = toIso(new Date())
  const allRows = [
    ...cardTransactions.map((t) => ({ date: t.date, type: t.type as 'credit_card_spend' | 'credit_card_payment', amount: t.amount, status: t.status, note: t.note, sourceType: t.sourceType })),
    ...generatedMinimums.map((t) => ({ date: t.date, type: t.type as 'credit_card_spend' | 'credit_card_payment', amount: t.amount, status: (t.date <= todayIso ? 'cleared' : 'pending') as 'cleared' | 'pending', note: t.note, sourceType: t.sourceType })),
  ]
  // For cardBalanceAsOf, which needs real Transaction-shaped objects with
  // an id — the generated rows above have none, since they're pure
  // projections.
  const allAsTransactions: Transaction[] = [
    ...cardTransactions,
    ...generatedMinimums.map((t, i) => ({ ...t, id: `projected-${i}` })),
  ]

  return cycles.map((cycle, cycleIndex) => {
    const windowStartIso = toIso(cycle.windowStart)
    const windowEndIso = toIso(cycle.windowEnd)
    const dueDateIso = toIso(cycle.dueDate)
    // BUGFIX (2026-09-09, UAT-reported) — a lump payment dated between a
    // window's close and its own due date (routine on a statement-window
    // card — see windowEnd vs dueDate's own comment) was falling into
    // the FOLLOWING cycle's section instead of the one it actually
    // clears, since the general filter below bounds by windowStart/
    // windowEnd (a spend-attribution concept a payment has no part of —
    // payments are never window-gated, they apply immediately). A
    // payment is grouped by which due-date cycle it's paying toward
    // instead: everything after the PREVIOUS cycle's own due date, up to
    // and including THIS cycle's — so a payment dated exactly on a due
    // date lands in that same cycle's section, next to the balance it
    // just cleared, not the next one.
    const prevDueDateIso = cycleIndex > 0 ? toIso(cycles[cycleIndex - 1].dueDate) : null
    const rows = allRows
      .filter((r) => {
        // A minimum-charge row is EXPLICITLY dated on a due date by
        // construction — it must anchor to THAT due date's own section
        // exclusively. Without this, a due date numerically sitting
        // inside the FOLLOWING cycle's own spend window (a real
        // possibility — see the type's own comment on why windowEnd,
        // not dueDate, bounds spend) would wrongly pull it into that
        // later section too, double-counting the same charge.
        const isMinimumChargeRow = r.type === 'credit_card_payment' && !r.sourceType
        if (isMinimumChargeRow) return r.date === dueDateIso
        if (r.type === 'credit_card_payment') return (prevDueDateIso == null || r.date > prevDueDateIso) && r.date <= dueDateIso
        return r.date >= windowStartIso && r.date <= windowEndIso
      })
      .sort((a, b) => a.date.localeCompare(b.date))
    // Fallback only for a due date genuinely outside the simulated range
    // (shouldn't happen — rangeEnd is always the last cycle's own
    // dueDate — but cardBalanceAsOf is a safe, real answer either way).
    const closingBalance = statementBalanceByDate.get(dueDateIso) ?? cardBalanceAsOf(card, allAsTransactions, cycle.dueDate)
    return { ...cycle, rows, closingBalance }
  })
}

// ── Payment day change from a chosen payment (2026-09-16) — see lib/scheduleChange.ts ──

function cardPaymentDates(day: number, start: Date, end: Date): string[] {
  const out: string[] = []
  for (let cursor = new Date(start.getFullYear(), start.getMonth(), 1); cursor <= end; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) {
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
    out.push(toIso(new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(day, daysInMonth))))
  }
  return out
}

/** The "which payment" picker for a card: its most recent payment date and the next 3. */
export function recentAndUpcomingCardPaymentDates(card: CreditCard, asOfDate: Date): { date: string; isPast: boolean }[] {
  const dates = cardPaymentDates(card.paymentDayOfMonth, new Date(asOfDate.getFullYear() - 1, asOfDate.getMonth(), 1), new Date(asOfDate.getFullYear() + 1, asOfDate.getMonth(), 1)).filter(
    (d) => d >= card.balanceAsOfDate && !(card.scheduleFrom && d < card.scheduleFrom),
  )
  return recentAndUpcomingFrom(dates, toIso(asOfDate))
}

export function applyCardPaymentDayChange(
  card: CreditCard,
  transactions: Transaction[],
  newDay: number,
  pickedDate: string,
  asOfIso: string,
): { patch: Partial<CreditCard>; transactions: Transaction[] } | null {
  // Generated minimum payments only — a logged lump payment carries a
  // sourceType and a date the user chose, and never moves.
  const belongs = (t: Transaction) => t.creditCardId === card.id && t.type === 'credit_card_payment' && !t.sourceType
  const keyed = [...transactions.filter(belongs).map((t) => t.date), ...(card.minimumPaymentOverrides ?? []).map((o) => o.date)]
  const lastKeyed = keyed.reduce((max, k) => (k > max ? k : max), pickedDate)
  const picked = parseLocalDate(pickedDate)
  const start = new Date(picked.getFullYear() - 3, picked.getMonth(), 1)
  const end = new Date(parseLocalDate(lastKeyed).getFullYear() + 2, 11, 31)
  const asOccurrences = (dates: string[]) => dates.map((d) => ({ key: d, date: d }))
  const plan = planReschedule(
    asOccurrences(cardPaymentDates(card.paymentDayOfMonth, start, end).filter((d) => !(card.scheduleFrom && d < card.scheduleFrom))),
    asOccurrences(cardPaymentDates(newDay, start, end)),
    pickedDate,
  )
  if (!plan) return null
  return {
    patch: {
      paymentDayOfMonth: newDay,
      scheduleFrom: plan.firstNew.date,
      minimumPaymentOverrides: card.minimumPaymentOverrides?.map((o) => ({ ...o, date: plan.dateMap.get(o.date) ?? o.date })),
    },
    transactions: redateStoredPayments(transactions, belongs, plan, asOfIso),
  }
}
