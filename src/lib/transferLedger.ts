// ── Transfer — the generic replacement for Savings/Joint/Pots' own
// deposit/withdrawal pills (2026-09-04 session, App_Dev.md "Salary
// Sorter & Transfer Pill"). A single Transaction/RecurringTemplate shape
// (type/kind: 'transfer', TransferLocation endpoints — see
// types/ledger.ts) now covers every combination of current account /
// savings pot / joint account / pot, one-off or recurring.
//
// Whenever 'personal' (the primary person's own account) is one of the
// two endpoints — still the overwhelmingly common case — the transaction
// carries `location: 'personal'`, `ownerId: <primary person>`, and a
// `direction` derived from which side personal is on, exactly the shape
// savings_deposit/joint_deposit/pot_deposit used to set by hand; this is
// what lets that transfer flow through the EXISTING personal-ledger
// machinery (projection.ts/autoClear.ts/runningBalance.ts) unchanged.
//
// A direct transfer with NO personal leg at all (Pot ↔ Pot, Pot ↔
// Savings, Savings ↔ Joint — UAT session, 2026-09) — reachable from the
// UI via TransferForm's own From picker — gets `location: 'joint'` or
// `'pot'` instead (see locationTypeForTransfer below), which is what
// correctly keeps it OFF the personal ledger; each entity's own ledger
// file (potLedger.ts/savingsPotLedger.ts/jointAccountLedger.ts) picks it
// up via `transferTouchesX(fromLocation, toLocation, ...)` regardless of
// what `location` says, and autoClear.ts has its own dedicated
// materialization pass for exactly this non-personal-endpoint case (see
// that file's own comment). `fromLocation`/`toLocation` are the
// authoritative fields for both endpoints; `savingsPotId`/`potId` are
// ALSO still populated (whichever ONE endpoint is a savings pot / pot —
// ambiguous when BOTH are, e.g. Pot A → Pot B, see potSignedAmount's own
// comment) purely so every existing simple `t.savingsPotId === pot.id` /
// `t.potId === pot.id` filter elsewhere in the app keeps working
// unchanged for the single-sided case.
//
// This file is the one place that knows how to read BOTH sides of a
// transfer — locationsEqual/matchesLocation for filtering, and a signed-
// amount function per non-personal ledger (savingsPotLedger.ts/
// jointAccountLedger.ts/potLedger.ts each import the relevant one rather
// than re-deriving the "which side am I, and is that an inflow or
// outflow" logic themselves).

import { nanoid } from 'nanoid'
import { SAVINGS_CATEGORY_ID } from '../types/ledger'
import { seededCategoryIdForIcon } from './categories'
import { toLocalIsoDate as toIso } from './date'
import type { Transaction, TransferLocation } from '../types/ledger'

// Same fixed bucket LedgerContext.tsx's superseded joint_deposit/
// joint_withdrawal used to create against — kept as the same constant
// (not re-exported from LedgerContext, to avoid a circular import; both
// sides independently derive the same deterministic id).
export const TRANSFER_JOINT_CATEGORY_ID = seededCategoryIdForIcon('joint')

/**
 * Which `location`/`ownerId` bucket a transfer's transactions/template
 * fall into — 'personal' whenever the primary person's own account is
 * either endpoint (the common case, and the ONLY thing that lets a
 * transfer flow through the existing personal-ledger machinery
 * unchanged), 'joint' when the joint account is an endpoint but personal
 * isn't, otherwise 'pot' — a direct Savings ↔ Pot ↔ Joint movement with
 * no personal leg at all (2026-09 UAT session: "Transfer form 'From'
 * location made editable" — previously unreachable from the UI, now is).
 * The single shared source of truth for this so buildTransferTransaction
 * (one-off) and LedgerContext.addRecurringTransfer (recurring) can't
 * drift into computing it two different ways.
 */
export function locationTypeForTransfer(from: TransferLocation | undefined, to: TransferLocation | undefined): 'personal' | 'joint' | 'pot' {
  if (from?.type === 'personal' || to?.type === 'personal') return 'personal'
  if (from?.type === 'joint' || to?.type === 'joint') return 'joint'
  return 'pot'
}

