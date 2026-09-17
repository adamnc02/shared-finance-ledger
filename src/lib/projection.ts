// Phase 3 scope (doc Section 4.4): "Projected balance = cleared balance +
// all pending/scheduled transactions up to a configurable horizon,
// defaulting to the end of the current pay cycle, extendable to 3
// cycles." This file generates the not-yet-materialized future
// occurrences (bills, loans, credit card minimums, salary) that fill in
// that horizon, dedupes them against anything that already exists as a
// real Transaction, and combines the two into one figure + one list.
//
// UAT Batch 4 (2026-09-04): this used to also fold in each person's own
// SHARE of every joint bill/loan (jointLedger.ts's
// generateJointContributionTransactions) — deliberately reversed per
// Adam's explicit call: the Personal ledger should show nothing about
// joint bills at all, full stop. The Joint card (jointAccountLedger.ts)
// remains the only place joint costs appear, at their full amount.

import { addDays } from 'date-fns'
import { nanoid } from 'nanoid'
import { generateTransactionsForTemplate } from './schedule'
import { generateLoanPaymentTransactions, resolveRecurringOverpaymentSource } from './ledgerLoans'
import { generateMinimumPaymentTransactions } from './creditCards'
import { generateSalaryTransactions } from './salaryLedger'
import { generatePensionTransactions } from './pensionLedger'
import { generateSavingsDepositTransactions, generateSavingsInterestTransactions, generateSavingsWithdrawalTransactions } from './savingsPotLedger'
import { generatePotDepositTransactions } from './potLedger'
import { resolveCycleBounds } from './pensionLedger'
import { isLedgerTransaction, signedAmount, daysBetweenInclusive, buildDailyBalanceSeries, buildDailySpendSeries, type BalanceSpendGranularity, type BalanceSpendTrendSeries } from './runningBalance'
import type { AppDataV2, PayCycleConfig, Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100
import { toLocalIsoDate as toIso, parseLocalDate } from './date'

export type ProjectionHorizon = 'current_cycle' | 'three_cycles'

/**
 * How many cycles AHEAD of the current one the `three_cycles` horizon
 * covers. The window is the current cycle plus this many more, so the
 * label "Next 3 cycles" names the three genuinely-upcoming ones rather
 * than counting the part-elapsed current cycle among them.
 */
export const THREE_CYCLES_AHEAD = 3

/**
 * The rows a card should DISPLAY for its horizon: first cycle start to last
 * cycle end. A projection's transaction list reaches back to the account's
 * opening-balance date because the running balance needs those rows, so any
 * list or total built straight from it shows history from before the cycle.
 */
export function inCycleWindow<T extends { date: string }>(rows: T[], cycles: { start: Date; end: Date }[]): T[] {
  const startIso = toIso(cycles[0].start)
  const endIso = toIso(cycles[cycles.length - 1].end)
  return rows.filter((r) => r.date >= startIso && r.date <= endIso)
}

/** Every cycle window inside the horizon, in order, starting with the one containing `asOfDate`. The Summary page's cycle-end grouping folds its rows against exactly these bounds, so grouping and totals can't disagree with the horizon they're drawn from. */
export function horizonCycles(data: AppDataV2, personId: string, horizon: ProjectionHorizon, asOfDate: Date): { start: Date; end: Date }[] {
  const cycles = [resolveCycleBounds(data, personId, asOfDate)]
  if (horizon === 'current_cycle') return cycles

  for (let i = 0; i < THREE_CYCLES_AHEAD; i++) {
    cycles.push(resolveCycleBounds(data, personId, addDays(cycles[cycles.length - 1].end, 1)))
  }
  return cycles
}

/** The end of the projection window: the current cycle's end, or the end of the last cycle in the horizon (current + THREE_CYCLES_AHEAD). */
export function horizonRangeEnd(data: AppDataV2, personId: string, horizon: ProjectionHorizon, asOfDate: Date): Date {
  const cycles = horizonCycles(data, personId, horizon, asOfDate)
  return cycles[cycles.length - 1].end
}

/**
 * The N pay cycles immediately BEFORE the one containing `asOfDate` —
 * the mirror-image walk of `horizonCycles`, which only ever walks
 * forward. Index 0 in the returned array is the cycle immediately
 * before "now"'s cycle; index N-1 is the oldest. Used by the average
 * spend forecast feature (2026-09-13) to build its trailing lookback
 * window — deliberately NOT anchored to any opening-balance date (see
 * that feature's own callers), since this is pure calendar/payday
 * arithmetic via `resolveCycleBounds`, same as `horizonCycles` itself.
 */
export function previousCycles(data: AppDataV2, personId: string, n: number, asOfDate: Date): { start: Date; end: Date }[] {
  const current = resolveCycleBounds(data, personId, asOfDate)
  const cycles: { start: Date; end: Date }[] = []
  let cursor = current.start
  for (let i = 0; i < n; i++) {
    const prev = resolveCycleBounds(data, personId, addDays(cursor, -1))
    cycles.push(prev)
    cursor = prev.start
  }
  return cycles
}

/**
 * A stable key for matching a generated occurrence against an already-
 * materialized real Transaction, so the same bill/loan/card-payment/
 * salary date never gets counted twice. Returns null for transaction
 * types this file doesn't generate (ad-hoc expense/income/bonus/spend),
 * which are never deduped against anything — they only ever exist once,
 * logged by hand.
 */
export function dedupeKey(t: Pick<Transaction, 'type' | 'date' | 'sourceType' | 'sourceId' | 'personId' | 'creditCardId'>): string | null {
  if (t.sourceType && t.sourceId) return `${t.sourceType}:${t.sourceId}:${t.date}`
  if (t.type === 'salary' && t.personId) return `salary:${t.personId}:${t.date}`
  if (t.type === 'credit_card_payment' && t.creditCardId) return `credit_card_min:${t.creditCardId}:${t.date}`
  return null
}

export interface ProjectionResult {
  horizon: ProjectionHorizon
  horizonEnd: string // ISO date
  openingBalance: number
  clearedBalance: number // from real, stored, cleared transactions only
  projectedBalance: number // clearedBalance + all pending (real + generated) dated on/before horizonEnd
  transactions: Transaction[] // stored + generated (synthetic ids on the generated ones), sorted by date, for display
}

export function computeProjection(
  data: AppDataV2,
  personId: string,
  payCycle: PayCycleConfig,
  horizon: ProjectionHorizon,
  asOfDate: Date = new Date(),
): ProjectionResult {
  return {
    horizon,
    ...computeProjectionToDate(data, personId, payCycle, horizonRangeEnd(data, personId, horizon, asOfDate), asOfDate),
  }
}

/**
 * The same projection, but bounded by an EXPLICIT end date rather than
 * one of the two named horizons.
 *
 * Exists for the What-if "buy something" action, which needs the balance
 * on an arbitrary chosen date (and at the end of whichever cycle that
 * date falls in) — a date that can easily sit beyond `three_cycles`, and
 * which almost never coincides with a cycle end. Extracted rather than
 * reimplemented specifically so a purchase is measured against the exact
 * same generated occurrences, dedupe rules, and visibility floor as every
 * figure on the Summary page; a parallel implementation would be free to
 * drift from the real one, which is the failure mode this whole engine
 * exists to prevent.
 *
 * computeProjection is now a thin wrapper over this, so the two can't
 * disagree by construction.
 */
export function computeProjectionToDate(
  data: AppDataV2,
  personId: string,
  payCycle: PayCycleConfig,
  horizonEndDate: Date,
  asOfDate: Date = new Date(),
): Omit<ProjectionResult, 'horizon'> {
  const horizonEndIso = toIso(horizonEndDate)

  const person = data.people.find((p) => p.id === personId)
  // Opening balance is a visibility FLOOR, not just a starting number
  // (doc addendum): nothing dated before it should appear anywhere in
  // this person's ledger — there's no use seeing a payment that predates
  // the point the balance was actually reconciled from. Applied here, at
  // the one place `stored` gets assembled, so both the balance maths and
  // the displayed list stay consistent with each other automatically.
  //
  // This floor applies to EVERYTHING, overpayments included. An earlier
  // revision exempted loan overpayments and credit card lump payments
  // from it, to stop a retroactively-logged overpayment "vanishing" —
  // but that exemption was both unbounded and aimed at the wrong target,
  // and produced a worse bug than the one it fixed. Reproduced directly:
  // a £40 overpayment dated 2025-02-22 against an opening balance
  // reconciled at 2026-08-22 moved clearedBalance from £570.95 to
  // £530.95 — cash counted as leaving the account eighteen months AFTER
  // it actually did, and already inside the reconciled opening figure.
  // That's double-counting, which is precisely what a reconciliation
  // point exists to prevent.
  //
  // The original concern was real but belongs elsewhere: an overpayment
  // still has to affect the LOAN, and it does, independently of this
  // file. buildLoanSchedule reads loan.overpayments directly (see
  // ledgerLoans.ts) and cardBalanceAsOf replays against the card's own
  // balanceAsOfDate anchor — neither consults payCycle.openingBalanceDate
  // at all. Verified by scripts/verify-overpayment-independence.ts: the
  // same £40 still reduces Home Improvements' capitalRemaining by £40
  // with this exemption gone. So the overpayment keeps every effect it
  // legitimately has; all it loses is a place in a personal cash ledger
  // that had already accounted for it.
  //
  // An overpayment dated on or after the opening balance date is
  // unaffected and lands in cleared exactly as before, which is the
  // ordinary case — log a loan today, overpay it in a fortnight, and it
  // clears normally.
  const stored = data.transactions.filter((t) => t.location === 'personal' && t.ownerId === personId && t.date >= payCycle.openingBalanceDate)
  const existingKeys = new Set(stored.map(dedupeKey).filter((k): k is string => k !== null))

  // Generation starts from the CURRENT cycle's start, not from asOfDate —
  // otherwise a bill/loan/card payment whose nominal date already fell
  // earlier in the current cycle, but hasn't been separately materialized
  // into a real Transaction yet, would silently never appear anywhere.
  // Never generate anything before the opening balance date either, for
  // the same visibility-floor reason `stored` is filtered above.
  const cycleStart = resolveCycleBounds(data, personId, asOfDate).start
  const rangeStart = cycleStart > parseLocalDate(payCycle.openingBalanceDate) ? cycleStart : parseLocalDate(payCycle.openingBalanceDate)

  const generated: Omit<Transaction, 'id'>[] = []
  for (const template of data.recurringTemplates.filter((t) => t.location === 'personal' && t.ownerId === personId)) {
    // `payCycle` is only actually consulted when `template.kind ===
    // 'transfer' && template.followsPayday` (2026-09-04 session) — every
    // other kind ignores the 4th argument entirely, so this is safe to
    // pass unconditionally for every template this loop generates.
    generated.push(...generateTransactionsForTemplate(template, rangeStart, horizonEndDate, payCycle))
  }
  // UAT 2026-09-09 (ed-overpay-just-single) — pre-filtering loans by
  // `l.location === 'personal'` alone missed the REVERSE case from the
  // comment below: a POT-located loan whose recurring overpayment is
  // independently redirected to 'personal' was excluded from this loop
  // entirely, so that overpayment's personal-funded rows never appeared
  // anywhere on the Home page at all — confirmed as a real, reported gap,
  // not hypothetical. Also include a loan whenever
  // resolveRecurringOverpaymentSource resolves to 'personal' for it, even
  // if the loan's own location doesn't; the `.filter((t) =>
  // t.location === 'personal')` below still does the real work of picking
  // out only the rows that actually belong here.
  for (const loan of data.loans.filter((l) => l.ownerId === personId && l.active && (l.location === 'personal' || resolveRecurringOverpaymentSource(l).location === 'personal'))) {
    // Filtered to 'personal' rows only, not just pre-filtered by the
    // loan's own location — Pots backlog item (2026-09-03): a
    // 'personal'-location loan's RECURRING OVERPAYMENT can now
    // independently resolve to 'pot' (resolveRecurringOverpaymentSource
    // in ledgerLoans.ts), so a single call can return a mix of locations
    // for the same loan. Without this filter, a pot-funded overpayment
    // row would leak into this person's personal cash balance even
    // though it's meant to be purely internal to the pot.
    generated.push(...generateLoanPaymentTransactions(loan, rangeStart, horizonEndDate).filter((t) => t.location === 'personal'))
  }
  for (const card of data.creditCards.filter((c) => c.ownerId === personId)) {
    // Full transaction list, not the person-scoped `stored` one: the
    // card's derived balance has to see every payment and spend against
    // that card, and the visibility floor applied to `stored` above is a
    // display rule for the personal ledger, not a statement of what the
    // card actually owes.
    // Personal rows only: a pot-funded minimum payment (CreditCard.location)
    // is internal to the pot, same as a pot-funded loan payment.
    generated.push(...generateMinimumPaymentTransactions(card, rangeStart, horizonEndDate, data.transactions).filter((t) => t.location === 'personal'))
  }
  if (person) {
    generated.push(...generateSalaryTransactions(person, payCycle, rangeStart, horizonEndDate))
    for (const pension of data.pensions.filter((p) => p.personId === personId)) {
      generated.push(...generatePensionTransactions(pension, rangeStart, horizonEndDate))
    }
    // BUGFIX (2026-09-02, reported by Adam): recurring monthly deposits
    // and interest were computed correctly by savingsPotLedger.ts's own
    // functions (the Wallet info-icon modal and Home's SavingsPotsSection
    // both call them directly), but computeProjection — the thing that
    // actually builds the Home page's PERSONAL LEDGER list and balance —
    // never called them at all. A hand-logged deposit/withdrawal from the
    // Transactions page is a real stored Transaction, so it showed up
    // fine; a recurring deposit that hasn't materialized yet never had
    // anywhere to come from on this page. Same generator pattern as
    // pension/salary above: interest needs the real + already-generated
    // deposit activity to compute its balance-at-period-start correctly,
    // same as buildSavingsPotScheduleRows already does for the ledger
    // modal — so deposits are generated first, then passed in.
    // Defensive rather than trusting the type here (unlike data.pensions
    // just above, which doesn't get this treatment) — a real swept sweep
    // of this codebase's own test fixtures (2026-09-02) turned up several
    // using `as unknown as AppDataV2` to sidestep the type checker
    // entirely, several of which genuinely lacked savingsPots and crashed
    // at runtime the moment this loop was added. ledgerStorage.ts always
    // defaults it on load, so real app state should never hit this, but
    // an unsafe cast — test fixture or otherwise — shouldn't be able to
    // crash the whole projection over one missing array.
    for (const pot of (data.savingsPots ?? []).filter((p) => p.personId === personId && p.active)) {
      // Legacy field-based deposits still get pushed into `generated`
      // directly (unchanged behaviour). NEW transfer-template-based
      // deposits/withdrawals are deliberately NOT pushed into `generated`
      // a second time here — the top-level `location === 'personal'`
      // loop above already generated that exact occurrence once (every
      // transfer template carries `location: 'personal'`), so doing it
      // again here would double-count its effect on this person's cash
      // balance. They're still folded into `realActivity` below purely
      // so generateSavingsInterestTransactions sees them and compounds
      // correctly against money that hasn't materialized into a stored
      // Transaction yet.
      const legacyDeposits = generateSavingsDepositTransactions(pot, rangeStart, horizonEndDate)
      generated.push(...legacyDeposits)
      const transferDeposits = generateSavingsDepositTransactions(pot, rangeStart, horizonEndDate, data.recurringTemplates, payCycle).filter((t) => t.type === 'transfer')
      const transferWithdrawals = generateSavingsWithdrawalTransactions(pot, rangeStart, horizonEndDate, data.recurringTemplates, payCycle)
      const realActivity = [
        ...data.transactions,
        ...legacyDeposits.map((d, i) => ({ ...d, id: `generated:dep-preview:${i}` })),
        ...transferDeposits.map((d, i) => ({ ...d, id: `generated:xfer-dep-preview:${i}` })),
        ...transferWithdrawals.map((d, i) => ({ ...d, id: `generated:xfer-wd-preview:${i}` })),
      ]
      // 2026-09-14 (Adam-reported, savings interest destination) — a
      // savings pot's own generated interest can now be destined
      // elsewhere (Joint, a Pot, a different Savings Pot), not always
      // this person's own personal cash the way it unconditionally was
      // before that feature existed. Filtered to `location === 'personal'`
      // here, same as every OTHER generator this function pushes into
      // `generated` (loans/bills/recurring templates are all pre-filtered
      // to this person's personal-location activity before reaching this
      // point) — without this, a not-yet-materialized interest row
      // destined for the Joint account or a Pot would ALSO show up (and
      // ALSO count toward the balance) on this person's Personal ledger,
      // reintroducing the exact "same money counted twice" bug this
      // feature was built to fix, just via a different code path.
      generated.push(...generateSavingsInterestTransactions(pot, realActivity, rangeStart, horizonEndDate).filter((t) => t.location === 'personal'))
    }
    // Pots backlog item (2026-09-03) — a pot DEPOSIT is the one pot-
    // related thing that touches personal cash (see potLedger.ts's file
    // header), so it belongs in this person's own projection exactly
    // like a savings-pot deposit above. A pot-funded bill/loan PAYMENT
    // deliberately does NOT get generated here — it's purely internal to
    // the pot (potLedger.ts's own buildPotScheduleRows/potBalanceAsOf is
    // where that lives), the same way generateSavingsInterestTransactions
    // is deliberately never called in this file either.
    for (const pot of (data.pots ?? []).filter((p) => p.personId === personId && p.active)) {
      generated.push(...generatePotDepositTransactions(pot, rangeStart, horizonEndDate))
    }
  }
  const dedupedGenerated: Transaction[] = generated
    .filter((t) => {
      const key = dedupeKey(t)
      return key === null || !existingKeys.has(key)
    })
    .map((t) => ({ ...t, id: `generated:${nanoid(8)}` }))

  const combined = [...stored, ...dedupedGenerated]

  // clearedBalance reflects ALL cleared history, unbounded by the horizon
  // (a payment that already cleared last month still counts). The
  // horizon only bounds what counts toward pending, and what's included
  // in the returned display list below.
  const clearedBalance = round2(
    payCycle.openingBalance + combined.filter((t) => t.status === 'cleared' && isLedgerTransaction(t)).reduce((sum, t) => sum + signedAmount(t), 0),
  )

  const pendingWithinHorizon = combined.filter((t) => t.status === 'pending' && isLedgerTransaction(t) && t.date <= horizonEndIso)
  const projectedBalance = round2(clearedBalance + pendingWithinHorizon.reduce((sum, t) => sum + signedAmount(t), 0))

  return {
    horizonEnd: horizonEndIso,
    openingBalance: payCycle.openingBalance,
    clearedBalance,
    projectedBalance,
    // Bounded to the horizon window, same as the balance figures above —
    // a stored transaction dated beyond the current horizon (e.g. next
    // month's rent, already materialized ahead of time) is real data but
    // isn't part of THIS projection's view.
    transactions: combined
      .filter((t) => t.date <= horizonEndIso)
      .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1)),
  }
}

