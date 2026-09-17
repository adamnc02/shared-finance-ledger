// ─────────────────────────────────────────────────────────────────────────
// Loan interest convention library (amortisation-engine scope §5).
//
// WHY THIS FILE EXISTS: two real loans (Santander, Monzo — see the fixtures
// below) were reconciled against real statement data during scoping, and
// they turned out to use genuinely different interest conventions. Neither
// formula fits the other loan's real figures well. There is no single
// "the" loan interest formula for this app to hard-code — instead the
// engine tests a small, growable library of candidates against whatever
// real statement lines the person has entered, and keeps whichever fits
// best (see `bestFitConvention` below). ledgerLoans.ts's baseline (no
// statement data yet) falls back to a back-solved flat-monthly rate via
// `standardPayment`/`backSolveMonthlyRate` — calibration (a future
// session's UI, scope §5.3) refines *which* convention and *how precisely*,
// it doesn't replace this baseline.
//
// ADDING A NEW CONVENTION (for a future session, when a real loan doesn't
// fit either candidate below within a sane confidence margin):
//   1. Ask the person for the same three things Santander/Monzo needed:
//        - the loan's principal, displayed APR, term, advance date, and
//          first-payment date (the loan's own contractual facts), and
//        - 2-5 real statement lines: { date, capital, interest } from
//          an actual lender statement, oldest first. 2-3 is usually
//          enough to distinguish a genuinely new convention from
//          rounding noise; the calibration UI caps at 5 regardless.
//   2. Write the new formula as an `InterestConvention` — same shape as
//      `flatMonthlyConvention`/`dailySimpleConvention` below: a small,
//      self-contained function of (balance, periodStart, periodEnd,
//      monthlyRate) => interest for that one period, PLUS a `fitRate`
//      function that solves for this convention's own best-fit monthly
//      rate against real statement lines (closed-form linear regression
//      if the formula is linear in its natural rate parameter, same as
//      both existing conventions — see calibrateRateAndConvention's own
//      comment below for why no iteration/library is needed for either
//      known case). `monthlyRate` is always the loan's calibrated
//      *monthly* rate (see `aprToMonthlyRate` below) — if the real
//      convention charges by a different rate cadence (daily, annual,
//      whatever), do that conversion *inside* the candidate's own
//      functions, the way `dailySimpleConvention` derives a daily rate
//      from the shared monthly figure. Don't invent a second
//      rate-storage shape per convention.
//   3. Add real (the actual reconciled, not invented) figures for the new
//      loan as a fixture below, in the same shape as SANTANDER_FIXTURE /
//      MONZO_FIXTURE — this both documents the new convention with a
//      worked example and becomes a regression test.
//   4. Push the new convention into the `interestConventions` array below.
//      Nothing else needs to change — `bestFitConvention` already tests
//      every entry in that array against whatever lines it's given.
//
// A REAL RISK FOUND WHILE INVESTIGATING A THIRD LOAN, NOW ADDRESSED: a car
// loan quoting both an APR and a separate, lower "flat rate" — the classic
// signature of a hire-purchase/add-on-rate agreement, where interest is a
// fixed percentage of the ORIGINAL principal every period, not the
// shrinking balance. Simulating what that loan's early statement lines
// WOULD look like if it genuinely is flat-rate, then running them through
// `calibrateRateAndConvention` as it stood at the time, produced a
// CONFIDENT (wrongly) match to flatMonthlyConvention — because a
// reducing-balance schedule and a flat-rate schedule look nearly
// identical for the first few periods of a loan's life; they only
// meaningfully diverge later, once reducing-balance's capital portion
// has visibly grown relative to flat-rate's constant one.
// `flatAddOnConvention` below closes this — added proactively (no real
// statement data existed for that loan yet), on the strength of
// reverse-engineering its own reported contractual figures (see that
// convention's own comment for the exact reasoning). Still worth heeding
// for anything genuinely new in the future: when a loan doesn't cleanly
// match a known convention, ask for at least one statement line from well
// into the loan's life (6+ months in), not just early consecutive ones —
// early lines alone can under-determine which convention actually fits.
// ─────────────────────────────────────────────────────────────────────────

import { differenceInCalendarDays } from 'date-fns'
import { parseLocalDate } from './date'

