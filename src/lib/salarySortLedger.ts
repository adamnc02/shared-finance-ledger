// Salary Sorter (App_Dev.md "Salary Sorter & Transfer Pill", 2026-09
// session) — the smart-suggestion and conflict-detection logic behind
// the sort modal. SalarySort's own record shape lives in types/ledger.ts
// (see its own comment for the two-way edit-sync contract); the actual
// upsert/detach/orphan-cleanup lives in LedgerContext.tsx (saveSalarySort/
// updateTransaction/removeTransaction). This file is read-only — nothing
// here writes to `data`.

import { addDays } from 'date-fns'
import { parseLocalDate } from './date'
import { cycleBoundsForDate } from './payCycle'
import { upcomingPaydays } from './salaryLedger'
import { generateTransactionsForTemplate } from './schedule'
import { generateLoanPaymentTransactions } from './ledgerLoans'
import { generateMinimumPaymentTransactions } from './creditCards'
import { generateJointContributionTransactions } from './jointLedger'
import { potBillsAndLoans } from './potLedger'
import { locationsEqual, transferLocationKey } from './transferLedger'
import type { AppDataV2, PayCycleConfig, Pot, RecurringTemplate, SavingsPot, Transaction, TransferLocation } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100

// ── Which destinations a sort can target (Adam-specified 2026-09
// session: "only my pots and/or joint account if one exists") ─────────
// Deliberately excludes any pot/savings pot owned by a NON-primary
// person — the primary person's own cash is what's leaving, so sending
// it into someone else's personal pot isn't offered as an option here.
// Joint is unambiguous (there's only ever one, and it's shared by
// construction) so it's never owner-filtered.

export interface SalarySortDestination {
  location: TransferLocation
  label: string
}

export function salarySortDestinations(data: AppDataV2): SalarySortDestination[] {
  const results: SalarySortDestination[] = []
  for (const pot of (data.pots ?? []).filter((p) => p.personId === data.primaryPersonId && p.active)) {
    results.push({ location: { type: 'pot', potId: pot.id }, label: pot.name })
  }
  for (const pot of (data.savingsPots ?? []).filter((p) => p.personId === data.primaryPersonId && p.active)) {
    results.push({ location: { type: 'savings', savingsPotId: pot.id }, label: pot.name })
  }
  if (data.jointAccount) {
    results.push({ location: { type: 'joint' }, label: 'Joint Account' })
  }
  return results
}

/** True only when at least one destination exists — the Salary page's sort icon is hidden entirely otherwise (Adam's spec: "I should not see the salary sort icon if there are no pots, savings pots or no joint account"). */
export function hasSalarySortDestinations(data: AppDataV2): boolean {
  return salarySortDestinations(data).length > 0
}

// ── "This pay cycle" window ─────────────────────────────────────────
// Two bases, per-person choice (PayCycleConfig.salarySortBasis, 2026-09
// session) — undefined defaults to 'payday'. Both return an END-
// inclusive window; 'payday' stops the day BEFORE the next resolved
// payday (never touches it — the next sort handles that period), and
// 'budget_cycle' uses the person's actual configured cycle boundary
// (cycleBoundsForDate), which may not coincide with payday at all.
export function salarySortWindow(payCycle: PayCycleConfig, payDate: string): { start: Date; end: Date } {
  const start = parseLocalDate(payDate)
  if (payCycle.salarySortBasis === 'budget_cycle') {
    return cycleBoundsForDate(start, payCycle)
  }
  const nextPayday = upcomingPaydays(payCycle, start, 1)[0]
  const end = nextPayday ? addDays(nextPayday, -1) : addDays(start, 27) // 27 = a sane fallback window if somehow no next payday resolves
  return { start, end }
}

// ── "Total due this window" — the label's own priority, ALWAYS wins
// over last-sorted when non-zero (Adam-specified 2026-09 session: "the
// total due out always wins the rule for the label if there is
// outstanding, that way if I do override one month, I can still
// re-baseline next pay against what actually needs to go in"). Savings
// pots have no bill/loan linkage at all, so this is always 0 for them —
// same "meaningless for savings" reasoning Pot's own header comment
// gives for goals/interest. ─────────────────────────────────────────

