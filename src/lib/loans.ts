import type { Bill, Loan, LoanPayment } from '../types/models'
import type { Loan as LedgerLoan, LoanOverpayment } from '../types/ledger'
import { toLocalIsoDate, todayIso, parseLocalDate } from './date'
import {
  buildLoanSchedule as buildLedgerLoanSchedule,
  estimateSettlementFigure as estimateLedgerSettlementFigure,
  type LoanScheduleEntry,
} from './ledgerLoans'

/**
 * Turns a bridged legacy Loan into the minimal real ledger-shaped Loan
 * ledgerLoans.ts's engine needs to simulate it forward from today. Only
 * called once loan.calibratedMonthlyRate is known to be set (see
 * buildLoanSchedule below) — that's always true for anything that came
 * through legacyBridge.ts in the live app. termMonths is a throwaway
 * safety-guard value only (buildLoanSchedule's own MAX_SCHEDULE_ENTRIES
 * cap is what actually bounds the loop; termMonths never otherwise
 * factors into the maths once calibratedMonthlyRate is already set, since
 * resolveLoanRateAndConvention's back-solve fallback — the only place
 * termMonths would matter — is short-circuited by the rate already being
 * present).
 */
export function toSyntheticLedgerLoan(loan: Loan): LedgerLoan {
  return {
    id: loan.id,
    name: loan.name,
    principal: loan.totalAmount,
    monthlyPayment: loan.monthlyPayment,
    termMonths: 600,
    startDate: loan.firstPaymentDate,
    categoryId: '',
    // Synthetic: this is a finance agreement reshaped into a Loan purely so
    // the amortisation engine can be run over it. It is never added to
    // `data.loans` and never rendered as a hero card, so it holds no
    // palette colour — and pickNextSharedCardColor ignores empty ones.
    color: '',
    location: loan.location,
    ownerId: loan.ownerId,
    payee: loan.payee,
    payeeSharePercent: loan.payeeSharePercent,
    overpayments: [],
    active: true,
    calibratedMonthlyRate: loan.calibratedMonthlyRate,
    interestConventionId: loan.interestConventionId,
    settlementMultiplier: loan.settlementMultiplier,
  }
}

/**
 * Builds the full month-by-month payment schedule for a loan, from its first
 * payment date until the balance reaches zero. The final payment absorbs any
 * rounding so the balance lands exactly on £0.
 *
 * DELEGATES to ledgerLoans.ts's real amortisation engine whenever the loan
 * carries a resolved calibratedMonthlyRate — i.e. whenever it was bridged
 * from a real ledger loan (loan-amortisation-engine scope §1's
 * architecture decision: one real engine, not two parallel
 * implementations that could silently drift apart). Falls back to the
 * original flat, interest-free simulation below, completely unchanged,
 * for any Loan that never carries that field — which keeps every
 * existing test fixture and any hypothetical standalone Loan behaving
 * exactly as before.
 */
export function buildLoanSchedule(loan: Loan): LoanPayment[] {
  if (loan.monthlyPayment <= 0 || loan.totalAmount <= 0) return []

  if (loan.calibratedMonthlyRate != null) {
    return buildLedgerLoanSchedule(toSyntheticLedgerLoan(loan)).map((e) => ({
      date: e.date,
      amount: e.scheduledPayment,
      balanceAfter: e.balanceAfter,
    }))
  }

  const schedule: LoanPayment[] = []
  let balance = loan.totalAmount
  const start = parseLocalDate(loan.firstPaymentDate)

  // Safety cap: never generate more than 600 months (50 years) of payments
  const MAX_PAYMENTS = 600
  let i = 0

  while (balance > 0 && i < MAX_PAYMENTS) {
    const paymentDate = addMonths(start, i)
    const payment = Math.min(loan.monthlyPayment, balance)
    balance = Math.round((balance - payment) * 100) / 100

    schedule.push({
      date: toLocalIsoDate(paymentDate),
      amount: Math.round(payment * 100) / 100,
      balanceAfter: balance,
    })
    i++
  }

  return schedule
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + months)
  // clamp to the last day of the target month if the original day doesn't exist
  // (e.g. 31st on a first-payment-date rolling into February)
  const lastDayOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, lastDayOfMonth))
  return d
}

