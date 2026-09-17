// Running balance engine — Phase 1 scope only (doc Section 4.4): cleared
// vs pending, current balance, no projection horizon yet. The 3-cycle
// projection using default/recurring salary and bills for unresolved
// future periods is Phase 3 — deliberately not attempted here, so this
// file has no dependency on RecurringTemplate/Loan schedule generation.

import type { Transaction, TransactionType } from '../types/ledger'
import { toLocalIsoDate as toIso } from './date'

const round2 = (n: number) => Math.round(n * 100) / 100

// Every TransactionType maps to a fixed ledger sign — see the summary
// comment on Transaction.direction in types/ledger.ts. Centralised here
// as the one place that turns `direction` into an actual +/- number, so
// every calculation in this file (and anything built on top of it) uses
// the same rule.
export function signedAmount(t: Pick<Transaction, 'amount' | 'direction'>): number {
  return t.direction === 'in' ? t.amount : -t.amount
}

// credit_card_spend never reaches the personal ledger (see types/ledger.ts) —
// filtered out up front so callers can't accidentally include it just by
// forgetting to check `type`. Exported so other files computing ledger
// totals (e.g. lib/projection.ts) share this one definition rather than
// re-deriving it.
export function isLedgerTransaction(t: Pick<Transaction, 'type'>): boolean {
  const excluded: TransactionType[] = ['credit_card_spend']
  return !excluded.includes(t.type)
}

export interface RunningBalanceSummary {
  openingBalance: number
  clearedBalance: number // openingBalance + all cleared, ledger-eligible transactions
  pendingTotal: number // signed sum of all pending, ledger-eligible transactions (no date/horizon filter yet — Phase 3)
}

export function computeRunningBalanceSummary(
  openingBalance: number,
  transactions: Transaction[],
): RunningBalanceSummary {
  let clearedDelta = 0
  let pendingTotal = 0

  for (const t of transactions) {
    if (!isLedgerTransaction(t)) continue
    const amount = signedAmount(t)
    if (t.status === 'cleared') clearedDelta += amount
    else pendingTotal += amount
  }

  return {
    openingBalance,
    clearedBalance: openingBalance + clearedDelta,
    pendingTotal,
  }
}

export interface RunningBalanceEntry {
  transaction: Transaction
  runningBalance: number // balance immediately after this transaction is applied
}

/**
 * Walks CLEARED transactions in chronological order and returns each one
 * alongside the running balance after it's applied — the "smaller,
 * greyed-out figure below each amount" the doc describes for the Summary
 * page's list-by-date view. Pending transactions are intentionally
 * excluded from this walk in Phase 1 (they don't have a settled place in
 * the sequence yet without the Phase 3 projection horizon); ties on the
 * same date are ordered by id for a stable, repeatable sort.
 */
export function computeClearedRunningBalanceList(
  openingBalance: number,
  transactions: Transaction[],
): RunningBalanceEntry[] {
  const cleared = transactions
    .filter((t) => isLedgerTransaction(t) && t.status === 'cleared')
    .slice()
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)))

  let running = openingBalance
  return cleared.map((transaction) => {
    running += signedAmount(transaction)
    return { transaction, runningBalance: running }
  })
}

// ── Trends feature (2026-09-15 build) — generic day-sampling primitives ──
// shared by every card type's own build<Type>TrendSeries function
// (projection.ts, jointAccountLedger.ts, householdLedger.ts, potLedger.ts,
// savingsPotLedger.ts, creditCards.ts). Deliberately generic over the
// caller's own sign convention (signedAmount/jointAccountSignedAmount/
// potSignedAmount/savingsPotSignedAmount/a credit-card-specific delta all
// disagree with each other on what "+"/"-" mean for a given transaction —
// see each one's own header comment) rather than hardcoding one here.

/** Every calendar-day ISO date from `start` to `end` inclusive, ascending. Capped at 10 years of days as a sanity guard against a caller accidentally passing a reversed or huge range. */
export function daysBetweenInclusive(start: Date, end: Date): string[] {
  const days: string[] = []
  let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  let guard = 0
  while (cursor <= last && guard < 3660) {
    days.push(toIso(cursor))
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
    guard++
  }
  return days
}

