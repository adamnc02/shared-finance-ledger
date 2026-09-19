// Salary as a dated history rather than one fixed figure (doc Section
// 3.4). Two things live here:
//  - computeNetPayForPeriod: what a given pay period's net pay actually
//    is — a manual SalaryOverride if one exists for that exact date,
//    otherwise the tax engine run against whichever SalarySnapshot was
//    effective on that date.
//  - generateSalaryTransactions: turns that into dated, pending 'salary'
//    Transaction occurrences, same "compute what should exist, caller
//    dedupes" contract as schedule.ts / ledgerLoans.ts / creditCards.ts.
//
// SIMPLIFICATION, stated explicitly: "Bonus" ad-hoc entries (TransactionType
// 'bonus', loggable from the Transactions page and the Salary page's "Attach a
// bonus to a pay" button) DO use this file's tax engine now — via
// computeNetBonusAmount below — to work out the correct net-of-tax amount
// from a gross figure. What they still don't do is get folded into a
// SalaryOverride or the generated 'salary' transaction for that period;
// the taxed net amount logs as its own standalone incoming transaction.
// Folding it into the payday transaction instead would mean either
// double-counting (if both existed) or silently rewriting a logged bonus
// into an invisible adjustment to a different transaction. A manual
// SalaryOverride remains the tool for "this period's net pay was actually
// £X"; a logged Bonus is "extra, properly-taxed money came in, on top of
// salary, without changing what salary itself shows as."

import { calculateBonusOnTop, calculateNetSalary, type BonusBreakdown, type PayFrequency, type SalaryInput } from './tax'
import { payPeriodWeeks, resolvePayday, scheduledPaydaysBetween, type PaydayRule } from './payCycle'
import { INCOME_CATEGORY_ID } from '../types/ledger'
import type { Person, PayCycleConfig, PaySchedule, SalarySnapshot, SalarySort, Transaction } from '../types/ledger'
import { fiscalPeriodEndingOn, fiscalPeriodsBetween } from './fiscalCalendar'
import { addDays } from 'date-fns'

const round2 = (n: number) => Math.round(n * 100) / 100
import { toLocalIsoDate as toIso, parseLocalDate } from './date'
import { planReschedule, redateStoredPayments } from './scheduleChange'

/** The snapshot effective on `date` — the latest one with effectiveFrom on or before it, never a future one. */
/**
 * The snapshot effective on `date` — the latest one with effectiveFrom on
 * or before it. When two snapshots share the exact same effectiveFrom
 * (which happens every time the same period gets edited more than once —
 * e.g. adjusting a pension %, saving "all future", then adjusting it
 * again), the one added MOST RECENTLY wins, not whichever happened to
 * sort first. A plain `.sort()` by date string alone is stable, which
 * for a genuine tie preserves original array order — since newly-added
 * snapshots are appended to the end of the array, that would silently
 * keep the OLDER edit as "applicable" and make the newer one invisible.
 * The explicit tie-break below is what prevents that.
 *
 * 2026-09-16 (PROMPT-02) — that tie-break is now `recordedSeq`, an
 * explicit per-person ordinal, rather than the snapshot's ARRAY INDEX.
 * Same resolution, same winner, but it no longer depends on array
 * position: `salaryHistory` becomes a real `salary_snapshots` table in
 * the Supabase migration, and a SELECT has no inherent row order, so two
 * devices holding identical rows could otherwise resolve different
 * salaries. See SalarySnapshot.recordedSeq and
 * DATA-MODEL-REVIEW-2026-09-15.md §11.7a.
 *
 * The array index is kept ONLY as a fallback for a snapshot with no
 * recordedSeq, which migrateLedgerData's backfill should make impossible
 * — but runtime data can always violate the type, and falling back to
 * the old behaviour is strictly better than sorting undefined. Note the
 * array is never sorted or de-duplicated to achieve this (§11.7b).
 */
