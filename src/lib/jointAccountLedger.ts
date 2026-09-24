// The joint account's OWN ledger — Adam's 2026-09-03 correction to this
// item's original scope. The joint account is now a real account with its
// own reconciled opening balance/date (AppDataV2.jointAccount), fed by:
//  - every joint-location RecurringTemplate/Loan occurrence, real +
//    generated — exactly like a personal ledger's own bills, just scoped
//    to location: 'joint'. Money LEAVING the joint account.
//  - every joint_deposit/joint_withdrawal transaction, hand-logged from
//    the Transactions page's "Joint" pill (Expenses.tsx). These are the
//    ONLY joint-account items that also touch a person's OWN personal
//    ledger — see types/ledger.ts's own comment on the two types for why
//    they need no special-casing in projection.ts.
//
// No synthetic per-person split lives here — that stays exactly where it
// already was (jointLedger.ts's computeJointSummary/
// generateJointContributionTransactions), unrelated to this file and to
// the Household card, which no longer shows joint bills at all (see
// householdLedger.ts).

import { nanoid } from 'nanoid'
import { generateTransactionsForTemplate, payCycleForTemplate } from './schedule'
import { generateLoanPaymentTransactions } from './ledgerLoans'
import { dedupeKey, horizonCycles, previousCycles, THREE_CYCLES_AHEAD, type ProjectionHorizon } from './projection'
import { jointTransferSignedAmount, transferTouchesJoint } from './transferLedger'
import { toLocalIsoDate as toIso, parseLocalDate } from './date'
import { daysBetweenInclusive, buildDailyBalanceSeries, buildDailySpendSeries, type BalanceSpendGranularity, type BalanceSpendTrendSeries } from './runningBalance'
import type { AppDataV2, Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * True the moment a joint-location bill/loan exists but no
 * JointAccountConfig has been set up yet — the trigger for the
 * non-dismissable setup flow (see components/JointAccountSetupModal.tsx,
 * wired in via AppGuards.tsx). Deliberately doesn't care WHICH page
 * created the joint-location item — Bills.tsx and Loans.tsx both need no
 * changes at all for this to work, since the guard is checked globally.
 */
export function needsJointAccountSetup(data: AppDataV2): boolean {
  if (data.jointAccount) return false
  return data.recurringTemplates.some((t) => t.location === 'joint') || data.loans.some((l) => l.location === 'joint')
}

/**
 * The sign a transaction counts as on the JOINT account's own ledger —
 * deliberately separate from runningBalance.ts's signedAmount, which
 * gives the PERSONAL-ledger sign (opposite, for joint_deposit/
 * joint_withdrawal specifically). Every joint-location bill/loan payment
 * always reduces the joint account (direction is already 'out' on those,
 * but this doesn't read `direction` at all — type-derived, same
 * "type decides the sign on THIS ledger" pattern as
 * credit_card_spend/savings_deposit elsewhere in this app).
 */
export function jointAccountSignedAmount(t: Pick<Transaction, 'type' | 'amount' | 'fromLocation' | 'toLocation'>): number {
  if (t.type === 'joint_deposit') return t.amount
  if (t.type === 'joint_withdrawal') return -t.amount
  if (t.type === 'transfer') return jointTransferSignedAmount(t)
  // 2026-09-13 (dev.md item 5) — an ad-hoc expense/income can now itself
  // carry location: 'joint' (previously only bill_payment/loan_payment
  // ever reached this fallback, both always 'out', so a bare `-t.amount`
  // was safe). 'income' needs the opposite sign — everything else
  // reaching this branch (bill_payment, loan_payment, expense) is still
  // always 'out'.
  if (t.type === 'income') return t.amount
  // 2026-09-14 (savings interest destination) — a savings pot's interest
  // can now be paid into the Joint account (SavingsPot.interestDestination),
  // same reason 'income' got its own case above — without it, this
  // always-'out' default would wrongly treat incoming interest as money
  // leaving the joint account.
  if (t.type === 'savings_interest') return t.amount
  return -t.amount
}

export interface JointAccountProjectionResult {
  horizonEnd: string // ISO date
  openingBalance: number
  openingBalanceDate: string
  clearedBalance: number
  projectedBalance: number
  transactions: Transaction[] // joint bill/loan occurrences (real+generated) + real joint_deposit/joint_withdrawal rows, sorted by date
}

/**
 * The joint account's own projection — same shape/reasoning as
 * projection.ts's computeProjectionToDate, just scoped to the joint
 * account rather than a person. Returns null until the account exists
 * (see needsJointAccountSetup) — callers should treat that as "nothing to
 * show yet," not as an error.
 *
 * Cycle boundaries: there's no joint-account-specific pay cycle in the
 * schema, so this reuses the primary person's cycle bounds — same
 * established convention the Joint card's existing synthetic summary
 * (jointLedger.ts's computeJointSummary) already uses. Flagged here
 * rather than silently assumed: if a genuinely separate joint-account
 * cycle concept is ever wanted, this is the one place that'd need to
 * change.
 */
export function computeJointAccountProjection(
  data: AppDataV2,
  horizon: ProjectionHorizon,
  asOfDate: Date = new Date(),
): JointAccountProjectionResult | null {
  const cycles = horizonCycles(data, data.primaryPersonId, horizon, asOfDate)
  return computeJointAccountProjectionToDate(data, cycles[cycles.length - 1].end, asOfDate)
}

/**
 * The same joint projection, bounded by an EXPLICIT end date rather than
 * one of the two named horizons — the joint counterpart of
 * projection.ts's computeProjectionToDate, extracted for the downloadable
 * cycle statement (TECHNICAL.md §"The cycle statement"), whose window is
 * a date range the person picks and can sit well beyond `three_cycles`.
 * computeJointAccountProjection is now a thin wrapper over it, so the two
 * cannot disagree by construction — the same precedent computeProjection
 * already follows.
 *
 * 🚨 Generation still starts at the CURRENT cycle's start, never at the
 * window's start, exactly as computeProjectionToDate does. A statement
 * reaching into past cycles is served by STORED history alone, which is
 * complete because autoClear.ts materialises every occurrence as it falls
 * due. Generating into the past instead would invent occurrences for
 * bills that were since deleted or changed — rows that never happened,
 * sitting in a document that reads as a record of what did.
 */
export function computeJointAccountProjectionToDate(
  data: AppDataV2,
  horizonEndDate: Date,
  asOfDate: Date = new Date(),
): JointAccountProjectionResult | null {
  if (!data.jointAccount) return null
  const { openingBalance, openingBalanceDate } = data.jointAccount

  const currentCycleStart = horizonCycles(data, data.primaryPersonId, 'current_cycle', asOfDate)[0].start
  const horizonEndIso = toIso(horizonEndDate)

  // Visibility floor, same rule as a personal ledger's own opening
  // balance date (projection.ts) — nothing before it is shown or counted.
  const openingDateObj = parseLocalDate(openingBalanceDate)
  const genStart = currentCycleStart > openingDateObj ? currentCycleStart : openingDateObj

  const stored = data.transactions.filter(
    (t) => t.date >= openingBalanceDate && (t.location === 'joint' || t.type === 'joint_deposit' || t.type === 'joint_withdrawal' || (t.type === 'transfer' && transferTouchesJoint(t.fromLocation, t.toLocation))),
  )
  const existingKeys = new Set(stored.map(dedupeKey).filter((k): k is string => k !== null))

  const generated: Omit<Transaction, 'id'>[] = []
  for (const template of data.recurringTemplates.filter((t) => t.location === 'joint')) {
    generated.push(...generateTransactionsForTemplate(template, genStart, horizonEndDate))
  }
  // Recurring transfers touching the joint account (2026-09-04 session)
  // — a SEPARATE lookup from the loop above, since a transfer template's
  // own `location` is always 'personal' (see RecurringTemplate.kind's
  // 'transfer' comment in types/ledger.ts), not 'joint' — the existing
  // `location === 'joint'` filter above is for JOINT-LOCATED BILLS, a
  // different concept.
  // 🚨 THE OWNER'S PAY CYCLE, NOT THE PRIMARY PERSON'S (2026-09-23 — see
  // payCycleForTemplate's own comment for the defect this fixes). Both
  // people can have a payday-following transfer into the joint account,
  // and resolving Adam's against Ella's payday silently MOVES it rather
  // than dropping it.
  for (const template of data.recurringTemplates.filter((t) => t.kind === 'transfer' && t.active && transferTouchesJoint(t.transferFrom, t.transferTo))) {
    generated.push(...generateTransactionsForTemplate(template, genStart, horizonEndDate, payCycleForTemplate(template, data.payCycles, data.primaryPersonId)))
  }
  for (const loan of data.loans.filter((l) => l.location === 'joint' && l.active)) {
    generated.push(...generateLoanPaymentTransactions(loan, genStart, horizonEndDate))
  }

  const dedupedGenerated: Transaction[] = generated
    .filter((t) => {
      const key = dedupeKey(t)
      return key === null || !existingKeys.has(key)
    })
    .map((t) => ({ ...t, id: `generated:${nanoid(8)}` }))

  const combined = [...stored, ...dedupedGenerated]

  const clearedBalance = round2(
    openingBalance + combined.filter((t) => t.status === 'cleared').reduce((sum, t) => sum + jointAccountSignedAmount(t), 0),
  )
  const pendingWithinHorizon = combined.filter((t) => t.status === 'pending' && t.date <= horizonEndIso)
  const projectedBalance = round2(clearedBalance + pendingWithinHorizon.reduce((sum, t) => sum + jointAccountSignedAmount(t), 0))

  return {
    horizonEnd: horizonEndIso,
    openingBalance,
    openingBalanceDate,
    clearedBalance,
    projectedBalance,
    transactions: combined.filter((t) => t.date <= horizonEndIso).sort((a, b) => a.date.localeCompare(b.date)),
  }
}

// ── Trends feature (2026-09-15 build) ──────────────────────────────────

/** "Spend" for the Joint Balance/Spend chart — every outgoing joint transaction (joint-location bills/loans, joint_withdrawal, a joint-side transfer leg), same "broader than averageSpendForecast's own ad-hoc-only scope" reasoning as buildPersonalTrendSeries' isPersonalSpend. */
function isJointSpend(t: Transaction): boolean {
  return jointAccountSignedAmount(t) < 0
}

/** Joint account equivalent of buildPersonalTrendSeries — see that function's own comment for the shared approach. Returns null (same convention as computeJointAccountProjection) until a joint account exists. */
export function buildJointTrendSeries(data: AppDataV2, granularity: BalanceSpendGranularity, asOfDate: Date = new Date()): BalanceSpendTrendSeries | null {
  if (!data.jointAccount) return null
  const horizon: ProjectionHorizon = granularity === 'this_cycle' ? 'current_cycle' : 'three_cycles'
  const cycles = horizonCycles(data, data.primaryPersonId, horizon, asOfDate)
  const periodStart = cycles[0].start
  const periodEnd = cycles[cycles.length - 1].end
  const days = daysBetweenInclusive(periodStart, periodEnd)
  const todayIso = toIso(asOfDate)

  const projection = computeJointAccountProjection(data, horizon, asOfDate)
  if (!projection) return null
  const balance = buildDailyBalanceSeries(projection.openingBalance, projection.transactions, days, jointAccountSignedAmount)
  const spend = buildDailySpendSeries(projection.transactions, days, isJointSpend)

  const cyclesBack = horizon === 'current_cycle' ? 1 : THREE_CYCLES_AHEAD + 1
  const prevCyclesAsc = [...previousCycles(data, data.primaryPersonId, cyclesBack, asOfDate)].reverse()
  const prevDays = daysBetweenInclusive(prevCyclesAsc[0].start, prevCyclesAsc[prevCyclesAsc.length - 1].end)
  const prevStored = data.transactions.filter(
    (t) => t.location === 'joint' || t.type === 'joint_deposit' || t.type === 'joint_withdrawal' || (t.type === 'transfer' && transferTouchesJoint(t.fromLocation, t.toLocation)),
  )
  const previousPeriodSpend = buildDailySpendSeries(prevStored, prevDays, isJointSpend)

  return { granularity, days, todayIso, balance, spend, previousPeriodSpend }
}
