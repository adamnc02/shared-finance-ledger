// PROMPT-08b Part 1 — the pure half of the "progress" section that used to
// be "Progress chart": what it is CALLED, whether it renders at all, and
// the numbers its progress bar(s) are drawn from.
//
// None of this is presentational. It lives here rather than inside
// Home.tsx so that `scripts/verify-progress-section.ts` can assert it
// against the real backups, and so the BAR and the RING in the modal are
// mathematically incapable of disagreeing: both go through
// `summarizeLoansProgress` below.

import { summarizeLoanProgress, type LoanProgress } from './ledgerLoans'
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

/**
 * Where the mini-tooltip above a progress bar sits, in the bar's OWN
 * percentage coordinate space (Adam, 2026-09-18: "the down arrow must
 * exactly hit the end of the filled line, so make sure the arrow/tooltip
 * box uses the same x axis spacing/dimensions as the progress bar to avoid
 * the arrow drifting left/right and over/undershooting").
 *
 * Every figure here is a percentage of the bar's width, never a pixel, and
 * ProgressBar renders the tooltip row inside a container that is exactly
 * as wide as the bar — so "50%" means the same x for both, at any screen
 * width, with no measuring and nothing to drift.
 */
export interface ProgressTooltipLayout {
  /** One arrow per real end-point: [fill] under "This cycle", [fill, projected] under "Next 3 cycles". */
  arrowPercents: number[]
  /** The box's centre — the midpoint of the arrows, so it is "centred between the two arrows". */
  centerPercent: number
  /** The distance between the outermost arrows; the box must be at least this wide plus its inset, so both arrows sit the same distance from its ends. */
  spanPercent: number
}

export function progressTooltipLayout(geo: ProgressBarGeometry): ProgressTooltipLayout {
  const fillEnd = geo.fillPercent
  const projectedEnd = geo.fillPercent + geo.projectedPercent
  // A projected segment of zero width would put two arrows in exactly the
  // same place — one arrow is the honest rendering of one end point, and
  // it is also what "This cycle" shows, so the two views agree whenever
  // there is nothing projected.
  const arrowPercents = geo.projectedLabelPercent === undefined || geo.projectedPercent <= 0 ? [fillEnd] : [fillEnd, projectedEnd]
  const first = arrowPercents[0]
  const last = arrowPercents[arrowPercents.length - 1]
  return { arrowPercents, centerPercent: (first + last) / 2, spanPercent: last - first }
}

export interface LoanProgressEntry {
  loan: Loan
  percentPaid: number
  projectedPercentPaid?: number
  /**
   * PROMPT-13 A2 — this loan's full `LoanProgress` as of today, not just
   * its percentage. The legend table needs the CASH figures (£4,000 /
   * £5,500 / £4,500), and §0b Q4 puts a legend above EVERY ring including
   * the per-loan ones, so the percentages alone are no longer enough.
   * Additive: `percentPaid` above is unchanged and still
   * `progress.percentPaid`, so nothing that read this entry before has to
   * change.
   */
  progress: LoanProgress
  /** The same, as of `horizonEndDate`. Absent exactly when no horizon was supplied. */
  projected?: LoanProgress
}

export interface LoansProgressSummary {
  /** One entry per loan, in the order given. */
  perLoan: LoanProgressEntry[]
  /** The contractual total, kept for callers that want it. NOT the progress denominator — see `totalAmortisedPayable`. */
  totalBalance: number
  totalPaid: number
  /** The REAL total these loans will take, after every logged overpayment. What `percentPaid` is a percentage OF. */
  totalAmortisedPayable: number
  /** Real cash left to hand over on the current schedule — the figure that falls when an overpayment shortens a term. */
  totalAmortisedRemaining: number
  totalNominalRemaining: number
  totalCapitalRemaining: number
  percentPaid: number
  /** Only set when a `horizonEndDate` was supplied (i.e. the "Next 3 cycles" horizon). */
  projectedPercentPaid?: number
  projectedPaid?: number
  projectedAmortisedRemaining?: number
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
  // The denominator is the AMORTISED total, not the contractual one —
  // see amortisedTotalPayable in ledgerLoans.ts. Summed across the loans
  // for the same reason the numerator is: a combined bar is one cash
  // figure over another, never a mean of per-loan percentages.
  const totalAmortisedPayable = progress.reduce((sum, p) => sum + p.amortisedTotalPayable, 0)
  const percentOf = (paid: number) => (totalAmortisedPayable > 0 ? Math.min(100, (paid / totalAmortisedPayable) * 100) : 0)
  const projectedPaid = projected?.reduce((sum, p) => sum + p.totalPaid, 0)

