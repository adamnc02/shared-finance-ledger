// Savings pot as its own top-level ledger entity (backlog item a). Same
// relationship to pensionLedger.ts as that file has to schedule.ts —
// deliberately a separate implementation rather than forced through
// either existing walker, since SavingsPot's field set (interest method,
// two-sided deposit/withdrawal bookkeeping, a balance that has to be
// FOLDED from transactions rather than read off one field) doesn't match
// either. The date-walking shape for recurring deposits mirrors
// pensionLedger.ts's walkPensionOccurrences closely on purpose.

import { addDays, addMonths, addYears, startOfWeek } from 'date-fns'
import { toLocalIsoDate as toIso, parseLocalDate } from './date'
import { periodThresholdsFor, type PayFrequency } from './tax'
import { aerCreditedInterest, dailyAccrualInterest, walkCreditingDates, walkMonthlyCreditingDates } from './savingsInterest'
import { generateTransactionsForTemplate } from './schedule'
import { savingsPotSignedAmount, transferTouchesSavingsPot } from './transferLedger'
import { resolveCycleBounds } from './pensionLedger'
import { daysBetweenInclusive } from './runningBalance'
import { SAVINGS_CATEGORY_ID } from '../types/ledger'
import type { AppDataV2, PayCycleConfig, RecurringOccurrenceOverride, RecurringTemplate, SavingsInterestMethod, SavingsPot, Transaction, TransferLocation } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100
const MAX_OCCURRENCES = 2000

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate()
}
function clampToAnchorDay(date: Date, anchorDay: number): Date {
  const day = Math.min(anchorDay, daysInMonth(date.getFullYear(), date.getMonth()))
  return new Date(date.getFullYear(), date.getMonth(), day)
}

/** Convenience constructor — mirrors pensionLedger.ts's newPension. Covers both "new" (zero balance, openingDate defaults to today) and "existing" (real opening balance + date) creation paths per Adam's spec; the caller decides which fields to pass, this just fills the rest with sensible defaults. */
export function newSavingsPot(input: {
  personId: string
  name: string
  openingBalance: number
  openingDate: string
  interestMethod: SavingsInterestMethod
  targetAmount?: number
  targetDate?: string
  color: string
  interestDestination?: TransferLocation
}): Omit<SavingsPot, 'id'> {
  return {
    personId: input.personId,
    name: input.name,
    openingBalance: input.openingBalance,
    openingDate: input.openingDate,
    active: true,
    interestMethod: input.interestMethod,
    targetAmount: input.targetAmount,
    targetDate: input.targetDate,
    color: input.color,
    interestDestination: input.interestDestination,
  }
}

// ── Historized interest-method changes — mirrors resolvePensionAmount/applyPensionAmountChange exactly, against SavingsPot's method field instead of a bare number. ──

export function resolveInterestMethod(pot: SavingsPot, dateIso: string): SavingsInterestMethod {
  const candidates: { effectiveFrom: string; method: SavingsInterestMethod }[] = [...(pot.interestHistory ?? [])]
  if (pot.interestEffectiveFrom) candidates.push({ effectiveFrom: pot.interestEffectiveFrom, method: pot.interestMethod })
  if (candidates.length === 0) return pot.interestMethod

  const applicable = candidates
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c.effectiveFrom <= dateIso)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.index - a.index)
  return applicable[0]?.method ?? pot.interestMethod
}

export function applyInterestMethodChange(pot: SavingsPot, newMethod: SavingsInterestMethod, effectiveFrom: string): Pick<SavingsPot, 'interestMethod' | 'interestEffectiveFrom' | 'interestHistory'> {
  const priorEntry = { effectiveFrom: pot.interestEffectiveFrom ?? pot.openingDate, method: pot.interestMethod }
  return {
    interestMethod: newMethod,
    interestEffectiveFrom: effectiveFrom,
    interestHistory: [...(pot.interestHistory ?? []), priorEntry],
  }
}

// ── Recurring deposits (monthly-only, per spec) ─────────────────────

export interface RawDepositOccurrence {
  originalDate: string
  date: string
  amount: number
}

function walkDepositOccurrences(pot: SavingsPot, rangeStart: Date, rangeEnd: Date): RawDepositOccurrence[] {
  if (!pot.active) return []
  if (!pot.recurringDepositAmount || pot.recurringDepositAmount <= 0) return []
  if (!pot.recurringDepositStartDate || !pot.recurringDepositDayOfMonth) return []
  if (rangeEnd < rangeStart) return []

  const anchorDay = pot.recurringDepositDayOfMonth
  let cursor = clampToAnchorDay(parseLocalDate(pot.recurringDepositStartDate), anchorDay)
  let iterations = 0
  while (cursor < rangeStart && iterations < MAX_OCCURRENCES) {
    cursor = clampToAnchorDay(addMonths(cursor, 1), anchorDay)
    iterations++
  }

  const results: RawDepositOccurrence[] = []
  while (cursor <= rangeEnd && iterations < MAX_OCCURRENCES) {
    const originalDate = toIso(cursor)
    if (originalDate >= pot.openingDate) {
      // Pause is just the ordinary deleted-override mechanism now (see
      // SavingsPot.recurringDepositOverrides's own comment) — no separate
      // pause concept to check here at all.
      const override = pot.recurringDepositOverrides?.find((o) => o.originalDate === originalDate)
      if (!override?.deleted) {
        results.push({ originalDate, date: override?.date ?? originalDate, amount: override?.amount ?? pot.recurringDepositAmount })
      }
    }
    cursor = clampToAnchorDay(addMonths(cursor, 1), anchorDay)
    iterations++
  }
  return results
}

/**
 * REDESIGNED 2026-09-02 (Adam's explicit correction — no separate
 * pause/resume flow, one multi-select checklist instead). Given the
 * FULL set of dates the person now wants paused (checked in the
 * checklist, drawn from `windowDates` — the same last-2/next-12 window
 * the modal already shows), replaces every deleted-override inside that
 * window with exactly that set: a date newly checked gets a
 * `{originalDate, deleted: true}` entry added, a date unchecked has its
 * entry removed, and anything already correct is left alone. Overrides
 * OUTSIDE the shown window, or that carry a date/amount override rather
 * than a pure pause marker, are never touched by this — this function
 * only reconciles the pause checklist's own window.
 */