export function dueAmountForLocation(data: AppDataV2, location: TransferLocation, window: { start: Date; end: Date }): number {
  if (location.type === 'pot') {
    const pot = (data.pots ?? []).find((p) => p.id === location.potId)
    if (!pot) return 0
    const { templates, loans, creditCards } = potBillsAndLoans(data, pot.id)
    let total = 0
    for (const template of templates) total += generateTransactionsForTemplate(template, window.start, window.end).reduce((sum, t) => sum + t.amount, 0)
    for (const loan of loans) total += generateLoanPaymentTransactions(loan, window.start, window.end).reduce((sum, t) => sum + t.amount, 0)
    for (const card of creditCards) total += generateMinimumPaymentTransactions(card, window.start, window.end, data.transactions).reduce((sum, t) => sum + t.amount, 0)
    return round2(total)
  }
  if (location.type === 'joint') {
    // The primary person's own SHARE of joint bills/loans due in the
    // window — same personShareOfJointAmount split every other joint
    // figure in the app uses (2026-09-03 decision: "the suggested joint
    // account top-up is based on MY share of joint bills only").
    const share = generateJointContributionTransactions(data, data.primaryPersonId, window.start, window.end).reduce((sum, t) => sum + t.amount, 0)
    return round2(share)
  }
  return 0 // 'savings' — no bill/loan linkage, and 'personal' is never a valid destination
}

// ── Deterministic Salary Sort ids (PROMPT-11, 2026-09-19) ──────────────
// A sort, its targets and their transfer transactions all derive their ids from the person and the
// payday, so two devices that sort the same payday before either has synced write the SAME rows
// and the upsert merges them — instead of two sorts, two targets and two real transfers, which
// would double the money moved (the same rule auto-cleared payments follow: MIGRATION-LESSONS §36).
// Records created before this keep their nanoid ids; nothing reads the shape.
export const salarySortId = (personId: string, payDate: string): string => `sort:${personId}:${payDate}`
export const salarySortTargetId = (sortId: string, to: TransferLocation): string => `${sortId}:${transferLocationKey(to)}`
export const salarySortTransactionId = (targetId: string): string => `${targetId}:tx`

/**
 * Whose sort this is. A record saved before sorts carried a person (PROMPT-11) is attributed to the
 * owner of the transfers it created, falling back to the primary person — the same answer the sort
 * would have had, since the Salary page only ever offers sorting for whoever the device is "me".
 */
export function salarySortPersonId(sort: { personId?: string; targets: { transactionId: string }[] }, transactions: Pick<Transaction, 'id' | 'ownerId'>[], fallbackPersonId: string): string {
  if (sort.personId) return sort.personId
  for (const target of sort.targets) {
    const owner = transactions.find((t) => t.id === target.transactionId)?.ownerId
    if (owner) return owner
  }
  return fallbackPersonId
}

/** This destination's amount on the most recent PRIOR salary sort (strictly before `beforePayDate`) — null if it's never been sorted to before. */
export function lastSortedAmountFor(data: AppDataV2, location: TransferLocation, beforePayDate: string, personId: string = data.primaryPersonId): number | null {
  const priorSorts = (data.salarySorts ?? [])
    // Scoped to one person (PROMPT-11): otherwise the prefill for your payday could come from your
    // partner's sort of theirs.
    .filter((s) => s.payDate < beforePayDate && s.personId === personId)
    .sort((a, b) => b.payDate.localeCompare(a.payDate))
  for (const sort of priorSorts) {
    const match = sort.targets.find((t) => locationsEqual(t.to, location))
    if (match) return match.amount
  }
  return null
}

export interface SalarySortSuggestion {
  dueAmount: number
  lastSortAmount: number | null
  /** What the input box opens pre-filled with — Adam's explicit 2026-09 rule: last-sorted wins the PREFILL whenever a prior sort to this destination exists, even though the label below always leads with dueAmount when it's non-zero. */
  prefillAmount: number
  /** What the small in-line label under the location name says — dueAmount ALWAYS wins here when non-zero, regardless of prefillAmount (see this file's header comment). */
  reasonLabel: string
}

