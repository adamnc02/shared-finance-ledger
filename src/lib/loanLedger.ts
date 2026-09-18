// PROMPT-08a Part C — a loan's OWN hero card, ledger and trend chart.
//
// THE ONE DECISION THIS FILE RESTS ON (see
// DECISION-2026-09-18-loan-ledger-double-entry.md, written before this was
// built): the positive row on a loan's own ledger is a **derived view** of
// the existing `loan_payment` transaction, never a second stored one.
//
// One payment is one stored row, shown twice — negative on whatever
// funded it (Personal/Joint/a Pot), positive here. Nothing in this file
// writes a transaction, and nothing should ever be added that does: every
// path that already sums `loan_payment` rows (projection.ts,
// cycleSummary.ts, scenarios.ts, every hero total and trend chart) would
// then double-count, and each one missed is a silently wrong number in a
// live app holding real data.
//
// This is not a new mechanism. The credit-card list already flips sign by
// `type`, and Joint/Pot already pass their own `amountSign` into the
// shared list components — a loan ledger is the fifth user of that same
// display convention, not a special case.

import { addDays } from 'date-fns'
import { toLocalIsoDate, parseLocalDate } from './date'
import { buildLoanSchedule, recurringOverpaymentRealDates, generateLoanPaymentTransactions, summarizeLoan } from './ledgerLoans'
import { dedupeKey } from './projection'
import type { BalanceSpendTrendSeries } from './runningBalance'
import type { AppDataV2, Loan, Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Which loans get their own hero card (Adam, 2026-09-18).
 *
 * Ownership is the same rule credit cards and pots already use, and is
 * also why a loan owned by someone else shows no monthly effect in the
 * What-if scenarios (Batch 24) — the two are consistent deliberately.
 *
 * **Both halves of the "hidden once it's done" rule are needed.**
 * `settleLoan` sets `active: false`, so that covers a loan settled by
 * hand — but NOT one that simply ran to the end of its own schedule,
 * which stays `active: true` forever with nothing left to pay. Without
 * the balance check, a finished loan would keep a card showing £0 owed
 * for the rest of time.
 */
export function isLoanCardVisible(loan: Loan, personId: string, asOfDate: Date = new Date()): boolean {
  if (loan.ownerId !== personId) return false
  if (!loan.active) return false
  return summarizeLoan(loan, asOfDate).remainingBalance > 0
}

/** Every loan that should currently have a hero card, in `data.loans` order. */
export function visibleLoanCards(data: AppDataV2, asOfDate: Date = new Date()): Loan[] {
  return data.loans.filter((l) => isLoanCardVisible(l, data.primaryPersonId, asOfDate))
}

export interface LoanCyclePeriod {
  windowStart: Date
  windowEnd: Date
  dueDate: Date
}

/**
 * A loan's own accounting periods — bounded by **its own payment due
 * dates**, never the household pay cycle. Exactly the rule
 * `creditCardCyclePeriods` follows for a card's statement periods, and for
 * the same reason: PROMPT-01 Part B found a card's ledger filtered to the
 * pay-cycle window could not show a charge due one day past that window's
 * end. A loan due on the 2nd has the same problem against a cycle ending
 * on the 30th.
 *
 * A period runs `(previous due date, this due date]` — the same
 * half-open-then-inclusive shape credit cards use. That is also what makes
 * a recurring overpayment land correctly without special-casing: its real
 * date can fall weeks before the loan period it is aggregated into for
 * interest (an overpayment on the 21st folding into the payment due on the
 * 2nd), and the 21st is inside `(2nd, 2nd-of-next-month]` already.
 *
 * `count` is the caller's concern — 1 for "This cycle", or
 * `1 + THREE_CYCLES_AHEAD` for "Next 3 cycles", matching horizonCycles'
 * current-cycle-first convention. Returns fewer than `count` periods when
 * the loan's schedule runs out first, and `[]` for a loan that cannot be
 * scheduled at all.
 */
export function loanCyclePeriods(loan: Loan, asOfDate: Date, count: number): LoanCyclePeriod[] {
  const schedule = buildLoanSchedule(loan)
  if (schedule.length === 0) return []

  const dates = schedule.map((e) => e.date)
  const asOfIso = toLocalIsoDate(asOfDate)
  // The current period is the one whose own due date hasn't passed yet —
  // "due today is still this period", the same convention the rest of the
  // app uses. A loan whose whole schedule is in the past falls back to its
  // final period rather than returning nothing, so a just-finished loan
  // still renders its last cycle instead of an empty card.
  let startIndex = dates.findIndex((d) => d >= asOfIso)
  if (startIndex === -1) startIndex = dates.length - 1

  const periods: LoanCyclePeriod[] = []
  for (let i = startIndex; i < Math.min(startIndex + count, dates.length); i++) {
    const dueDate = parseLocalDate(dates[i])
    // The first period opens at the loan's advance date (inclusive) — the
    // money is drawn there, so a payment dated on it belongs to period 1.
    // Every later period opens the day after its predecessor's due date.
    const windowStart = i > 0 ? addDays(parseLocalDate(dates[i - 1]), 1) : parseLocalDate(loan.advanceDate ?? loan.startDate)
    periods.push({ windowStart, windowEnd: dueDate, dueDate })
  }
  return periods
}

/**
 * Every payment toward this loan — stored rows plus the generated ones
 * that haven't materialised yet — as they should appear on the LOAN's own
 * ledger: **positive**, because from the loan's point of view the money is
 * arriving.
 *
 * `amount` stays the transaction's own positive magnitude (as everywhere
 * else in this app); `loanSignedAmount` below is what flips it for
 * display, the same shape as `potSignedAmount`/`jointAccountSignedAmount`.
 *
 * Generated rows are deduped against stored ones by `dedupeKey`, the same
 * function `computeProjection` uses — a materialised payment and its own
 * projection share `sourceType:sourceId:date`, so the ledger can never
 * show one payment twice.
 */
export function loanPaymentTransactions(loan: Loan, transactions: Transaction[], rangeStart: Date, rangeEnd: Date): Transaction[] {
  const startIso = toLocalIsoDate(rangeStart)
  const endIso = toLocalIsoDate(rangeEnd)

  // Stored: anything logged against this loan. Every one of them is a
  // `loan_payment` — the regular payment, an ad-hoc overpayment
  // (`loan_overpayment`), a recurring one, or a settlement — so matching
  // on `sourceId` + type covers all four without naming each sourceType
  // and silently missing one added later.
  const stored = transactions.filter((t) => t.sourceId === loan.id && t.type === 'loan_payment' && t.date >= startIso && t.date <= endIso)
  const storedKeys = new Set(stored.map(dedupeKey).filter((k): k is string => k !== null))

  const generated = generateLoanPaymentTransactions(loan, rangeStart, rangeEnd)
    .filter((t) => {
      const key = dedupeKey(t)
      return key === null || !storedKeys.has(key)
    })
    // Generated rows have no id of their own. Keyed by what actually makes
    // them unique — the loan, its source type and the date — rather than an
    // index, so the key is stable across renders.
    .map((t, i): Transaction => ({ ...t, id: `generated-loan-${loan.id}-${t.sourceType}-${t.date}-${i}` }))

  return [...stored, ...generated].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * The loan ledger's sign convention: money paid toward the loan reads
 * POSITIVE here, because it is arriving at the debt — while the exact same
 * stored row reads negative on whatever account funded it. Passed into the
 * shared list components as `amountSign`, exactly like `potSignedAmount`.
 */
export function loanSignedAmount(t: Transaction): number {
  return t.amount
}

export interface LoanCycleSection {
  windowStart: Date
  windowEnd: Date
  dueDate: Date
  startIso: string
  endIso: string
  rows: Transaction[]
  /** Total paid toward the loan in this period — always positive. */
  total: number
  /** The loan's outstanding capital at this period's due date. */
  balanceAfter: number
}

/**
 * One section per period, each carrying its own rows and closing balance —
 * the loan counterpart of `buildCreditCardCycleSections`.
 *
 * The flat (cycle-totals-off) ledger is built by flattening these, never
 * by filtering `data.transactions` separately. That is deliberate and it
 * is the whole point: PROMPT-01 Part B found the credit card's two toggle
 * states disagreeing about the same card on the same data precisely
 * because each derived its rows independently. One source, two
 * presentations.
 */
export function buildLoanCycleSections(loan: Loan, transactions: Transaction[], periods: LoanCyclePeriod[]): LoanCycleSection[] {
  const schedule = buildLoanSchedule(loan)
  return periods.map((p) => {
    const rows = loanPaymentTransactions(loan, transactions, p.windowStart, p.windowEnd)
    const dueIso = toLocalIsoDate(p.dueDate)
    // The schedule's own balance at this due date — the amortisation
    // engine's figure, not a second calculation of it here.
    const entry = schedule.find((e) => e.date === dueIso)
    return {
      windowStart: p.windowStart,
      windowEnd: p.windowEnd,
      dueDate: p.dueDate,
      startIso: toLocalIsoDate(p.windowStart),
      endIso: dueIso,
      rows,
      total: round2(rows.reduce((sum, t) => sum + t.amount, 0)),
      balanceAfter: entry ? round2(entry.balanceAfter) : summarizeLoan(loan, p.dueDate).remainingBalance,
    }
  })
}

export interface LoanTrendPoint {
  dateIso: string
  /** Outstanding capital after that date's payment(s). */
  balance: number
}

export interface LoanTrendSeries {
  points: LoanTrendPoint[]
  /** Capital outstanding today — the point the chart's headline figure reads. */
  currentBalance: number
}

/**
 * The loan's balance over its WHOLE life — Adam's spec for Part C:
 * balance view only, one time range (all time), and an x axis of "the
 * payment due dates, plus any additional overpayment made on the loan".
 *
 * That is exactly the shape `buildLoanLedgerRows` already produces (one
 * row per dated event, with the recurring overpayment mapped to its own
 * real calendar date rather than the loan's period date), so this reads
 * that rather than walking the schedule a second time and risking a
 * different answer. Same reason `buildLoanCycleSections` above takes its
 * closing balance from the schedule instead of recomputing it.
 *
 * Deliberately not a `BalanceSpendTrendSeries`: that type is built around
 * `this_cycle`/`next_3_cycles` daily granularity, and this chart has
 * neither a cycle nor a daily point — its points ARE the payment events.
 */
/** What kind of payment a trend point represents — Adam, 2026-09-18: the loan chart should say whether a point was the monthly repayment, a one-off overpayment or a recurring one, since a loan's category icon is the same for every point and says nothing. */
export type LoanPaymentKind = 'monthly' | 'one_off_overpayment' | 'recurring_overpayment'

export const LOAN_PAYMENT_KIND_LABELS: Record<LoanPaymentKind, string> = {
  monthly: 'Monthly repayment',
  one_off_overpayment: 'One-off overpayment',
  recurring_overpayment: 'Recurring overpayment',
}

export interface LoanTrendEvent {
  dateIso: string
  kind: LoanPaymentKind
  /** Cash handed over. */
  amount: number
  /** How much of it came off the principal — what moves the balance line. */
  capital: number
}

/**
 * Every dated payment event on the loan, each at its OWN real calendar
 * date. This is the loan trend chart's x axis (Adam: "all monthly
 * repayments, any one off overpayments and any recurring overpayments date
 * form the x axis, not locked in on the monthly payment dates").
 *
 * Why this exists rather than reusing `buildLoanLedgerRows`: that function
 * dates a one-off overpayment at the SCHEDULE ENTRY's date, not the
 * overpayment's own. `buildLoanSchedule` aggregates an overpayment into
 * whichever period shares its MONTH, so a £3,000 overpayment logged on
 * 22 Oct is folded into the payment due on 14 Oct — and the chart drew the
 * dip on the 14th, labelled £290 (the monthly payment), which is exactly
 * what Adam reported on 2026-09-18. Recurring overpayments were already
 * remapped to their real dates; one-off ones never were.
 *
 * The per-period aggregate `entry.overpaymentApplied` stays the source of
 * truth for HOW MUCH the engine actually applied (it clamps at the
 * remaining balance). Overpayments are consumed against it in date order,
 * which is the same order `buildLoanSchedule` consumes them in — so this
 * splits the aggregate back out to real dates without re-deriving the
 * engine's own same-month matching rule, which would be a second copy of
 * it to keep in step.
 */
export function buildLoanTrendEvents(loan: Loan): LoanTrendEvent[] {
  const schedule = buildLoanSchedule(loan)
  const recurringDates = recurringOverpaymentRealDates(loan, schedule)
  const overpayments = [...(loan.overpayments ?? [])].sort((a, b) => a.date.localeCompare(b.date))
  let overpaymentIndex = 0
  const events: LoanTrendEvent[] = []

  for (const entry of schedule) {
    if (entry.scheduledPayment > 0) {
      events.push({
        dateIso: entry.date,
        kind: 'monthly',
        amount: round2(entry.scheduledPayment),
        capital: round2(entry.scheduledPayment - entry.interestApplied),
      })
    }
    let remaining = entry.overpaymentApplied
    while (remaining > 0.005 && overpaymentIndex < overpayments.length) {
      const op = overpayments[overpaymentIndex]
      const applied = round2(Math.min(op.amount, remaining))
      events.push({ dateIso: op.date, kind: 'one_off_overpayment', amount: applied, capital: applied })
      remaining = round2(remaining - applied)
      overpaymentIndex++
    }
    if (entry.recurringOverpaymentApplied > 0) {
      events.push({
        dateIso: recurringDates.get(entry.date) ?? entry.date,
        kind: 'recurring_overpayment',
        amount: round2(entry.recurringOverpaymentApplied),
        capital: round2(entry.recurringOverpaymentApplied),
      })
    }
  }

  return events.sort((a, b) => a.dateIso.localeCompare(b.dateIso))
}

export function buildLoanTrendSeries(loan: Loan, asOfDate: Date = new Date()): LoanTrendSeries {
  const rows = buildLoanTrendEvents(loan)
  // The opening point: the full principal, on the day the money was drawn.
  // Without it a loan whose first payment is still in the future has a
  // single-point chart that can't show a line at all.
  const openingIso = loan.advanceDate ?? loan.startDate
  const points: LoanTrendPoint[] = [{ dateIso: openingIso, balance: round2(loan.principal) }]

  // DELIBERATELY walking capital down in DATE order rather than reading
  // each row's own `balanceAfter` (2026-09-18, found against Ella's real
  // Tesco loan). Those two disagree, and `balanceAfter` is the wrong one
  // for a chart:
  //
  // `buildLoanLedgerRows` computes `balanceAfter` from the amortisation
  // engine's WITHIN-PERIOD ordering (regular payment, then one-off, then
  // recurring overpayment) — but then re-dates the recurring overpayment
  // row to its own REAL calendar date, which routinely falls BEFORE the
  // payment it is aggregated into (an overpayment on the 12th folding
  // into the payment due on the 1st of the next month). Sorted by date,
  // the balances then read 374.55 → 0 → 14.55: the series jumps back UP
  // and never reaches zero, because the last row by date is carrying a
  // balance computed as though it came first.
  //
  // Capital is immune to that: each row's own capital component is
  // independent of the others' ordering, and the components sum to the
  // principal over the loan's life by construction. Walking them in date
  // order therefore gives a monotonic curve that lands exactly on zero,
  // with every point on its true calendar date.
  //
  // NOTE this means the Borrowing page's own loan ledger modal, which
  // reads `balanceAfter` directly, shows that same non-monotonic sequence
  // for a loan whose recurring overpayment falls on a different day of the
  // month. Pre-existing and untouched here — flagged in APP-KNOWLEDGE.md.
  let balance = loan.principal
  for (const row of rows) {
    balance = Math.max(0, balance - row.capital)
    const rounded = round2(balance)
    const last = points[points.length - 1]
    // Two events on one date (a payment and its overpayment) collapse to
    // one point carrying the balance after BOTH — a chart x-axis can only
    // hold one value per date, and the later balance is the true one.
    if (last && last.dateIso === row.dateIso) last.balance = rounded
    else points.push({ dateIso: row.dateIso, balance: rounded })
  }

  return { points, currentBalance: summarizeLoan(loan, asOfDate).remainingBalance }
}

/**
 * The same all-time balance series, shaped for the existing
 * `BalanceSpendChart` so a loan reuses the proven chart rather than
 * getting a second one written for it.
 *
 * In `view="balance"` that component reads exactly three things — `days`,
 * `todayIso` and `balance[i].clearedBalance/projectedBalance` — and draws
 * SOLID up to `todayIso`, DOTTED after it. That split is a free and
 * genuinely meaningful one here: solid is what has actually been paid,
 * dotted is the schedule still to come.
 *
 * Two deliberate shape compromises, neither of which the balance view
 * reads:
 *  - `granularity` is nominal. The type only offers the two pay-cycle
 *    values and a loan has neither — Part C gives it ONE range, all time,
 *    so nothing ever switches on it. It is not rendered.
 *  - `spend`/`previousPeriodSpend` are zero-filled and empty: a loan has
 *    no spend view at all (Adam: "balance view only").
 *
 * `todayIso` is snapped to the last point on or before today, because the
 * chart locates the split with `days.indexOf(todayIso)` — a real calendar
 * "today" is almost never one of the payment dates, and a miss silently
 * renders the whole line solid.
 */
export function loanTrendAsBalanceSeries(loan: Loan, asOfDate: Date = new Date()): BalanceSpendTrendSeries {
  const { points } = buildLoanTrendSeries(loan, asOfDate)
  const asOfIso = toLocalIsoDate(asOfDate)
  const days = points.map((p) => p.dateIso)
  const lastPast = [...days].reverse().find((d) => d <= asOfIso)
  return {
    granularity: 'next_3_cycles',
    days,
    todayIso: lastPast ?? days[0],
    balance: points.map((p) => ({ date: p.dateIso, clearedBalance: p.balance, projectedBalance: p.balance })),
    spend: points.map((p) => ({ date: p.dateIso, spendToDate: 0 })),
    previousPeriodSpend: [],
  }
}
