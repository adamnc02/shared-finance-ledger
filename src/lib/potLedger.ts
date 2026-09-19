// Pot as its own top-level ledger entity (App Dev.md "Pots" backlog item,
// Adam-specified 2026-09-03). Same relationship to schedule.ts/
// ledgerLoans.ts as savingsPotLedger.ts has to them — a Pot's recurring-
// deposit walking is deliberately a near-exact copy of SavingsPot's (same
// monthly-only, flat-pause-list shape, copied rather than shared because
// the two entities are deliberately kept separate — see Pot's own header
// comment in types/ledger.ts). What's genuinely NEW here, with no
// SavingsPot equivalent, is the bill/loan-folding half: a Pot also funds
// whichever RecurringTemplate/Loan rows point `potId` at it, and this
// file is what turns that into the pot's own balance and ledger view.
//
// COST CATEGORY NOTE: pot_deposit/pot_withdrawal transactions are
// generated against the existing built-in SAVINGS_CATEGORY_ID rather than
// a new dedicated category — a minor, easily-revisited cosmetic choice
// (no 'pot' icon exists in billIcons.ts yet), not a structural one. Worth
// a real category (and icon) once the Wallet page's Pot UI is built, if
// Adam wants Pots to read as visually distinct from Savings Pots in the
// category breakdown.

import { addDays, addMonths } from 'date-fns'
import { toLocalIsoDate as toIso, parseLocalDate } from './date'
import { earlyMoveLookaheadDays, isOccurrenceAdjusted } from './occurrenceOverrides'
import { generateTransactionsForTemplate } from './schedule'
import { generateLoanPaymentTransactions } from './ledgerLoans'
import { generateMinimumPaymentTransactions } from './creditCards'
import { dedupeKey, horizonCycles, previousCycles, THREE_CYCLES_AHEAD, type ProjectionHorizon } from './projection'
import { potTransferSignedAmount, transferTouchesPot } from './transferLedger'
import { nanoid } from 'nanoid'
import { SAVINGS_CATEGORY_ID } from '../types/ledger'
import { daysBetweenInclusive, buildDailyBalanceSeries, buildDailySpendSeries, type BalanceSpendGranularity, type BalanceSpendTrendSeries } from './runningBalance'
import type { AppDataV2, CreditCard, Loan, PayCycleConfig, Pot, RecurringOccurrenceOverride, RecurringTemplate, Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100
const MAX_OCCURRENCES = 2000

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate()
}
function clampToAnchorDay(date: Date, anchorDay: number): Date {
  const day = Math.min(anchorDay, daysInMonth(date.getFullYear(), date.getMonth()))
  return new Date(date.getFullYear(), date.getMonth(), day)
}

/** Convenience constructor — mirrors savingsPotLedger.ts's newSavingsPot. Covers both "new" (zero balance, openingDate defaults to today) and "existing" (real opening balance + date) creation paths. `color` is the caller's job to pick (pickNextSharedCardColor, lib/creditCards.ts) since it needs the full AppDataV2 to count against. */
export function newPot(input: { personId: string; name: string; openingBalance: number; openingDate: string; color: string }): Omit<Pot, 'id'> {
  return {
    personId: input.personId,
    name: input.name,
    openingBalance: input.openingBalance,
    openingDate: input.openingDate,
    active: true,
    color: input.color,
  }
}

// ── Which bills/loans this pot funds — DERIVED, not stored on the Pot
// itself (see Pot's own header comment). ───────────────────────────────

export function potBillsAndLoans(data: AppDataV2, potId: string): { templates: RecurringTemplate[]; loans: Loan[]; creditCards: CreditCard[] } {
  return {
    templates: data.recurringTemplates.filter((t) => t.location === 'pot' && t.potId === potId),
    loans: data.loans.filter((l) => l.location === 'pot' && l.potId === potId),
    // 2026-09-16 — credit cards whose minimum payment is paid from this pot.
    creditCards: data.creditCards.filter((c) => c.location === 'pot' && c.potId === potId),
  }
}

// ── Recurring deposits (monthly-only, same shape as SavingsPot's) ─────

