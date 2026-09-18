// Loan calculations for the rebuilt model (doc Section 3.2, "Tweak"):
// monthlyPayment + termMonths + startDate are the primary inputs now,
// with totalPayable as a derived/display figure, instead of the old
// app's totalAmount + monthlyPayment -> derived term. Overpayments are
// recorded here for real (LoanOverpayment[] on the Loan itself) and
// actually shrink the remaining schedule — unlike the What-if page's
// hypothetical "loan_overpayment" scenario action, which this file has
// no relationship to at all.
//
// AMORTISATION ENGINE (loan-amortisation-engine scope): this used to be
// a flat, interest-free model — `balance` just started at
// monthlyPayment × termMonths and counted down by each payment.
// `buildLoanSchedule` below now runs genuine reducing-balance interest,
// using whichever InterestConvention the loan has calibrated (or the
// back-solved flat-monthly baseline when it hasn't — see
// resolveLoanRateAndConvention). See lib/interestConventions.ts for the
// convention library and the maths behind the baseline.

import { addMonths } from 'date-fns'
import { nanoid } from 'nanoid'
import type { Loan, LoanOverpayment, LoanRecurringOverpayment, StatementCalibrationLine, Transaction } from '../types/ledger'
import type { BillLocation } from '../types/models'
import { backSolveMonthlyRate, calibrateRateAndConvention, flatMonthlyConvention, interestConventions, standardPayment, type InterestConvention } from './interestConventions'

const round2 = (n: number) => Math.round(n * 100) / 100
import { toLocalIsoDate as toIso, todayIso, parseLocalDate } from './date'
import { planReschedule, redateStoredPayments, type ReschedulePlan, type ScheduleOccurrence } from './scheduleChange'
const sameMonth = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()

/**
 * Which interest convention and monthly rate apply to this loan. A
 * calibrated loan (scope §5.3) uses its stored, fitted values directly.
 * An uncalibrated loan falls back to the flat-monthly convention with a
 * rate back-solved from its own contractual facts (principal, payment,
 * term) — scope §5.2's baseline, needing zero statement data and
 * verified within ~0.00005 percentage points of the real rate on both
 * reconciled fixtures (see verify-interest-conventions.ts).
 */
export function resolveLoanRateAndConvention(loan: Loan): { monthlyRate: number; convention: InterestConvention } {
  const monthlyRate = loan.calibratedMonthlyRate ?? backSolveMonthlyRate(loan.principal, loan.monthlyPayment, loan.termMonths)
  const convention = interestConventions.find((c) => c.id === loan.interestConventionId) ?? flatMonthlyConvention
  return { monthlyRate, convention }
}

/**
 * The nominal total payable as originally agreed — the full schedule's
 * real payments (principal + interest) with NO overpayments applied, so
 * this stays a STABLE denominator for "percent repaid" even as real
 * overpayments genuinely shrink the actual schedule (scope §9's
 * live-recompute is about the real schedule, not this reference figure).
 * Purely a display figure; buildLoanSchedule below (with the loan's real
 * recorded overpayments) is what determines the real payoff date.
 */
export function nominalTotalPayable(loan: Loan): number {
  if (!(loan.monthlyPayment > 0) || !(loan.termMonths > 0) || !(loan.principal > 0)) return 0
  const nominalLoan: Loan = { ...loan, overpayments: [], recurringOverpayment: undefined }
  const schedule = buildLoanSchedule(nominalLoan)
  return round2(schedule.reduce((sum, e) => sum + e.scheduledPayment, 0))
}

/**
 * What the person will ACTUALLY hand over across this loan's whole life,
 * given every overpayment already logged — the real schedule's own total,
 * not the contractual one.
 *
 * Distinct from `nominalTotalPayable` above, which is deliberately frozen
 * against overpayments (pinned by verify-loan-amortisation.ts: "a moving
 * denominator would make percentRepaid misleading"). That remains exactly
 * right for `summarizeLoan.totalPayable` and for settlement maths, which
 * ask a contractual question.
 *
 * It is the wrong denominator for a PROGRESS figure, which is why this
 * exists alongside it (Adam, 2026-09-18): "The progress bars and pie
 * charts 100% needs to be the amortised value after all projected payments
 * (including scheduled one off overpayments and recurring overpayments)."
 *
 * The decisive symptom: against a frozen denominator, a loan with
 * overpayments can never reach 100%. Overpaying shortens the term and cuts
 * the interest, so the real total falls below the contractual one — and
 * the bar would top out short of full and then the loan would simply
 * close. Against this total, `totalPaid` reaches it exactly at payoff,
 * because both sum the same terms over the same schedule.
 */
export function amortisedTotalPayable(loan: Loan, schedule: LoanScheduleEntry[] = buildLoanSchedule(loan)): number {
  return round2(schedule.reduce((sum, e) => sum + e.scheduledPayment + e.overpaymentApplied + e.recurringOverpaymentApplied, 0))
}

export interface AppliedOneOffOverpayment {
  overpaymentId: string
  /** The overpayment's OWN calendar date — when the money actually left the person's account. */
  date: string
  /** The schedule entry that absorbed it, which can be LATER than `date`. */
  periodDate: string
  /** How much of it the engine actually applied (it clamps at the remaining balance). */
  amount: number
}

/**
 * Each one-off overpayment matched to the schedule period that absorbed
 * it, so a caller can tell when the money was PAID apart from when the
 * amortisation engine recognises it.
 *
 * `buildLoanSchedule` aggregates an overpayment into whichever period
 * shares its MONTH, and a loan's due day is usually not the day the
 * overpayment was made — so a £7,000 overpayment paid on the 17th is
 * folded into the payment due on the 28th. That is correct for INTEREST
 * (the engine must not compound differently just because a lump landed
 * mid-period), but wrong for every "as of today" question.
 *
 * The per-period aggregate `entry.overpaymentApplied` stays the source of
 * truth for how much was applied. Overpayments are consumed against it in
 * date order, which is the same order `buildLoanSchedule` consumes them
 * in — so this splits the aggregate back out to real dates without
 * re-deriving the engine's own same-month matching rule, which would be a
 * second copy of it to keep in step.
 */
export function appliedOneOffOverpayments(loan: Loan, schedule: LoanScheduleEntry[] = buildLoanSchedule(loan)): AppliedOneOffOverpayment[] {
  const overpayments = [...(loan.overpayments ?? [])].sort((a, b) => a.date.localeCompare(b.date))
  const applied: AppliedOneOffOverpayment[] = []
  let index = 0
  for (const entry of schedule) {
    let remaining = entry.overpaymentApplied
    while (remaining > 0.005 && index < overpayments.length) {
      const op = overpayments[index]
      const amount = round2(Math.min(remaining, op.amount))
      applied.push({ overpaymentId: op.id, date: op.date, periodDate: entry.date, amount })
      remaining = round2(remaining - amount)
      index++
    }
  }
  return applied
}

/**
 * Cash already handed over as a one-off overpayment on or before
 * `asOfIso`, but absorbed by a schedule period that has not been reached
 * yet — so no "as of" read derived from the schedule alone has counted it.
 *
 * BUGFIX (Adam-reported, 2026-09-18, PROMPT-08b). He logged a £7,000
 * overpayment on Car Finance dated 2026-09-17; the loan's due day is the
 * 28th, so the engine folded it into the 2026-09-28 period. Every
 * schedule-derived "as of today" figure cut off at the 2026-08-28 entry
 * and so reported the loan exactly as it was before the payment: owed
 * £7,437 on the hero card and the Borrowing page, 13% paid on the
 * progress bar, and the same untouched figure in the pie chart. Only the
 * ledger and the balance trend were right, because PROMPT-08a had already
 * re-dated overpayments to their own dates for the CHART — the same
 * correction was never applied to these reads.
 *
 * A one-off overpayment is 100% principal with no interest component (see
 * applyLoanOverpayment), so crediting the cash figure straight against
 * capital is exact, not an approximation.
 */
export function unrecognisedOneOffOverpayments(loan: Loan, schedule: LoanScheduleEntry[], asOfIso: string): number {
  return round2(
    appliedOneOffOverpayments(loan, schedule)
      .filter((a) => a.date <= asOfIso && a.periodDate > asOfIso)
      .reduce((sum, a) => sum + a.amount, 0),
  )
}

export interface LoanProgress {
  totalPaid: number // cumulative real cash paid to date (regular payments + any overpayments), principal+interest combined
  totalBalance: number // == nominalTotalPayable — the stable, no-overpayment contractual total (principal + real total interest)
  nominalRemaining: number // totalBalance - totalPaid — "how much more cash will I hand over if I keep paying as scheduled," INCLUDING interest not yet accrued. This is deliberately the same figure the old flat model produced (validated directly against the person's own worked example: 9846.96 - 820.58 = 9026.38 after 2 real payments) — it was never a wrong NUMBER, only a wrong choice of which figure to headline as "remaining balance" elsewhere in the app.
  capitalRemaining: number // == summarizeLoan(loan, asOfDate).remainingBalance — the true amortised principal still owed (what a real lender's "balance" figure shows). Kept here too so a caller wanting BOTH figures (Home page pie chart, scope-confirmed "show both, clearly labelled" resolution) doesn't need two separate calls that could drift out of sync from different asOfDate values.
  amortisedTotalPayable: number // == amortisedTotalPayable(loan) — the REAL total cash this loan will take, after every overpayment already logged. The progress denominator (Adam, 2026-09-18).
  amortisedRemaining: number // amortisedTotalPayable - totalPaid — the real cash left to hand over on the current schedule. Unlike nominalRemaining this FALLS when an overpayment shortens the term, which is what Adam means by "the amortised amount remaining".
  percentPaid: number // totalPaid / amortisedTotalPayable x 100, clamped 0-100 — cash-progress against the REAL total, so it reaches exactly 100% at payoff however much was overpaid. Not principal-progress (see capitalRemaining for that instead).
}