/**
 * What a SPECIFIC recurring-deposit occurrence resolves to, checking
 * `recurringDepositOverrides` first — mirrors schedule.ts's
 * resolveOccurrenceAmount / potLedger.ts's resolvePotDepositOccurrenceAmount
 * (2026-09-10, "Manage upcoming payments" redesign, call site #4).
 * `walkDepositOccurrences` above already reads an override's `.amount`
 * when generating transactions, so the real ledger has always been
 * correct — this is purely the missing single-date display resolver.
 * `originalDate` is the un-overridden scheduled date (the override's own
 * key).
 */
export function resolveSavingsPotDepositOccurrenceAmount(pot: SavingsPot, originalDate: string): number {
  const override = pot.recurringDepositOverrides?.find((o) => o.originalDate === originalDate)
  if (override?.amount !== undefined) return override.amount
  return pot.recurringDepositAmount ?? 0
}

/**
 * Builds the patch for a SINGLE-occurrence ("just a single payment")
 * amount change against a SavingsPot's recurring deposit — new for
 * 2026-09-10, identical shape to potLedger.ts's
 * applyPotSingleDepositAmountChange. Merges onto any existing override
 * for the same slot (e.g. a pause) rather than clobbering it.
 */
export function applySavingsPotSingleDepositAmountChange(pot: SavingsPot, newAmount: number, originalDate: string): Pick<SavingsPot, 'recurringDepositOverrides'> {
  const existing = pot.recurringDepositOverrides ?? []
  const priorEntry = existing.find((o) => o.originalDate === originalDate)
  const withoutThis = existing.filter((o) => o.originalDate !== originalDate)
  return { recurringDepositOverrides: [...withoutThis, { ...priorEntry, originalDate, amount: newAmount }] }
}

// UAT 2026-09-11 fix — merges `deleted` onto the SAME override entry a
// prior single-occurrence amount override lives on, instead of creating
// a second entry sharing the same originalDate (see schedule.ts's
// setPausedTemplateOccurrences for the full "pausing an already-amount-
// overridden occurrence silently did nothing" bug this replaces).
export function setPausedDeposits(pot: SavingsPot, windowDates: string[], pausedDates: string[]): Pick<SavingsPot, 'recurringDepositOverrides'> {
  const windowSet = new Set(windowDates)
  const pausedSet = new Set(pausedDates)
  const outside = (pot.recurringDepositOverrides ?? []).filter((o) => !windowSet.has(o.originalDate))
  const priorByDate = new Map((pot.recurringDepositOverrides ?? []).filter((o) => windowSet.has(o.originalDate)).map((o) => [o.originalDate, o]))
  const merged: RecurringOccurrenceOverride[] = []
  for (const originalDate of windowSet) {
    const prior = priorByDate.get(originalDate)
    const isPaused = pausedSet.has(originalDate)
    if (!isPaused && prior?.date === undefined && prior?.amount === undefined) continue
    const entry: RecurringOccurrenceOverride = { originalDate }
    if (prior?.date !== undefined) entry.date = prior.date
    if (prior?.amount !== undefined) entry.amount = prior.amount
    if (isPaused) entry.deleted = true
    merged.push(entry)
  }
  return { recurringDepositOverrides: [...outside, ...merged] }
}

/**
 * Every calendar date the recurring schedule would land on in
 * [rangeStart, rangeEnd] — deliberately IGNORING pause state entirely,
 * unlike walkDepositOccurrences. This is what the pause checklist itself
 * shows as candidates: it has to list a date THAT'S CURRENTLY PAUSED so
 * the person can uncheck it, which a pause-aware walk would never
 * surface (a paused date isn't a real occurrence any more, generator-
 * side — this function is the one place that still needs to see it as a
 * calendar slot regardless).
 */
export function scheduledDepositDates(pot: SavingsPot, rangeStart: Date, rangeEnd: Date): string[] {
  if (!pot.recurringDepositAmount || pot.recurringDepositAmount <= 0) return []
  if (!pot.recurringDepositStartDate || !pot.recurringDepositDayOfMonth) return []
  if (rangeEnd < rangeStart) return []

  const anchorDay = pot.recurringDepositDayOfMonth
  let cursor = clampToAnchorDay(parseLocalDate(pot.recurringDepositStartDate), anchorDay)
  let iterations = 0
  while (cursor < rangeStart && iterations < MAX_OCCURRENCES) {
    cursor = clampToAnchorDay(addMonths(cursor, 1), anchorDay)
    iterations++
  }

  const results: string[] = []
  while (cursor <= rangeEnd && iterations < MAX_OCCURRENCES) {
    const originalDate = toIso(cursor)
    if (originalDate >= pot.openingDate) results.push(originalDate)
    cursor = clampToAnchorDay(addMonths(cursor, 1), anchorDay)
    iterations++
  }
  return results
}

/**
 * Generates pending deposit-shaped transactions for the recurring
 * schedule — same "compute what should exist, caller dedupes against
 * real stored rows" contract as every other generator in this app.
 *
 * Two sources, merged (2026-09-04 session, Transfer pill):
 *  - the LEGACY `recurringDepositAmount`/`recurringDepositDayOfMonth`
 *    fields on `pot` itself (SUPERSEDED — see their own comment in
 *    types/ledger.ts — kept purely so a pot from a pre-2026-09-04 backup
 *    keeps generating exactly as before).
 *  - any `kind: 'transfer'` RecurringTemplate whose transferFrom/
 *    transferTo references this pot — the new, single mechanism every
 *    recurring deposit created from now on (Wallet-page card OR
 *    Transactions page Transfer pill) actually uses. `transferTemplates`
 *    should be `data.recurringTemplates` — passed in rather than this
 *    file importing AppDataV2 wholesale, to keep this function's
 *    dependency surface as small as the rest of this file's functions.
 *    `payCycle` is only consulted for a follows-payday transfer template
 *    (see schedule.ts's generateTransactionsForTemplate).
 */