export interface RawPotDepositOccurrence {
  originalDate: string
  date: string
  amount: number
}

function walkPotDepositOccurrences(pot: Pot, rangeStart: Date, rangeEnd: Date): RawPotDepositOccurrence[] {
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

  // PROMPT-08c Part B — slots past rangeEnd are walked only so a deposit
  // moved EARLIER into the range is still found; see earlyMoveLookaheadDays.
  const walkEnd = addDays(rangeEnd, earlyMoveLookaheadDays(pot.recurringDepositOverrides))
  const rangeStartIso = toIso(rangeStart)
  const rangeEndIso = toIso(rangeEnd)

  const results: RawPotDepositOccurrence[] = []
  while (cursor <= walkEnd && iterations < MAX_OCCURRENCES) {
    const originalDate = toIso(cursor)
    if (originalDate >= pot.openingDate) {
      const override = pot.recurringDepositOverrides?.find((o) => o.originalDate === originalDate)
      if (!override?.deleted) {
        const date = override?.date ?? originalDate
        if (date >= rangeStartIso && (originalDate <= rangeEndIso || date <= rangeEndIso)) {
          results.push({ originalDate, date, amount: override?.amount ?? pot.recurringDepositAmount })
        }
      }
    }
    cursor = clampToAnchorDay(addMonths(cursor, 1), anchorDay)
    iterations++
  }
  return results
}

/**
 * Generates pending deposit-shaped transactions for the recurring
 * schedule — same "compute what should exist, caller dedupes against
 * real stored rows" contract as generateSavingsDepositTransactions.
 * Same legacy-field + new-transfer-template merge as that function's own
 * comment describes (2026-09-04 session) — Pot's legacy fields never had
 * a live UI writing to them, but are kept for the same backup-loading
 * safety.
 */
export function generatePotDepositTransactions(pot: Pot, rangeStart: Date, rangeEnd: Date, transferTemplates: RecurringTemplate[] = [], payCycle?: PayCycleConfig): Omit<Transaction, 'id'>[] {
  const legacy = walkPotDepositOccurrences(pot, rangeStart, rangeEnd).map((occ) => ({
    date: occ.date,
    amount: occ.amount,
    direction: 'out' as const,
    categoryId: SAVINGS_CATEGORY_ID,
    paymentMethod: 'bank_transfer' as const,
    status: 'pending' as const,
    type: 'pot_deposit' as const,
    location: 'personal' as const,
    ownerId: pot.personId,
    sourceType: 'pot' as const,
    sourceId: pot.id,
    potId: pot.id,
    note: pot.name,
  }))

  const fromTransfers = transferTemplates
    .filter((t) => t.kind === 'transfer' && t.active && transferTouchesPot(t.transferFrom, t.transferTo, pot.id))
    .flatMap((t) => generateTransactionsForTemplate(t, rangeStart, rangeEnd, payCycle))
    .filter((t) => t.toLocation?.type === 'pot' && t.toLocation.potId === pot.id)

  return [...legacy, ...fromTransfers]
}

/** The withdrawal-side equivalent — a transfer template with THIS pot as `transferFrom` (e.g. a recurring Pot → Savings sweep). No legacy equivalent existed. */
export function generatePotWithdrawalTransferTransactions(pot: Pot, rangeStart: Date, rangeEnd: Date, transferTemplates: RecurringTemplate[] = [], payCycle?: PayCycleConfig): Omit<Transaction, 'id'>[] {
  return transferTemplates
    .filter((t) => t.kind === 'transfer' && t.active && transferTouchesPot(t.transferFrom, t.transferTo, pot.id))
    .flatMap((t) => generateTransactionsForTemplate(t, rangeStart, rangeEnd, payCycle))
    .filter((t) => t.fromLocation?.type === 'pot' && t.fromLocation.potId === pot.id)
}

/** Next N upcoming recurring-deposit occurrences, for the Wallet page's editable pills. */
export function potDepositOccurrencePreviews(pot: Pot, asOfDate: Date, count: number): RawPotDepositOccurrence[] {
  return walkPotDepositOccurrences(pot, asOfDate, addMonths(asOfDate, count + 2)).slice(0, count)
}