export function findApplicableSnapshot(person: Person, date: string): SalarySnapshot | null {
  const applicable = person.salaryHistory
    .map((s, index) => ({ s, seq: s.recordedSeq ?? index }))
    .filter(({ s }) => s.effectiveFrom <= date)
    .sort((a, b) => {
      const byDate = b.s.effectiveFrom.localeCompare(a.s.effectiveFrom)
      if (byDate !== 0) return byDate
      return b.seq - a.seq // tie: prefer the one recorded later (a more recent edit)
    })
  const resolved = applicable[0]?.s ?? null
  // If the snapshot that would otherwise govern `date` has an end date,
  // and `date` falls after it, nothing governs this period — this is
  // exactly the "no salary payments generate after [end date]" behaviour
  // the Wallet page's end-date field promises. Only the RESOLVED
  // snapshot's own endDate matters here: if a later snapshot exists
  // covering `date`, it already won the sort above and its own (likely
  // unset) endDate is what applies instead, correctly ignoring the
  // earlier snapshot's end.
  if (resolved?.endDate && date > resolved.endDate) return null
  return resolved
}

/**
 * The most recent snapshot by effectiveFrom, regardless of endDate —
 * deliberately NOT the same lookup as findApplicableSnapshot, which
 * excludes a snapshot once its own endDate has passed. The Wallet page's
 * end-date field needs to find and edit that snapshot even once it's
 * ended (e.g. to push the date back out, or clear it entirely) —
 * findApplicableSnapshot(person, today) would return null in exactly
 * that case, since "no longer governs today" is precisely what it just
 * got told to mean. Returns null only when the person has no salary
 * history at all yet.
 *
 * 2026-09-16 (PROMPT-02) — this had the SAME array-order dependency
 * findApplicableSnapshot did, just less visibly: `>=` meant that on a tie
 * each equal-dated snapshot replaced the previous one as it was iterated,
 * so the LAST one in the array won. Correct today, arbitrary once the
 * rows come back from a table in no particular order. Now broken by
 * recordedSeq explicitly, with the same index fallback, so it and
 * findApplicableSnapshot agree on which of two same-dated snapshots is
 * "the latest" by the same rule rather than by coincidence.
 */
export function latestSalarySnapshot(person: Person): SalarySnapshot | null {
  return person.salaryHistory
    .map((s, index) => ({ s, seq: s.recordedSeq ?? index }))
    .reduce<{ s: SalarySnapshot; seq: number } | null>((latest, cur) => {
      if (!latest) return cur
      const byDate = cur.s.effectiveFrom.localeCompare(latest.s.effectiveFrom)
      if (byDate !== 0) return byDate > 0 ? cur : latest
      return cur.seq > latest.seq ? cur : latest
    }, null)?.s ?? null
}

/**
 * The recordedSeq to give the NEXT snapshot recorded for this person:
 * max(existing) + 1, starting at 0.
 *
 * The invariant is "greater than every ordinal CURRENTLY in the array",
 * which is all that matters — ordinals are only ever compared against
 * other snapshots in the same live array. Deleting the newest snapshot
 * does free its number for reuse, and that is harmless, because the
 * snapshot it belonged to is gone.
 *
 * Deliberately NOT `salaryHistory.length`, which breaks that invariant:
 * delete a MIDDLE snapshot from [0, 1, 2] and length is 2, colliding with
 * the live snapshot that already holds 2. A tie between two equal
 * ordinals falls back to whatever `.sort()` does with a 0 comparison —
 * i.e. array order, the exact dependency recordedSeq exists to remove.
 *
 * Ignores any snapshot missing the field (pre-backfill data) rather than
 * letting an undefined poison the max. See SalarySnapshot.recordedSeq.
 */
export function nextRecordedSeq(salaryHistory: SalarySnapshot[]): number {
  const seqs = salaryHistory.map((s) => s.recordedSeq).filter((n): n is number => typeof n === 'number')
  return seqs.length === 0 ? 0 : Math.max(...seqs) + 1
}