export function generateSavingsDepositTransactions(
  pot: SavingsPot,
  rangeStart: Date,
  rangeEnd: Date,
  transferTemplates: RecurringTemplate[] = [],
  payCycle?: PayCycleConfig,
): Omit<Transaction, 'id'>[] {
  const legacy = walkDepositOccurrences(pot, rangeStart, rangeEnd).map((occ) => ({
    date: occ.date,
    amount: occ.amount,
    direction: 'out' as const,
    categoryId: SAVINGS_CATEGORY_ID,
    paymentMethod: 'bank_transfer' as const,
    status: 'pending' as const,
    type: 'savings_deposit' as const,
    location: 'personal' as const,
    ownerId: pot.personId,
    sourceType: 'savings_pot' as const,
    sourceId: pot.id,
    savingsPotId: pot.id,
    note: pot.name,
  }))

  const fromTransfers = transferTemplates
    .filter((t) => t.kind === 'transfer' && t.active && transferTouchesSavingsPot(t.transferFrom, t.transferTo, pot.id))
    .flatMap((t) => generateTransactionsForTemplate(t, rangeStart, rangeEnd, payCycle))
    // Only the INFLOW side counts as a "deposit" here — a transfer
    // template could equally have this pot as the SOURCE (a withdrawal
    // funding something else), which generateSavingsWithdrawalTransactions
    // below picks up instead.
    .filter((t) => t.toLocation?.type === 'savings' && t.toLocation.savingsPotId === pot.id)

  return [...legacy, ...fromTransfers]
}

/**
 * The withdrawal-side equivalent of generateSavingsDepositTransactions
 * above — there's no legacy field-based mechanism for a recurring
 * withdrawal (savings withdrawals were always hand-logged, one-off), so
 * this only ever has one source: a `kind: 'transfer'` template with this
 * pot as `transferFrom`.
 */
export function generateSavingsWithdrawalTransactions(
  pot: SavingsPot,
  rangeStart: Date,
  rangeEnd: Date,
  transferTemplates: RecurringTemplate[] = [],
  payCycle?: PayCycleConfig,
): Omit<Transaction, 'id'>[] {
  return transferTemplates
    .filter((t) => t.kind === 'transfer' && t.active && transferTouchesSavingsPot(t.transferFrom, t.transferTo, pot.id))
    .flatMap((t) => generateTransactionsForTemplate(t, rangeStart, rangeEnd, payCycle))
    .filter((t) => t.fromLocation?.type === 'savings' && t.fromLocation.savingsPotId === pot.id)
}

/** Next N upcoming recurring-deposit occurrences, for the Wallet page's editable pills. */
export function depositOccurrencePreviews(pot: SavingsPot, asOfDate: Date, count: number): RawDepositOccurrence[] {
  return walkDepositOccurrences(pot, asOfDate, addYears(asOfDate, 15)).slice(0, count)
}

// ── Balance — derived, never stored, same philosophy as CreditCard's currentBalance-as-anchor-plus-replay (see cardBalanceAsOf) ──

/**
 * True when a STORED Transaction belongs on this savings pot's own
 * ledger — `t.savingsPotId === pot.id` alone is right for every non-
 * transfer type, but ambiguous for a `type: 'transfer'` row with a
 * savings pot on BOTH ends (e.g. Savings A → Savings B) — same reasoning
 * as potLedger.ts's transactionTouchesPot.
 */
function transactionTouchesSavingsPot(t: Pick<Transaction, 'type' | 'savingsPotId' | 'fromLocation' | 'toLocation'>, savingsPotId: string): boolean {
  if (t.type === 'transfer') return transferTouchesSavingsPot(t.fromLocation, t.toLocation, savingsPotId)
  return t.savingsPotId === savingsPotId
}

/** This pot's balance as of a given date, folding openingBalance against every deposit/withdrawal/interest transaction for it dated within [openingDate, asOfDate]. `activity` should already include any generated-but-not-yet-materialized rows the caller wants counted (e.g. projected future deposits/interest) — this function only folds, it never generates. Anything dated before openingDate is ignored outright, per spec. */
export function savingsPotBalanceAsOf(pot: SavingsPot, activity: Transaction[], asOfDate: Date): number {
  const asOfIso = toIso(asOfDate)
  const relevant = activity
    .filter((t) => transactionTouchesSavingsPot(t, pot.id) && t.date >= pot.openingDate && t.date <= asOfIso)
    .sort((a, b) => a.date.localeCompare(b.date))

  let balance = pot.openingBalance
  for (const t of relevant) balance += savingsPotActivityDelta(t, pot.id)
  return round2(balance)
}

/** How one activity row moves this pot's balance — positive in, negative out, 0 for a type that doesn't touch the balance. The single rule both savingsPotBalanceAsOf and the trend series' in/out totals use, so the two can't disagree. */
function savingsPotActivityDelta(t: Transaction, savingsPotId: string): number {
  if (t.type === 'savings_deposit' || t.type === 'savings_interest') return t.amount
  if (t.type === 'savings_withdrawal') return -t.amount
  if (t.type === 'transfer') return savingsPotSignedAmount(t, savingsPotId)
  return 0
}

/**
 * Highest balance the pot holds at any point across [startIso, endIso]
 * (Adam, 2026-09-16): the balance entering the range, and within each day
 * that day's money IN applied before its money OUT — so £500 + £500 in and
 * £300 out on one day peaks at £1,000, not the £700 it closes at. Rows carry
 * no time of day, so in-before-out is the stated convention, not a
 * measurement. One sorted pass rather than savingsPotBalanceAsOf per day,
 * since the modal rebuilds its series on every drag re-render.
 */
function savingsPotPeakBalance(pot: SavingsPot, activity: Transaction[], startIso: string, endIso: string): number {
  const relevant = activity
    .filter((t) => transactionTouchesSavingsPot(t, pot.id) && t.date >= pot.openingDate && t.date <= endIso)
    .sort((a, b) => a.date.localeCompare(b.date))
  let balance = pot.openingBalance
  let i = 0
  for (; i < relevant.length && relevant[i].date < startIso; i++) balance += savingsPotActivityDelta(relevant[i], pot.id)
  let peak = balance
  while (i < relevant.length) {
    const date = relevant[i].date
    let dayIn = 0
    let dayOut = 0
    for (; i < relevant.length && relevant[i].date === date; i++) {
      const delta = savingsPotActivityDelta(relevant[i], pot.id)
      if (delta > 0) dayIn += delta
      else dayOut -= delta
    }
    peak = Math.max(peak, balance + dayIn)
    balance += dayIn - dayOut
  }
  return round2(Math.max(0, peak))
}