/** True when two TransferLocations refer to the exact same place (same type, and same id when one is required). */
export function locationsEqual(a: TransferLocation | undefined, b: TransferLocation | undefined): boolean {
  if (!a || !b) return false
  if (a.type !== b.type) return false
  if (a.type === 'savings') return a.savingsPotId === b.savingsPotId
  if (a.type === 'pot') return a.potId === b.potId
  return true // 'personal' and 'joint' need no id — there's only ever one of each
}

/** A short label for a TransferLocation, e.g. for the "Savings → Joint Account" row title. Needs the live entity lists to resolve a pot/savings pot's name. */
export function transferLocationLabel(
  location: TransferLocation | undefined,
  savingsPots: { id: string; name: string }[],
  pots: { id: string; name: string }[],
): string {
  if (!location) return 'Unknown'
  switch (location.type) {
    case 'personal':
      return 'Current Account'
    case 'joint':
      return 'Joint Account'
    case 'savings':
      return savingsPots.find((p) => p.id === location.savingsPotId)?.name ?? 'Savings'
    case 'pot':
      return pots.find((p) => p.id === location.potId)?.name ?? 'Pot'
  }
}

/** The same key scheme buildTransferLocationOptions below uses — lets a caller exclude/match a specific TransferLocation against an options list without re-deriving the scheme. */
export function transferLocationKey(location: TransferLocation): string {
  return location.type === 'pot' ? `pot:${location.potId}` : location.type === 'savings' ? `savings:${location.savingsPotId}` : location.type
}

/** One pickable location for a transfer's From/To picker — Current Account, the (singleton) joint account, a specific savings pot, or a specific pot. UAT Batch 4 (2026-09-04): moved here from Expenses.tsx so the same options/picker logic can be shared with Salary.tsx's own Wallet-page deposit/withdrawal/recurring-creation flows, not just the Transactions page's Transfer pill. */
export interface TransferLocationOption {
  key: string
  label: string
  location: TransferLocation
}

/**
 * Every pickable location, scoped to the given primary person's own
 * savings pots/pots (falling back to everyone's if they own none — same
 * rule the pre-rebuild SavingsTransactionForm applied).
 */
export function buildTransferLocationOptions(
  savingsPots: { id: string; name: string; personId: string }[],
  pots: { id: string; name: string; personId: string }[],
  hasJoint: boolean,
  primaryPersonId: string,
): TransferLocationOption[] {
  const ownSavingsPots = savingsPots.filter((p) => p.personId === primaryPersonId)
  const pickableSavingsPots = ownSavingsPots.length > 0 ? ownSavingsPots : savingsPots
  const ownPots = pots.filter((p) => p.personId === primaryPersonId)
  const pickablePots = ownPots.length > 0 ? ownPots : pots

  return [
    { key: 'personal', label: 'Current Account', location: { type: 'personal' as const } },
    ...(hasJoint ? [{ key: 'joint', label: 'Joint Account', location: { type: 'joint' as const } }] : []),
    ...pickableSavingsPots.map((p) => ({ key: `savings:${p.id}`, label: p.name, location: { type: 'savings' as const, savingsPotId: p.id } })),
    ...pickablePots.map((p) => ({ key: `pot:${p.id}`, label: p.name, location: { type: 'pot' as const, potId: p.id } })),
  ]
}

/**
 * Which built-in category a transfer's occurrences carry — reuses the
 * same seeded categories the superseded per-type deposit/withdrawal
 * transactions used to (Savings for savings/pot, Joint for joint),
 * rather than inventing a new one, so grouped-by-category views don't
 * gain a brand-new bucket for what's conceptually the same kind of
 * activity as before.
 */
export function categoryForTransfer(from: TransferLocation | undefined, to: TransferLocation | undefined): string {
  if (from?.type === 'joint' || to?.type === 'joint') return TRANSFER_JOINT_CATEGORY_ID
  return SAVINGS_CATEGORY_ID
}

/**
 * The signed effect a transfer transaction has on a SavingsPot's own
 * ledger — positive (inflow) if the pot is the destination, negative
 * (outflow) if it's the source, 0 if the pot isn't either endpoint at
 * all (shouldn't be called in that case, but kept total). Mirrors the
 * "type decides the sign on THIS ledger" pattern credit_card_spend/the
 * superseded savings_deposit already used, just resolved from
 * fromLocation/toLocation now that one type can mean either direction.
 */