const round2 = (n: number) => Math.round(n * 100) / 100

// ── Rate conversions ────────────────────────────────────────────────────

/**
 * UK APR is a true compound annual figure — converting via `apr / 12` is
 * wrong and was itself part of why this feature's first-draft numbers
 * didn't reconcile (scope §5.2, §4). This is the one that matters:
 *   r = (1 + APR)^(1/12) - 1
 */
export function aprToMonthlyRate(apr: number): number {
  return Math.pow(1 + apr, 1 / 12) - 1
}

/** Inverse of aprToMonthlyRate — used inside conventions (e.g. daily simple) that need an annual figure derived from the shared calibrated monthly rate. */
export function monthlyRateToApr(monthlyRate: number): number {
  return Math.pow(1 + monthlyRate, 12) - 1
}

/**
 * Standard reducing-balance payment for a given principal, monthly rate,
 * and term — scope §5.2/§4:  PMT = P × r / (1 - (1+r)^-n)
 * Falls back to a flat P/n split for the (non-realistic but worth not
 * dividing-by-zero on) 0%-rate case.
 */
export function standardPayment(principal: number, monthlyRate: number, termMonths: number): number {
  if (termMonths <= 0) return 0
  if (monthlyRate === 0) return principal / termMonths
  return (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths))
}

/**
 * Back-solves the monthly rate implied by a real contractual payment that
 * may differ slightly from the formula-derived one (scope §5.2 step 4) —
 * no closed form exists for this, so bisection is used. Converges to far
 * tighter than banking precision well within the iteration cap.
 *
 * Tested against both real fixtures below, this back-solved rate (needing
 * zero statement data) lands within ~0.00005 percentage points of the rate
 * independently derived from real per-period statement interest — see
 * verify-interest-conventions.ts.
 */
export function backSolveMonthlyRate(principal: number, payment: number, termMonths: number): number {
  if (principal <= 0 || termMonths <= 0 || payment <= 0) return 0

  const f = (r: number) => standardPayment(principal, r, termMonths) - payment

  // f is monotonically increasing in r (a higher rate always means a
  // higher standard payment for the same principal/term), so a simple
  // bisection between "no interest at all" and a generously high monthly
  // rate is guaranteed to converge on the one real root.
  let lo = 0
  let hi = 1 // 100%/month — nothing realistic gets remotely close to this
  if (f(lo) >= 0) return lo // payment already at/below the 0%-rate flat split

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (f(mid) > 0) hi = mid
    else lo = mid
  }
  return (lo + hi) / 2
}

/**
 * Inverse of standardPayment: given a balance, monthly rate, and payment
 * amount, how many more periods until it reaches zero — the closed-form
 * "number of payments remaining" formula, so a reduce-payment recast
 * (loan-amortisation-engine scope §9) can find out how many periods the
 * loan WOULD have taken at its current payment before applying the
 * overpayment, then hold that period count fixed while recomputing a
 * smaller payment via standardPayment. Rounds up (ceil) since periods
 * are discrete and a real schedule's final period absorbs whatever
 * fractional remainder is left, same as buildLoanSchedule's own final-
 * payment rounding.
 */
export function remainingPeriodsFor(balance: number, monthlyRate: number, payment: number): number {
  if (balance <= 0 || payment <= 0) return 0
  if (monthlyRate === 0) return Math.ceil(balance / payment)

  const ratio = 1 - (balance * monthlyRate) / payment
  // payment doesn't even cover this period's interest — balance would
  // never reach zero at this payment. No real finite answer; return a
  // large-but-finite safety value rather than Infinity/NaN so callers
  // doing further arithmetic with this don't propagate non-numbers.
  if (ratio <= 0) return 999

  return Math.ceil(-Math.log(ratio) / Math.log(1 + monthlyRate))
}

// ── Candidate interest conventions ──────────────────────────────────────

/**
 * A single, self-contained interest formula for one payment period. See
 * the file header for the exact contract a new candidate must follow.
 */