/** Money in and out of the pot across [startIso, endIso] inclusive, from the same rows and filter savingsPotBalanceAsOf folds — so for any period, moneyIn - moneyOut equals the change in balance across it. The opening balance is not a flow. */
function savingsPotFlowsBetween(pot: SavingsPot, activity: Transaction[], startIso: string, endIso: string): { moneyIn: number; moneyOut: number } {
  let moneyIn = 0
  let moneyOut = 0
  for (const t of activity) {
    if (!transactionTouchesSavingsPot(t, pot.id) || t.date < pot.openingDate || t.date < startIso || t.date > endIso) continue
    const delta = savingsPotActivityDelta(t, pot.id)
    if (delta > 0) moneyIn += delta
    else moneyOut -= delta
  }
  return { moneyIn: round2(moneyIn), moneyOut: round2(moneyOut) }
}

// ── Interest generation ──────────────────────────────────────────────
// Chronological by construction: each crediting date's interest is
// computed against the balance as of that period's start using
// savingsPotBalanceAsOf against (realActivity + interest already
// generated earlier in this same walk) — which is what makes
// compounding fall out correctly without any special-casing.

/**
 * Where a pot's generated interest actually lands — resolves
 * `pot.interestDestination` (undefined = the SAME pot, i.e. self-
 * compounding, the sensible default) into the four Transaction fields
 * that determine which ledger(s) it touches.
 *
 * 2026-09-14 (Adam-reported) — before this existed, every generated
 * interest row was unconditionally `location: 'personal'` AND carried
 * this pot's own `savingsPotId` at once, so it counted toward BOTH the
 * pot's own balance (via transactionTouchesSavingsPot, keyed purely off
 * savingsPotId) AND the owner's personal cash balance (via the personal
 * ledger's `location === 'personal'` filter) simultaneously — real
 * double-counted money, not just a duplicated row. Now exactly one of
 * location/ownerId/potId/savingsPotId reflects the chosen destination, so
 * the interest touches exactly one ledger, same as any other transaction.
 */
function resolveInterestDestinationFields(pot: SavingsPot): Pick<Transaction, 'location' | 'ownerId' | 'potId' | 'savingsPotId'> {
  const dest = pot.interestDestination ?? { type: 'savings' as const, savingsPotId: pot.id }
  switch (dest.type) {
    case 'personal':
      return { location: 'personal', ownerId: pot.personId }
    case 'joint':
      return { location: 'joint', ownerId: pot.personId }
    case 'pot':
      return { location: 'pot', ownerId: pot.personId, potId: dest.potId }
    case 'savings':
    default:
      return { location: 'savings', ownerId: pot.personId, savingsPotId: dest.savingsPotId }
  }
}

/** Generates 'savings_interest' transactions for every crediting date in range, honouring interestOverrides and each method's own resolved history. `realActivity` = every real deposit/withdrawal (cleared or pending, already materialized or freshly generated by the caller) for this pot — NOT including interest, which this function produces itself. */
export function generateSavingsInterestTransactions(pot: SavingsPot, realActivity: Transaction[], rangeStart: Date, rangeEnd: Date): Omit<Transaction, 'id'>[] {
  const results: Omit<Transaction, 'id'>[] = []
  const generatedSoFar: Transaction[] = []
  const activityPlusGenerated = () => [...realActivity, ...generatedSoFar]
  // 2026-09-16 — a crediting period that already has a STORED interest
  // payment for this pot on a different day is already paid. Crediting
  // dates are counted from openingDate, so moving that date (Rebalance
  // accounts can) shifted every period's date and re-created the whole
  // interest history alongside what was already stored. Same-day matches
  // were always caught by the date dedupe; this catches the rest.
  const storedInterestDates = realActivity
    .filter((t) => t.type === 'savings_interest' && (t.sourceId === pot.id || (t.sourceType === undefined && t.savingsPotId === pot.id)) && !t.id.startsWith('generated:'))
    .map((t) => t.date)
  const periodAlreadyPaid = (c: { date: string; periodStart: string }) => storedInterestDates.some((d) => d !== c.date && d > c.periodStart && d <= c.date)

  const method = resolveInterestMethod(pot, toIso(rangeEnd))
  // NOTE: resolving once against rangeEnd rather than per-date is a
  // deliberate simplification — a method change mid-range would need
  // per-crediting-date resolution to be fully correct. Flagging rather
  // than silently under-building: fine for "the method as it stands
  // today" (the common case, and the only one the UI currently drives
  // toward), genuinely wrong if a rate change's effective date falls
  // inside the requested range. Worth revisiting if that becomes a real
  // scenario rather than a theoretical one.

  if (method.type === 'aer_credited') {
    // Walks from the pot's OWN openingDate regardless of rangeStart —
    // every period has to be generated internally (into generatedSoFar)
    // so later periods compound on it correctly, even though only
    // dates >= rangeStart are actually returned to the caller below.
    for (const c of walkCreditingDates(pot.openingDate, method.creditingFrequency, rangeEnd)) {
      if (periodAlreadyPaid(c)) continue
      const override = pot.interestOverrides?.find((o) => o.date === c.date)
      const balanceAtStart = savingsPotBalanceAsOf(pot, activityPlusGenerated(), parseLocalDate(c.periodStart))
      const amount = override?.amount ?? aerCreditedInterest(balanceAtStart, method)
      const row: Omit<Transaction, 'id'> = {
        date: c.date,
        amount,
        direction: 'in',
        categoryId: SAVINGS_CATEGORY_ID,
        paymentMethod: 'bank_transfer',
        status: 'pending',
        type: 'savings_interest',
        ...resolveInterestDestinationFields(pot),
        sourceType: override ? undefined : 'savings_pot',
        sourceId: override ? undefined : pot.id,
        note: `${pot.name} — interest`,
      }
      generatedSoFar.push({ ...row, id: `generated:interest:${pot.id}:${c.date}` })
      if (c.date >= toIso(rangeStart)) results.push(row)
    }
    return results
  }

  // daily_accrual_monthly_credited
  for (const c of walkMonthlyCreditingDates(pot.openingDate, rangeEnd)) {
    if (periodAlreadyPaid(c)) continue
    const override = pot.interestOverrides?.find((o) => o.date === c.date)
    let amount: number
    if (override) {
      amount = override.amount
    } else {
      const dailyBalances = dailyBalancesFor(pot, activityPlusGenerated(), parseLocalDate(c.periodStart), parseLocalDate(c.periodEnd))
      amount = dailyAccrualInterest(dailyBalances, parseLocalDate(c.periodStart), parseLocalDate(c.periodEnd), method)
    }
    const row: Omit<Transaction, 'id'> = {
      date: c.date,
      amount,
      direction: 'in',
      categoryId: SAVINGS_CATEGORY_ID,
      paymentMethod: 'bank_transfer',
      status: 'pending',
      type: 'savings_interest',
      ...resolveInterestDestinationFields(pot),
      sourceType: override ? undefined : 'savings_pot',
      sourceId: override ? undefined : pot.id,
      note: `${pot.name} — interest`,
    }
    generatedSoFar.push({ ...row, id: `generated:interest:${pot.id}:${c.date}` })
    if (c.date >= toIso(rangeStart)) results.push(row)
  }
  return results
}