/**
 * Every calendar date the recurring deposit schedule would land on in
 * [rangeStart, rangeEnd] — deliberately IGNORING pause state, same
 * purpose as SavingsPot's scheduledDepositDates: the pause checklist
 * needs a currently-paused date to still appear so it can be unticked.
 */
export function scheduledPotDepositDates(pot: Pot, rangeStart: Date, rangeEnd: Date): string[] {
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
 * What a SPECIFIC recurring-deposit occurrence resolves to, checking
 * `recurringDepositOverrides` first — mirrors schedule.ts's
 * resolveOccurrenceAmount (2026-09-10, "Manage upcoming payments"
 * redesign, call site #5). `walkPotDepositOccurrences` above already
 * reads an override's `.amount` when generating transactions, so the
 * real ledger has always been correct here — this is purely the
 * missing single-date display resolver a "manage upcoming payments" row
 * preview needs, same reasoning applyPotSingleDepositAmountChange below
 * exists for the write side. `originalDate` is the un-overridden
 * scheduled date (the override's own key).
 */
export function resolvePotDepositOccurrenceAmount(pot: Pot, originalDate: string): number {
  const override = pot.recurringDepositOverrides?.find((o) => o.originalDate === originalDate)
  if (override?.amount !== undefined) return override.amount
  return pot.recurringDepositAmount ?? 0
}

/** Whether this deposit shows the "Adjusted" badge — see isOccurrenceAdjusted. */
export function potDepositOccurrenceAdjusted(pot: Pot, originalDate: string): boolean {
  const override = pot.recurringDepositOverrides?.find((o) => o.originalDate === originalDate)
  if (!override || override.deleted) return false
  const natural = { date: originalDate, amount: pot.recurringDepositAmount ?? 0 }
  return isOccurrenceAdjusted({ date: override.date ?? originalDate, amount: override.amount ?? natural.amount }, natural)
}

/**
 * Builds the patch for a SINGLE-occurrence ("just a single payment")
 * amount change against a Pot's recurring deposit — new for 2026-09-10.
 * Before this, `recurringDepositOverrides` only ever carried
 * `{deleted: true}` pause markers; nothing populated `.amount`. Reuses
 * the same override slot a pause uses (keyed by originalDate), merging
 * onto any existing entry (e.g. a pause) rather than clobbering it —
 * identical shape/behaviour to schedule.ts's
 * applyTemplateSingleOccurrenceAmountChange.
 */
export function applyPotSingleDepositAmountChange(pot: Pot, newAmount: number, originalDate: string): Pick<Pot, 'recurringDepositOverrides'> {
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
export function setPausedPotDeposits(pot: Pot, windowDates: string[], pausedDates: string[]): Pick<Pot, 'recurringDepositOverrides'> {
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

// ── Outgoing (bill/loan) activity — the genuinely new half ────────────

/**
 * Every bill_payment/loan_payment (including a pot-funded recurring loan
 * overpayment) this pot funds, in range — generated by calling straight
 * through to the SAME generators the personal ledger uses
 * (generateTransactionsForTemplate/generateLoanPaymentTransactions), then
 * filtered to exactly this pot's rows.
 *
 * The filter matters, not just the potId match on the OUTER template/loan
 * — generateLoanPaymentTransactions can return a MIX of locations for one
 * loan now (its own scheduled-payment row uses loan.location, but a
 * recurring overpayment can independently resolve to a DIFFERENT pot, or
 * fall back to 'personal' — see resolveRecurringOverpaymentSource in
 * ledgerLoans.ts). Filtering the returned rows themselves, rather than
 * trusting "this loan's potId matches" alone, is what keeps a stray
 * personal-funded overpayment row off THIS pot's ledger even though the
 * loan's own regular payment belongs here.
 */
export function generatePotOutgoingTransactions(data: AppDataV2, pot: Pot, rangeStart: Date, rangeEnd: Date): Omit<Transaction, 'id'>[] {
  const { templates, loans, creditCards } = potBillsAndLoans(data, pot.id)
  const results: Omit<Transaction, 'id'>[] = []

  for (const template of templates) {
    results.push(...generateTransactionsForTemplate(template, rangeStart, rangeEnd).filter((t) => t.location === 'pot' && t.potId === pot.id))
  }
  // Loans whose recurring overpayment (not their own regular payment) is
  // funded from THIS pot, even when the loan's own `location`/`potId`
  // points somewhere else entirely (personal, or a different pot) —
  // generateLoanPaymentTransactions has to be called for those too, or
  // their pot-funded overpayment rows would never be generated at all.
  const overpaymentOnlyLoans = data.loans.filter(
    (l) => l.recurringOverpayment?.location === 'pot' && l.recurringOverpayment?.potId === pot.id && !(l.location === 'pot' && l.potId === pot.id),
  )
  for (const loan of [...loans, ...overpaymentOnlyLoans]) {
    results.push(...generateLoanPaymentTransactions(loan, rangeStart, rangeEnd).filter((t) => t.location === 'pot' && t.potId === pot.id))
  }
  // 2026-09-16 — a card's minimum payment funded from this pot. The full
  // transaction list goes in: the card's simulated balance must see every
  // spend and payment against the card, wherever it was paid from.
  for (const card of creditCards) {
    results.push(...generateMinimumPaymentTransactions(card, rangeStart, rangeEnd, data.transactions).filter((t) => t.location === 'pot' && t.potId === pot.id))
  }
  return results
}

// ── Balance — derived, never stored, same "fold activity against openingBalance" approach as savingsPotBalanceAsOf/cardBalanceAsOf ──

/**
 * The sign a transaction counts as on THIS POT'S own ledger — deliberately
 * separate from runningBalance.ts's signedAmount, which gives the
 * PERSONAL-ledger sign (opposite, for pot_deposit specifically — see this
 * file's own header for why a deposit is the one thing that's genuinely
 * two-sided). Type-derived, same "type decides the sign on THIS ledger"
 * pattern as jointAccountLedger.ts's jointAccountSignedAmount and
 * credit_card_spend/savings_deposit elsewhere in this app — deliberately
 * NOT reading `direction`, which encodes the PERSONAL ledger's sign and
 * would get every one of these backwards here (a pot_withdrawal has
 * direction 'in' because it credits personal cash, but it debits THIS
 * pot; a bill_payment/loan_payment funded from this pot has direction
 * 'out' on the bill/loan's own terms, which happens to already be right
 * for this ledger too, but that's this function saying so explicitly,
 * not `direction` being trusted to mean the same thing in both places).
 */
/**
 * `potId`, when supplied, resolves which side of a pot-to-pot transfer
 * this ledger is (the one edge case where `t.potId` alone is ambiguous —
 * see generatePotDepositTransactions' comment). Every call site in this
 * app has a specific pot in scope and should pass it; the fallback
 * (inferred from whichever endpoint is 'pot' first) only exists so this
 * function stays callable as a bare `(t) => number` where that's more
 * convenient, which is safe for the overwhelmingly common case of a
 * transfer with only ONE 'pot' endpoint.
 */
export function potSignedAmount(t: Pick<Transaction, 'type' | 'amount' | 'fromLocation' | 'toLocation'>, potId?: string): number {
  if (t.type === 'pot_deposit') return t.amount
  if (t.type === 'transfer') {
    if (potId) return potTransferSignedAmount(t, potId)
    if (t.toLocation?.type === 'pot') return t.amount
    if (t.fromLocation?.type === 'pot') return -t.amount
    return 0
  }
  // 2026-09-13 (dev.md item 5) — an ad-hoc expense/income can now itself
  // carry location: 'pot' (previously only pot_withdrawal/bill_payment/
  // loan_payment ever reached this fallback, all always 'out', so a bare
  // `-t.amount` was safe). 'income' needs the opposite sign.
  if (t.type === 'income') return t.amount
  // 2026-09-14 (savings interest destination) — a savings pot's interest
  // can now be paid into a Pot (SavingsPot.interestDestination), so this
  // fallback whitelist needs its own case too, same reason 'income' got
  // one — without it, this always-'out' default would wrongly treat
  // incoming interest as a withdrawal from the pot.
  if (t.type === 'savings_interest') return t.amount
  return -t.amount // pot_withdrawal, bill_payment, loan_payment, expense
}

/**
 * True when a STORED Transaction belongs on this pot's own ledger —
 * `t.potId === pot.id` alone is the right check for every non-transfer
 * type (a bill/loan payment only ever funds ONE pot), but is genuinely
 * ambiguous for a `type: 'transfer'` row with a Pot on BOTH ends (e.g.
 * Pot A → Pot B) — `potId` can only ever equal ONE of them (whichever
 * `buildTransferTransaction`/schedule.ts happened to pick), so the OTHER
 * pot's own stored-transaction lookup would silently never find its
 * half of the transfer without this. `transferTouchesPot` reads
 * fromLocation/toLocation directly instead, which correctly identifies
 * either side regardless of what the flat `potId` field says.
 */
function transactionTouchesPot(t: Pick<Transaction, 'type' | 'potId' | 'fromLocation' | 'toLocation'>, potId: string): boolean {
  if (t.type === 'transfer') return transferTouchesPot(t.fromLocation, t.toLocation, potId)
  return t.potId === potId
}

/**
 * This pot's balance as of a given date: openingBalance, plus every
 * pot_deposit, minus every pot_withdrawal AND every bill_payment/
 * loan_payment funded from it (a pot-funded bill payment reduces the
 * pot's own balance — it's "purely internal to the pot," per Adam's
 * confirmed 2026-09-03 read: the personal-ledger cash-out event already
 * happened at the deposit, not here). `activity` should already include
 * any generated-but-not-yet-materialized rows the caller wants counted —
 * this function only folds, it never generates. Anything dated before
 * openingDate is ignored, same rule as SavingsPot.
 */
export function potBalanceAsOf(pot: Pot, activity: Transaction[], asOfDate: Date): number {
  const asOfIso = toIso(asOfDate)
  const relevant = activity
    .filter((t) => transactionTouchesPot(t, pot.id) && t.date >= pot.openingDate && t.date <= asOfIso)
    .sort((a, b) => a.date.localeCompare(b.date))

  let balance = pot.openingBalance
  for (const t of relevant) balance += potSignedAmount(t, pot.id)
  return round2(balance)
}

export interface PotProjectionResult {
  horizonEnd: string // ISO date
  openingBalance: number
  clearedBalance: number
  projectedBalance: number
  transactions: Transaction[] // stored + generated (synthetic ids on the generated ones), sorted by date, for display
}

/**
 * A pot's own projection — same shape/reasoning as projection.ts's
 * computeProjectionToDate and jointAccountLedger.ts's
 * computeJointAccountProjection, just scoped to this Pot. Feeds the
 * Summary page's pot swipe card (Phase 7, 2026-09 session) — Adam's own
 * spec: "It's ledger should match the same style as the Personal swipe
 * card, in that I can see this cycle / next 3 cycles, and all other
 * group by / sort by features." Returning the exact same shape
 * `computeProjection`/`computeJointAccountProjection` do is what lets
 * Home.tsx feed this straight into the SAME CategoryGroupedList/
 * AmountOrderedList/CycleGroupedList/DateOrderedList components those
 * already use, with potSignedAmount passed as the amountSign override —
 * same mechanism jointAccountSignedAmount already exercises for Joint.
 *
 * Cycle boundaries: reuses the pot's OWNER's pay-cycle bounds (pots have
 * no cycle concept of their own) — same established convention
 * computeJointAccountProjection already uses for the joint account.
 */
export function computePotProjection(data: AppDataV2, pot: Pot, horizon: ProjectionHorizon, asOfDate: Date = new Date()): PotProjectionResult {
  const cycles = horizonCycles(data, pot.personId, horizon, asOfDate)
  const horizonEndDate = cycles[cycles.length - 1].end
  const horizonEndIso = toIso(horizonEndDate)

  // Visibility floor, same rule as a personal ledger's own opening
  // balance date (projection.ts) — nothing before it is shown or counted.
  const openingDateObj = parseLocalDate(pot.openingDate)
  const genStart = cycles[0].start > openingDateObj ? cycles[0].start : openingDateObj

  const stored = data.transactions.filter((t) => transactionTouchesPot(t, pot.id) && t.date >= pot.openingDate)
  const existingKeys = new Set(stored.map(dedupeKey).filter((k): k is string => k !== null))

  const generated: Omit<Transaction, 'id'>[] = [
    ...generatePotDepositTransactions(pot, genStart, horizonEndDate, data.recurringTemplates, data.payCycles.find((c) => c.personId === data.primaryPersonId)),
    ...generatePotWithdrawalTransferTransactions(pot, genStart, horizonEndDate, data.recurringTemplates, data.payCycles.find((c) => c.personId === data.primaryPersonId)),
    ...generatePotOutgoingTransactions(data, pot, genStart, horizonEndDate),
  ]

  const dedupedGenerated: Transaction[] = generated
    .filter((t) => {
      const key = dedupeKey(t)
      return key === null || !existingKeys.has(key)
    })
    .map((t) => ({ ...t, id: `generated:${nanoid(8)}` }))

  const combined = [...stored, ...dedupedGenerated]

  const clearedBalance = round2(pot.openingBalance + combined.filter((t) => t.status === 'cleared').reduce((sum, t) => sum + potSignedAmount(t, pot.id), 0))
  const pendingWithinHorizon = combined.filter((t) => t.status === 'pending' && t.date <= horizonEndIso)
  const projectedBalance = round2(clearedBalance + pendingWithinHorizon.reduce((sum, t) => sum + potSignedAmount(t, pot.id), 0))

  return {
    horizonEnd: horizonEndIso,
    openingBalance: pot.openingBalance,
    clearedBalance,
    projectedBalance,
    transactions: combined.filter((t) => t.date <= horizonEndIso).sort((a, b) => a.date.localeCompare(b.date)),
  }
}

// ── Ramp-up preview window — same "don't fabricate history" rule as SavingsPot's schedulePreviewWindow ──

export function schedulePotPreviewWindow(pot: Pot, asOfDate: Date): { start: Date; end: Date } {
  const openingDate = parseLocalDate(pot.openingDate)
  const monthsOld = Math.max(0, (asOfDate.getFullYear() - openingDate.getFullYear()) * 12 + (asOfDate.getMonth() - openingDate.getMonth()))
  const monthsBack = Math.min(2, monthsOld)
  const start = new Date(Math.max(addMonths(asOfDate, -monthsBack).getTime(), openingDate.getTime()))
  const end = addMonths(asOfDate, 12)
  return { start, end }
}

export interface PotScheduleRow {
  date: string
  type: 'pot_deposit' | 'pot_withdrawal' | 'bill_payment' | 'loan_payment' | 'credit_card_payment'
  amount: number
  status: 'cleared' | 'pending'
  note?: string
}

/**
 * Builds the combined deposit/withdrawal/bill/loan row list for the
 * pot's own ledger view (the Wallet page's future PotLedgerModal, and the
 * Summary page's future pot swipe card) — same ramp-up window and
 * stored-row-dedupe convention as buildSavingsPotScheduleRows.
 */
export function buildPotScheduleRows(data: AppDataV2, pot: Pot, asOfDate: Date = new Date()): PotScheduleRow[] {
  const { start, end } = schedulePotPreviewWindow(pot, asOfDate)
  const potStored = data.transactions.filter((t) => transactionTouchesPot(t, pot.id) && t.date >= toIso(start) && t.date <= toIso(end))
  const storedKeys = new Set(potStored.map((t) => `${t.type}:${t.sourceId ?? ''}:${t.date}`))
  const payCycle = data.payCycles.find((c) => c.personId === data.primaryPersonId)

  const generatedDeposits = generatePotDepositTransactions(pot, start, end, data.recurringTemplates, payCycle).filter((t) => !storedKeys.has(`${t.type}:${t.sourceId ?? ''}:${t.date}`))
  const generatedWithdrawals = generatePotWithdrawalTransferTransactions(pot, start, end, data.recurringTemplates, payCycle).filter((t) => !storedKeys.has(`${t.type}:${t.sourceId ?? ''}:${t.date}`))
  // Card minimum payments carry no sourceId, so they dedupe on the card id (dedupeKey) instead.
  const storedCardKeys = new Set(potStored.map(dedupeKey).filter((k): k is string => k !== null))
  const generatedOutgoing = generatePotOutgoingTransactions(data, pot, start, end).filter((t) =>
    t.type === 'credit_card_payment' ? !storedCardKeys.has(dedupeKey(t) ?? '') : !storedKeys.has(`${t.type}:${t.sourceId ?? ''}:${t.date}`),
  )

  const rows: PotScheduleRow[] = [
    // `toLocation.type === 'pot'` alone isn't enough to tell deposit from
    // withdrawal for THIS pot — a Pot A → Pot B transfer has toLocation
    // type 'pot' on BOTH pots' own rows, so it must check whose id it
    // actually is (same ambiguity transactionTouchesPot's own comment
    // describes).
    ...potStored.map((t) => ({
      date: t.date,
      type: (t.type === 'transfer' ? (t.toLocation?.type === 'pot' && t.toLocation.potId === pot.id ? 'pot_deposit' : 'pot_withdrawal') : t.type) as PotScheduleRow['type'],
      amount: t.amount,
      status: t.status,
      note: t.note,
    })),
    ...generatedDeposits.map((t) => ({ date: t.date, type: 'pot_deposit' as const, amount: t.amount, status: 'pending' as const, note: t.note })),
    ...generatedWithdrawals.map((t) => ({ date: t.date, type: 'pot_withdrawal' as const, amount: t.amount, status: 'pending' as const, note: t.note })),
    ...generatedOutgoing.map((t) => ({ date: t.date, type: t.type as 'bill_payment' | 'loan_payment' | 'credit_card_payment', amount: t.amount, status: 'pending' as const, note: t.note })),
  ]
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

// ── Trends feature (2026-09-15 build) ──────────────────────────────────
// Pot (bills pot, not Savings Pot) gets the SAME Balance/Spend chart shape
// as Personal (Adam-confirmed): balance = pot's own end-of-day balance,
// spend = accumulating drawdown from the pot in the period.

/** "Spend" (drawdown) for a Pot's Balance/Spend chart — every negative-signed activity against the pot (a funded bill/loan payment, or a pot_withdrawal/outgoing-transfer leg) — mirrors buildPersonalTrendSeries' isPersonalSpend, scoped to potSignedAmount instead. */
function isPotSpend(pot: Pot) {
  return (t: Transaction) => potSignedAmount(t, pot.id) < 0
}

export function buildPotTrendSeries(data: AppDataV2, pot: Pot, granularity: BalanceSpendGranularity, asOfDate: Date = new Date()): BalanceSpendTrendSeries {
  const horizon: ProjectionHorizon = granularity === 'this_cycle' ? 'current_cycle' : 'three_cycles'
  const cycles = horizonCycles(data, pot.personId, horizon, asOfDate)
  const periodStart = cycles[0].start
  const periodEnd = cycles[cycles.length - 1].end
  const days = daysBetweenInclusive(periodStart, periodEnd)
  const todayIso = toIso(asOfDate)

  const projection = computePotProjection(data, pot, horizon, asOfDate)
  const signFn = (t: Transaction) => potSignedAmount(t, pot.id)
  const balance = buildDailyBalanceSeries(pot.openingBalance, projection.transactions, days, signFn)
  const spend = buildDailySpendSeries(projection.transactions, days, isPotSpend(pot))

  const cyclesBack = horizon === 'current_cycle' ? 1 : THREE_CYCLES_AHEAD + 1
  const prevCyclesAsc = [...previousCycles(data, pot.personId, cyclesBack, asOfDate)].reverse()
  const prevDays = daysBetweenInclusive(prevCyclesAsc[0].start, prevCyclesAsc[prevCyclesAsc.length - 1].end)
  const prevStored = data.transactions.filter((t) => transactionTouchesPot(t, pot.id))
  const previousPeriodSpend = buildDailySpendSeries(prevStored, prevDays, isPotSpend(pot))

  return { granularity, days, todayIso, balance, spend, previousPeriodSpend }
}