export function savingsPotSignedAmount(t: Pick<Transaction, 'type' | 'amount' | 'fromLocation' | 'toLocation'>, savingsPotId: string): number {
  if (t.type !== 'transfer') return 0
  if (t.toLocation?.type === 'savings' && t.toLocation.savingsPotId === savingsPotId) return t.amount
  if (t.fromLocation?.type === 'savings' && t.fromLocation.savingsPotId === savingsPotId) return -t.amount
  return 0
}

/** Same as savingsPotSignedAmount above, for a Pot. */
export function potTransferSignedAmount(t: Pick<Transaction, 'type' | 'amount' | 'fromLocation' | 'toLocation'>, potId: string): number {
  if (t.type !== 'transfer') return 0
  if (t.toLocation?.type === 'pot' && t.toLocation.potId === potId) return t.amount
  if (t.fromLocation?.type === 'pot' && t.fromLocation.potId === potId) return -t.amount
  return 0
}

/** Same as savingsPotSignedAmount above, for the (singleton) joint account. */
export function jointTransferSignedAmount(t: Pick<Transaction, 'type' | 'amount' | 'fromLocation' | 'toLocation'>): number {
  if (t.type !== 'transfer') return 0
  if (t.toLocation?.type === 'joint') return t.amount
  if (t.fromLocation?.type === 'joint') return -t.amount
  return 0
}

/**
 * Builds a one-off transfer Transaction — the exact same shape
 * LedgerContext.logTransfer creates, pulled out as a pure function
 * (2026-09 Salary Sorter session) so both logTransfer AND
 * LedgerContext.saveSalarySort produce identical rows rather than two
 * hand-maintained copies of this logic drifting apart. `sourceType`/
 * `sourceId` are optional — omitted for an ordinary hand-logged/Transfer-
 * pill transfer, set to `'salary_sort'`/the owning SalarySort.id when
 * called from saveSalarySort (see SalarySort's own comment in
 * types/ledger.ts for what that link is for).
 */
export function buildTransferTransaction(
  from: TransferLocation,
  to: TransferLocation,
  amount: number,
  date: string,
  primaryPersonId: string,
  options?: { note?: string; followsPayday?: boolean; sourceType?: Transaction['sourceType']; sourceId?: string },
): Transaction {
  return {
    id: nanoid(8),
    date,
    amount,
    // 'out' when personal is the source (or isn't involved at all — see
    // locationTypeForTransfer), 'in' when it's the destination. Unused by
    // any non-personal ledger's own sign calc (each reads fromLocation/
    // toLocation directly — see potSignedAmount's own comment), so this
    // is purely the PERSONAL ledger's sign, meaningless when personal
    // isn't an endpoint at all.
    direction: from.type === 'personal' ? 'out' : 'in',
    categoryId: categoryForTransfer(from, to),
    paymentMethod: 'bank_transfer',
    status: date <= toIso(new Date()) ? 'cleared' : 'pending',
    type: 'transfer',
    location: locationTypeForTransfer(from, to),
    ownerId: primaryPersonId,
    savingsPotId: from.type === 'savings' ? from.savingsPotId : to.type === 'savings' ? to.savingsPotId : undefined,
    potId: from.type === 'pot' ? from.potId : to.type === 'pot' ? to.potId : undefined,
    fromLocation: from,
    toLocation: to,
    followsPayday: options?.followsPayday,
    sourceType: options?.sourceType,
    sourceId: options?.sourceId,
    note: options?.note,
  }
}

/** True if a transfer has the given pot as either endpoint. Pass fromLocation/toLocation (a Transaction) or transferFrom/transferTo (a RecurringTemplate) directly. */
export function transferTouchesPot(from: TransferLocation | undefined, to: TransferLocation | undefined, potId: string): boolean {
  return (from?.type === 'pot' && from.potId === potId) || (to?.type === 'pot' && to.potId === potId)
}

/** Same as transferTouchesPot above, for a savings pot. */
export function transferTouchesSavingsPot(from: TransferLocation | undefined, to: TransferLocation | undefined, savingsPotId: string): boolean {
  return (from?.type === 'savings' && from.savingsPotId === savingsPotId) || (to?.type === 'savings' && to.savingsPotId === savingsPotId)
}

/** Same as transferTouchesPot above, for the (singleton) joint account. */
export function transferTouchesJoint(from: TransferLocation | undefined, to: TransferLocation | undefined): boolean {
  return from?.type === 'joint' || to?.type === 'joint'
}