/** Month/cycle filtering (doc Section 4.1) — which of the given transactions fall inside [start, end] inclusive. */
export function transactionsInRange(transactions: Transaction[], start: Date, end: Date): Transaction[] {
  const s = toIso(start)
  const e = toIso(end)
  return transactions.filter((t) => t.date >= s && t.date <= e)
}

// ── Trends feature (2026-09-15 build) ──────────────────────────────────

/** "Spend" for the Personal Balance/Spend chart: every outgoing, ledger-eligible transaction (bills, loans, ad-hoc expense, card minimums, etc) — deliberately BROADER than averageSpendForecast's own ad-hoc-only SpendScope, which is reused unchanged only for the dotted line's daily RATE (see the Trends prompt doc's own clarification: reuse the existing forecast lib as-is, don't rebuild it) — not as the definition of the solid actual-spend-so-far line. */
function isPersonalSpend(t: Transaction): boolean {
  return isLedgerTransaction(t) && signedAmount(t) < 0
}

/**
 * Builds the Personal card's Balance/Spend trend series for the Trends
 * modal (and its small inline preview) — samples computeProjectionToDate
 * across every day of the requested granularity's period via
 * buildDailyBalanceSeries/buildDailySpendSeries, rather than re-deriving
 * balance/spend maths independently. The previous-period comparison line
 * reads directly from `data.transactions` (real, already-settled history)
 * rather than re-running the forward-looking projection engine, since a
 * fully past period has nothing left to project.
 */