export interface InterestConvention {
  id: string
  label: string // for debugging/display — not shown to the person normally (handoff §2)
  interestForPeriod(balance: number, periodStart: Date, periodEnd: Date, monthlyRate: number, originalPrincipal: number): number
  /**
   * Solves for this convention's best-fit monthly rate against real
   * statement lines (loan-amortisation-engine scope §5.3, calibration
   * step 3) — a closed-form linear least-squares regression through the
   * origin, since every convention here is linear in its own natural
   * rate parameter (flat: interest = balance × monthlyRate directly;
   * daily: interest = balance × days × (APR/365), linear in APR). No
   * iteration, no library, no guessing — deterministic curve-fitting per
   * scope §5.1. Validated against both real fixtures: reproduces
   * SANTANDER_FIXTURE.empiricalMonthlyRate to 8 decimal places from its
   * own 3 real statement lines.
   */
  fitRate(advanceDateIso: string, startingBalance: number, lines: StatementLine[]): number
}

/**
 * Flat monthly-equivalent — e.g. Santander. `interest = balance × monthlyRate`,
 * charged identically every period regardless of exact day count — even an
 * odd-length stub period (advance date to first payment) is charged as one
 * ordinary period, never day-weighted or pro-rated (scope §5.1).
 */
export const flatMonthlyConvention: InterestConvention = {
  id: 'flat_monthly',
  label: 'Flat monthly-equivalent (e.g. Santander)',
  interestForPeriod(balance, _periodStart, _periodEnd, monthlyRate, _originalPrincipal) {
    return round2(balance * monthlyRate)
  },
  fitRate(_advanceDateIso, startingBalance, lines) {
    // interest_i = balance_i × rate is already linear in rate — regress
    // interest against balance directly, coefficient c_i = balance_i.
    let balance = startingBalance
    let num = 0
    let den = 0
    for (const line of lines) {
      num += balance * line.interest
      den += balance * balance
      balance = round2(balance - line.capital)
    }
    return den === 0 ? 0 : Math.max(0, num / den)
  },
}

/**
 * Daily simple interest — e.g. Monzo. `interest = balance × (APR ÷ 365) ×
 * exact days elapsed`, precisely day-weighted for every period including
 * its own stub (scope §5.1). The shared calibrated figure is always a
 * *monthly* rate (see file header), so this derives the annual/daily
 * figures from it rather than storing its own separate rate.
 */
export const dailySimpleConvention: InterestConvention = {
  id: 'daily_simple',
  label: 'Daily simple interest (e.g. Monzo)',
  interestForPeriod(balance, periodStart, periodEnd, monthlyRate, _originalPrincipal) {
    const apr = monthlyRateToApr(monthlyRate)
    const dailyRate = apr / 365
    const days = differenceInCalendarDays(periodEnd, periodStart)
    return round2(balance * dailyRate * days)
  },
  fitRate(advanceDateIso, startingBalance, lines) {
    // interest_i = balance_i × days_i × (APR/365) is linear in APR, not
    // directly in the monthly rate — regress against APR first (via
    // coefficient c_i = balance_i × days_i / 365), then convert the
    // fitted APR to the shared monthly figure at the end.
    let balance = startingBalance
    let prevDate = parseLocalDate(advanceDateIso)
    let num = 0
    let den = 0
    for (const line of lines) {
      const periodEnd = parseLocalDate(line.date)
      const days = differenceInCalendarDays(periodEnd, prevDate)
      const c = (balance * days) / 365
      num += c * line.interest
      den += c * c
      balance = round2(balance - line.capital)
      prevDate = periodEnd
    }
    const apr = den === 0 ? 0 : Math.max(0, num / den)
    return aprToMonthlyRate(apr)
  },
}