export interface LoanSummary {
  totalAmount: number
  repaidToDate: number
  remaining: number
  nextPayment: LoanPayment | null
  finalPaymentDate: string | null
  monthsRemaining: number
  percentRepaid: number
}

export function summarizeLoan(loan: Loan, asOf: Date = new Date()): LoanSummary {
  const schedule = buildLoanSchedule(loan)
  const today = toLocalIsoDate(asOf)

  const repaidToDate = schedule
    .filter((p) => p.date <= today)
    .reduce((sum, p) => sum + p.amount, 0)

  // Read the true remaining balance straight from the schedule's own
  // balanceAfter — correct for BOTH the flat and delegated cases, since
  // in the delegated (real-interest) case some of repaidToDate covers
  // interest rather than principal, so `totalAmount - repaidToDate`
  // would overstate what's actually still owed.
  const lastPast = schedule.filter((p) => p.date <= today).at(-1)
  const remaining = lastPast ? lastPast.balanceAfter : loan.totalAmount
  const nextPayment = schedule.find((p) => p.date > today) ?? null
  const finalPaymentDate = schedule.length > 0 ? schedule[schedule.length - 1].date : null
  const monthsRemaining = schedule.filter((p) => p.date > today).length
  const percentRepaid = loan.totalAmount > 0 ? Math.min(100, ((loan.totalAmount - remaining) / loan.totalAmount) * 100) : 0

  return { totalAmount: loan.totalAmount, repaidToDate, remaining, nextPayment, finalPaymentDate, monthsRemaining, percentRepaid }
}

/**
 * The real cost of fully closing this loan right now (loan-amortisation-
 * engine scope §6) — always MORE than `summarizeLoan(loan).remaining`
 * once real interest is involved, since early settlement carries a
 * premium. Falls back to the raw remaining balance (today's exact prior
 * behaviour) when there's no rate to estimate a premium from at all.
 * scenarios.ts's pay_off_loan logic uses this, not raw remaining, to
 * decide whether a lump sum genuinely clears a loan (scope §13 / handoff
 * step 6).
 */
export function estimateSettlementFigure(loan: Loan, asOf: Date = new Date()): number {
  if (loan.calibratedMonthlyRate == null) return summarizeLoan(loan, asOf).remaining
  return estimateLedgerSettlementFigure(toSyntheticLedgerLoan(loan), asOf)
}

/** What this loan actually costs per month right now — £0 once it's paid off, and the reduced final payment near the end. */
export function currentLoanMonthlyCost(loan: Loan, asOf: Date = new Date()): number {
  const summary = summarizeLoan(loan, asOf)
  if (summary.remaining <= 0) return 0
  return Math.round(Math.min(loan.monthlyPayment, summary.remaining) * 100) / 100
}

/**
 * Represents a loan's current monthly payment as a virtual Bill, so it can
 * flow through the same personal/joint split totals as everything else
 * without needing a separate, manually-linked bill entry.
 */
export function loanAsBill(loan: Loan, asOf: Date = new Date()): Bill {
  const dueDay = parseLocalDate(loan.firstPaymentDate).getDate()
  return {
    id: `loan:${loan.id}`,
    name: loan.name,
    cost: currentLoanMonthlyCost(loan, asOf),
    dueDay,
    location: loan.location,
    payee: loan.payee,
    payeeSharePercent: loan.payeeSharePercent,
    category: 'Loan',
    ownerId: loan.ownerId,
    isStandingOrder: true,
    icon: loan.icon,
    iconColor: loan.iconColor,
  }
}

/**
 * Merges real bills with each loan's current monthly payment (as a virtual
 * bill), so totals and summary lists automatically include loan repayments
 * without needing them duplicated as separate bill entries.
 */
export function combineBillsWithLoans(bills: Bill[], loans: Loan[], asOf: Date = new Date()): Bill[] {
  return [...bills, ...loans.map((loan) => loanAsBill(loan, asOf))]
}