export function buildPersonalTrendSeries(
  data: AppDataV2,
  personId: string,
  payCycle: PayCycleConfig,
  granularity: BalanceSpendGranularity,
  asOfDate: Date = new Date(),
): BalanceSpendTrendSeries {
  const horizon: ProjectionHorizon = granularity === 'this_cycle' ? 'current_cycle' : 'three_cycles'
  const cycles = horizonCycles(data, personId, horizon, asOfDate)
  const periodStart = cycles[0].start
  const periodEnd = cycles[cycles.length - 1].end
  const days = daysBetweenInclusive(periodStart, periodEnd)
  const todayIso = toIso(asOfDate)

  const projection = computeProjectionToDate(data, personId, payCycle, periodEnd, asOfDate)
  const balance = buildDailyBalanceSeries(payCycle.openingBalance, projection.transactions, days, signedAmount, isLedgerTransaction)
  const spend = buildDailySpendSeries(projection.transactions, days, isPersonalSpend)

  // Previous period: "This Cycle" compares to the single prior cycle;
  // "Next 3 Cycles" compares offsets 0-3 against -4 to -1 (per the prompt
  // doc's own table) — i.e. the same number of cycles immediately before.
  const cyclesBack = horizon === 'current_cycle' ? 1 : THREE_CYCLES_AHEAD + 1
  const prevCyclesDesc = previousCycles(data, personId, cyclesBack, asOfDate)
  const prevCyclesAsc = [...prevCyclesDesc].reverse()
  const prevDays = daysBetweenInclusive(prevCyclesAsc[0].start, prevCyclesAsc[prevCyclesAsc.length - 1].end)
  const prevStored = data.transactions.filter((t) => t.location === 'personal' && t.ownerId === personId)
  const previousPeriodSpend = buildDailySpendSeries(prevStored, prevDays, isPersonalSpend)

  return { granularity, days, todayIso, balance, spend, previousPeriodSpend }
}