function snapshotToSalaryInput(snapshot: SalarySnapshot, periodWeeks?: number): SalaryInput {
  return {
    grossAnnual: snapshot.grossAnnual,
    taxCode: snapshot.taxCode,
    studentLoanPlan: snapshot.studentLoanPlan,
    payFrequency: snapshot.payFrequency,
    periodWeeks,
    deductions: snapshot.deductions,
    employerPensionPercent: snapshot.employerPensionPercent,
  }
}

/**
 * Net value of a one-off GROSS bonus for this person, on this pay
 * period's snapshot — properly taxed, not face-value. The actual maths
 * lives in tax.ts's calculateBonusOnTop; see its comment for why the
 * bonus is charged tax and NI ONLY, with none of the person's standing
 * deductions applied to it, and why that's a correction rather than a
 * tweak.
 *
 * Returns null if there's no applicable snapshot for the period (same
 * "unanswerable, not zero" contract as computeNetPayForPeriod).
 */
export function computeBonusBreakdownForPeriod(person: Person, payPeriodDate: string, grossBonusAmount: number, payCycle?: PayCycleConfig): BonusBreakdown | null {
  const snapshot = findApplicableSnapshot(person, payPeriodDate)
  if (!snapshot) return null
  return calculateBonusOnTop(snapshotToSalaryInput(snapshot, periodWeeksFor(snapshot, payCycle, payPeriodDate)), grossBonusAmount)
}

export function computeNetBonusAmount(person: Person, payPeriodDate: string, grossBonusAmount: number, payCycle?: PayCycleConfig): number | null {
  if (grossBonusAmount <= 0) return 0
  const breakdown = computeBonusBreakdownForPeriod(person, payPeriodDate, grossBonusAmount, payCycle)
  return breakdown === null ? null : round2(breakdown.net)
}

/**
 * The tax-engine-computed net pay for this period from the applicable
 * salary snapshot alone — deliberately ignoring any SalaryOverride. This
 * is the "base" figure a bonus gets added on top of, and what an override
 * reverts to when removed. Returns null when there's no applicable
 * snapshot at all.
 */
export function computeSnapshotNetPayForPeriod(person: Person, payPeriodDate: string, payCycle?: PayCycleConfig): number | null {
  const snapshot = findApplicableSnapshot(person, payPeriodDate)
  if (!snapshot) return null
  return round2(calculateNetSalary(snapshotToSalaryInput(snapshot, periodWeeksFor(snapshot, payCycle, payPeriodDate))).netPerPeriod)
}

/**
 * 2026-09-19 (PROMPT-08c Part D) — the pay period's length, which only
 * matters on the fiscal-calendar frequency: P13 of a 53-week year is 5
 * weeks, paid and taxed as such. Needs the pay cycle, because the period
 * grid comes from its pay schedule. Without it (or on any other frequency)
 * the period is taken as a normal one.
 */
function periodWeeksFor(snapshot: SalarySnapshot, payCycle: PayCycleConfig | undefined, payPeriodDate: string): number | undefined {
  if (snapshot.payFrequency !== 'four_weekly_fiscal' || !payCycle) return undefined
  return payPeriodWeeks(payCycle, payPeriodDate)
}

/**
 * 2026-09-19 (PROMPT-08c Part C, Adam's call: "ask in the app, don't
 * guess") — a 4-weekly salary whose pay cycle has no matching pay schedule
 * yet. Every 4-weekly salary saved before pay schedules existed is in this
 * state (Ella's, in Adam's backup). Its paydays are not generated until a
 * next pay date is set, and the Salary page asks for one. Nothing is
 * written silently.
 */
export function salaryNeedsPayDate(person: Person, payCycle: PayCycleConfig | undefined): boolean {
  const frequency = latestSalarySnapshot(person)?.payFrequency
  if (!frequency) return false
  // Monthly wants no schedule; a salary switched back to monthly while a
  // 4-weekly schedule is still stored needs its day of the month set again.
  const wanted = frequency === 'monthly' ? undefined : frequency
  return payCycle?.paySchedule?.kind !== wanted
}