/**
 * Consolidated view of a loan's progress by CASH PAID, as distinct from
 * `summarizeLoan`'s principal-balance view. Two genuinely different,
 * both-legitimate questions: "how much do I still truly owe" (capital,
 * what a bank app shows) vs "how much more will I ever hand over if I
 * keep paying as scheduled" (nominal, includes interest not yet accrued).
 * Both figures are real and neither is a bug — conflating them, or
 * silently picking one without labelling it, was the actual defect.
 */
export function summarizeLoanProgress(loan: Loan, asOfDate: Date = new Date()): LoanProgress {
  const totalBalance = nominalTotalPayable(loan)
  const schedule = buildLoanSchedule(loan)
  const asOfIso = toIso(asOfDate)
  // `+ unrecognisedOneOffOverpayments` — a lump already paid, but folded
  // into a period that has not arrived yet, is still cash the person has
  // handed over today. See that function for the reported bug.
  const totalPaid = round2(
    schedule.filter((e) => e.date <= asOfIso).reduce((sum, e) => sum + e.scheduledPayment + e.overpaymentApplied + e.recurringOverpaymentApplied, 0) +
      unrecognisedOneOffOverpayments(loan, schedule, asOfIso),
  )
  const capitalRemaining = summarizeLoan(loan, asOfDate).remainingBalance
  const nominalRemaining = round2(Math.max(0, totalBalance - totalPaid))
  // The progress pair, against the REAL total rather than the contractual
  // one — see amortisedTotalPayable for why the two denominators differ
  // and why a progress bar needs this one.
  const amortisedTotal = amortisedTotalPayable(loan, schedule)
  const amortisedRemaining = round2(Math.max(0, amortisedTotal - totalPaid))
  const percentPaid = amortisedTotal > 0 ? Math.min(100, (totalPaid / amortisedTotal) * 100) : 0
  return { totalPaid, totalBalance, nominalRemaining, capitalRemaining, amortisedTotalPayable: amortisedTotal, amortisedRemaining, percentPaid }
}


export interface LoanScheduleEntry {
  date: string // ISO date
  scheduledPayment: number // the regular monthly amount applied this period — principal + interest combined, i.e. the real cash paid (may be less than monthlyPayment on the final entry)
  interestApplied: number // the interest portion of scheduledPayment for this period, per the loan's resolved convention (0 for a 0%-rate/uncalibrated-and-self-consistent loan)
  overpaymentApplied: number // sum of any one-off LoanOverpayment amounts dated in this period, applied on top — 100% principal, no interest component (scope §9)
  recurringOverpaymentApplied: number // this period's standing/recurring overpayment, if the loan has one active for this date — same 0%-interest rule as above
  balanceAfter: number
}

const MAX_SCHEDULE_ENTRIES = 720 // 60 years — generous safety cap, not a real limit

/**
 * What a recurring overpayment's `amount` resolves to on a specific date,
 * once an `amountOverrides`/`amountHistory` entry exists — an exact-date
 * override wins outright (the "just a single payment" case), otherwise
 * mirrors resolveMonthlyPayment/resolveTemplateAmount's history walk
 * (later array index wins on an exact-date tie).
 */
export function resolveRecurringOverpaymentAmount(r: LoanRecurringOverpayment, dateIso: string): LoanRecurringOverpayment['amount'] {
  const override = r.amountOverrides?.find((o) => o.date === dateIso)
  if (override) return override.amount

  const candidates: { effectiveFrom: string; amount: LoanRecurringOverpayment['amount'] }[] = [...(r.amountHistory ?? [])]
  if (r.amountEffectiveFrom) candidates.push({ effectiveFrom: r.amountEffectiveFrom, amount: r.amount })
  if (candidates.length === 0) return r.amount

  const applicable = candidates
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c.effectiveFrom <= dateIso)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.index - a.index)
  return applicable[0]?.amount ?? r.amount
}

/**
 * Builds the patch for a PERMANENT ("all future payments") recurring-
 * overpayment amount change — preserves the old amount as a history
 * entry, mirroring applyLoanMonthlyPaymentChange/applyTemplateAmountChange.
 */
// UAT 2026-09-09 (retest-bills-just-single/all-future-samedate) — same
// fix as schedule.ts's applyTemplateAmountChange: a PERMANENT ("all
// future") change also clears any amountOverrides entry dated on/after
// `effectiveFrom`, so a prior single-occurrence override can't silently
// outlive a later standing change that was meant to cover it too.
// UAT 2026-09-09 (retest2-bills-single-before-allfuture-untouched) — same
// fix as schedule.ts's applyTemplateAmountChange: DROPS every existing
// candidate (amountHistory entries, and the current amount/
// amountEffectiveFrom pair) whose OWN effectiveFrom is on/after the new
// effectiveFrom, rather than just appending on top — otherwise a change
// recorded further in the future than a new, earlier-effective edit kept
// wrongly outranking it for any date on/after its own effectiveFrom. See
// that function's own comment for the full repro and reasoning; applies
// identically here.
export function applyRecurringOverpaymentAmountChange(
  r: LoanRecurringOverpayment,
  newAmount: LoanRecurringOverpayment['amount'],
  effectiveFrom: string,
): Pick<LoanRecurringOverpayment, 'amount' | 'amountEffectiveFrom' | 'amountHistory' | 'amountOverrides'> {
  const priorCandidates = [...(r.amountHistory ?? []), { effectiveFrom: r.amountEffectiveFrom ?? r.startDate, amount: r.amount }]
  return {
    amount: newAmount,
    amountEffectiveFrom: effectiveFrom,
    amountHistory: priorCandidates.filter((c) => c.effectiveFrom < effectiveFrom),
    amountOverrides: (r.amountOverrides ?? []).filter((o) => o.date < effectiveFrom),
  }
}

/**
 * Builds the patch for a SINGLE-occurrence ("just a single payment")
 * recurring-overpayment amount change — leaves the standing amount/
 * amountHistory completely untouched, only recording a one-date override.
 */
export function applyRecurringOverpaymentSingleAmountOverride(
  r: LoanRecurringOverpayment,
  amount: LoanRecurringOverpayment['amount'],
  date: string,
): Pick<LoanRecurringOverpayment, 'amountOverrides'> {
  const withoutExisting = (r.amountOverrides ?? []).filter((o) => o.date !== date)
  return { amountOverrides: [...withoutExisting, { date, amount }] }
}

/** The recurring overpayment amount for this exact payment date, given the balance remaining AFTER the scheduled payment and any one-off overpayment for that month — 0 if the loan has no recurring overpayment configured, this date falls outside its start/end window, or it's one of the individually paused dates (Phase 4). Percent-of-balance is deliberately computed fresh each period, never cached, same reasoning as a credit card's minimum payment: a fixed % of a shrinking balance shrinks in turn. */
export function recurringOverpaymentForDate(loan: Loan, dateIso: string, balanceAfterScheduledAndOneOff: number): number {
  const r = loan.recurringOverpayment
  if (!r || balanceAfterScheduledAndOneOff <= 0) return 0
  if (dateIso < r.startDate) return 0
  if (r.endDate && dateIso > r.endDate) return 0
  if (r.pausedDates?.includes(dateIso)) return 0
  const amount = resolveRecurringOverpaymentAmount(r, dateIso)
  if (amount.type === 'fixed') return round2(Math.min(amount.amount, balanceAfterScheduledAndOneOff))
  return round2((balanceAfterScheduledAndOneOff * amount.percent) / 100)
}

/**
 * Every date the recurring overpayment WOULD land on within
 * [rangeStart, rangeEnd] if nothing were paused — same purpose as
 * schedule.ts's scheduledTemplateDates: the pause picker needs to see a
 * currently-paused date too, so it can be unticked. Walks the loan's own
 * payment schedule (same monthly cadence buildLoanSchedule uses) and
 * keeps only the dates inside the recurring overpayment's start/end
 * window — deliberately ignoring pausedDates itself, unlike
 * recurringOverpaymentForDate above.
 */
/**
 * UAT 2026-09-09 (retest2-overpay-single-no-reamortise note) — used to
 * return the LOAN's own schedule dates directly (`e.date`), same bug as
 * recentAndUpcomingLoanRecurringOverpaymentDates fixed for the "which
 * payment" picker: the "manage paused payments" window showed/paused the
 * wrong day of the month whenever the overpayment's own real cadence
 * differs from the loan's. Now returns both the REAL date (for display
 * and for what the picker/pause-checklist UI should show) and the
 * underlying `periodDate` (what pausedDates/recurringOverpaymentForDate
 * actually compare against internally) — same duality as
 * recentAndUpcomingLoanRecurringOverpaymentDates, see its own comment.
 */
export function scheduledLoanRecurringOverpaymentRealDates(loan: Loan, rangeStart: Date, rangeEnd: Date): { date: string; periodDate: string }[] {
  const r = loan.recurringOverpayment
  if (!r) return []
  const schedule = buildLoanSchedule(loan)
  const realDates = recurringOverpaymentRealDates(loan, schedule)
  const rangeStartIso = toIso(rangeStart)
  const rangeEndIso = toIso(rangeEnd)
  return schedule
    .filter((e) => e.date >= rangeStartIso && e.date <= rangeEndIso && e.date >= r.startDate && (!r.endDate || e.date <= r.endDate))
    .map((e) => ({ date: realDates.get(e.date) ?? e.date, periodDate: e.date }))
    .filter((e) => !(r.scheduleFrom && e.date < r.scheduleFrom))
}

/**
 * What `loan.monthlyPayment` resolves to on a specific date, once a
 * `monthlyPaymentHistory` entry exists — mirrors schedule.ts's
 * resolveTemplateAmount exactly, including its tie-break-by-recording-
 * order rule (the LATER array index wins on an exact-date collision,
 * since a loan's first-ever payment edit routinely offers the loan's own
 * startDate as the very first picker option, which is also the fallback
 * "prior value" date applyLoanMonthlyPaymentChange records below — the
 * same real, not-just-theoretical collision resolveTemplateAmount's own
 * comment documents for Bills).
 */