export interface DailyBalancePoint {
  date: string
  clearedBalance: number // openingBalance + every CLEARED matching transaction dated on/before `date`
  projectedBalance: number // clearedBalance + every PENDING matching transaction dated on/before `date`
}

/**
 * Walks `days` (ascending ISO dates) once, folding `transactions` against
 * `openingBalance` — the shared engine behind every Balance-chart trend
 * series. `signFn` is the caller's own ledger-sign function; `filterFn`
 * narrows which transactions count at all (e.g. isLedgerTransaction) before
 * either cleared or pending sums are accumulated. O(days + transactions)
 * via two sorted-once, index-advancing merges rather than re-filtering the
 * full transaction list per day.
 */
export function buildDailyBalanceSeries(
  openingBalance: number,
  transactions: Transaction[],
  days: string[],
  signFn: (t: Transaction) => number,
  filterFn: (t: Transaction) => boolean = () => true,
): DailyBalancePoint[] {
  const relevant = transactions.filter(filterFn)
  const cleared = relevant.filter((t) => t.status === 'cleared').sort((a, b) => a.date.localeCompare(b.date))
  const pending = relevant.filter((t) => t.status === 'pending').sort((a, b) => a.date.localeCompare(b.date))
  let cIdx = 0
  let pIdx = 0
  let clearedSum = 0
  let pendingSum = 0
  const out: DailyBalancePoint[] = []
  for (const day of days) {
    while (cIdx < cleared.length && cleared[cIdx].date <= day) {
      clearedSum += signFn(cleared[cIdx])
      cIdx++
    }
    while (pIdx < pending.length && pending[pIdx].date <= day) {
      pendingSum += signFn(pending[pIdx])
      pIdx++
    }
    const clearedBalance = round2(openingBalance + clearedSum)
    out.push({ date: day, clearedBalance, projectedBalance: round2(clearedBalance + pendingSum) })
  }
  return out
}

export interface DailySpendPoint {
  date: string
  spendToDate: number // cumulative from the start of `days` — the Spend chart's own "cycle always starts at 0" convention, not a running-since-forever total
}

/** Same day-walk shape as buildDailyBalanceSeries, but for a cumulative total that resets to 0 at the start of `days` rather than folding against an opening balance. `matchesFn` decides which transactions count as "spend" for this chart (a card-type-specific definition — see each build<Type>TrendSeries' own comment). */
export function buildDailySpendSeries(transactions: Transaction[], days: string[], matchesFn: (t: Transaction) => boolean): DailySpendPoint[] {
  const sorted = transactions.filter(matchesFn).sort((a, b) => a.date.localeCompare(b.date))
  let idx = 0
  let sum = 0
  const out: DailySpendPoint[] = []
  for (const day of days) {
    while (idx < sorted.length && sorted[idx].date <= day) {
      sum += Math.abs(sorted[idx].amount)
      idx++
    }
    out.push({ date: day, spendToDate: round2(sum) })
  }
  return out
}

/** Which of the two Trends-modal chart granularities a Balance/Spend card is showing — "This Cycle" (day grouping, x-axis shows only start/end) or "Next 3 Cycles" (also day grouping, same x-axis rule) per the Trends feature spec's own table. */
export type BalanceSpendGranularity = 'this_cycle' | 'next_3_cycles'

export interface BalanceSpendTrendSeries {
  granularity: BalanceSpendGranularity
  days: string[] // ascending ISO, the current period's own days
  todayIso: string
  balance: DailyBalancePoint[] // aligned 1:1 with `days`
  spend: DailySpendPoint[] // aligned 1:1 with `days`
  previousPeriodSpend: DailySpendPoint[] // day-INDEX aligned with `days` (not date-aligned) — the faded comparison line; same length as `days` whenever the previous period has any history, empty otherwise
}