/** The three "Paid" options, in the order the forms show them. */
export const PAY_FREQUENCY_OPTIONS: { value: PayFrequency; label: string }[] = [
  { value: 'monthly', label: 'Monthly (12/yr)' },
  { value: 'four_weekly', label: 'Every 4 weeks (13/yr)' },
  { value: 'four_weekly_fiscal', label: 'Every 4 weeks, 5-week P13 in 53-week years' },
]

export function payFrequencyLabel(frequency: PayFrequency): string {
  return PAY_FREQUENCY_OPTIONS.find((o) => o.value === frequency)?.label ?? 'Monthly (12/yr)'
}

/**
 * 2026-09-19 (PROMPT-08c) — what's wrong with a "Next pay date", or null if
 * nothing is. It must be today or later, and no more than one period away
 * (35 days covers a 5-week P13). On the fiscal-calendar frequency it must
 * also be the last day of a period, since that is when Ella is paid; a
 * date that isn't is refused with the nearest period ends named, rather
 * than being silently shifted.
 */
export function nextPayDateProblem(kind: PaySchedule['kind'], dateIso: string, todayIso: string): string | null {
  if (!dateIso) return 'Pick the next pay date.'
  if (dateIso < todayIso) return 'The next pay date can’t be in the past.'
  const date = parseLocalDate(dateIso)
  if (date > addDays(parseLocalDate(todayIso), 35)) return 'Pick the NEXT pay date — it should be within the next 5 weeks.'
  if (kind === 'four_weekly_fiscal' && !fiscalPeriodEndingOn(date, date.getDay())) {
    const nearby = fiscalPeriodsBetween(addDays(date, -35), addDays(date, 35), date.getDay()).map((p) => toIso(p.end))
    const before = nearby.filter((d) => d < dateIso).pop()
    const after = nearby.find((d) => d > dateIso)
    return `That isn't the last day of a pay period on this calendar. The nearest are ${[before, after].filter(Boolean).join(' and ')}.`
  }
  return null
}

/**
 * Net pay for a specific pay period date. Returns null only when there's
 * no applicable snapshot at all (person has no salary history yet as of
 * that date) — a genuinely unanswerable case, not a zero.
 */
export function computeNetPayForPeriod(person: Person, payPeriodDate: string, payCycle?: PayCycleConfig): number | null {
  // Gate on the underlying snapshot FIRST, even for a manual override —
  // findApplicableSnapshot already returns null for a period past the
  // governing snapshot's endDate (see its own comment), and a manual
  // override or an attached bonus shouldn't be able to resurrect a
  // payment for a period the end date says shouldn't happen. This only
  // affects periods created before the end date was set and now fall
  // after it; it never touches an already-materialized/cleared
  // Transaction, which doesn't go through this function again.
  if (!findApplicableSnapshot(person, payPeriodDate)) return null

  const override = person.salaryOverrides.find((o) => o.payPeriodDate === payPeriodDate)

  // A BONUS override is RECOMPUTED here rather than read back from its
  // stored netPayOverride. The stored figure is a snapshot of "base net
  // pay + net bonus" taken at the moment the bonus was attached, and it
  // goes stale the instant anything it was derived from changes — edit
  // the gross salary, a pension percentage, or the tax code afterwards
  // and the period keeps reporting a net pay computed against the OLD
  // salary, silently, with nothing in the UI hinting that the two no
  // longer agree. Deriving it makes that whole class of staleness
  // impossible; bonusGrossAmount (what the person actually typed) is the
  // only thing that genuinely needs storing. netPayOverride is still
  // written for backwards compatibility and for the plain manual
  // override case below, which has no formula to re-derive from.
  if (override?.bonusGrossAmount) {
    const base = computeSnapshotNetPayForPeriod(person, payPeriodDate, payCycle)
    const netBonus = computeNetBonusAmount(person, payPeriodDate, override.bonusGrossAmount, payCycle)
    if (base !== null && netBonus !== null) return round2(base + netBonus)
  }

  if (override) return round2(override.netPayOverride)

  return computeSnapshotNetPayForPeriod(person, payPeriodDate, payCycle)
}