export function resolveMonthlyPayment(loan: Loan, dateIso: string): number {
  const candidates: { effectiveFrom: string; amount: number }[] = [...(loan.monthlyPaymentHistory ?? [])]
  if (loan.monthlyPaymentEffectiveFrom) candidates.push({ effectiveFrom: loan.monthlyPaymentEffectiveFrom, amount: loan.monthlyPayment })
  if (candidates.length === 0) return loan.monthlyPayment

  const applicable = candidates
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c.effectiveFrom <= dateIso)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.index - a.index)
  return applicable[0]?.amount ?? loan.monthlyPayment
}

/**
 * Builds the patch to apply when a loan's own standing monthlyPayment
 * changes and the person has picked which payment it should take effect
 * from (LoanEditPanel's "which payment does this apply from" step) —
 * preserves the OLD amount as a history entry, exactly like
 * schedule.ts's applyTemplateAmountChange. Falls back to `startDate` (a
 * loan's own equivalent of a bill's anchorDate) for the very first edit's
 * "prior value" entry.
 */
// UAT 2026-09-09 (retest2-bills-single-before-allfuture-untouched) — same
// fix as schedule.ts's applyTemplateAmountChange (see its comment for the
// full repro): DROPS every existing candidate whose OWN effectiveFrom is
// on/after the new effectiveFrom, rather than just appending on top —
// otherwise a payment change recorded further in the future than a new,
// earlier-effective edit would keep wrongly outranking it for any date
// on/after its own effectiveFrom. Proactively applied here too even
// though not yet reported against this specific field — identical latent
// flaw, same fix, per Adam's own instruction to apply this consistently.
export function applyLoanMonthlyPaymentChange(
  loan: Loan,
  newAmount: number,
  effectiveFrom: string,
): Pick<Loan, 'monthlyPayment' | 'monthlyPaymentEffectiveFrom' | 'monthlyPaymentHistory'> {
  const priorCandidates = [...(loan.monthlyPaymentHistory ?? []), { effectiveFrom: loan.monthlyPaymentEffectiveFrom ?? loan.startDate, amount: loan.monthlyPayment }]
  return {
    monthlyPayment: newAmount,
    monthlyPaymentEffectiveFrom: effectiveFrom,
    monthlyPaymentHistory: priorCandidates.filter((c) => c.effectiveFrom < effectiveFrom),
  }
}

/** Reconciles pausedDates against a full desired-pause-set from the picker — same reconcile-the-whole-window logic as schedule.ts's setPausedTemplateOccurrences, just against a plain date list instead of RecurringOccurrenceOverride objects (Phase 4). */
export function setPausedLoanRecurringOverpaymentDates(loan: Loan, windowDates: string[], pausedDates: string[]): LoanRecurringOverpayment | undefined {
  if (!loan.recurringOverpayment) return undefined
  const windowSet = new Set(windowDates)
  const untouched = (loan.recurringOverpayment.pausedDates ?? []).filter((d) => !windowSet.has(d))
  return { ...loan.recurringOverpayment, pausedDates: [...untouched, ...pausedDates] }
}

/**
 * Builds the full month-by-month schedule from startDate, applying real
 * reducing-balance interest each period (via resolveLoanRateAndConvention)
 * before the payment, then any recorded overpayments as they fall due —
 * walking until the balance reaches zero. The final scheduled payment
 * absorbs any rounding, same as the old flat model.
 *
 * Interest accrues on the balance BEFORE that period's payment — this is
 * standard reducing-balance amortisation, and matches how both real
 * fixtures (Santander, Monzo) actually behave. The period the interest
 * accrues OVER runs from the previous payment date (or the loan's
 * advanceDate, for the very first period — falling back to startDate if
 * advanceDate wasn't given) to this payment's date; a convention that
 * doesn't day-weight (flat monthly) ignores that span's exact length,
 * one that does (daily simple) uses it precisely, stub period included.
 *
 * RECAST (scope §9): a ONE-OFF overpayment (LoanOverpayment) carries its
 * own recastMode. 'reduce_term' (the default) needs no special handling
 * at all here — the payment just stays `loan.monthlyPayment` and the
 * loop naturally reaches zero sooner. 'reduce_payment' is what needs the
 * `currentPayment` variable below to be genuinely mutable across the
 * walk: whenever a reduce_payment overpayment lands, this recomputes a
 * new payment (standardPayment) that clears the now-smaller balance over
 * however many periods remain until the loan's own real, fixed term ends
 * (termMonths - i) — anchored to the loan's actual agreed end date, not
 * re-derived from whatever payment happened to be in effect a moment
 * ago (that WAS the original approach, and it was a real bug — see the
 * inline comment at the call site for the runaway-feedback-loop failure
 * mode it caused).
 *
 * A RECURRING overpayment (LoanRecurringOverpayment) is ALWAYS treated as
 * reduce_term here, regardless of what its own `recastMode` field says
 * (UAT 2026-09-09, ed-overpay-just-single — Adam's own call, after a
 * single one-off *occurrence override* on a recurring overpayment
 * unexpectedly re-amortised every future contractual payment). Letting a
 * recurring reduce_payment fire fresh every single period it applies is
 * exactly the runaway-feedback-loop risk this comment already warned
 * about for the one-off case, compounded by firing repeatedly rather than
 * once — the UI no longer offers this choice for a recurring overpayment
 * at all (LoanRecurringOverpaymentEditForm always writes reduce_term),
 * and this ignores the field defensively for any already-persisted data
 * that predates that change.
 */
/**
 * The most recent past scheduled payment (if any) and the next 3 upcoming
 * ones — loan's own equivalent of schedule.ts's recentAndUpcomingOccurrences,
 * for the same "which payment should this apply from" picker-first flow
 * (UAT 2026-09-08, 7-bug8.2-confirm-loans note), reused for a pot's own
 * checklist toggle when the item being moved is a loan rather than a bill.
 */
export function recentAndUpcomingLoanPaymentDates(loan: Loan, asOfDate: Date): { date: string; isPast: boolean }[] {
  const schedule = buildLoanSchedule(loan).filter((s) => !(loan.scheduleFrom && s.date < loan.scheduleFrom))
  const asOfIso = toIso(asOfDate)
  const past = schedule.filter((s) => s.date <= asOfIso)
  const upcoming = schedule.filter((s) => s.date > asOfIso)
  const result: { date: string; isPast: boolean }[] = []
  if (past.length > 0) result.push({ date: past[past.length - 1].date, isPast: true })
  for (const s of upcoming.slice(0, 3)) result.push({ date: s.date, isPast: false })
  return result
}