/** The actual daily balance across [periodStart, periodEnd) — the opening figure at periodStart, stepped forward by every deposit/withdrawal dated inside the window. Interest itself is deliberately excluded from this replay: it doesn't change the daily balance until IT credits, which only happens at a month boundary — including it here would double-apply the same money on its own crediting day. */
function dailyBalancesFor(pot: SavingsPot, activity: Transaction[], periodStart: Date, periodEnd: Date): { date: string; balance: number }[] {
  const openingBalance = savingsPotBalanceAsOf(pot, activity, addDays(periodStart, -1))
  const movements = activity
    .filter(
      (t) =>
        transactionTouchesSavingsPot(t, pot.id) &&
        (t.type === 'savings_deposit' || t.type === 'savings_withdrawal' || t.type === 'transfer') &&
        t.date >= toIso(periodStart) &&
        t.date < toIso(periodEnd),
    )
    .sort((a, b) => a.date.localeCompare(b.date))

  const result: { date: string; balance: number }[] = [{ date: toIso(periodStart), balance: openingBalance }]
  let balance = openingBalance
  for (const m of movements) {
    const delta = m.type === 'savings_deposit' ? m.amount : m.type === 'savings_withdrawal' ? -m.amount : savingsPotSignedAmount(m, pot.id)
    balance = round2(balance + delta)
    result.push({ date: m.date, balance })
  }
  return result
}

// ── Ramp-up preview window (info-icon modal) ─────────────────────────
// Same "only show real data" fix already proven for CreditCard's
// buildCreditCardMinimumChargeRows (a brand-new card was showing a
// fabricated year of past charges before that fix): a brand-new pot has
// no real history before its openingDate, so showing a blanket "last 2
// months" window would fabricate months that never happened. Ramps up
// as the pot actually ages, per Adam's spec:
//   0 months old  → next 12 only
//   1 month old   → last 1 + next 12
//   2+ months old → last 2 + next 12 (steady state)

export function schedulePreviewWindow(pot: SavingsPot, asOfDate: Date): { start: Date; end: Date } {
  const openingDate = parseLocalDate(pot.openingDate)
  const monthsOld = Math.max(0, (asOfDate.getFullYear() - openingDate.getFullYear()) * 12 + (asOfDate.getMonth() - openingDate.getMonth()))
  const monthsBack = Math.min(2, monthsOld)
  const start = new Date(Math.max(addMonths(asOfDate, -monthsBack).getTime(), openingDate.getTime()))
  const end = addYears(asOfDate, 1)
  return { start, end }
}

export interface SavingsPotScheduleRow {
  date: string
  type: 'savings_deposit' | 'savings_withdrawal' | 'savings_interest'
  amount: number
  status: 'cleared' | 'pending'
  overridable: boolean // only interest rows are editable from this modal, per spec
}

/**
 * Builds the combined deposit/withdrawal/interest row list for the
 * pot's info-icon modal, across the ramp-up window above. `stored` =
 * real transactions already in data.transactions for this pot (cleared
 * or pending); generated rows for dates already covered by a stored row
 * are skipped, same dedupe convention as every other generator/modal
 * pairing in this app. `transferTemplates`/`payCycle` — see
 * generateSavingsDepositTransactions' own comment (2026-09-04 session).
 */