/**
 * When a person's ENTIRE salary is deleted (not just an end date — see
 * SalaryEndDateField/Wallet.tsx for that, deliberately non-destructive,
 * case), already-CLEARED 'salary' transactions must not retroactively
 * look broken, or keep being chased forever by autoClear.ts's
 * reconcileSalaryTransactions against a person who no longer has any
 * salary history to compute against. Confirmed direction: convert them
 * into standalone 'income' transactions — same date/amount/note,
 * silently, in the background — so deleting the salary record never
 * ripples into already-happened history. PENDING 'salary' transactions
 * are deliberately left alone: they simply stop being regenerated
 * (autoClearDuePayments's materialization step produces nothing new once
 * salaryHistory is empty, since computeNetPayForPeriod has nothing left
 * to compute against), and any already-stored pending one is harmless to
 * leave as-is since it hasn't touched the balance yet.
 */
export function convertClearedSalaryToStandaloneIncome(transactions: Transaction[], personId: string): Transaction[] {
  return transactions.map((t) => (t.type === 'salary' && t.personId === personId && t.status === 'cleared' ? { ...t, type: 'income' } : t))
}

/** Generates pending 'salary' transactions for each resolved payday in the range. Skips any period with no applicable snapshot rather than emitting a zero-amount transaction. */
export function generateSalaryTransactions(person: Person, payCycle: PayCycleConfig, rangeStart: Date, rangeEnd: Date): Omit<Transaction, 'id'>[] {
  const results: Omit<Transaction, 'id'>[] = []
  // A 4-weekly salary waits for its next pay date rather than being paid on
  // a guessed monthly day — see salaryNeedsPayDate.
  if (salaryNeedsPayDate(person, payCycle)) return results
  let cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1)

  while (cursor <= rangeEnd) {
    for (const payday of paydaysForMonth(payCycle, cursor.getFullYear(), cursor.getMonth())) {
      if (payday >= rangeStart && payday <= rangeEnd) {
        const dateIso = toIso(payday)
        const netPay = computeNetPayForPeriod(person, dateIso, payCycle)
        if (netPay !== null && netPay > 0) {
          results.push({
            date: dateIso,
            amount: netPay,
            direction: 'in',
            categoryId: INCOME_CATEGORY_ID,
            paymentMethod: 'bank_transfer',
            status: 'pending',
            type: 'salary',
            location: 'personal',
            ownerId: person.id,
            personId: person.id,
          })
        }
      }
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }

  return results
}

// ── Upcoming / closed payday lists — Salary page redesign ─────────────
// "Upcoming" = strictly after `fromDate` (today) — the moment a payday's
// date arrives, it's no longer upcoming, it's paid (closed). "Closed" =
// on or before `beforeDate`. Both walk month-by-month using the same
// resolvePayday logic everything else uses, so these lists are always
// consistent with the actual weekend/bank-holiday-adjusted payday, not
// just the nominal day-of-month.

export function upcomingPaydays(payCycle: PayCycleConfig, fromDate: Date, count: number): Date[] {
  const results: Date[] = []
  let cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1)
  let guard = 0
  while (results.length < count && guard < 120) {
    for (const payday of paydaysForMonth(payCycle, cursor.getFullYear(), cursor.getMonth())) {
      if (payday > fromDate && results.length < count) results.push(payday)
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    guard++
  }
  return results
}

/**
 * The last `count` closed (already-paid) paydays before `beforeDate`.
 * Never walks back past the pay cycle's opening balance date — there's
 * no use showing payday history from before the point the balance was
 * actually reconciled from, same visibility-floor reasoning as
 * everywhere else opening balance applies.
 */