export function buildLoanSchedule(loan: Loan): LoanScheduleEntry[] {
  if (!(loan.monthlyPayment > 0) || !(loan.termMonths > 0) || !(loan.principal > 0)) return []

  const { monthlyRate, convention } = resolveLoanRateAndConvention(loan)

  const schedule: LoanScheduleEntry[] = []
  let balance = loan.principal
  let currentPayment = loan.monthlyPayment
  const start = parseLocalDate(loan.startDate)
  let previousPeriodDate = parseLocalDate(loan.advanceDate ?? loan.startDate)
  // Overpayments logged before the loan's first scheduled payment aren't
  // nonsensical at all — confirmed as a real, common case: a person
  // often makes a voluntary extra payment in the gap between the loan
  // being advanced and the first contractual instalment being due (this
  // file's own earlier comment here wrongly assumed otherwise, and a real
  // overpayment logged in that exact gap was silently discarded as a
  // result — sameMonth() only ever matches a payment's calendar month
  // against ITS OWN scheduled payment dates, which starts at the first
  // payment's month and never looks backward, so anything dated in an
  // earlier month never gets a chance to match at all, for the lifetime
  // of the loop). Handled below: period 0 additionally catches anything
  // dated on or before its own payment date, not just same-month matches.
  const overpayments = loan.overpayments.slice().sort((a, b) => a.date.localeCompare(b.date))
  let overpaymentIndex = 0
  // Once a reduce_payment recast has ever fired for this loan, it fully
  // owns the payment figure from that point on — a monthlyPaymentHistory
  // entry describes a hypothetical standing payment the recast has
  // already superseded with a real, computed re-amortisation, so it's
  // deliberately never consulted again after this flips true (Adam's own
  // call on the interaction between the two mechanisms).
  let recastActive = false

  for (let i = 0; i < MAX_SCHEDULE_ENTRIES && balance > 0.005; i++) {
    const paymentDate = addMonths(start, i)
    const paymentDateIso = toIso(paymentDate)
    if (!recastActive) currentPayment = resolveMonthlyPayment(loan, paymentDateIso)

    const interestApplied = round2(convention.interestForPeriod(balance, previousPeriodDate, paymentDate, monthlyRate, loan.principal))
    const balanceWithInterest = round2(balance + interestApplied)
    // The loan's TERM is a fixed contractual fact (agreed with the lender
    // alongside the monthly payment) — it must never silently drift just
    // because a calibrated/back-solved rate doesn't reproduce EXACTLY the
    // schedule the real lender's own (unknowable in full precision)
    // method would. A rate off by a few ten-thousandths of a percentage
    // point — entirely normal calibration noise, especially from only 1-2
    // real statement lines — is enough to leave a stray extra payment
    // dangling past the agreed term otherwise (confirmed directly: 24
    // periods becomes 25 from a rate difference of 0.0007 points). Once
    // the contractually-final period is reached, force it to clear the
    // balance outright, regardless of currentPayment — the "final payment
    // absorbs the rounding" principle this file already promised, now
    // actually enforced against the TERM, not just against the balance
    // naturally reaching zero. A loan finishing EARLY (overpayments/
    // recast) is unaffected — the loop's own `balance > 0.005` exit
    // already handles that on its own, before this is ever reached.
    const isFinalContractualPeriod = i >= loan.termMonths - 1
    const scheduledPayment = round2(isFinalContractualPeriod ? balanceWithInterest : Math.min(currentPayment, balanceWithInterest))
    balance = round2(balanceWithInterest - scheduledPayment)
    previousPeriodDate = paymentDate

    // Sum any overpayments dated in this payment's month and apply them
    // on top of the scheduled payment — this is what lets the term
    // shrink instead of drifting away from reality (doc Section 3.2).
    // An overpayment carries no interest component at all (scope §9) —
    // it's not part of the contractual instalment structure, so it comes
    // straight off the balance already reduced by this period's real
    // payment above, not off a separately-interest-bearing sub-amount.
    let overpaymentApplied = 0
    let recastToReducePayment = false
    while (
      overpaymentIndex < overpayments.length &&
      (sameMonth(parseLocalDate(overpayments[overpaymentIndex].date), paymentDate) || (i === 0 && parseLocalDate(overpayments[overpaymentIndex].date) <= paymentDate))
    ) {
      overpaymentApplied += overpayments[overpaymentIndex].amount
      if (overpayments[overpaymentIndex].recastMode === 'reduce_payment') recastToReducePayment = true
      overpaymentIndex++
    }
    balance = round2(Math.max(0, balance - overpaymentApplied))

    const recurringOverpaymentApplied = recurringOverpaymentForDate(loan, paymentDateIso, balance)
    // Deliberately never reads loan.recurringOverpayment?.recastMode —
    // see this function's own doc comment above.
    balance = round2(Math.max(0, balance - recurringOverpaymentApplied))

    // If either kind of overpayment landing this period asked to recast
    // to "reduce payment" (rather than the reduce_term default), find
    // the new payment now.
    //
    // periodsRemaining is anchored to the loan's own real, fixed term
    // (termMonths - i) — NOT remainingPeriodsFor(balance, rate, currentPayment)
    // as this used to be. Confirmed as a serious, real bug: for a
    // RECURRING reduce_payment overpayment, this recast fires fresh every
    // single period, each time feeding the ALREADY-shrunk currentPayment
    // from last time back into remainingPeriodsFor. A smaller payment
    // implies a LONGER payoff horizon, which gets recast into an even
    // smaller payment next time, which implies an even longer horizon
    // than that — a runaway feedback loop completely decoupled from the
    // loan's actual agreed term. The outer loop still hard-stops at the
    // real term regardless (isFinalContractualPeriod above), so by the
    // final period the balance hadn't been paying down fast enough to
    // reach zero on schedule, and the "final period clears whatever's
    // left" rule dumped the entire shortfall into one payment — confirmed
    // directly: a real loan's supposedly-£350-ish payments decayed for 23
    // months down to £180, then the 24th period jumped to £2,116.95.
    // Anchoring to the loan's real remaining term instead means the
    // recast payment is always sized to clear the balance by the loan's
    // TRUE end date, however many times it's already recast before.
    if (recastToReducePayment && balance > 0.005) {
      const periodsRemaining = Math.max(1, loan.termMonths - i)
      currentPayment = round2(standardPayment(balance, monthlyRate, periodsRemaining))
      recastActive = true
    }

    schedule.push({
      date: paymentDateIso,
      scheduledPayment: round2(scheduledPayment),
      interestApplied,
      overpaymentApplied: round2(overpaymentApplied),
      recurringOverpaymentApplied,
      balanceAfter: balance,
    })
  }

  return schedule
}

// ── Recast preview (loan-amortisation-engine scope §9, D7's follow-up
// step) ──────────────────────────────────────────────────────────────

export interface RecastOptionPreview {
  payoffDate: string | null // relevant to the "keep monthly payment" (reduce_term) option
  finalPayment: number | null // ditto — the schedule's real final payment, which the last-period rounding absorption usually makes smaller than the regular one
  newMonthlyPayment: number | null // relevant to the "keep the same length" (reduce_payment) option — the payment in effect for the FIRST period after this overpayment recasts, not necessarily every later period (a recurring reduce_payment overpayment keeps changing it further)
}

export interface RecastPreview {
  reduceTerm: RecastOptionPreview
  reducePayment: RecastOptionPreview
}

function summarizeRecastPreview(schedule: LoanScheduleEntry[], afterDateIso: string): RecastOptionPreview {
  if (schedule.length === 0) return { payoffDate: null, finalPayment: null, newMonthlyPayment: null }
  // Recast deliberately takes effect from the period AFTER the one an
  // overpayment lands on (matches the one-off case's own documented
  // behaviour) — so the landing period itself still shows the OLD,
  // unchanged payment; the recast is only visible from the entry after
  // THAT. Confirmed as a real, misleading bug otherwise: a real
  // recurring reduce_payment case previewed "New monthly payment:
  // £427.57" — identical to the current, un-recast payment — even
  // though the payment genuinely does drop, just one period later.
  //
  // The landing period is found by checking which entry ACTUALLY has a
  // non-zero overpayment applied — not by comparing dates against
  // `afterDateIso` directly. Those two are usually the same period, but
  // not always: when `afterDateIso` happens to fall exactly ON a real
  // payment date (as a one-off overpayment's own date routinely does),
  // "the first entry strictly after afterDateIso" skips past the
  // landing period entirely, landing an extra period too far ahead.
  // Checking for the real applied amount sidesteps that date-comparison
  // off-by-one regardless of how afterDateIso happens to align.
  const landingIndex = schedule.findIndex((e) => e.date >= afterDateIso && (e.overpaymentApplied > 0 || e.recurringOverpaymentApplied > 0))
  const changedEntry = landingIndex >= 0 ? (schedule[landingIndex + 1] ?? schedule[landingIndex]) : null
  return {
    payoffDate: schedule.at(-1)!.date,
    finalPayment: schedule.at(-1)!.scheduledPayment,
    newMonthlyPayment: changedEntry ? changedEntry.scheduledPayment : schedule.at(-1)!.scheduledPayment,
  }
}

/**
 * Previews both recast outcomes for a NOT-YET-LOGGED one-off overpayment,
 * so the follow-up step (D7) can show a real summary for each button
 * before the person picks one — "keep the same length -> what's my new
 * monthly payment" and "keep monthly -> when does it end / what's the
 * final repayment." Reuses buildLoanSchedule directly for both (rather
 * than any separate preview maths) — same "one source of truth" the
 * scope doc insists on for the real, already-logged case.
 */
export function previewOverpaymentRecast(loan: Loan, amount: number, date: string): RecastPreview {
  const reduceTermLoan: Loan = { ...loan, overpayments: [...loan.overpayments, { id: '__preview__', date, amount, recastMode: 'reduce_term' }] }
  const reducePaymentLoan: Loan = { ...loan, overpayments: [...loan.overpayments, { id: '__preview__', date, amount, recastMode: 'reduce_payment' }] }
  return {
    reduceTerm: summarizeRecastPreview(buildLoanSchedule(reduceTermLoan), date),
    reducePayment: summarizeRecastPreview(buildLoanSchedule(reducePaymentLoan), date),
  }
}

/** Same as previewOverpaymentRecast, for a not-yet-saved RECURRING overpayment — scope §11.3 explicitly extended the recast choice to recurring, not just one-off. */
export function previewRecurringOverpaymentRecast(loan: Loan, recurring: LoanRecurringOverpayment): RecastPreview {
  const reduceTermLoan: Loan = { ...loan, recurringOverpayment: { ...recurring, recastMode: 'reduce_term' } }
  const reducePaymentLoan: Loan = { ...loan, recurringOverpayment: { ...recurring, recastMode: 'reduce_payment' } }
  return {
    reduceTerm: summarizeRecastPreview(buildLoanSchedule(reduceTermLoan), recurring.startDate),
    reducePayment: summarizeRecastPreview(buildLoanSchedule(reducePaymentLoan), recurring.startDate),
  }
}

// ── Loan ledger modal (loan-amortisation-engine scope §10) ─────────────

export type LoanLedgerRowType = 'Monthly Repayment' | 'Ad-hoc Overpayment' | 'Recurring Overpayment'

export interface LoanLedgerRow {
  date: string
  type: LoanLedgerRowType
  amount: number
  capital: number
  interest: number
  balanceAfter: number
}

/**
 * Explodes buildLoanSchedule's one-entry-per-period shape into one row
 * PER DATED EVENT (scope §10) — a period with both a regular payment and
 * an overpayment becomes two (or three) separate rows, not one folded
 * together, so the three payment types stay visually distinguishable
 * (three distinct labels, not a generic "Overpayment," per scope). Both
 * overpayment row types always show £0 interest — the confirmed rule
 * from scope §9. Intermediate balances are reconstructed by adding back
 * whichever later-in-period components haven't happened yet, since
 * buildLoanSchedule's own balanceAfter already nets out all three in the
 * same order (regular payment, then one-off overpayment, then recurring
 * overpayment) — this is read-only display maths, not a second
 * calculation of the schedule itself.
 */
/**
 * The recurring overpayment's OWN real dated occurrences — confirmed as a
 * genuine, serious gap, not a re-surfacing of the earlier stub-period
 * bug: recurringOverpaymentForDate only ever used `startDate` as a
 * FILTER ("has this started yet") against the LOAN's own payment dates,
 * never as its own independent monthly cadence. A person setting a
 * recurring overpayment to start "21 Aug" — genuinely wanting it to
 * recur on the 21st of every month, e.g. matching their payday, not the
 * 2nd their loan happens to be due on — saw every single occurrence
 * dated on the 2nd throughout the app instead, in both the ledger modal
 * and the Home page summary. Confirmed directly against a real loan.
 *
 * The loan's own contractual payment dates remain the backbone for
 * interest/amortisation math in buildLoanSchedule — that's tied to the
 * agreed monthly cycle and doesn't change. What changes here is DISPLAY:
 * each loan period's aggregate recurringOverpaymentApplied is mapped
 * back to the real calendar date the recurring overpayment's own
 * monthly cadence actually fell on, for whoever is reading the ledger
 * row or transaction rather than the internal amortisation entry.
 * Reliable because both cadences are monthly: there's exactly one real
 * recurring-overpayment date inside the (previous period, this period]
 * window for any period where the aggregate is non-zero.
 */