/**
 * A hypothetical, dated scenario overpayment — the What-if page's own
 * shape for "what if I put £X toward this loan on this date, and here's
 * how I want it recast." Deliberately the same fields as a real
 * `LoanOverpayment` (ledgerLoans.ts), since that's exactly what these get
 * turned into below.
 */
export interface ScenarioLoanEvent {
  date: string // ISO date
  amount: number
  recastMode: 'reduce_term' | 'reduce_payment'
}

export interface ScenarioLoanOutcome {
  // false when this loan has no calibratedMonthlyRate to delegate to (see
  // buildLoanSchedule's own fallback comment — not reachable for any real
  // bridged loan in the live app, only a hypothetical bare test fixture)
  // or there were no events to apply at all. Callers fall back to today's
  // ordinary flat "apply now" treatment in either case.
  hasSchedule: boolean
  monthsRemaining: number // real periods still ahead of today, per the new combined schedule
  finalPaymentDate: string | null
  remainingAfterEvents: number // balance right after the LAST supplied event's own period lands
  effectiveMonthlyPayment: number // the payment in effect for the period right after the last event — what they'd actually pay next
  fullyPaidOff: boolean // the combined events clear the loan outright
  // BUGFIX (Adam-reported, 2026-09 session — "lump sum was 2000,
  // remaining after shows 0") — the full combined schedule, so a caller
  // asking "what's the balance/payment right after MY OWN action" (via
  // scheduleEntryAsOf below) isn't stuck with remainingAfterEvents/
  // effectiveMonthlyPayment above, which are anchored to the
  // CHRONOLOGICALLY LAST event across every action sharing this loan —
  // for a scenario combining a lump sum with a recurring overpayment,
  // that's a materialized event ~50 years out (see loan_overpayment's own
  // 600-month materialization in scenarios.ts), so those two fields
  // collapse to "the loan's eventual payoff state" for ANY action on a
  // loan that also has a recurring overpayment, regardless of that
  // action's own actual date. See scenarios.ts's own comment on the lump-
  // sum/overpayment loops for how this is actually used correctly.
  schedule: LoanScheduleEntry[]
}

/**
 * The schedule entry whose own period a given date lands in — same
 * "sameMonth" bucketing buildLoanSchedule itself uses, so this always
 * answers "what did the balance/payment look like right after THIS
 * date's event landed" for an arbitrary date within a ScenarioLoanOutcome's
 * combined schedule, rather than only ever the schedule's own final entry
 * the way remainingAfterEvents/effectiveMonthlyPayment are anchored.
 * Falls back to the schedule's last entry when the date is beyond it
 * (the loan was already fully paid off by then) — same fallback
 * simulateScenarioLoan's own internal landing-index lookup already uses.
 */
/**
 * The loan's own schedule with NO hypothetical events on it — the same
 * entries simulateScenarioLoan produces, so a What-if section's "before"
 * figures can be read with scheduleEntryAsOf exactly like its "after" ones.
 *
 * 2026-09-17 (Adam-reported): without this, a scenario's FIRST section had
 * no schedule to read (simulateScenarioLoan returns nothing for an empty
 * event list) and fell back to today's balance, so "balance on 14 Jan 2027"
 * showed today's £6,854.55 rather than £5,814.55 — four monthly payments
 * later — making the lump sum look like it removed £4,040.
 */
export function baselineLoanSchedule(loan: Loan): LoanScheduleEntry[] {
  if (loan.calibratedMonthlyRate == null) return []
  return buildLedgerLoanSchedule(toSyntheticLedgerLoan(loan))
}

/**
 * Which schedule entry absorbs an overpayment dated `eventDate` — the same
 * matching ledgerLoans.buildLoanSchedule uses: the entry in the event's own
 * calendar month, or, for the first entry, anything dated on or before it.
 * −1 when the loan has finished before that month.
 *
 * 🚨 The engine applies an overpayment AFTER that month's scheduled payment,
 * whichever side of the payment day it is dated. So an entry's balanceAfter
 * already includes a lump paid later in the same month, and a lump paid
 * earlier in the month sits in the payment entry dated after it.
 */