export function closedPaydays(payCycle: PayCycleConfig, beforeDate: Date, count: number): Date[] {
  const results: Date[] = []
  const openingBalanceDate = parseLocalDate(payCycle.openingBalanceDate)
  const floorMonth = new Date(openingBalanceDate.getFullYear(), openingBalanceDate.getMonth(), 1)
  let cursor = new Date(beforeDate.getFullYear(), beforeDate.getMonth(), 1)
  let guard = 0
  while (results.length < count && guard < 120 && cursor >= floorMonth) {
    // Latest first within the month, since this walks backward.
    for (const payday of paydaysForMonth(payCycle, cursor.getFullYear(), cursor.getMonth()).reverse()) {
      if (payday <= beforeDate && payday >= openingBalanceDate && results.length < count) results.push(payday)
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1)
    guard++
  }
  // Walked backward, so the closest-to-today payday was collected first — reverse to chronological (oldest first, most recent last).
  return results.reverse()
}

// ── Payday change from a chosen payment (2026-09-16) — see lib/scheduleChange.ts ──

/**
 * Every payday falling in a calendar month, honouring earlier payday rules
 * (PayCycleConfig.paydayHistory): a rule governs paydays from the previous
 * rule's `nextRuleFrom` up to (not including) its own `until`. Usually one
 * date; a month can hold two, or none, right where a change moved a payday
 * across a month boundary.
 */
export function paydaysForMonth(payCycle: PayCycleConfig, year: number, monthIndex0: number): Date[] {
  const rules: (PaydayRule & { until: string | null; nextRuleFrom: string | null })[] = [
    ...(payCycle.paydayHistory ?? []),
    { paydayDayOfMonth: payCycle.paydayDayOfMonth, paydayAdjustForNonWorkingDay: payCycle.paydayAdjustForNonWorkingDay, paySchedule: payCycle.paySchedule, until: null, nextRuleFrom: null },
  ]
  const out: Date[] = []
  let from: string | null = null
  for (const rule of rules) {
    // 2026-09-19 (PROMPT-08c) — a 4-weekly rule contributes the paydays that
    // LAND in this month: none, one or two. Months partition time, so every
    // month-walking caller below sees each 4-weekly payday exactly once.
    const candidates = rule.paySchedule
      ? scheduledPaydaysBetween({ ...rule, paySchedule: rule.paySchedule }, new Date(year, monthIndex0, 1), new Date(year, monthIndex0 + 1, 0))
      : [resolvePayday(year, monthIndex0, rule.paydayDayOfMonth, rule.paydayAdjustForNonWorkingDay)]
    for (const payday of candidates) {
      const iso = toIso(payday)
      if ((from === null || iso >= from) && (rule.until === null || iso < rule.until)) out.push(payday)
    }
    from = rule.nextRuleFrom
  }
  return out.sort((a, b) => a.getTime() - b.getTime())
}

function paydayDates(payCycle: PayCycleConfig, start: Date, end: Date): string[] {
  const out: string[] = []
  for (let cursor = new Date(start.getFullYear(), start.getMonth(), 1); cursor <= end; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) {
    for (const payday of paydaysForMonth(payCycle, cursor.getFullYear(), cursor.getMonth())) out.push(toIso(payday))
  }
  return out
}

/** The first payday on or after `dateIso` under the current rules — where a new job's payday change takes effect. */
export function firstPaydayOnOrAfter(payCycle: PayCycleConfig, dateIso: string): string {
  const from = parseLocalDate(dateIso)
  return paydayDates(payCycle, from, new Date(from.getFullYear(), from.getMonth() + 2, 1)).find((d) => d >= dateIso) ?? dateIso
}