export function buildSavingsPotScheduleRows(
  pot: SavingsPot,
  stored: Transaction[],
  asOfDate: Date = new Date(),
  transferTemplates: RecurringTemplate[] = [],
  payCycle?: PayCycleConfig,
): SavingsPotScheduleRow[] {
  const { start, end } = schedulePreviewWindow(pot, asOfDate)
  const potStored = stored.filter((t) => transactionTouchesSavingsPot(t, pot.id) && t.date >= toIso(start) && t.date <= toIso(end))
  const storedDates = new Set(potStored.map((t) => `${t.type}:${t.date}`))

  const generatedDeposits = generateSavingsDepositTransactions(pot, start, end, transferTemplates, payCycle).filter((t) => !storedDates.has(`${t.type}:${t.date}`))
  const generatedWithdrawals = generateSavingsWithdrawalTransactions(pot, start, end, transferTemplates, payCycle).filter((t) => !storedDates.has(`${t.type}:${t.date}`))
  const generatedInterest = generateSavingsInterestTransactions(
    pot,
    [...stored, ...generatedDeposits.map((t, i) => ({ ...t, id: `generated:dep:${i}` })), ...generatedWithdrawals.map((t, i) => ({ ...t, id: `generated:wd:${i}` }))],
    start,
    end,
  ).filter((t) => !storedDates.has(`savings_interest:${t.date}`))

  const rows: SavingsPotScheduleRow[] = [
    // A stored `type: 'transfer'` row isn't itself a member of this row's
    // type union — resolve it to deposit/withdrawal from THIS pot's own
    // side (checking `savingsPotId` specifically, not just `type ===
    // 'savings'`, for the same Savings A → Savings B ambiguity
    // transactionTouchesSavingsPot's own comment describes).
    ...potStored.map((t) => ({
      date: t.date,
      type: (t.type === 'transfer' ? (t.toLocation?.type === 'savings' && t.toLocation.savingsPotId === pot.id ? 'savings_deposit' : 'savings_withdrawal') : t.type) as SavingsPotScheduleRow['type'],
      amount: t.amount,
      status: t.status,
      overridable: t.type === 'savings_interest',
    })),
    ...generatedDeposits.map((t) => ({ date: t.date, type: (t.type === 'transfer' ? 'savings_deposit' : t.type) as 'savings_deposit', amount: t.amount, status: 'pending' as const, overridable: false })),
    ...generatedWithdrawals.map((t) => ({ date: t.date, type: 'savings_withdrawal' as const, amount: t.amount, status: 'pending' as const, overridable: false })),
    ...generatedInterest.map((t) => ({ date: t.date, type: 'savings_interest' as const, amount: t.amount, status: 'pending' as const, overridable: true })),
  ]
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

// ── Trends feature (2026-09-15 build) — the pill/column chart ─────────
// Savings Pot is the one card type that gets the pill-chart style instead
// of the Balance/Spend line-area chart (Adam-confirmed). Each column is
// the pot's own END-OF-PERIOD balance (not a net-change-only bar); the
// tap-and-hold tooltip's headline metric switches meaning by sign of that
// period's net movement — "total saved" when positive, "amount withdrawn"
// when negative (both per the prompt doc's own clarification).
//
// `resolveCycleBounds`/local cycle walking is duplicated from
// projection.ts's horizonCycles/previousCycles here (not imported) for the
// same reason creditCards.ts duplicates it: projection.ts already imports
// FROM this file (generateSavingsDepositTransactions et al), so importing
// projection.ts back here would be circular.

export type SavingsPotPillGranularity = 'this_cycle' | 'last_6_cycles' | 'year'

export interface SavingsPotPillPoint {
  periodStart: string
  periodEnd: string
  endBalance: number
  netChange: number // positive = net saved this period, negative = net withdrawn
  /** Gross money in / out behind netChange (PROMPT-04 Bug B, 2026-09-16): a period can net to £0 or a small figure while hiding a large deposit and withdrawal. Both positive; moneyIn - moneyOut === netChange. */
  moneyIn: number
  moneyOut: number
  axisLabel: string // this point's own natural label — the chart component caps how many are actually SHOWN (max 4), per the prompt doc's table
  tooltipLabel: string // fuller label for the tooltip (e.g. "w/c 1 Sep · w/e 7 Sep", or "Jul 2026")
}

export interface SavingsPotTrendSeries {
  granularity: SavingsPotPillGranularity
  points: SavingsPotPillPoint[] // ascending by period
  /** Highest balance the pot reaches anywhere across the whole view, including a peak inside a single period (see savingsPotPeakBalance) — the full-height reference every column's endBalance is drawn against. */
  peakBalance: number
}

function savingsPotCycleBounds(data: AppDataV2, personId: string, asOfDate: Date): { start: Date; end: Date } {
  return resolveCycleBounds(data, personId, asOfDate)
}

/** Every real+generated activity row touching this pot across [rangeStart, rangeEnd] — same generate-then-dedupe-against-real shape as buildSavingsPotScheduleRows, just parameterised by an arbitrary range instead of the fixed ramp-up preview window (which only ever looks a couple of months back — too short for "Last 6 Cycles"/"Year"). Deliberately NOT reused wholesale from buildSavingsPotScheduleRows for that reason. */
function savingsPotActivityForRange(
  pot: SavingsPot,
  stored: Transaction[],
  rangeStart: Date,
  rangeEnd: Date,
  transferTemplates: RecurringTemplate[] = [],
  payCycle?: PayCycleConfig,
): Transaction[] {
  const potStored = stored.filter((t) => transactionTouchesSavingsPot(t, pot.id) && t.date >= pot.openingDate)
  const storedKeys = new Set(potStored.map((t) => `${t.type}:${t.date}`))
  const generatedDeposits = generateSavingsDepositTransactions(pot, rangeStart, rangeEnd, transferTemplates, payCycle).filter((t) => !storedKeys.has(`${t.type}:${t.date}`))
  const generatedWithdrawals = generateSavingsWithdrawalTransactions(pot, rangeStart, rangeEnd, transferTemplates, payCycle).filter((t) => !storedKeys.has(`${t.type}:${t.date}`))
  const generatedInterest = generateSavingsInterestTransactions(
    pot,
    [...potStored, ...generatedDeposits.map((t, i) => ({ ...t, id: `generated:trend-dep:${i}` })), ...generatedWithdrawals.map((t, i) => ({ ...t, id: `generated:trend-wd:${i}` }))],
    rangeStart,
    rangeEnd,
  ).filter((t) => !storedKeys.has(`savings_interest:${t.date}`))
  const generated = [...generatedDeposits, ...generatedWithdrawals, ...generatedInterest].map((t, i) => ({ ...t, id: `generated:trend:${i}` }))
  return [...potStored, ...generated]
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function shortDateLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTH_ABBR[m - 1]}`
}

/**
 * Builds the pill-chart series for one of the three Savings Pot
 * granularities: This Cycle (one column per DAY of the current pay
 * cycle), Last 6 Cycles (one column per WEEK across the current cycle
 * plus the 5 before it), or Year (one column per PAY CYCLE across the
 * current one plus the 11 before it, offset-labelled 0/-1/-2/... —
 * deliberately ignoring any this-cycle/next-cycle filter elsewhere on the
 * page, per the prompt doc's own table).
 */
export function buildSavingsPotTrendSeries(
  data: AppDataV2,
  pot: SavingsPot,
  granularity: SavingsPotPillGranularity,
  asOfDate: Date = new Date(),
): SavingsPotTrendSeries {
  const personId = pot.personId
  const payCycle = data.payCycles.find((c) => c.personId === personId)
  const transferTemplates = data.recurringTemplates
  const stored = data.transactions

  if (granularity === 'this_cycle') {
    const { start, end } = savingsPotCycleBounds(data, personId, asOfDate)
    const rangeStart = new Date(Math.max(start.getTime(), parseLocalDate(pot.openingDate).getTime()))
    const days = daysBetweenInclusive(rangeStart, end)
    const activity = savingsPotActivityForRange(pot, stored, rangeStart, end, transferTemplates, payCycle)
    let prevBalance = savingsPotBalanceAsOf(pot, activity, addDays(rangeStart, -1))
    const points: SavingsPotPillPoint[] = days.map((date) => {
      const endBalance = savingsPotBalanceAsOf(pot, activity, parseLocalDate(date))
      const netChange = round2(endBalance - prevBalance)
      prevBalance = endBalance
      return { periodStart: date, periodEnd: date, endBalance, netChange, ...savingsPotFlowsBetween(pot, activity, date, date), axisLabel: shortDateLabel(date), tooltipLabel: shortDateLabel(date) }
    })
    return { granularity, points, peakBalance: savingsPotPeakBalance(pot, activity, days[0] ?? toIso(rangeStart), toIso(end)) }
  }

  if (granularity === 'last_6_cycles') {
    const current = savingsPotCycleBounds(data, personId, asOfDate)
    let cursor = current.start
    for (let i = 0; i < 5; i++) cursor = savingsPotCycleBounds(data, personId, addDays(cursor, -1)).start
    const rangeStart = new Date(Math.max(cursor.getTime(), parseLocalDate(pot.openingDate).getTime()))
    const rangeEnd = current.end
    const activity = savingsPotActivityForRange(pot, stored, rangeStart, rangeEnd, transferTemplates, payCycle)

    // Weekly buckets, Monday-start ("w/c" = week commencing).
    const weekStarts: Date[] = []
    let weekCursor = startOfWeek(rangeStart, { weekStartsOn: 1 })
    while (weekCursor <= rangeEnd) {
      weekStarts.push(weekCursor)
      weekCursor = addDays(weekCursor, 7)
    }
    let prevBalance = savingsPotBalanceAsOf(pot, activity, addDays(weekStarts[0] ?? rangeStart, -1))
    const points: SavingsPotPillPoint[] = weekStarts.map((wStart) => {
      const wEnd = new Date(Math.min(addDays(wStart, 6).getTime(), rangeEnd.getTime()))
      const endBalance = savingsPotBalanceAsOf(pot, activity, wEnd)
      const netChange = round2(endBalance - prevBalance)
      prevBalance = endBalance
      const startIso = toIso(wStart)
      const endIso = toIso(wEnd)
      return {
        periodStart: startIso,
        periodEnd: endIso,
        endBalance,
        netChange,
        ...savingsPotFlowsBetween(pot, activity, startIso, endIso),
        axisLabel: `w/c ${shortDateLabel(startIso)}`,
        tooltipLabel: `w/c ${shortDateLabel(startIso)} · w/e ${shortDateLabel(endIso)}`,
      }
    })
    return { granularity, points, peakBalance: savingsPotPeakBalance(pot, activity, toIso(weekStarts[0] ?? rangeStart), toIso(rangeEnd)) }
  }

  // 'year' — one column per pay cycle, current + 11 before it, offset-labelled.
  const cyclesDesc: { start: Date; end: Date }[] = [savingsPotCycleBounds(data, personId, asOfDate)]
  for (let i = 0; i < 11; i++) cyclesDesc.push(savingsPotCycleBounds(data, personId, addDays(cyclesDesc[cyclesDesc.length - 1].start, -1)))
  // Cycles that ended before the pot opened are hidden (Adam, 2026-09-16), matching This Cycle
  // (starts at openingDate) and Last 6 Cycles (starts at the week it opened). Previously they
  // rendered as full columns, because savingsPotBalanceAsOf returns openingBalance for any date,
  // including dates before the pot existed. The current cycle is always kept.
  const openingIso = pot.openingDate
  const allCyclesAsc = [...cyclesDesc].reverse() // oldest..current
  const cyclesAsc = allCyclesAsc.filter((c, i) => i === allCyclesAsc.length - 1 || toIso(c.end) >= openingIso)
  const rangeStart = new Date(Math.max(cyclesAsc[0].start.getTime(), parseLocalDate(pot.openingDate).getTime()))
  const rangeEnd = cyclesAsc[cyclesAsc.length - 1].end
  const activity = savingsPotActivityForRange(pot, stored, rangeStart, rangeEnd, transferTemplates, payCycle)
  let prevBalance = savingsPotBalanceAsOf(pot, activity, addDays(cyclesAsc[0].start, -1))
  const points: SavingsPotPillPoint[] = cyclesAsc.map((cycle, i) => {
    const offset = i - (cyclesAsc.length - 1) // 0 for current (last element), negative going back
    const endBalance = savingsPotBalanceAsOf(pot, activity, cycle.end)
    const netChange = round2(endBalance - prevBalance)
    prevBalance = endBalance
    const startIso = toIso(cycle.start)
    const endIso = toIso(cycle.end)
    return {
      periodStart: startIso,
      periodEnd: endIso,
      endBalance,
      netChange,
      ...savingsPotFlowsBetween(pot, activity, startIso, endIso),
      axisLabel: `${offset}`,
      tooltipLabel: `${MONTH_ABBR[cycle.start.getMonth()]} ${cycle.start.getFullYear()}`,
    }
  })
  return { granularity, points, peakBalance: savingsPotPeakBalance(pot, activity, toIso(cyclesAsc[0].start), toIso(rangeEnd)) }
}

// ── Goal helpers — two independent triggers, per Adam's spec ─────────

const PAY_FREQUENCY_LABELS: Record<PayFrequency, string> = { monthly: 'month', four_weekly: '4 weeks' }

/** Info-only label content for targetDate: how much to save per pay period (the pot owner's currently-active salary frequency) to hit targetAmount... or a plain remaining-balance figure if no targetAmount is set (targetDate can exist alone). */
export function amountNeededPerPayPeriod(pot: SavingsPot, currentBalance: number, payFrequency: PayFrequency, asOfDate: Date = new Date()): { amountPerPeriod: number; periodLabel: string } | null {
  if (!pot.targetDate) return null
  const target = parseLocalDate(pot.targetDate)
  if (target <= asOfDate) return { amountPerPeriod: Math.max(0, round2((pot.targetAmount ?? 0) - currentBalance)), periodLabel: PAY_FREQUENCY_LABELS[payFrequency] }

  const periodsPerYear = periodThresholdsFor(payFrequency).periodsPerYear
  const daysPerPeriod = 365 / periodsPerYear
  const daysRemaining = Math.max(1, Math.round((target.getTime() - asOfDate.getTime()) / 86400000))
  const periodsRemaining = Math.max(1, Math.ceil(daysRemaining / daysPerPeriod))
  const remaining = Math.max(0, round2((pot.targetAmount ?? 0) - currentBalance))
  return { amountPerPeriod: round2(remaining / periodsRemaining), periodLabel: PAY_FREQUENCY_LABELS[payFrequency] }
}

/** This pot's balance at a FUTURE date, given current balance plus everything pending between now and then (recurring deposit schedule + projected interest) — the same combined-activity approach projectedTargetDate uses, exposed separately for the Home summary card's "This cycle → Next 3 cycles" projected-ring pattern (see ProgressRingsSection). */
/**
 * This pot's balance at a FUTURE date, given current balance plus
 * everything pending between now and then.
 *
 * BUGFIX (Adam-reported, 2026-09-03): this used to only sum freshly-
 * GENERATED recurring deposits + generated interest — it never looked at
 * `realActivity` at all, so a real, already-logged manual deposit or
 * withdrawal dated in the future (the £100 top-up, the £70 withdrawal
 * from Adam's own reported case) was silently invisible to every
 * projection that called this function, even though it's completely
 * real, pending data. Rewritten to fold the FULL combined activity
 * (real transactions AND whatever's freshly generated, deduped against
 * each other by type+date so a real row and its generated preview are
 * never both counted) through savingsPotBalanceAsOf itself, rather than
 * re-deriving the deposit/withdrawal/interest sign logic a second time
 * in a different, less-tested place.
 */
export function projectedBalanceAt(
  pot: SavingsPot,
  currentBalance: number,
  realActivity: Transaction[],
  asOfDate: Date,
  targetDate: Date,
  transferTemplates: RecurringTemplate[] = [],
  payCycle?: PayCycleConfig,
): number {
  if (targetDate <= asOfDate) return currentBalance
  const generatedDeposits = generateSavingsDepositTransactions(pot, asOfDate, targetDate, transferTemplates, payCycle)
  const generatedWithdrawals = generateSavingsWithdrawalTransactions(pot, asOfDate, targetDate, transferTemplates, payCycle)
  const combinedForInterest = [
    ...realActivity,
    ...generatedDeposits.map((d, i) => ({ ...d, id: `generated:dep:${i}` })),
    ...generatedWithdrawals.map((d, i) => ({ ...d, id: `generated:wd:${i}` })),
  ]
  const generatedInterest = generateSavingsInterestTransactions(pot, combinedForInterest, asOfDate, targetDate)

  // Same dedupe convention as buildSavingsPotScheduleRows/computeProjection: a real row already covers whatever a generator would produce for the same type+date, so the generated one is dropped, not double-counted.
  const realKeys = new Set(realActivity.filter((t) => transactionTouchesSavingsPot(t, pot.id)).map((t) => `${t.type}:${t.date}`))
  const dedupedGenerated = [...generatedDeposits, ...generatedWithdrawals, ...generatedInterest].filter((t) => !realKeys.has(`${t.type}:${t.date}`))

  const allActivity = [...realActivity, ...dedupedGenerated.map((t, i) => ({ ...t, id: `generated:proj:${i}` }))]
  return savingsPotBalanceAsOf(pot, allActivity, targetDate)
}

/**
 * Pie-chart projected completion date for targetAmount, based on current
 * balance plus everything pending (recurring deposit schedule +
 * projected interest) — never influenced by targetDate, per spec (the
 * two triggers are independent). Returns null if there's no realistic
 * path to the target within 30 years.
 *
 * KNOWN SIMPLIFICATION (2026-09-04 session, flagged rather than silently
 * built around): only counts DEPOSITS + interest toward the target, not
 * any recurring WITHDRAWAL-shaped transfer that might also be scheduled
 * against this pot — the accumulation loop below assumes every entry is
 * a positive contribution, which stops being true the moment a
 * withdrawal is mixed in. A recurring withdrawal FROM a pot with an
 * active savings goal is an unusual combination; worth a proper signed
 * rewrite if that turns out to be a real scenario rather than a
 * theoretical one.
 */
export function projectedTargetDate(pot: SavingsPot, currentBalance: number, realActivity: Transaction[], asOfDate: Date = new Date(), transferTemplates: RecurringTemplate[] = [], payCycle?: PayCycleConfig): string | null {
  if (!pot.targetAmount || pot.targetAmount <= currentBalance) return pot.targetAmount ? toIso(asOfDate) : null
  const horizon = addYears(asOfDate, 30)

  const asOfIso = toIso(asOfDate)
  const deposits = generateSavingsDepositTransactions(pot, asOfDate, horizon, transferTemplates, payCycle)
  const interest = generateSavingsInterestTransactions(pot, [...realActivity, ...deposits.map((d, i) => ({ ...d, id: `generated:dep:${i}` }))], asOfDate, horizon)

  // Real rows dated after asOfDate (e.g. a logged future deposit) aren't in
  // currentBalance yet, so they're folded in here. Same dedupe as
  // projectedBalanceAt: a real row replaces a generated one of the same
  // type and date.
  const pendingReal = realActivity.filter((t) => transactionTouchesSavingsPot(t, pot.id) && t.date > asOfIso && t.date >= pot.openingDate)
  const realKeys = new Set(pendingReal.map((t) => `${t.type}:${t.date}`))
  const combined = [
    ...pendingReal.map((t) => ({ date: t.date, amount: savingsPotActivityDelta(t, pot.id) })),
    ...[...deposits, ...interest].filter((t) => !realKeys.has(`${t.type}:${t.date}`)).map((t) => ({ date: t.date, amount: t.amount })),
  ].sort((a, b) => a.date.localeCompare(b.date))

  let balance = currentBalance
  for (const t of combined) {
    balance = round2(balance + t.amount)
    if (balance >= pot.targetAmount) return t.date
  }
  return null
}