export function salarySortSuggestion(data: AppDataV2, payCycle: PayCycleConfig, payDate: string, location: TransferLocation): SalarySortSuggestion {
  const window = salarySortWindow(payCycle, payDate)
  const dueAmount = dueAmountForLocation(data, location, window)
  const lastSortAmount = lastSortedAmountFor(data, location, payDate)

  const prefillAmount = lastSortAmount !== null ? lastSortAmount : dueAmount

  const reasonLabel =
    dueAmount > 0
      ? `Total due this pay cycle: £${dueAmount.toFixed(2)}`
      : lastSortAmount !== null
        ? `Last time you sorted: £${lastSortAmount.toFixed(2)}`
        : 'No bills or loans tagged here yet'

  return { dueAmount, lastSortAmount, prefillAmount, reasonLabel }
}

// ── Conflict detection — same exact-match rule (locationsEqual) both
// directions (Adam-specified 2026-09 session: "matching exact locations
// only", "do not check on amount"). ─────────────────────────────────

/** An already-existing ONE-OFF transfer, from Current Account, on this exact date, to this exact destination. Used when sorting a salary (line 41's guard) — a `SalarySort`'s own targets are never matched against themselves here, since a sort's own prior transactions for THIS payDate are what saveSalarySort is about to reconcile, not a foreign conflict. */
export function findOneOffTransferConflict(data: AppDataV2, date: string, location: TransferLocation): Transaction | undefined {
  return data.transactions.find(
    (t) => t.type === 'transfer' && t.date === date && t.fromLocation?.type === 'personal' && locationsEqual(t.toLocation, location) && t.sourceType !== 'salary_sort',
  )
}

/** An already-active RECURRING transfer template, from Current Account to this exact destination, whose next resolved occurrence lands on this exact payDate. Same guard as above, for the recurring case. Generates over a WIDER window than just `payDate` itself — a follows-payday/follows-cycle-start occurrence's NOMINAL (pre-resolution) date is usually earlier than its resolved one, so restricting generation to `payDate` alone would miss it; 40 days comfortably covers every supported frequency down to weekly. */
export function findRecurringTransferConflict(data: AppDataV2, payCycle: PayCycleConfig, payDate: string, location: TransferLocation): RecurringTemplate | undefined {
  const rangeStart = addDays(parseLocalDate(payDate), -40)
  const rangeEnd = parseLocalDate(payDate)
  return data.recurringTemplates.find((t) => {
    if (t.kind !== 'transfer' || !t.active) return false
    if (t.transferFrom?.type !== 'personal' || !locationsEqual(t.transferTo, location)) return false
    const occurrences = generateTransactionsForTemplate(t, rangeStart, rangeEnd, payCycle)
    return occurrences.some((occ) => occ.date === payDate)
  })
}

export interface SalarySortConflict {
  payDate: string
  amount: number
}

/**
 * The REVERSE guard — creating a new one-off/recurring transfer to this
 * exact destination, where one or more of `dates` already has a saved
 * SalarySort targeting it. `dates` is the single date for a one-off
 * transfer, or (Adam's 2026-09 answer) this payday plus the next 3
 * resolved occurrences for a recurring one — the caller resolves those
 * via generateTransactionsForTemplate against a draft template before
 * calling this, since the exact dates depend on frequency/anchorDate/
 * followsPayday/followsCycleStart, none of which this function needs to
 * know about itself.
 */
export function findSalarySortConflicts(data: AppDataV2, location: TransferLocation, dates: string[], personId: string = data.primaryPersonId): SalarySortConflict[] {
  const dateSet = new Set(dates)
  const conflicts: SalarySortConflict[] = []
  for (const sort of data.salarySorts ?? []) {
    if (!dateSet.has(sort.payDate) || sort.personId !== personId) continue
    for (const target of sort.targets) {
      if (locationsEqual(target.to, location)) conflicts.push({ payDate: sort.payDate, amount: target.amount })
    }
  }
  return conflicts
}

// Re-exported purely for convenience so a UI file only needs one import
// for "everything Salary Sort needs" rather than reaching into potLedger/
// savingsPotLedger separately just to build the destination list's own
// entity lookups (name, active state) — SalarySortDestination.label
// already carries the resolved name, but the modal still needs the full
// Pot/SavingsPot records for other display purposes (icons, etc.).
export type { Pot, SavingsPot }