/** The "which payment" picker for a payday change: the most recent payday and the next 3. */
export function recentAndUpcomingPaydayDates(payCycle: PayCycleConfig, asOfDate: Date): { date: string; isPast: boolean }[] {
  const asOfIso = toIso(asOfDate)
  const dates = paydayDates(payCycle, new Date(asOfDate.getFullYear() - 1, asOfDate.getMonth(), 1), new Date(asOfDate.getFullYear() + 1, asOfDate.getMonth(), 1))
  const past = dates.filter((d) => d <= asOfIso)
  const upcoming = dates.filter((d) => d > asOfIso)
  return [...(past.length ? [{ date: past[past.length - 1], isPast: true }] : []), ...upcoming.slice(0, 3).map((date) => ({ date, isPast: false }))]
}

/** A new payday rule. No paySchedule = monthly on paydayDayOfMonth (2026-09-19: it can now switch to or from a 4-weekly schedule). */
export type PaydayChange = Pick<PayCycleConfig, 'paydayDayOfMonth' | 'paydayAdjustForNonWorkingDay' | 'paySchedule'>

/**
 * The payday changed, from a chosen payday. Salary payments from there on
 * are re-dated, and so is everything keyed on a payday: that person's
 * SalaryOverrides (bonuses, manual net pay) and, for the primary person,
 * SalarySorts. Earlier paydays keep resolving on the old rule.
 *
 * Pay-cycle WINDOWS (payCycle.ts) are deliberately untouched: they follow
 * the current payday rule, as they always have.
 */
export function applyPaydayChange(
  payCycle: PayCycleConfig,
  person: Person,
  transactions: Transaction[],
  salarySorts: SalarySort[] | null,
  next: PaydayChange,
  pickedDate: string,
  asOfIso: string,
): { payCycle: PayCycleConfig; person: Person; transactions: Transaction[]; salarySorts: SalarySort[] | null } | null {
  const belongs = (t: Transaction) => t.type === 'salary' && t.personId === person.id
  const keyed = [
    ...transactions.filter(belongs).map((t) => t.date),
    ...person.salaryOverrides.map((o) => o.payPeriodDate),
    ...(salarySorts ?? []).map((s) => s.payDate),
  ]
  const lastKeyed = keyed.reduce((max, k) => (k > max ? k : max), pickedDate)
  const picked = parseLocalDate(pickedDate)
  const start = new Date(picked.getFullYear() - 3, picked.getMonth(), 1)
  const end = new Date(parseLocalDate(lastKeyed).getFullYear() + 2, 11, 31)
  const asOccurrences = (dates: string[]) => dates.map((d) => ({ key: d, date: d }))
  // paySchedule is set explicitly: `next` without one means monthly, not "keep the current schedule".
  const newRule: PayCycleConfig = { ...payCycle, ...next, paySchedule: next.paySchedule, paydayHistory: undefined }
  const plan = planReschedule(asOccurrences(paydayDates(payCycle, start, end)), asOccurrences(paydayDates(newRule, start, end)), pickedDate)
  if (!plan) return null

  // A rule recorded by an earlier change that this one reaches back past is superseded.
  const history = (payCycle.paydayHistory ?? []).filter((h) => h.until <= plan.from.date && h.nextRuleFrom <= plan.from.date)
  return {
    payCycle: {
      ...payCycle,
      ...next,
      paySchedule: next.paySchedule,
      paydayHistory: [
        ...history,
        { paydayDayOfMonth: payCycle.paydayDayOfMonth, paydayAdjustForNonWorkingDay: payCycle.paydayAdjustForNonWorkingDay, ...(payCycle.paySchedule ? { paySchedule: payCycle.paySchedule } : {}), until: plan.from.date, nextRuleFrom: plan.firstNew.date },
      ],
    },
    person: { ...person, salaryOverrides: person.salaryOverrides.map((o) => ({ ...o, payPeriodDate: plan.dateMap.get(o.payPeriodDate) ?? o.payPeriodDate })) },
    transactions: redateStoredPayments(transactions, belongs, plan, asOfIso),
    salarySorts: salarySorts?.map((s) => ({ ...s, payDate: plan.dateMap.get(s.payDate) ?? s.payDate })) ?? null,
  }
}