export function recurringOverpaymentRealDates(loan: Loan, schedule: LoanScheduleEntry[]): Map<string, string> {
  const map = new Map<string, string>() // schedule entry date -> real recurring-overpayment date
  const r = loan.recurringOverpayment
  if (!r) return map

  // The k-th overpayment date is counted from startDate, not stepped from
  // the previous one: stepping stuck a 31st on the 28th after February
  // (2026-09-16). date-fns addMonths clamps to the month's last day.
  const overpaymentStart = parseLocalDate(r.startDate)
  let monthsFromStart = 0
  let cursor = overpaymentStart
  let previousPeriodDate = parseLocalDate(loan.advanceDate ?? loan.startDate)
  let iterations = 0

  for (const entry of schedule) {
    // UAT 2026-09-09 (retest3-overpay-pause-still-works) — gate on the
    // overpayment's own active DATE WINDOW (start/end), not on whether it
    // actually applied that period. Confirmed as a real, reported bug:
    // gating on `entry.recurringOverpaymentApplied > 0` meant a PAUSED
    // period (which `recurringOverpaymentForDate` correctly zeroes out)
    // got no real-date mapping at all, so callers fell back to the
    // loan's own period date for that one row — pausing a date flipped
    // its displayed date to the loan's, while every other (unpaused) row
    // stayed correct. Same "ignore pausedDates entirely, a paused date
    // still has to appear correctly so it can be unpaused" principle
    // scheduledLoanRecurringOverpaymentRealDates's own date-window filter
    // already follows — this is the other half of that same fix.
    const inWindow = entry.date >= r.startDate && (!r.endDate || entry.date <= r.endDate)
    if (!inWindow) {
      previousPeriodDate = parseLocalDate(entry.date)
      continue
    }
    // Advance the recurring overpayment's own cadence until it lands
    // inside this period's window — normally the very first step,
    // since both cadences are monthly.
    while (toIso(cursor) <= toIso(previousPeriodDate) && iterations < MAX_SCHEDULE_ENTRIES) {
      cursor = addMonths(overpaymentStart, ++monthsFromStart)
      iterations++
    }
    map.set(entry.date, toIso(cursor))
    previousPeriodDate = parseLocalDate(entry.date)
  }

  return map
}