  return {
    perLoan: loans.map((loan, i) => ({
      loan,
      percentPaid: progress[i].percentPaid,
      projectedPercentPaid: projected?.[i].percentPaid,
      progress: progress[i],
      projected: projected?.[i],
    })),
    totalBalance,
    totalPaid,
    totalAmortisedPayable,
    totalAmortisedRemaining: progress.reduce((sum, p) => sum + p.amortisedRemaining, 0),
    totalNominalRemaining: progress.reduce((sum, p) => sum + p.nominalRemaining, 0),
    totalCapitalRemaining: progress.reduce((sum, p) => sum + p.capitalRemaining, 0),
    percentPaid: percentOf(totalPaid),
    projectedPercentPaid: projectedPaid === undefined ? undefined : percentOf(projectedPaid),
    projectedPaid,
    projectedAmortisedRemaining: projected?.reduce((sum, p) => sum + p.amortisedRemaining, 0),
    projectedNominalRemaining: projected?.reduce((sum, p) => sum + p.nominalRemaining, 0),
    projectedCapitalRemaining: projected?.reduce((sum, p) => sum + p.capitalRemaining, 0),
  }
}

// ── PROMPT-13 Part A — the RAG breakdown behind the loan pie charts ─────
//
// Everything the three-segment ring AND the legend table above it are
// drawn from, in one place. It lives here, not in Home.tsx, for the same
// reason the rest of this file does: a segment size or a legend row
// computed inline in a component cannot be checked by the sweep.
// `verify-rag-progress-segments.ts` and `verify-rag-legend-rows.ts` are
// the gates.
//
// 🚨 THE SEGMENTS AND THE LEGEND'S `%` COLUMN ARE DIFFERENT NUMBERS, AND
// THAT IS DELIBERATE. On Adam's own worked example — a £10,000 loan,
// £4,000 paid, £500/month over the next 3 cycles:
//
//   segments   40%  /  15%  /  45%   ← arc sizes; sum to 100
//   legend     40%  /  55%  /  45%   ← each row's own balance / total;
//                                      sums to 140, ON PURPOSE
//
// The amber ARC is the £1,500 INCREMENT (it is drawn starting where green
// stops, so anything else would overlap it). The amber ROW is the £5,500
// CUMULATIVE figure, because the table's job is to explain the balances
// beside it, and a 15% that matches nothing else on its own row invites a
// bug report. Adam settled this on 2026-09-20 (PROMPT-13 §0 Q1), choosing
// the cumulative reading. **Do not "fix" the 140%.**
//
// Likewise the delta column: only the amber row carries one (§0 Q2, also
// settled 2026-09-20 — Adam chose this over the recommendation). Green
// reads `—` because nothing is projected to change about money already
// paid, and red reads `—` too. `−£1,500` on the red row is wrong.

export type RagSegmentKind = 'paid' | 'projected' | 'remaining'

/** One arc of the ring. The arcs always sum to exactly 100. */
export interface RagSegment {
  kind: RagSegmentKind
  /** Arc size as a percentage of the whole ring. Amber is the INCREMENT — see the note above. */
  percent: number
}

/** One row of the legend table above the ring. */
export interface RagLegendRow {
  kind: RagSegmentKind
  /** Cumulative for paid and projected; remaining-to-pay for remaining. */
  balance: number
  /** Only ever set on the projected row (§0 Q2). `undefined` renders as `—`. */
  delta?: number
  /** This row's own balance over the total. Does NOT sum to 100 — see the note above. */
  percent: number
}

export interface RagProgress {
  /** The denominator every figure here is taken against — the AMORTISED total (§1.18). */
  total: number
  segments: RagSegment[]
  rows: RagLegendRow[]
}

/**
 * Below this, a gain is not a real gain — it is float noise, or a
 * projection that landed on the same penny as today's figure. Half a
 * penny, expressed in pounds. An amber arc of 0.000001% renders as a
 * hairline artefact on the ring, so it is dropped rather than drawn.
 */
