// PROMPT-08b Part 1 — the pure half of the "progress" section that used to
// be "Progress chart": what it is CALLED, whether it renders at all, and
// the numbers its progress bar(s) are drawn from.
//
// None of this is presentational. It lives here rather than inside
// Home.tsx so that `scripts/verify-progress-section.ts` can assert it
// against the real backups, and so the BAR and the RING in the modal are
// mathematically incapable of disagreeing: both go through
// `summarizeLoansProgress` below.

import { summarizeLoanProgress } from './ledgerLoans'
import type { Loan } from '../types/ledger'

/**
 * Section titles (Adam, 2026-09-18). "Progress chart" said nothing about
 * what was progressing; every title below names its own subject.
 *
 *  - a loan's own hero card → "Home Improvements loan progress"
 *  - Personal / Joint / Household → "Combined loan progress" (Personal
 *    shows one bar, Joint/Household add a per-loan bar under it)
 *  - a credit card → "Santander credit progress" (Claude's choice, per
 *    Adam: "you are free to come up with one that... fits in nicely with
 *    the other titles")
 *  - a savings pot → "Emergency Fund savings progress"
 */
export type ProgressSectionKind = 'loan' | 'combined_loans' | 'credit_card' | 'savings_pot'

export function progressSectionTitle(kind: ProgressSectionKind, name?: string): string {
  switch (kind) {
    case 'loan':
      return `${name} loan progress`
    case 'combined_loans':
      return 'Combined loan progress'
    case 'credit_card':
      return `${name} credit progress`
    case 'savings_pot':
      return `${name} savings progress`
  }
}

/**
 * Adam, 2026-09-18: "Unless the balance on the card is zero and there is
 * no due balance on the card, in which case we completely hide the
 * progress chart section, it's only visible when there is balance on the
 * card."
 *
 * Two figures, because CreditCardDetail genuinely has two and they can
 * disagree: `owedNow` is today's replayed balance, `projectedBalance` is
 * the same balance as of the horizon end (which is what the ring and bar
 * are actually drawn from). Either one being non-zero means there is
 * something to show, so the section only disappears when BOTH are clear.
 * Guarded with `> 0` rather than `!== 0` so an overpaid (negative) card
 * doesn't resurrect a section that has nothing left to fill.
 */
export function isCreditCardProgressVisible(owedNow: number, projectedBalance: number): boolean {
  return owedNow > 0 || projectedBalance > 0
}

/** Where the 25/50/75 markers sit. Fixed by the spec, exported so the bar and its checks share one list. */
export const PROGRESS_BAR_MARKERS = [25, 50, 75] as const

export interface ProgressBarGeometry {
  /** Width of the solid fill, 0–100, clamped. */
  fillPercent: number
  /** Width of the FADED extension, 0–100 — the projected gain only, NOT the cumulative figure, so the two segments abut without overlapping. */
  projectedPercent: number
  /** The data label above the bar: whole percent, no decimals (Adam: "rounded to 0 decimal points (int, not a float)"). */
  labelPercent: number
  /** The projected whole percent, or undefined when there is no projection to show. */
  projectedLabelPercent?: number
}

/**
 * The bar's geometry, mirroring ProgressRing's cumulative-segment maths
 * exactly (see ProgressRing.tsx): the solid segment is always today's
 * real figure, and the faded one starts where the solid one stops.
 *
 * A projected figure BELOW the current one is not an error (a horizon end
 * in the past, a clamped 100%) — it just means there is nothing to
 * project, so it collapses to zero width rather than drawing backwards.
 */
export function progressBarGeometry(percent: number, projectedPercent?: number): ProgressBarGeometry {
  const fillPercent = Math.max(0, Math.min(100, percent))
  const clampedProjected = projectedPercent === undefined ? fillPercent : Math.max(fillPercent, Math.min(100, projectedPercent))
  const hasProjection = projectedPercent !== undefined
  return {
    fillPercent,
    projectedPercent: clampedProjected - fillPercent,
    labelPercent: Math.round(fillPercent),
    // Suppressed when the projection rounds to the same whole percent as
    // today: "42→42% paid" is noise, not information.
    projectedLabelPercent: hasProjection && Math.round(clampedProjected) !== Math.round(fillPercent) ? Math.round(clampedProjected) : undefined,
  }
}

export interface LoanProgressEntry {
  loan: Loan
  percentPaid: number
  projectedPercentPaid?: number
}

export interface LoansProgressSummary {
  /** One entry per loan, in the order given. */
  perLoan: LoanProgressEntry[]
  totalBalance: number
  totalPaid: number
  totalNominalRemaining: number
  totalCapitalRemaining: number
  percentPaid: number
  /** Only set when a `horizonEndDate` was supplied (i.e. the "Next 3 cycles" horizon). */
  projectedPercentPaid?: number
  projectedPaid?: number
  projectedNominalRemaining?: number
  projectedCapitalRemaining?: number
}

/**
 * Every figure the progress section needs, for one card's set of loans.
 *
 * The combined percentage is deliberately computed from the summed CASH
 * figures (totalPaid / totalBalance), not as a mean of the per-loan
 * percentages — a £500 loan 90% paid and a £50,000 loan 5% paid is not
 * "47% paid", and the ring has always read it this way.
 *
 * `horizonEndDate` is passed through to `summarizeLoanProgress` unchanged
 * rather than re-derived from the projection's generated transactions:
 * `buildLoanSchedule` already bakes in every scheduled payment, one-off
 * overpayment and standing recurring overpayment between now and then.
 */
export function summarizeLoansProgress(loans: Loan[], horizonEndDate?: Date): LoansProgressSummary {
  const progress = loans.map((l) => summarizeLoanProgress(l))
  const projected = horizonEndDate ? loans.map((l) => summarizeLoanProgress(l, horizonEndDate)) : null

  const totalBalance = progress.reduce((sum, p) => sum + p.totalBalance, 0)
  const totalPaid = progress.reduce((sum, p) => sum + p.totalPaid, 0)
  const percentOf = (paid: number) => (totalBalance > 0 ? Math.min(100, (paid / totalBalance) * 100) : 0)
  const projectedPaid = projected?.reduce((sum, p) => sum + p.totalPaid, 0)

  return {
    perLoan: loans.map((loan, i) => ({
      loan,
      percentPaid: progress[i].percentPaid,
      projectedPercentPaid: projected?.[i].percentPaid,
    })),
    totalBalance,
    totalPaid,
    totalNominalRemaining: progress.reduce((sum, p) => sum + p.nominalRemaining, 0),
    totalCapitalRemaining: progress.reduce((sum, p) => sum + p.capitalRemaining, 0),
    percentPaid: percentOf(totalPaid),
    projectedPercentPaid: projectedPaid === undefined ? undefined : percentOf(projectedPaid),
    projectedPaid,
    projectedNominalRemaining: projected?.reduce((sum, p) => sum + p.nominalRemaining, 0),
    projectedCapitalRemaining: projected?.reduce((sum, p) => sum + p.capitalRemaining, 0),
  }
}