export function absorbingEntryIndex(schedule: LoanScheduleEntry[], eventDate: string): number {
  if (schedule.length === 0) return -1
  if (eventDate <= schedule[0].date) return 0
  const month = eventDate.slice(0, 7)
  return schedule.findIndex((e) => e.date.slice(0, 7) === month)
}

/**
 * What the overpayments in entry `index` actually took off the balance.
 * 🚨 Not `overpaymentApplied`: the engine records the full overpayment there
 * and then clamps the balance at £0, so in the final month it overstates
 * what was paid (a £450 extra recorded where £396.69 cleared the loan).
 */
export function appliedExtraAt(schedule: LoanScheduleEntry[], index: number, opening: number): number {
  const entry = schedule[index]
  const before = index === 0 ? opening : schedule[index - 1].balanceAfter
  return round2(Math.max(0, before + entry.interestApplied - entry.scheduledPayment - entry.balanceAfter))
}

/**
 * The balance owed at the end of `date`: everything dated on or before it,
 * nothing after. Read off the schedule's last entry on or before the date,
 * then corrected for the overpayments the engine filed in a different entry
 * from their own date (see absorbingEntryIndex): a lump later in that
 * entry's month is put back, and a lump earlier in the next entry's month is
 * taken off. Extras within one entry are taken in date order, capped at what
 * that entry actually absorbed. Only for a date on or after the first entry.
 */
export function loanBalanceOnDay(schedule: LoanScheduleEntry[], opening: number, events: ScenarioLoanEvent[], date: string): number {
  let k = -1
  for (let i = 0; i < schedule.length && schedule[i].date <= date; i++) k = i
  if (k < 0) return opening
  const absorbedBy = (index: number) => events.filter((e) => absorbingEntryIndex(schedule, e.date) === index)
  const applied = appliedExtraAt(schedule, k, opening)
  const extrasOnOrBefore = round2(absorbedBy(k).filter((e) => e.date <= date).reduce((s, e) => s + e.amount, 0))
  let balance = round2(schedule[k].balanceAfter + applied - Math.min(applied, extrasOnOrBefore))
  if (k + 1 < schedule.length) {
    // Uncapped by what that entry absorbed: the engine books the payment
    // first and clamps the lump to what is then left, so in the final month a
    // clearing lump on 3 Mar is recorded as less than was sent, and capping
    // here left £272.71 "owed" on the day a £100,000 lump went in.
    const early = round2(absorbedBy(k + 1).filter((e) => e.date <= date).reduce((s, e) => s + e.amount, 0))
    balance = round2(Math.max(0, balance - early))
  }
  return balance
}

/** One line of a What-if loan statement: a payment day, or an extra paid on a day of its own. */
export interface LoanStatementRow {
  date: string
  kind: 'payment' | 'extra'
  interest: number
  payment: number
  /** What the extra actually took off the balance (see appliedExtraAt), never more than was owed. */
  extra: number
  balance: number
}

/**
 * The loan's payment-by-payment statement, one row per date money moves,
 * from the same schedule the card reads. Each payment entry becomes a
 * payment row carrying the extras dated that same day; an extra dated on
 * any other day gets a row of its own on its real date, before or after the
 * payment it was filed with (absorbingEntryIndex). Every row satisfies
 * previous balance + interest − payment − extra = balance, and an extra
 * never takes off more than is owed on its day.
 *
 * Interest and payments are the engine's own figures, entry by entry. The
 * one place the rows differ is the loan's last month: the engine books the
 * payment and then clamps any extra, whichever side of the payment day it
 * is dated. Here an extra dated BEFORE the payment day comes off first, and
 * if it clears the balance it is the last row: the loan is gone that day,
 * so no payment follows it. The card's "Finishes" date is the date of the
 * last row (scenarios.ts), so the card and its statement cannot disagree.
 */
