// The What-if statement: what one card's scenario looks like, date by date
// and payment by payment, behind the "Statement" button on a loan or
// savings-pot card (pages/Scenarios.tsx).
//
// 🚨 ONE ENGINE. Every figure here comes from the same inputs the card was
// computed from: a loan's `DebtImpact.loanEvents` through the same
// simulateScenarioLoan schedule, and a pot's `SavingsPotImpact.whatIfPlan`
// through the same potWhatIfActivity / potWhatIfTemplates. Re-deriving a
// schedule here, or reusing Borrowing's buildLoanLedgerRows (whose
// balanceAfter is not monotonic), would give the card and its statement two
// chances to disagree.
//
// Credit cards have no statement: What-if's card maths is dateless (one
// "Today" section and a flat payoff count), so a dated card statement would
// have to invent dates the engine never had.

import { addMonths, addYears, addDays } from 'date-fns'
import type { AppData, Loan } from '../types/models'
import { baselineLoanSchedule, buildLoanStatementRows, simulateScenarioLoan, type LoanStatementRow, type ScenarioLoanEvent } from './loans'
import { potWhatIfActivity, potWhatIfTemplates, type PotPlan, type SavingsPotImpact } from './scenarios'
import { buildSavingsPotScheduleRows, savingsPotBalanceAsOf } from './savingsPotLedger'
import { parseLocalDate, toLocalIsoDate } from './date'

const round2 = (n: number) => Math.round(n * 100) / 100

export interface LoanStatementSummary {
  finishDate: string | null
  payments: number
  interest: number
}

export interface LoanScenarioStatement {
  /** Owed before the first row. */
  opening: number
  rows: LoanStatementRow[]
  /** The same loan with none of this card's actions. */
  without: LoanStatementSummary
  with: LoanStatementSummary
  /** What the extras actually took off, summed from the rows, never from the engine's overpaymentApplied. */
  extrasTotal: number
}

function summarise(rows: LoanStatementRow[]): LoanStatementSummary {
  return {
    finishDate: rows.at(-1)?.date ?? null,
    payments: rows.filter((r) => r.kind === 'payment').length,
    interest: round2(rows.reduce((s, r) => s + r.interest, 0)),
  }
}

/**
 * `loan` is the bridged loan (legacyBridge.ts), whose schedule starts at the
 * next payment due. null for an uncalibrated loan: it has no schedule, and
 * its card falls back to plain arithmetic with no dates to list.
 */
export function buildLoanScenarioStatement(loan: Loan, events: ScenarioLoanEvent[]): LoanScenarioStatement | null {
  const baseline = baselineLoanSchedule(loan)
  if (baseline.length === 0) return null
  const outcome = events.length > 0 ? simulateScenarioLoan(loan, events) : null
  const schedule = outcome?.hasSchedule ? outcome.schedule : baseline
  const rows = buildLoanStatementRows(schedule, loan.totalAmount, events)
  return {
    opening: loan.totalAmount,
    rows,
    without: summarise(buildLoanStatementRows(baseline, loan.totalAmount, [])),
    with: summarise(rows),
    extrasTotal: round2(rows.reduce((s, r) => s + r.extra, 0)),
  }
}

export interface PotStatementRow {
  date: string
  kind: 'deposit' | 'withdrawal' | 'interest'
  /** Signed: a withdrawal is negative. */
  amount: number
  balance: number
  /** A lump sum or withdrawal this scenario adds, not part of the pot's own schedule. */
  whatIf: boolean
}

export interface PotScenarioStatement {
  opening: number
  startDate: string
  endDate: string
  rows: PotStatementRow[]
  without: { endBalance: number; reachDate: string | null }
  with: { endBalance: number; reachDate: string | null }
}

/** How far a pot statement runs: to the latest of the last change + 12 months, the target date and either reach date, never beyond 30 years. */
export function potStatementEnd(si: SavingsPotImpact, today: Date): Date {
  const lastChange = si.sections.map((s) => s.date).sort().at(-1)
  const candidates = [
    lastChange ? addMonths(parseLocalDate(lastChange), 12) : addMonths(today, 12),
    ...[si.targetDate, si.currentReachDate, si.finalReachDate].filter((d): d is string => !!d).map(parseLocalDate),
  ]
  const latest = new Date(Math.max(...candidates.map((d) => d.getTime())))
  const cap = addYears(today, 30)
  return latest > cap ? cap : latest
}

function potRows(si: SavingsPotImpact, plan: PotPlan, data: AppData, today: Date, end: Date): { opening: number; rows: PotStatementRow[] } {
  const pot = data.savingsPots.find((p) => p.id === si.savingsPotId)
  if (!pot) return { opening: 0, rows: [] }
  const payCycle = data.payCycles.find((c) => c.personId === pot.personId)
  const activity = potWhatIfActivity(pot, plan, data)
  const opening = savingsPotBalanceAsOf(pot, activity, addDays(today, -1))
  const raw = buildSavingsPotScheduleRows(pot, activity, today, potWhatIfTemplates(pot, plan, data), payCycle, { start: today, end })
  const unclaimed = [...plan.lumps.map((l) => ({ ...l, type: 'savings_deposit' })), ...plan.withdrawals.map((w) => ({ ...w, type: 'savings_withdrawal' }))]
  let balance = opening
  const rows = raw.map((r) => {
    const kind: PotStatementRow['kind'] = r.type === 'savings_withdrawal' ? 'withdrawal' : r.type === 'savings_interest' ? 'interest' : 'deposit'
    const amount = kind === 'withdrawal' ? -r.amount : r.amount
    balance = round2(balance + amount)
    const i = unclaimed.findIndex((u) => u.date === r.date && u.type === r.type && u.amount === r.amount)
    if (i >= 0) unclaimed.splice(i, 1)
    return { date: r.date, kind, amount: round2(amount), balance, whatIf: i >= 0 }
  })
  return { opening: round2(opening), rows }
}

export function buildSavingsPotScenarioStatement(si: SavingsPotImpact, data: AppData, today: Date = new Date()): PotScenarioStatement {
  const end = potStatementEnd(si, today)
  const withPlan = potRows(si, si.whatIfPlan, data, today, end)
  const withoutPlan = potRows(si, { lumps: [], withdrawals: [], recurring: [] }, data, today, end)
  return {
    opening: withPlan.opening,
    startDate: toLocalIsoDate(today),
    endDate: toLocalIsoDate(end),
    rows: withPlan.rows,
    without: { endBalance: withoutPlan.rows.at(-1)?.balance ?? withoutPlan.opening, reachDate: si.currentReachDate },
    with: { endBalance: withPlan.rows.at(-1)?.balance ?? withPlan.opening, reachDate: si.finalReachDate },
  }
}
