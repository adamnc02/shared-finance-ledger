// Household card's own data layer — Adam's 2026-09-03 correction: the
// Household card shows EACH person's own personal picture only (income,
// personal-location bills/loans/ad-hoc, and joint_deposit/
// joint_withdrawal transactions) — no joint bills, and no synthetic
// per-person SHARE of a joint bill either. UAT Batch 4 (2026-09-04):
// projection.ts no longer folds that share into the Personal ledger at
// all, so this filter is now mostly a no-op going forward — kept because
// it's still the correct behaviour for any ALREADY-STORED cleared
// transaction from before that change (cleared transactions are
// immutable historic fact, never retroactively rewritten — see
// LedgerContext.tsx's own comment on that rule), traced by sourceId back
// to a joint-location RecurringTemplate/Loan.
//
// The joint account's own real ledger — actual joint bills paid, actual
// deposits/withdrawals — lives entirely on the Joint card instead (see
// jointAccountLedger.ts). Nothing here reads AppDataV2.jointAccount.

import { computeProjection, type ProjectionHorizon } from './projection'
import { horizonCycles, previousCycles, THREE_CYCLES_AHEAD } from './projection'
import { isLedgerTransaction, signedAmount, daysBetweenInclusive, buildDailyBalanceSeries, buildDailySpendSeries, type BalanceSpendGranularity, type BalanceSpendTrendSeries, type DailyBalancePoint, type DailySpendPoint } from './runningBalance'
import { toLocalIsoDate as toIso } from './date'
import type { AppDataV2, Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100

/** Every RecurringTemplate/Loan id that's joint-location. */
function jointSourceIds(data: AppDataV2): Set<string> {
  const ids = new Set<string>()
  for (const t of data.recurringTemplates) if (t.location === 'joint') ids.add(t.id)
  for (const l of data.loans) if (l.location === 'joint') ids.add(l.id)
  return ids
}

function isJointShareTransaction(t: Transaction, jointIds: Set<string>): boolean {
  return (t.sourceType === 'recurring_template' || t.sourceType === 'loan') && !!t.sourceId && jointIds.has(t.sourceId)
}

export interface HouseholdPersonProjection {
  personId: string
  personName: string
  openingBalance: number
  clearedBalance: number
  projectedBalance: number
  horizonEnd: string
  // Real+generated, personal-only (joint-bill shares stripped) — the
  // exact set CycleGroupedList/DateOrderedList/etc. below fold over, so
  // this person's own section total can never disagree with what's shown.
  transactions: Transaction[]
}

/**
 * One person's personal-only projection for the Household card.
 * Recomputes clearedBalance/projectedBalance from the FILTERED
 * transaction set (rather than trusting computeProjection's own figures,
 * which legitimately include the joint-bill share) so the Household
 * hero and its own transaction list can never disagree — the same
 * "single source, not two calculations" property the rest of this app
 * holds everywhere else (see e.g. projection.ts's own header comment).
 */
export function computeHouseholdPersonProjection(
  data: AppDataV2,
  personId: string,
  horizon: ProjectionHorizon,
  asOfDate: Date = new Date(),
): HouseholdPersonProjection | null {
  const person = data.people.find((p) => p.id === personId)
  const payCycle = data.payCycles.find((pc) => pc.personId === personId)
  if (!person || !payCycle) return null

  const jointIds = jointSourceIds(data)
  const projection = computeProjection(data, personId, payCycle, horizon, asOfDate)
  const transactions = projection.transactions.filter((t) => !isJointShareTransaction(t, jointIds))

  const clearedBalance = round2(
    payCycle.openingBalance +
      transactions.filter((t) => t.status === 'cleared' && isLedgerTransaction(t)).reduce((sum, t) => sum + signedAmount(t), 0),
  )
  const pendingWithinHorizon = transactions.filter((t) => t.status === 'pending' && isLedgerTransaction(t) && t.date <= projection.horizonEnd)
  const projectedBalance = round2(clearedBalance + pendingWithinHorizon.reduce((sum, t) => sum + signedAmount(t), 0))

  return {
    personId,
    personName: person.name,
    openingBalance: payCycle.openingBalance,
    clearedBalance,
    projectedBalance,
    horizonEnd: projection.horizonEnd,
    transactions,
  }
}

/** Every household member's personal-only projection, for whoever has a pay cycle set up (same "missing pay cycle just gets left out" convention Home.tsx's existing household hero already uses). */
export function computeHouseholdProjections(data: AppDataV2, horizon: ProjectionHorizon, asOfDate: Date = new Date()): HouseholdPersonProjection[] {
  return data.people
    .map((p) => computeHouseholdPersonProjection(data, p.id, horizon, asOfDate))
    .filter((r): r is HouseholdPersonProjection => r !== null)
}

/** One person's pill inside a cycle on Household's "Group by Person" view. Same shape as jointLedger.ts's JointPersonGroup, so both render through Home.tsx's shared PersonPills. */
export interface HouseholdPersonGroup {
  id: string
  name: string
  transactions: Transaction[]
}

/**
 * 2026-09-16 (PROMPT-03) — Household's "Group by Person" is now
 * cycle-outer/person-inner, matching Joint: CycleGroupedList buckets the
 * combined list into cycles, then calls this with ONE cycle's rows to
 * split them per person.
 *
 * A row is attributed to the person whose projection it CAME FROM
 * (object identity), not re-derived from `ownerId` — HouseholdDetail's
 * combined list is literally `personProjections.flatMap(pp =>
 * pp.transactions)`, so attributing by provenance means the per-person
 * totals inside a cycle always sum to that cycle's ungrouped total, by
 * construction. `ownerId` is only a fallback for a row passed in from
 * somewhere else. Unlike Joint there's no share-splitting and no "Spend"
 * bucket — every Household row is one person's own personal row.
 *
 * Every person with a projection is returned, in projection order, even
 * when empty; PersonPills hides the empty ones, same as on Joint.
 */
export function buildHouseholdPersonGroups(personProjections: HouseholdPersonProjection[], rows: Transaction[]): HouseholdPersonGroup[] {
  const sourceOf = new Map<Transaction, string>()
  for (const pp of personProjections) for (const t of pp.transactions) sourceOf.set(t, pp.personId)
  const byPerson = new Map<string, Transaction[]>(personProjections.map((pp) => [pp.personId, []]))
  for (const t of rows) {
    const personId = sourceOf.get(t) ?? t.ownerId
    if (personId) byPerson.get(personId)?.push(t)
  }
  return personProjections.map((pp) => ({ id: pp.personId, name: pp.personName, transactions: byPerson.get(pp.personId) ?? [] }))
}

// ── Trends feature (2026-09-15 build) ──────────────────────────────────
// "Household" Balance/Spend = combined across every member's own personal
// ledger, summed — not a per-member breakdown (Adam-confirmed). Day range
// is drawn from the PRIMARY person's own cycle bounds (same established
// convention Joint/Pot already use for "no independent cycle concept of
// its own") and every member's own daily series is then sampled against
// that SAME day list — deliberately not each member's own cycle bounds,
// which could disagree in length/start — so summing them day-index-by-
// day-index is always meaningful.

function sumBalancePoints(days: string[], perMember: DailyBalancePoint[][]): DailyBalancePoint[] {
  return days.map((date, i) => ({
    date,
    clearedBalance: round2(perMember.reduce((sum, series) => sum + series[i].clearedBalance, 0)),
    projectedBalance: round2(perMember.reduce((sum, series) => sum + series[i].projectedBalance, 0)),
  }))
}

function sumSpendPoints(days: string[], perMember: DailySpendPoint[][]): DailySpendPoint[] {
  return days.map((date, i) => ({
    date,
    spendToDate: round2(perMember.reduce((sum, series) => sum + series[i].spendToDate, 0)),
  }))
}

export function buildHouseholdTrendSeries(data: AppDataV2, granularity: BalanceSpendGranularity, asOfDate: Date = new Date()): BalanceSpendTrendSeries {
  const horizon: ProjectionHorizon = granularity === 'this_cycle' ? 'current_cycle' : 'three_cycles'
  const primaryCycles = horizonCycles(data, data.primaryPersonId, horizon, asOfDate)
  const days = daysBetweenInclusive(primaryCycles[0].start, primaryCycles[primaryCycles.length - 1].end)
  const todayIso = toIso(asOfDate)

  const memberIds = data.people.map((p) => p.id).filter((id) => data.payCycles.some((pc) => pc.personId === id))
  const perMemberBalance: DailyBalancePoint[][] = []
  const perMemberSpend: DailySpendPoint[][] = []
  for (const personId of memberIds) {
    const payCycle = data.payCycles.find((pc) => pc.personId === personId)!
    const projection = computeProjection(data, personId, payCycle, horizon, asOfDate)
    perMemberBalance.push(buildDailyBalanceSeries(payCycle.openingBalance, projection.transactions, days, signedAmount, isLedgerTransaction))
    perMemberSpend.push(buildDailySpendSeries(projection.transactions, days, (t) => isLedgerTransaction(t) && signedAmount(t) < 0))
  }
  const balance = memberIds.length > 0 ? sumBalancePoints(days, perMemberBalance) : days.map((date) => ({ date, clearedBalance: 0, projectedBalance: 0 }))
  const spend = memberIds.length > 0 ? sumSpendPoints(days, perMemberSpend) : days.map((date) => ({ date, spendToDate: 0 }))

  const cyclesBack = horizon === 'current_cycle' ? 1 : THREE_CYCLES_AHEAD + 1
  const prevCyclesAsc = [...previousCycles(data, data.primaryPersonId, cyclesBack, asOfDate)].reverse()
  const prevDays = daysBetweenInclusive(prevCyclesAsc[0].start, prevCyclesAsc[prevCyclesAsc.length - 1].end)
  const prevPerMemberSpend: DailySpendPoint[][] = memberIds.map((personId) =>
    buildDailySpendSeries(
      data.transactions.filter((t) => t.location === 'personal' && t.ownerId === personId),
      prevDays,
      (t) => isLedgerTransaction(t) && signedAmount(t) < 0,
    ),
  )
  const previousPeriodSpend = memberIds.length > 0 ? sumSpendPoints(prevDays, prevPerMemberSpend) : prevDays.map((date) => ({ date, spendToDate: 0 }))

  return { granularity, days, todayIso, balance, spend, previousPeriodSpend }
}