export function buildLoanLedgerRows(loan: Loan): LoanLedgerRow[] {
  const schedule = buildLoanSchedule(loan)
  const recurringDates = recurringOverpaymentRealDates(loan, schedule)
  const rows: LoanLedgerRow[] = []

  for (const entry of schedule) {
    if (entry.scheduledPayment > 0) {
      rows.push({
        date: entry.date,
        type: 'Monthly Repayment',
        amount: entry.scheduledPayment,
        capital: round2(entry.scheduledPayment - entry.interestApplied),
        interest: entry.interestApplied,
        balanceAfter: round2(entry.balanceAfter + entry.overpaymentApplied + entry.recurringOverpaymentApplied),
      })
    }
    if (entry.overpaymentApplied > 0) {
      rows.push({
        date: entry.date,
        type: 'Ad-hoc Overpayment',
        amount: entry.overpaymentApplied,
        capital: entry.overpaymentApplied,
        interest: 0,
        balanceAfter: round2(entry.balanceAfter + entry.recurringOverpaymentApplied),
      })
    }
    if (entry.recurringOverpaymentApplied > 0) {
      rows.push({
        date: recurringDates.get(entry.date) ?? entry.date,
        type: 'Recurring Overpayment',
        amount: entry.recurringOverpaymentApplied,
        capital: entry.recurringOverpaymentApplied,
        interest: 0,
        balanceAfter: entry.balanceAfter,
      })
    }
  }

  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

function monthDiff(fromIso: string, toIso: string): number {
  const [fy, fm] = fromIso.split('-').map(Number)
  const [ty, tm] = toIso.split('-').map(Number)
  return (fy - ty) * 12 + (fm - tm)
}

export interface LoanFinishInfo {
  finishDate: string | null // real finish date (or the loan's real closedDate if settled early) — null if the loan can't be scheduled at all (e.g. no principal)
  monthsEarly: number // vs the NOMINAL schedule (no overpayments) — 0 if there's nothing to compare, or the real finish isn't actually earlier
  settledEarly: boolean // true when the loan was manually settled (scope §7) rather than paid off through its own schedule
}

/**
 * Powers the ledger modal's finish-date banner (scope §10) — "Finishes:
 * March 2028 (2 months early due to overpayments)" — computed live from
 * the real schedule against the NOMINAL one (overpayments stripped,
 * same construction nominalTotalPayable already uses), not a static
 * term-based estimate.
 */
export function loanFinishInfo(loan: Loan): LoanFinishInfo {
  if (!loan.active) return { finishDate: loan.closedDate ?? null, monthsEarly: 0, settledEarly: true }

  const schedule = buildLoanSchedule(loan)
  if (schedule.length === 0) return { finishDate: null, monthsEarly: 0, settledEarly: false }

  const nominalLoan: Loan = { ...loan, overpayments: [], recurringOverpayment: undefined }
  const nominalSchedule = buildLoanSchedule(nominalLoan)
  const finishDate = schedule.at(-1)!.date
  const nominalFinishDate = nominalSchedule.at(-1)?.date ?? finishDate
  const monthsEarly = Math.max(0, monthDiff(nominalFinishDate, finishDate))

  return { finishDate, monthsEarly, settledEarly: false }
}

export interface LoanSummary {
  totalPayable: number
  remainingBalance: number
  payoffDate: string | null // ISO date of the final schedule entry, or null if there's no schedule
  monthsRemaining: number
}

export function summarizeLoan(loan: Loan, asOfDate: Date = new Date()): LoanSummary {
  const totalPayable = nominalTotalPayable(loan)

  // A settled/closed loan (scope §7) reports zero remaining regardless of
  // what the mechanical schedule would otherwise predict — settleLoan
  // below is a deliberate manual override ("the actual amount paid to
  // settle... may genuinely differ from the app's settlement estimate"),
  // not something buildLoanSchedule's own maths should have to model.
  if (!loan.active) {
    return { totalPayable, remainingBalance: 0, payoffDate: loan.closedDate ?? null, monthsRemaining: 0 }
  }

  const schedule = buildLoanSchedule(loan)

  if (schedule.length === 0) {
    return { totalPayable, remainingBalance: totalPayable, payoffDate: null, monthsRemaining: 0 }
  }

  const asOfIso = toIso(asOfDate)
  const lastPast = schedule.filter((e) => e.date <= asOfIso).at(-1)
  // If asOfDate falls before the loan's very first scheduled payment
  // (e.g. checking a loan's balance the day it's created, or during its
  // stub period before the first payment posts), NO period has actually
  // been recognised yet — the true balance is simply the untouched
  // principal, not principal + schedule[0]'s not-yet-recognised interest.
  // (Bug found via verify-loan-scenarios-interest.ts: this fallback used
  // to reconstruct schedule[0].balanceAfter + schedule[0].scheduledPayment,
  // which equals principal + schedule[0]'s interest — correct only in the
  // old flat, interest-free model this formula predates, where that
  // extra term was always zero.)
  // A one-off overpayment already PAID, but absorbed by a period that has
  // not been reached yet, has genuinely reduced the capital owed today
  // even though `lastPast.balanceAfter` predates it — and it is 100%
  // principal, so it comes straight off. Clamped at zero: a lump big
  // enough to clear the loan leaves nothing owed, never a negative
  // balance. See unrecognisedOneOffOverpayments for the reported bug.
  const unrecognised = unrecognisedOneOffOverpayments(loan, schedule, asOfIso)
  const remainingBalance = Math.max(0, (lastPast ? lastPast.balanceAfter : loan.principal) - unrecognised)
  const monthsRemaining = schedule.filter((e) => e.date > asOfIso).length

  return {
    totalPayable,
    remainingBalance: round2(remainingBalance),
    payoffDate: schedule.at(-1)!.date,
    monthsRemaining,
  }
}

/**
 * The default early-settlement multiplier 'k' (scope §6) — matches the
 * general UK statutory cap on what a lender can add for a loan with more
 * than 12 months remaining (k=2), or 12 or fewer (k=1). Only used when
 * the loan hasn't calibrated its own settlementMultiplier against a real
 * settlement quote yet.
 */
export function defaultSettlementMultiplier(monthsRemaining: number): number {
  return monthsRemaining > 12 ? 2 : 1
}

/**
 * Estimated early-settlement figure (scope §6): `balance × (1 + k ×
 * monthlyRate)`. Purely informational everywhere on the loan's own page
 * — shown alongside the true outstanding balance, never replacing it;
 * only What-if's loan-payoff scenario (a future session, scope §8)
 * actually treats this as "the amount needed to clear the loan." Returns
 * 0 once the loan is inactive/fully repaid — there's nothing left to
 * settle.
 */
export function estimateSettlementFigure(loan: Loan, asOfDate: Date = new Date()): number {
  const summary = summarizeLoan(loan, asOfDate)
  if (summary.remainingBalance <= 0) return 0
  const { monthlyRate } = resolveLoanRateAndConvention(loan)
  const k = loan.settlementMultiplier ?? defaultSettlementMultiplier(summary.monthsRemaining)
  return round2(summary.remainingBalance * (1 + k * monthlyRate))
}

/**
 * Logs the real, actual amount paid to close a loan early (scope §7) —
 * which may genuinely differ from estimateSettlementFigure above — as a
 * real cleared transaction, and marks the loan inactive with a
 * closedDate so summarizeLoan reports it as fully repaid from this point
 * on, regardless of what its mechanical schedule would have predicted.
 * Deliberately does NOT touch loan.overpayments — the settlement is its
 * own distinct event (sourceType 'loan_settlement'), not one more
 * overpayment for buildLoanSchedule to reconcile against.
 */
export function settleLoan(loan: Loan, actualAmountPaid: number, date: string, note?: string): { updatedLoan: Loan; transaction: Omit<Transaction, 'id'> } {
  const updatedLoan: Loan = { ...loan, active: false, closedDate: date, settledAmount: actualAmountPaid }
  const transaction: Omit<Transaction, 'id'> = {
    date,
    amount: actualAmountPaid,
    direction: 'out',
    categoryId: loan.categoryId,
    paymentMethod: 'bank_transfer',
    status: 'cleared',
    type: 'loan_payment',
    // A settlement is a one-off lump payoff, same as an overpayment
    // (Adam-specified, 2026-09-03: "certainly not lump sums" — a pot
    // never funds a one-off payment, only a loan's regular monthly
    // payment or its recurring overpayment can be). Falls back to
    // 'personal' when the loan's own location is 'pot'; a joint loan's
    // own 'joint' location is unaffected (a real, splittable joint
    // expense, unlike a pot-funded one which can't be split at all) —
    // see applyLoanOverpayment's identical fallback just below for the
    // full reasoning.
    location: loan.location === 'pot' ? 'personal' : loan.location,
    ownerId: loan.ownerId,
    payee: loan.payee,
    payeeSharePercent: loan.payeeSharePercent,
    sourceType: 'loan_settlement',
    sourceId: loan.id,
    note: note ?? `${loan.name} — settled early`,
  }
  return { updatedLoan, transaction }
}

// ── Calibration (loan-amortisation-engine scope §5.3/§5.4) ─────────────

/** Cap at 5 statement lines (scope §5.3, step 1) — 2-3 is normally enough to distinguish between known conventions and average out rounding noise; the UI enforces this too (disables "add another line" once 5 are stored), this is the defensive engine-level backstop. */
export const MAX_CALIBRATION_LINES = 5

// scope §11.1 was explicit that this should NOT be a carefully-tuned
// number from day one — a sample size of two real loans isn't enough to
// justify precision. This is the average absolute pence-error-per-line
// that currently separates "this clearly matches a known convention"
// (both real fixtures: Santander ~£0.00/line, Monzo ~£0.12/line once
// fitted) from "this doesn't obviously match anything we know." Tune
// this constant as more real loans get calibrated, per the scope doc's
// own resolution of this exact open question — don't treat it as load-bearing.
const CONFIDENT_FIT_MAX_AVERAGE_ERROR_PER_LINE = 0.5
// A single line is mathematically guaranteed to fit ANY convention
// trivially (one line, one free parameter) — see calibrateLoanFromStatementLines's
// own comment for the confirmed real-world consequence of not having this
// guard. Shared here so isLoanConfidentlyCalibrated (which independently
// re-derives confidence from stored lines, not a stored flag) can't drift
// out of sync with the actual calibration flow's own rule.
const MIN_LINES_FOR_CONFIDENCE = 2

export type CalibrationConfidence = 'confident' | 'low_first' | 'low_repeated'

export interface CalibrationResult {
  updatedLoan: Loan
  confidence: CalibrationConfidence
  // scope §5.4's exact wording for each low-confidence stage — null once confident. UI displays this verbatim, doesn't paraphrase it.
  message: string | null
}

/**
 * Merges newly-entered statement lines with whatever's already stored
 * against this loan (never just the newest addition — scope §5.3 step
 * 2), re-fits every known convention's own best rate against the WHOLE
 * accumulated set (calibrateRateAndConvention — closed-form regression,
 * no LLM, no guessing, scope §5.1), and keeps whichever convention fits
 * best. The "small residual correction" scope §5.3 step 4 describes
 * (the displayed APR being rounded to 2dp, so the true rate sits a hair
 * either side) isn't a separate step here — fitting against real
 * reported figures rather than assuming the formula-derived rate
 * already closes that gap by construction.
 *
 * Confidence (scope §5.4): a fit whose average error per line exceeds
 * CONFIDENT_FIT_MAX_AVERAGE_ERROR_PER_LINE is flagged rather than
 * silently presented as gospel — the FIRST such result offers to add
 * more lines; once 4+ lines are already in play and it's STILL a poor
 * fit, the message changes to make clear more data won't help (matches
 * scope's "more data only resolves ambiguity between known candidates or
 * rounding noise — if the real convention isn't in the library at all,
 * no amount of additional data converges on it").
 */
export function calibrateLoanFromStatementLines(loan: Loan, newLines: StatementCalibrationLine[]): CalibrationResult {
  const merged = [...(loan.statementCalibrationLines ?? []), ...newLines].sort((a, b) => a.date.localeCompare(b.date)).slice(0, MAX_CALIBRATION_LINES)

  const advanceDateIso = loan.advanceDate ?? loan.startDate
  const ranked = calibrateRateAndConvention(advanceDateIso, loan.principal, merged)
  const best = ranked[0]
  const averageErrorPerLine = merged.length > 0 ? best.error / merged.length : Infinity
  // Confirmed as a real, mathematically-guaranteed problem, not a
  // theoretical one: with exactly 1 line, every candidate convention has
  // exactly one free parameter (its rate) and exactly one data point to
  // fit it against — the fit is trivially exact (~£0 error) BY
  // CONSTRUCTION, for every convention, regardless of whether the line
  // is even real or correct. Reproduced directly: a single line with
  // capital and interest deliberately SWAPPED still reported "confident."
  // A single line carries no genuine signal about which convention is
  // right — it can't, structurally — so no amount of low error from just
  // one line is allowed to count as confident, however small.
  const confident = merged.length >= MIN_LINES_FOR_CONFIDENCE && averageErrorPerLine <= CONFIDENT_FIT_MAX_AVERAGE_ERROR_PER_LINE

  // Confirmed directly against a real loan: a day-weighted convention
  // (e.g. daily_simple, Monzo's) needs the loan's real advance date to
  // fit AT ALL — without it, the fallback anchor (startDate/first payment
  // date) makes the very first calibration line's period length wrong,
  // and the fit falls apart completely (in one real test, average error
  // per line went from 7p to over £7 just from this one missing field).
  // "Advance date" is labelled optional on the form because a flat-rate
  // lender genuinely doesn't need it — but there's no way to know that in
  // advance, and nothing else hints that a bad fit might be fixed by
  // filling in a field labelled "optional." Worth surfacing directly
  // rather than leaving the person to guess.
  const missingAdvanceDate = !loan.advanceDate
  const advanceDateHint = missingAdvanceDate
    ? " This loan doesn't have an Advance date set — some lenders' interest calculations depend on it even though it's optional on the form, and adding it here could improve the fit."
    : ''

  const confidence: CalibrationConfidence = confident ? 'confident' : merged.length < 4 ? 'low_first' : 'low_repeated'
  const message =
    confidence === 'low_first'
      ? `We couldn't determine a close enough estimate on how interest rates are being calculated on this loan — these figures are the closest we could produce.${advanceDateHint}`
      : confidence === 'low_repeated'
        ? missingAdvanceDate
          ? `This still doesn't match a pattern we recognise.${advanceDateHint}`
          : "This still doesn't match a pattern we recognise — the estimate above is our closest fit, and adding more statements is unlikely to improve it further."
        : null

  // Confirmed as a serious, real bug: this used to write interestConventionId
  // /calibratedMonthlyRate unconditionally, even on a LOW-CONFIDENCE fit —
  // meaning a bad attempt (too few lines, mis-entered figures, a genuinely
  // unrecognised convention) immediately became the rate driving the
  // loan's REAL schedule/balance maths, silently, while the UI kept
  // showing the red "not confidently calibrated" warning as if nothing
  // had changed. In one real case this produced a wildly wrong rate that
  // sent the balance into six figures on a ~£9,400 loan — the calibration
  // status badge said "still needs calibrating" while the actual numbers
  // had already been corrupted underneath it. A low-confidence fit must
  // never be trusted to drive real numbers — that's the entire point of
  // having a confidence concept — so only a CONFIDENT fit is allowed to
  // update the working rate/convention below; anything else leaves both
  // exactly as they were (the safe fallback, or a still-good earlier
  // confident calibration), while still saving the raw lines so the
  // person's data isn't lost and more can be added to try again.
  const updatedLoan: Loan = {
    ...loan,
    statementCalibrationLines: merged,
    ...(confident ? { interestConventionId: best.convention.id, calibratedMonthlyRate: best.monthlyRate } : {}),
  }

  return { updatedLoan, confidence, message }
}

/**
 * Whether a loan's CURRENTLY STORED calibration (if any) is confident —
 * re-derives this from `statementCalibrationLines` rather than persisting
 * a confidence flag directly on the loan, so it can never silently go
 * stale if the lines or the convention library themselves ever change.
 * Cheap: the same closed-form fit calibration itself already runs, just
 * without merging in any new lines. Used by the UI (Loans.tsx) to decide
 * whether the "Calibrate" control should still be offered at all — once
 * this is true, the loan has a genuinely trustworthy fit and doesn't need
 * re-prompting, though the person can still choose to add more lines for
 * extra precision if they want (see the calibration modal itself).
 */
export function isLoanConfidentlyCalibrated(loan: Loan): boolean {
  const lines = loan.statementCalibrationLines
  if (!lines || lines.length < MIN_LINES_FOR_CONFIDENCE) return false
  const advanceDateIso = loan.advanceDate ?? loan.startDate
  const best = calibrateRateAndConvention(advanceDateIso, loan.principal, lines)[0]
  return best.error / lines.length <= CONFIDENT_FIT_MAX_AVERAGE_ERROR_PER_LINE
}

/**
 * Finds an existing loan from the same lender that's already been
 * calibrated (or confidently back-solved), so a NEW loan from that
 * lender can offer to reuse its convention/rate/settlement-multiplier
 * profile straight away instead of starting from scratch (scope §5.3
 * step 5's "offering to carry the same profile forward"). Case/whitespace
 * insensitive since it's free text the person types twice.
 */
export function findLenderCalibrationProfile(loans: Loan[], lender: string): Pick<Loan, 'interestConventionId' | 'calibratedMonthlyRate' | 'settlementMultiplier'> | null {
  const needle = lender.trim().toLowerCase()
  if (!needle) return null
  const match = loans.find((l) => l.lender?.trim().toLowerCase() === needle && l.calibratedMonthlyRate != null)
  if (!match) return null
  return { interestConventionId: match.interestConventionId, calibratedMonthlyRate: match.calibratedMonthlyRate, settlementMultiplier: match.settlementMultiplier }
}

/**
 * Generates pending loan_payment transactions for scheduled entries within
 * a date range — same "compute what should exist, caller dedupes"
 * contract as schedule.ts's generateTransactionsForTemplate.
 *
 * A recurring overpayment gets its OWN transaction, separate from that
 * period's regular payment — confirmed as a real bug, not the intended
 * design, despite this file's own older comment (now corrected) claiming
 * otherwise: a person testing this directly found their recurring
 * overpayment quietly inflating the regular payment's amount rather than
 * showing as its own line, which is inconsistent with a ONE-OFF logged
 * overpayment (applyLoanOverpayment) already always getting its own
 * transaction, and with the loan ledger modal already treating all three
 * kinds (regular/ad-hoc/recurring) as distinct row types. Two generated
 * transactions on the same date dedupe independently, via distinct
 * sourceType values on the same loan id — see dedupeKey in projection.ts.
 *
 * A one-off logged overpayment stays exactly as it was — its own separate
 * transaction, created once at the point it's logged (applyLoanOverpayment),
 * not generated here at all.
 *
 * A closed loan (active: false) generates nothing further — same pattern
 * as creditCards.ts's generateMinimumPaymentTransactions.
 */
export function generateLoanPaymentTransactions(loan: Loan, rangeStart: Date, rangeEnd: Date): Omit<Transaction, 'id'>[] {
  if (!loan.active) return []
  const startIso = toIso(rangeStart)
  const endIso = toIso(rangeEnd)
  const results: Omit<Transaction, 'id'>[] = []

  // Computed over the FULL schedule, not date-filtered — the recurring
  // overpayment's own monthly cadence has to chain correctly from its
  // real startDate regardless of which slice of the loan's life this
  // particular call is asking about, same reasoning as
  // buildLoanLedgerRows's identical use of this map.
  const fullSchedule = buildLoanSchedule(loan)
  const recurringDates = recurringOverpaymentRealDates(loan, fullSchedule)

  // Deliberately NOT pre-filtering fullSchedule by [startIso, endIso]
  // before this loop — confirmed as a real, serious bug when it was
  // structured that way: a recurring overpayment's REAL date can fall
  // WELL BEFORE the loan's own contractual period it's aggregated into
  // for interest purposes (e.g. an overpayment on the 21st gets folded
  // into the loan's own NEXT payment on the 2nd of the following month —
  // see recurringOverpaymentRealDates's own comment). Pre-filtering on
  // the schedule entry's date meant that whenever the loan's own period
  // date fell just outside a requested window (e.g. the 2nd of next
  // month, just past "this cycle" ending on the 30th) but the
  // overpayment's REAL date was comfortably inside it (the 21st), the
  // whole entry was discarded before its real date was ever checked —
  // reproduced directly: "This cycle" showed nothing at all for a
  // recurring overpayment that "Next 3 cycles" displayed correctly.
  // Each row below now checks its OWN real display date against the
  // range independently, since a scheduled payment and its
  // period-mate's recurring overpayment can legitimately fall on
  // opposite sides of a window boundary.
  for (const e of fullSchedule) {
    // Before scheduleFrom is stored history from an earlier schedule — see Loan.scheduleFrom.
    if (e.scheduledPayment > 0 && e.date >= startIso && e.date <= endIso && !(loan.scheduleFrom && e.date < loan.scheduleFrom)) {
      results.push({
        date: e.date,
        amount: round2(e.scheduledPayment),
        direction: 'out',
        categoryId: loan.categoryId,
        paymentMethod: 'direct_debit',
        status: 'pending',
        type: 'loan_payment',
        location: loan.location,
        ownerId: loan.ownerId,
        payee: loan.payee,
        payeeSharePercent: loan.payeeSharePercent,
        potId: loan.location === 'pot' ? loan.potId : undefined,
        sourceType: 'loan',
        sourceId: loan.id,
        // The loan's own name — without it, a row falls back to its
        // category's name, duplicating the category group header when
        // viewed grouped by category.
        note: loan.name,
      })
    }
    if (e.recurringOverpaymentApplied > 0) {
      // The recurring overpayment's own real date (see
      // recurringOverpaymentRealDates's comment) — confirmed as a real
      // bug otherwise: this always showed on the loan's own payment
      // date throughout the Home page summary, even when the person
      // had deliberately set the recurring overpayment to a
      // completely different day of the month.
      const realDate = recurringDates.get(e.date) ?? e.date
      const beforeOverpaymentScheduleFrom = !!loan.recurringOverpayment?.scheduleFrom && realDate < loan.recurringOverpayment.scheduleFrom
      if (realDate >= startIso && realDate <= endIso && !beforeOverpaymentScheduleFrom) {
        const overpaymentSource = resolveRecurringOverpaymentSource(loan)
        results.push({
          date: realDate,
          amount: round2(e.recurringOverpaymentApplied),
          direction: 'out',
          categoryId: loan.categoryId,
          paymentMethod: 'direct_debit',
          status: 'pending',
          type: 'loan_payment',
          location: overpaymentSource.location,
          ownerId: loan.ownerId,
          payee: overpaymentSource.location === 'joint' ? loan.payee : '',
          payeeSharePercent: overpaymentSource.location === 'joint' ? loan.payeeSharePercent : 100,
          potId: overpaymentSource.potId,
          sourceType: 'loan_recurring_overpayment',
          sourceId: loan.id,
          note: `${loan.name} — recurring overpayment`,
        })
      }
    }
  }

  return results
}

/**
 * The most recent past REAL recurring-overpayment date (if any) and the
 * next 3 upcoming ones — the recurring-overpayment counterpart to
 * recentAndUpcomingLoanPaymentDates above, for the SAME "which payment
 * does this apply from" picker-first flow, but for its own cadence rather
 * than the loan's own regular payment dates. UAT 2026-09-09
 * (retest-overpay-single-no-reamortise) — confirmed as a real bug: the
 * recurring-overpayment editor's picker was reusing
 * recentAndUpcomingLoanPaymentDates directly, which returns the LOAN's
 * own schedule dates (e.g. the 2nd of each month), not the recurring
 * overpayment's own real dates (which can land on a completely different
 * day — see recurringOverpaymentRealDates's own comment). Reuses
 * generateLoanPaymentTransactions directly (already resolves the real
 * date via recurringOverpaymentRealDates internally) rather than
 * re-deriving that mapping here a second time.
 */
/**
 * `date` is the REAL calendar date to show the person (what
 * generateLoanPaymentTransactions/the ledger itself displays this
 * occurrence as) — `periodDate` is the underlying loan schedule entry's
 * OWN date, which is what recurringOverpaymentForDate/
 * resolveRecurringOverpaymentAmount actually key their date comparisons
 * against internally (same basis as `r.startDate`/`r.endDate`/
 * `pausedDates`, all of which compare against buildLoanSchedule's own
 * per-period `dateIso`, never the real display date). A caller writing an
 * amountHistory/amountOverrides entry MUST use `periodDate`, not `date`,
 * or the entry will silently never match anything inside the engine.
 */
export function recentAndUpcomingLoanRecurringOverpaymentDates(loan: Loan, asOfDate: Date): { date: string; periodDate: string; isPast: boolean }[] {
  const schedule = buildLoanSchedule(loan)
  const realDates = recurringOverpaymentRealDates(loan, schedule)
  const entries = schedule
    .filter((e) => e.recurringOverpaymentApplied > 0)
    .map((e) => ({ date: realDates.get(e.date) ?? e.date, periodDate: e.date }))
    .filter((e) => !(loan.recurringOverpayment?.scheduleFrom && e.date < loan.recurringOverpayment.scheduleFrom))
    .sort((a, b) => a.date.localeCompare(b.date))
  const asOfIso = toIso(asOfDate)
  const past = entries.filter((e) => e.date <= asOfIso)
  const upcoming = entries.filter((e) => e.date > asOfIso)
  const result: { date: string; periodDate: string; isPast: boolean }[] = []
  if (past.length > 0) result.push({ ...past[past.length - 1], isPast: true })
  for (const e of upcoming.slice(0, 3)) result.push({ ...e, isPast: false })
  return result
}

/**
 * Where a loan's RECURRING overpayment is actually funded from —
 * independent of the loan's own `location` (Adam-specified, 2026-09-03).
 * See LoanRecurringOverpayment.location's own comment in types/ledger.ts
 * for the full reasoning; this is purely the resolution step.
 *
 * Deliberately short-circuits to the loan's own location/potId whenever
 * that location is 'joint' — a joint loan's recurring overpayment always
 * follows the loan (never independently pot-funded), so
 * generateJointContributionTransactions/computeJointSummary (which only
 * ever call this generator for `location === 'joint'` loans, and split
 * every returned row's amount by payee/payeeSharePercent) can keep
 * assuming every row they get back is genuinely joint and genuinely
 * splittable — a pot-funded amount can't be split between two people's
 * personal ledgers, so letting `recurringOverpayment.location` override a
 * JOINT loan would silently corrupt that split math. Confining the new
 * independent choice to personal/pot-located loans (the only case Adam
 * actually asked for) avoids that risk entirely rather than trying to
 * solve "a joint loan's overpayment funded by one person's personal pot"
 * as a real feature nobody's asked for yet.
 */
/**
 * Rewrites every stored Transaction for a loan's RECURRING overpayment
 * (sourceType 'loan_recurring_overpayment') dated on/after `effectiveFrom`
 * to the new location/potId — cleared and pending alike, same "cleared
 * ones included" rule Bills'/Loans' own location changes already follow
 * (lib/locationChange.ts's reassignTransactionsForLocationChange, which
 * this mirrors but scopes to this one distinct sourceType — never
 * touching the loan's own regular 'loan'-sourced payments, which have
 * their own independent location per LoanRecurringOverpayment.location's
 * own comment). UAT 2026-09-09 (ed-overpay-scope-step) — a recurring
 * overpayment's location previously had no such rewrite at all (a flat,
 * non-effective-dated setting); Adam's own call reversed that: "Location
 * should be treated the same as amount for recurring overpayments."
 */
export function reassignLoanRecurringOverpaymentTransactions(
  transactions: Transaction[],
  loanId: string,
  effectiveFrom: string,
  newLocation: BillLocation,
  newPotId: string | undefined,
): Transaction[] {
  return transactions.map((t) => {
    if (t.sourceType !== 'loan_recurring_overpayment' || t.sourceId !== loanId) return t
    if (t.date < effectiveFrom) return t
    return { ...t, location: newLocation, potId: newLocation === 'pot' ? newPotId : undefined }
  })
}

export function resolveRecurringOverpaymentSource(loan: Loan): { location: BillLocation; potId?: string } {
  if (loan.location === 'joint') return { location: 'joint' }
  const explicit = loan.recurringOverpayment?.location
  if (!explicit) return { location: loan.location, potId: loan.location === 'pot' ? loan.potId : undefined }
  return { location: explicit, potId: explicit === 'pot' ? loan.recurringOverpayment?.potId : undefined }
}

/**
 * Records a real, immediate overpayment against a loan — pushes a new
 * LoanOverpayment onto the loan (so buildLoanSchedule picks it up on the
 * next call, no separate "regenerate" step needed) and returns the
 * matching cleared loan_payment Transaction to insert into the ledger.
 */
export function applyLoanOverpayment(
  loan: Loan,
  amount: number,
  date: string,
  note?: string,
  recastMode: 'reduce_term' | 'reduce_payment' = 'reduce_term',
): { updatedLoan: Loan; transaction: Omit<Transaction, 'id'>; overpayment: LoanOverpayment } {
  const overpayment: LoanOverpayment = { id: nanoid(8), date, amount, note, recastMode }
  const updatedLoan: Loan = { ...loan, overpayments: [...loan.overpayments, overpayment] }
  const transaction: Omit<Transaction, 'id'> = {
    date,
    amount,
    direction: 'out',
    categoryId: loan.categoryId,
    paymentMethod: 'bank_transfer',
    // Confirmed real bug: this was hardcoded to 'cleared' regardless of
    // the date — a future-dated overpayment (or a recurring one landing
    // on an upcoming date) would immediately show as already-happened
    // cash out of the account, rather than pending until its date
    // actually arrives. Same rule LedgerContext's addAdHocTransaction
    // already uses for everything else: cleared only once today is on
    // or past the transaction's own date.
    status: date <= todayIso() ? 'cleared' : 'pending',
    type: 'loan_payment',
    // Same "never pot-funded, falls back to personal" rule as settleLoan
    // above — a one-off lump overpayment is always real cash out of
    // personal or a genuine joint expense, never internal-to-a-pot
    // (Adam-specified, 2026-09-03). A joint loan's 'joint' location is
    // preserved unchanged (still a real, splittable expense) — only the
    // 'pot' case is redirected, since that's the one location a lump
    // payment structurally can't come from.
    location: loan.location === 'pot' ? 'personal' : loan.location,
    ownerId: loan.ownerId,
    payee: loan.payee,
    payeeSharePercent: loan.payeeSharePercent,
    sourceType: 'loan_overpayment',
    sourceId: overpayment.id,
    note,
  }
  return { updatedLoan, transaction, overpayment }
}

// ── Schedule changes from a chosen payment (2026-09-16) — see lib/scheduleChange.ts ──

const FAR_PAST = new Date(1970, 0, 1)
const FAR_FUTURE = new Date(2200, 0, 1)

function loanPaymentOccurrences(loan: Loan, respectScheduleFrom: boolean): ScheduleOccurrence[] {
  return buildLoanSchedule(loan)
    .filter((e) => e.scheduledPayment > 0 && !(respectScheduleFrom && loan.scheduleFrom && e.date < loan.scheduleFrom))
    .map((e) => ({ key: e.date, date: e.date }))
}

/** Recurring-overpayment occurrences keyed on their loan period (what pausedDates/amountOverrides key on), dated on their real date. */
function overpaymentOccurrences(loan: Loan): ScheduleOccurrence[] {
  return scheduledLoanRecurringOverpaymentRealDates(loan, FAR_PAST, FAR_FUTURE).map((o) => ({ key: o.periodDate, date: o.date }))
}

function withoutScheduleFrom(loan: Loan): Loan {
  return { ...loan, scheduleFrom: undefined, recurringOverpayment: loan.recurringOverpayment ? { ...loan.recurringOverpayment, scheduleFrom: undefined } : undefined }
}

function remapOverpaymentKeys(r: LoanRecurringOverpayment, keyMap: Map<string, string>, boundary: (iso: string) => string): LoanRecurringOverpayment {
  return {
    ...r,
    pausedDates: r.pausedDates?.map((d) => keyMap.get(d) ?? d),
    amountOverrides: r.amountOverrides?.map((o) => ({ ...o, date: keyMap.get(o.date) ?? o.date })),
    amountEffectiveFrom: r.amountEffectiveFrom ? boundary(r.amountEffectiveFrom) : undefined,
    amountHistory: r.amountHistory?.map((h) => ({ ...h, effectiveFrom: boundary(h.effectiveFrom) })),
  }
}

/**
 * A loan's first payment date changed, from a chosen payment. Its regular
 * payments are re-dated from there, and so are its recurring overpayment's,
 * whose real dates are worked out against the loan's own periods and can
 * shift with them.
 */
export function applyLoanStartDateChange(loan: Loan, transactions: Transaction[], newStartDate: string, pickedDate: string, asOfIso: string): { patch: Partial<Loan>; transactions: Transaction[] } | null {
  const moved = withoutScheduleFrom({ ...loan, startDate: newStartDate })
  const plan = planReschedule(loanPaymentOccurrences(loan, true), loanPaymentOccurrences(moved, false), pickedDate)
  if (!plan) return null

  let rewritten = redateStoredPayments(transactions, (t) => t.sourceType === 'loan' && t.sourceId === loan.id, plan, asOfIso)
  let recurringOverpayment = loan.recurringOverpayment
  if (recurringOverpayment) {
    const oldByPeriod = new Map(overpaymentOccurrences(loan).map((o) => [o.key, o.date]))
    const newByPeriod = new Map(overpaymentOccurrences(moved).map((o) => [o.key, o.date]))
    const dateMap = new Map<string, string>()
    for (const [oldPeriod, newPeriod] of plan.keyMap) {
      const oldReal = oldByPeriod.get(oldPeriod)
      const newReal = newByPeriod.get(newPeriod)
      if (oldReal && newReal) dateMap.set(oldReal, newReal)
    }
    const firstNewReal = [...dateMap.values()].sort()[0]
    rewritten = redateStoredPayments(rewritten, (t) => t.sourceType === 'loan_recurring_overpayment' && t.sourceId === loan.id, { ...plan, dateMap } as ReschedulePlan, asOfIso)
    recurringOverpayment = {
      ...remapOverpaymentKeys(recurringOverpayment, plan.keyMap, plan.boundary),
      scheduleFrom: firstNewReal ?? recurringOverpayment.scheduleFrom,
    }
  }

  return {
    patch: {
      startDate: newStartDate,
      scheduleFrom: plan.firstNew.date,
      monthlyPaymentEffectiveFrom: loan.monthlyPaymentEffectiveFrom ? plan.boundary(loan.monthlyPaymentEffectiveFrom) : undefined,
      monthlyPaymentHistory: loan.monthlyPaymentHistory?.map((h) => ({ ...h, effectiveFrom: plan.boundary(h.effectiveFrom) })),
      recurringOverpayment,
    },
    transactions: rewritten,
  }
}

/** A recurring overpayment's start date changed, from a chosen overpayment (`pickedDate` is its real date). */
export function applyRecurringOverpaymentStartDateChange(
  loan: Loan,
  transactions: Transaction[],
  newStartDate: string,
  pickedDate: string,
  asOfIso: string,
): { patch: Partial<Loan>; transactions: Transaction[] } | null {
  const r = loan.recurringOverpayment
  if (!r) return null
  const oldOccurrences = overpaymentOccurrences(loan)
  const pickedKey = oldOccurrences.find((o) => o.date === pickedDate)?.key ?? pickedDate
  const moved = withoutScheduleFrom({ ...loan, recurringOverpayment: { ...r, startDate: newStartDate } })
  const plan = planReschedule(oldOccurrences, overpaymentOccurrences(moved), pickedKey)
  if (!plan) return null
  return {
    patch: { recurringOverpayment: { ...remapOverpaymentKeys({ ...r, startDate: newStartDate }, plan.keyMap, plan.boundary), scheduleFrom: plan.firstNew.date } },
    transactions: redateStoredPayments(transactions, (t) => t.sourceType === 'loan_recurring_overpayment' && t.sourceId === loan.id, plan, asOfIso),
  }
}