/**
 * Flat / add-on rate — hire-purchase style (a car loan quoting both an
 * APR AND a separate, lower "flat rate" is the classic signature this
 * exists for). Interest is a FIXED share of the ORIGINAL principal every
 * single period, never the shrinking balance — so unlike the two
 * conventions above, `balance` is irrelevant here; `originalPrincipal` is
 * what actually drives the number, and stays constant for the loan's
 * whole life. `monthlyRate` is (per this file's shared convention) always
 * a monthly figure — here that's the flat ANNUAL rate ÷ 12, applied
 * straight to the original principal, not compounded or day-weighted at
 * all.
 *
 * Added proactively, without real statement data (none existed for the
 * loan that prompted this — see the file header's "a real risk" note):
 * reverse-engineering that loan's own reported figures gave real
 * evidence worth acting on, not just a hunch. Back-solving each
 * hypothesis's own natural rate FROM the real contractual payment and
 * comparing it to what the loan actually quotes: a reducing-balance read
 * of the payment implies an APR of ~8.75%, a 15-basis-point miss against
 * the quoted 8.9%. A flat/add-on read implies a flat rate of ~4.57%, a
 * tighter 8-basis-point miss against the quoted 4.65% — very close to
 * twice as precise a reconstruction of its own quoted figure. Neither
 * gap is huge, and this isn't proof — but it's real signal, worth having
 * the engine ready to confirm or rule out the moment real statement
 * lines exist, rather than only two candidates that were already known
 * (from the same investigation) to be capable of confidently mis-fitting
 * early flat-rate data to the wrong one of themselves.
 */
export const flatAddOnConvention: InterestConvention = {
  id: 'flat_add_on',
  label: 'Flat / add-on rate (e.g. hire purchase)',
  interestForPeriod(_balance, _periodStart, _periodEnd, monthlyRate, originalPrincipal) {
    return round2(originalPrincipal * monthlyRate)
  },
  fitRate(_advanceDateIso, startingBalance, lines) {
    // interest_i = originalPrincipal × rate is CONSTANT across every
    // period (no balance/day dependence at all) — the least-squares
    // best-fit constant is simply the mean of the real interest figures,
    // divided by the principal. No regression needed; this already IS
    // the closed form.
    if (lines.length === 0 || startingBalance === 0) return 0
    const meanInterest = lines.reduce((sum, l) => sum + l.interest, 0) / lines.length
    return Math.max(0, meanInterest / startingBalance)
  },
}

/** The full growable candidate library — see file header for how to extend this. */
export const interestConventions: InterestConvention[] = [flatMonthlyConvention, dailySimpleConvention, flatAddOnConvention]

// ── Fit-testing against real statement lines ────────────────────────────

/** One real, reconciled statement line — the raw calibration input (scope §5.3). */
export interface StatementLine {
  date: string // ISO date
  capital: number
  interest: number
}

/**
 * Walks a convention forward through a real set of statement lines (oldest
 * first), predicting each period's interest from the balance *before* that
 * period and comparing it to what was actually charged. Balance moves
 * forward using the lines' own real capital figures, not a re-derived
 * schedule — calibration is about matching reality, not re-simulating it.
 * Returns the summed absolute error across all lines, in pounds.
 */
export function totalAbsoluteError(convention: InterestConvention, monthlyRate: number, advanceDateIso: string, startingBalance: number, lines: StatementLine[]): number {
  let balance = startingBalance
  let prevDate = parseLocalDate(advanceDateIso)
  let totalError = 0

  for (const line of lines) {
    const periodEnd = parseLocalDate(line.date)
    const predicted = convention.interestForPeriod(balance, prevDate, periodEnd, monthlyRate, startingBalance)
    totalError += Math.abs(round2(predicted - line.interest))
    balance = round2(balance - line.capital)
    prevDate = periodEnd
  }

  return round2(totalError)
}

export interface ConventionFit {
  convention: InterestConvention
  error: number // summed absolute pence-level error across all provided lines
}

/**
 * Tests every candidate in the library against the same real statement
 * lines and returns all of them ranked best-fit first — the calibration
 * flow (scope §5.3/§5.4, a future session) uses the top result plus the
 * gap to the runner-up to decide confidence; this function just does the
 * deterministic curve-fitting (scope §5.1 — no LLM, no ambiguity, same
 * answer every time).
 */
export function fitConventions(monthlyRate: number, advanceDateIso: string, startingBalance: number, lines: StatementLine[], candidates: InterestConvention[] = interestConventions): ConventionFit[] {
  return candidates.map((convention) => ({ convention, error: totalAbsoluteError(convention, monthlyRate, advanceDateIso, startingBalance, lines) })).sort((a, b) => a.error - b.error)
}

export function bestFitConvention(monthlyRate: number, advanceDateIso: string, startingBalance: number, lines: StatementLine[], candidates: InterestConvention[] = interestConventions): ConventionFit {
  return fitConventions(monthlyRate, advanceDateIso, startingBalance, lines, candidates)[0]
}