export function buildLoanStatementRows(schedule: LoanScheduleEntry[], opening: number, events: ScenarioLoanEvent[]): LoanStatementRow[] {
  const rows: LoanStatementRow[] = []
  let balance = opening
  const sorted = events.slice().sort((a, b) => a.date.localeCompare(b.date))
  const extra = (date: string) => {
    const taken = round2(Math.min(groups.get(date) ?? 0, balance))
    balance = round2(balance - taken)
    return taken
  }
  let groups = new Map<string, number>()
  for (let j = 0; j < schedule.length && balance > 0.005; j++) {
    const entry = schedule[j]
    groups = new Map<string, number>()
    for (const e of sorted.filter((ev) => absorbingEntryIndex(schedule, ev.date) === j)) groups.set(e.date, round2((groups.get(e.date) ?? 0) + e.amount))
    const dates = [...groups.keys()].sort()
    for (const date of dates.filter((d) => d < entry.date)) {
      const taken = extra(date)
      if (taken > 0) rows.push({ date, kind: 'extra', interest: 0, payment: 0, extra: taken, balance })
      if (balance <= 0.005) return rows
    }
    const payment = round2(Math.min(entry.scheduledPayment, balance + entry.interestApplied))
    balance = round2(balance + entry.interestApplied - payment)
    rows.push({ date: entry.date, kind: 'payment', interest: entry.interestApplied, payment, extra: extra(entry.date), balance })
    for (const date of dates.filter((d) => d > entry.date)) {
      if (balance <= 0.005) break
      const taken = extra(date)
      if (taken > 0) rows.push({ date, kind: 'extra', interest: 0, payment: 0, extra: taken, balance })
    }
  }
  return rows
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function scheduleEntryAsOf(schedule: LoanScheduleEntry[], date: string): LoanScheduleEntry | undefined {
  if (schedule.length === 0) return undefined
  const index = schedule.findIndex((e) => e.date >= date)
  return index >= 0 ? schedule[index] : schedule[schedule.length - 1]
}

/**
 * Runs a loan forward through the REAL amortisation/recast engine
 * (ledgerLoans.ts's buildLoanSchedule) with a set of hypothetical, dated
 * overpayment events layered on top of today's actual remaining balance —
 * item d's whole point: genuinely the same maths the Loans page uses for a
 * real logged overpayment (loan-amortisation-engine scope §9's recast
 * rules), not a second, parallel implementation. Events are sorted by
 * date here (not by whatever order the caller built them in), so two
 * scenarios specifying the same dates always produce identical results
 * regardless of which was created first.
 */
export function simulateScenarioLoan(loan: Loan, events: ScenarioLoanEvent[]): ScenarioLoanOutcome {
  const empty: ScenarioLoanOutcome = {
    hasSchedule: false,
    monthsRemaining: 0,
    finalPaymentDate: null,
    remainingAfterEvents: 0,
    effectiveMonthlyPayment: 0,
    fullyPaidOff: false,
    schedule: [],
  }
  if (loan.calibratedMonthlyRate == null || events.length === 0) return empty

  const sortedEvents = events.slice().sort((a, b) => a.date.localeCompare(b.date))
  const overpayments: LoanOverpayment[] = sortedEvents.map((e, i) => ({
    id: `scenario:${i}`,
    date: e.date,
    amount: e.amount,
    recastMode: e.recastMode,
  }))

  const schedule: LoanScheduleEntry[] = buildLedgerLoanSchedule({ ...toSyntheticLedgerLoan(loan), overpayments })
  if (schedule.length === 0) return empty

  const today = todayIso()
  const lastEventDate = sortedEvents[sortedEvents.length - 1].date
  // The schedule entry whose own period the last event landed in — same
  // "sameMonth" bucketing buildLoanSchedule itself uses to match an
  // overpayment to a period, so this always lines up with the period that
  // genuinely absorbed it.
  const landingIndex = schedule.findIndex((e) => e.date >= lastEventDate)
  const landingEntry = landingIndex >= 0 ? schedule[landingIndex] : schedule[schedule.length - 1]
  const nextEntry = schedule.find((e) => e.date > landingEntry.date) ?? landingEntry

  return {
    hasSchedule: true,
    monthsRemaining: schedule.filter((e) => e.date > today).length,
    finalPaymentDate: schedule[schedule.length - 1].date,
    remainingAfterEvents: landingEntry.balanceAfter,
    effectiveMonthlyPayment: nextEntry.scheduledPayment,
    fullyPaidOff: landingEntry.balanceAfter <= 0.005,
    schedule,
  }
}
