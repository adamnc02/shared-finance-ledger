// The pop-down "breakdown" card that lives behind the Summary page's
// salary (Personal) hero — income vs outgoings vs what's actually left,
// for whichever horizon the hero itself is showing.
//
// Kept out of Home.tsx deliberately: it's arithmetic over the projection's
// transaction list, so it's exactly the kind of thing that should be
// verifiable by a scripts/verify-*.ts run rather than only by eye.

import { isLedgerTransaction, signedAmount } from './runningBalance'
import type { Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100

export interface CycleSummary {
  income: {
    /** Regular payday salary plus any bonuses attached to it. */
    salary: number
    /** A transfer INTO the personal ledger from a savings pot, joint account, or pot. */
    withdrawals: number
    /** Ad-hoc incoming logged on the Expenses page. */
    other: number
    total: number
  }
  outgoings: {
    standingOrder: number
    /** Direct debits, plus every loan payment regardless of its own payment method. */
    directDebit: number
    /** A transfer OUT of the personal ledger into a savings pot, joint account, or pot. */
    deposits: number
    /** Everything else — cash, card, bank transfer. */
    other: number
    total: number
  }
  /** Cleared balance as things stand right now. */
  currentBalance: number
  /**
   * What's genuinely left once the rest of the window plays out.
   *
   * NOT `currentBalance + income.total - outgoings.total`, even though
   * that's the shape the figures suggest: the income/outgoings totals
   * above cover the WHOLE window, including items that have already
   * cleared and are therefore already baked into `currentBalance`. Adding
   * them again would count this month's salary twice the moment it lands.
   * So only STILL-PENDING items move this figure — which makes it exactly
   * equal to the projected balance the hero card already headlines, and
   * that equality is asserted in scripts/verify-cycle-summary.ts.
   */
  available: number
}

/**
 * Which bucket a transaction's outgoing amount counts toward. Loans are
 * folded into the direct-debit bucket by explicit request, whatever
 * payment method the individual loan actually carries — a loan leaving
 * the account monthly reads as a DD to the person budgeting against it,
 * and scheduled loan payments are already generated as direct_debit
 * anyway (lib/ledgerLoans.ts); this only additionally catches loan
 * overpayments/settlements, which generate as bank_transfer.
 */
function outgoingBucket(t: Transaction): 'standingOrder' | 'directDebit' | 'other' {
  if (t.type === 'loan_payment') return 'directDebit'
  if (t.paymentMethod === 'standing_order') return 'standingOrder'
  if (t.paymentMethod === 'direct_debit') return 'directDebit'
  return 'other'
}

/**
 * True for a transaction that's a transfer between the personal ledger and
 * a savings pot, the joint account, or a pot — in either direction. Covers
 * both the current generic 'transfer' type (checked by its fromLocation/
 * toLocation, since the same type now means either direction — see
 * types/ledger.ts's own comment on 'transfer') and the superseded
 * savings_deposit/savings_withdrawal/joint_deposit/joint_withdrawal/
 * pot_deposit/pot_withdrawal types, kept only for round-tripping an
 * already-persisted backup that still contains them.
 */
function isPotSavingsJointTransfer(t: Transaction): boolean {
  if (t.type === 'transfer') {
    return t.fromLocation?.type === 'savings' || t.fromLocation?.type === 'joint' || t.fromLocation?.type === 'pot' || t.toLocation?.type === 'savings' || t.toLocation?.type === 'joint' || t.toLocation?.type === 'pot'
  }
  return t.type === 'savings_deposit' || t.type === 'savings_withdrawal' || t.type === 'joint_deposit' || t.type === 'joint_withdrawal' || t.type === 'pot_deposit' || t.type === 'pot_withdrawal'
}

/**
 * `window` bounds the income/outgoings buckets to the rows the card shows
 * (see inCycleWindow). Pending is never bounded: Available = current
 * balance + every pending row, whatever its date.
 */
export function computeCycleSummary(transactions: Transaction[], clearedBalance: number, window?: { startIso: string; endIso: string }): CycleSummary {
  const ledger = transactions.filter(isLedgerTransaction)

  let salary = 0
  let withdrawals = 0
  let otherIncome = 0
  let standingOrder = 0
  let directDebit = 0
  let deposits = 0
  let otherOut = 0
  let pendingDelta = 0

  for (const t of ledger) {
    if (t.status === 'pending') pendingDelta += signedAmount(t)
    if (window && (t.date < window.startIso || t.date > window.endIso)) continue

    if (t.direction === 'in') {
      // Pension income counted in the same bucket as salary/bonus — same
      // "the wage/pension arriving" concept, and per Pension's own type
      // comment, treated as income exactly like salary everywhere else
      // already was. The BUCKET's label ("salary") not yet reflecting
      // that a pension can be the one filling it is exactly backlog item
      // c's flagged, still-open complication #1 ("transaction sort order
      // forcing salary first — needs revisiting once multiple income
      // sources exist") — this fix is the correctness-preserving part
      // (nothing silently undercounts pension income in the summary
      // totals), not that deeper relabeling.
      if (t.type === 'salary' || t.type === 'bonus' || t.type === 'pension_income') salary += t.amount
      else if (isPotSavingsJointTransfer(t)) withdrawals += t.amount
      else otherIncome += t.amount
      continue
    }

    if (isPotSavingsJointTransfer(t)) {
      deposits += t.amount
      continue
    }

    const bucket = outgoingBucket(t)
    if (bucket === 'standingOrder') standingOrder += t.amount
    else if (bucket === 'directDebit') directDebit += t.amount
    else otherOut += t.amount
  }

  return {
    income: {
      salary: round2(salary),
      withdrawals: round2(withdrawals),
      other: round2(otherIncome),
      total: round2(salary + withdrawals + otherIncome),
    },
    outgoings: {
      standingOrder: round2(standingOrder),
      directDebit: round2(directDebit),
      deposits: round2(deposits),
      other: round2(otherOut),
      total: round2(standingOrder + directDebit + deposits + otherOut),
    },
    currentBalance: round2(clearedBalance),
    available: round2(clearedBalance + pendingDelta),
  }
}

/**
 * Ordering rank within a single date for the Summary ledger's
 * group-by-list / order-by-date view: salary/pension income (and a bonus
 * paid alongside salary) always lands FIRST on its date, before any bill
 * or loan due the same day. This isn't cosmetic — the rolling balance
 * figure shown beside each row is a running fold in list order, so a
 * bill sorted above the income that funds it shows a dip that never
 * actually happens. Same open question as computeCycleSummary above once
 * there's genuinely more than one same-day income source (e.g. a salary
 * AND a pension landing the same date) — which of the two should rank
 * first between THEM isn't resolved here, only that both rank ahead of
 * outgoings.
 */
// Salary/bonus/pension income ranks first same-day (0); a Salary-Sort
// transfer ranks directly after that income (1) — Adam-specified
// 2026-09 Salary Sorter session: the money it's sorting only exists
// because the salary landed moments before, so it should read as "the
// very next thing that happened," not mixed in among the day's ordinary
// bills. Everything else keeps its prior rank (2, was 1).
export function sameDateRank(t: Pick<Transaction, 'type' | 'sourceType'>): number {
  if (t.type === 'salary' || t.type === 'bonus' || t.type === 'pension_income') return 0
  if (t.sourceType === 'salary_sort') return 1
  return 2
}

/** Chronological, with salary/pension income first within any given date. */
export function compareByDateSalaryFirst(a: Transaction, b: Transaction): number {
  if (a.date !== b.date) return a.date.localeCompare(b.date)
  return sameDateRank(a) - sameDateRank(b)
}

/** Reverse-chronological, still with salary first within any given date. */
export function compareByDateDescSalaryFirst(a: Transaction, b: Transaction): number {
  if (a.date !== b.date) return b.date.localeCompare(a.date)
  return sameDateRank(a) - sameDateRank(b)
}