export interface RateAndConventionFit {
  convention: InterestConvention
  monthlyRate: number // this convention's OWN best-fit rate — not a shared/given one
  error: number // summed absolute pence-level error, using that fitted rate
}

/**
 * The real calibration flow (scope §5.3, steps 3-4): for each candidate
 * convention, fit ITS OWN best rate against the real statement lines
 * (convention.fitRate — a closed-form regression, not a search), then
 * score that fitted rate's error, and rank every candidate by that
 * error. This is what a loan calibrating for the very first time
 * actually needs — fitConventions/bestFitConvention above assume the
 * rate is already known (useful for the cross-test / a loan calibrating
 * further statement lines against an already-established rate); this
 * discovers both the rate AND the convention from raw statement data
 * alone. Step 4's "small residual correction" (the displayed APR being
 * rounded to 2dp, so the true rate sits a hair either side) falls out of
 * this automatically — fitting against real reported figures, rather
 * than assuming the formula-derived rate, is exactly what closes that
 * gap.
 */
export function calibrateRateAndConvention(advanceDateIso: string, startingBalance: number, lines: StatementLine[], candidates: InterestConvention[] = interestConventions): RateAndConventionFit[] {
  return candidates
    .map((convention) => {
      const monthlyRate = convention.fitRate(advanceDateIso, startingBalance, lines)
      const error = totalAbsoluteError(convention, monthlyRate, advanceDateIso, startingBalance, lines)
      return { convention, monthlyRate, error }
    })
    .sort((a, b) => a.error - b.error)
}

// ─────────────────────────────────────────────────────────────────────────
// Real, reconciled fixtures (scope §5.5, §13 — these double as the
// regression-test data source for verify-interest-conventions.ts).
// ─────────────────────────────────────────────────────────────────────────

export const SANTANDER_FIXTURE = {
  lender: 'Santander',
  principal: 8400.0,
  displayedApr: 0.1693,
  termMonths: 24,
  advanceDate: '2026-05-11',
  firstPaymentDate: '2026-07-02',
  contractualPayment: 410.29,
  // Third line was a lender-side forward projection at the time it was
  // captured (not yet actually charged) but is internally consistent with
  // the first two real lines — safe to use as a third calibration point.
  statementLines: [
    { date: '2026-07-02', capital: 300.03, interest: 110.26 },
    { date: '2026-08-02', capital: 303.97, interest: 106.32 },
    { date: '2026-09-02', capital: 307.96, interest: 102.33 },
  ] as StatementLine[],
  // Back-solved (Payment/Principal/Term alone) vs. empirically-observed
  // (from the real statement lines) monthly rate — these should agree to
  // within ~0.0001 percentage points once both are implemented.
  backSolvedMonthlyRate: 0.01312553,
  empiricalMonthlyRate: 0.01312604,
  balanceAfterTwoRealPayments: 7796.0,
  // What the OLD flat model called "remaining" at that point — kept here
  // as a negative-check fixture (assert the new engine is NOT computing
  // this), not a figure to reproduce.
  oldFlatModelRemainingAfterTwoPayments: 9026.38,
  realSettlementQuoteAfterTwoPayments: 8103.37,
} as const

export const MONZO_FIXTURE = {
  lender: 'Monzo',
  principal: 9411.13,
  displayedApr: 0.087,
  termMonths: 24,
  advanceDate: '2026-02-10',
  firstPaymentDate: '2026-03-02',
  contractualPayment: 427.57,
  statementLines: [
    { date: '2026-03-02', capital: 382.77, interest: 44.8 },
    { date: '2026-04-02', capital: 360.92, interest: 66.65 },
    { date: '2026-05-02', capital: 365.77, interest: 61.8 },
    { date: '2026-06-02', capital: 366.5, interest: 61.07 },
    { date: '2026-07-02', capital: 370.87, interest: 56.7 },
    { date: '2026-08-02', capital: 371.77, interest: 55.8 },
  ] as StatementLine[],
  // Implied daily rate, consistent (within rounding noise) across all 6
  // periods including the 20-day stub.
  impliedDailyRate: 0.000238,
} as const