const MIN_GAIN = 0.005

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The RAG breakdown for one set of figures.
 *
 * `showProjection` is passed IN rather than derived, because
 * `showProjection = horizon === 'three_cycles'` already exists in
 * Home.tsx (~404) and reimplementing it here would give the app two
 * places to disagree about what "next 3 cycles" means. This cycle →
 * green + red; next 3 cycles → green + amber + red.
 *
 * Every figure is clamped so the ring can never be handed a negative or
 * an over-100 arc: a loan paid beyond its amortised total (possible after
 * a settlement) reads 100/0 rather than 105/−5, and a projection that
 * somehow came back below today's paid figure yields no amber at all
 * rather than an arc drawn backwards.
 */
export function ragProgress({
  total,
  paid,
  projectedPaid,
  showProjection,
}: {
  total: number
  paid: number
  projectedPaid?: number
  showProjection: boolean
}): RagProgress {
  const safeTotal = total > 0 ? total : 0
  const paidBalance = round2(Math.max(0, Math.min(paid, safeTotal)))
  // The projected figure can never be less than what is already paid, nor
  // more than the total. Both clamps are load-bearing — see above.
  const projectedBalance =
    showProjection && projectedPaid !== undefined ? round2(Math.max(paidBalance, Math.min(projectedPaid, safeTotal))) : paidBalance
  const gain = round2(projectedBalance - paidBalance)
  const hasProjection = showProjection && gain > MIN_GAIN
  // Red is measured from wherever the ring gets to by the horizon end —
  // the projected figure when there is one, today's figure otherwise.
  const reachedBalance = hasProjection ? projectedBalance : paidBalance
  const remainingBalance = round2(Math.max(0, safeTotal - reachedBalance))

  // A percentage OF THE TOTAL. With safeTotal 0 there is nothing to be a
  // percentage of, so paid reads 0 and red picks up the whole ring below.
  const pct = (amount: number) => (safeTotal > 0 ? (amount / safeTotal) * 100 : 0)
  const paidPercent = pct(paidBalance)
  const projectedPercent = hasProjection ? pct(gain) : 0
  // Red is the REMAINDER of the ring, not an independent calculation.
  // Deriving it this way is what guarantees the three arcs sum to exactly
  // 100 at every rounding, which is the invariant the ring depends on.
  const remainingPercent = 100 - paidPercent - projectedPercent

  const segments: RagSegment[] = [{ kind: 'paid', percent: paidPercent }]
  if (hasProjection) segments.push({ kind: 'projected', percent: projectedPercent })
  segments.push({ kind: 'remaining', percent: remainingPercent })

  // The legend. Balances are cumulative for green and amber, remaining
  // for red; the `%` is each row's own balance over the total; only amber
  // carries a delta. All three settled in §0 — see the note above.
  const rows: RagLegendRow[] = [{ kind: 'paid', balance: paidBalance, percent: pct(paidBalance) }]
  if (hasProjection) rows.push({ kind: 'projected', balance: projectedBalance, delta: gain, percent: pct(projectedBalance) })
  rows.push({ kind: 'remaining', balance: remainingBalance, percent: pct(remainingBalance) })

  return { total: safeTotal, segments, rows }
}

/** The RAG breakdown for a card's combined loan ring (Personal, Joint, Household, or a loan's own hero). */
export function loansRagProgress(summary: LoansProgressSummary, showProjection: boolean): RagProgress {
  return ragProgress({
    total: summary.totalAmortisedPayable,
    paid: summary.totalPaid,
    projectedPaid: summary.projectedPaid,
    showProjection,
  })
}

/**
 * The RAG breakdown for ONE loan's own ring inside a combined modal.
 * §0b Q4 (2026-09-20): every ring gets its own legend, including these.
 */
export function loanEntryRagProgress(entry: LoanProgressEntry, showProjection: boolean): RagProgress {
  return ragProgress({
    total: entry.progress.amortisedTotalPayable,
    paid: entry.progress.totalPaid,
    projectedPaid: entry.projected?.totalPaid,
    showProjection,
  })
}

/** The legend's status column. */
export const RAG_ROW_LABELS: Record<RagSegmentKind, string> = {
  paid: 'Paid',
  projected: 'Projected',
  remaining: 'Remaining',
}

/** The legend's colour swatch, and the ring's own arc colour. */
export const RAG_SEGMENT_COLORS: Record<RagSegmentKind, string> = {
  paid: 'var(--color-positive)',
  projected: 'var(--color-warning)',
  remaining: 'var(--color-negative)',
}
