import type { AppData, Person as LegacyPerson } from '../types/models'
import type { BillLocation } from '../types/models'
import type { AppDataV2, Pension, Person, RecurringTemplate, Transaction, TransferLocation } from '../types/ledger'
import { calculateNetSalary } from './tax'
import { combineBillsWithLoans } from './loans'
import { categoryForTransfer, locationTypeForTransfer } from './transferLedger'

export interface HouseholdFigures {
  totalIncome: number // every person's net pay, normalized to a monthly-equivalent
  totalOutgoings: number // every bill and loan's full cost — not per-person splits
  totalAvailable: number
}

/**
 * The whole household's combined numbers — every person's income together,
 * against every bill and loan at full value (not anyone's individual split
 * share). Used by the What-if page's household view toggle.
 */
export function calculateHouseholdFigures(data: AppData): HouseholdFigures {
  const allBills = combineBillsWithLoans(data.bills, data.loans)
  const totalIncome = round2(data.people.reduce((sum, p) => sum + calculateNetSalary(p.salary).netMonthly, 0))
  const totalOutgoings = round2(allBills.reduce((sum, b) => sum + b.cost, 0))
  const totalAvailable = round2(totalIncome - totalOutgoings)
  return { totalIncome, totalOutgoings, totalAvailable }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ── "Has any income configured" helpers ──────────────────────────────
// "A second person exists" and "a second income source is configured"
// are NOT the same thing — addPerson() creates a person with an empty
// salaryHistory and no pensions, so a household can have 2+ people with
// only one of them actually earning anything yet. Joint bills/loans
// split a real income between people, so anywhere that offers "Joint" as
// a choice (not just displays one that already exists) should gate on
// this, not on people.length alone.
//
// Broadened from "has a salary" to "has a salary OR an active pension"
// once Pension became a real income type (backlog item c) — a
// pension-only household still needs Joint to work, exactly as a
// salary-only one always has.

/** Ledger shape (types/ledger.ts) — current app data, most pages. */
export function hasSalaryConfigured(person: Pick<Person, 'salaryHistory'>): boolean {
  return person.salaryHistory.length > 0
}

export function peopleWithSalaryCount(people: Pick<Person, 'salaryHistory'>[]): number {
  return people.filter(hasSalaryConfigured).length
}

/** True if this person has a salary OR at least one active pension — the real "has any income" check for gating Joint. */
export function hasIncomeConfigured(person: Pick<Person, 'salaryHistory' | 'id'>, pensions: Pick<Pension, 'personId' | 'active'>[]): boolean {
  return hasSalaryConfigured(person) || pensions.some((p) => p.personId === person.id && p.active)
}

export function peopleWithIncomeCount(people: Pick<Person, 'salaryHistory' | 'id'>[], pensions: Pick<Pension, 'personId' | 'active'>[]): number {
  return people.filter((p) => hasIncomeConfigured(p, pensions)).length
}

/**
 * Legacy shape (types/models.ts) — used by Scenarios.tsx via legacyBridge's
 * adapter. The adapter always produces a `salary` object
 * (never omits it), defaulting to `{ grossAnnual: 0, ... }` when there's no
 * real snapshot (see legacyBridge.ts's buildLegacyAppData), so
 * `grossAnnual > 0` is the closest available proxy for "has a real salary
 * configured" in this shape.
 */
export function hasLegacySalaryConfigured(person: Pick<LegacyPerson, 'salary'>): boolean {
  return person.salary.grossAnnual > 0
}

export function legacyPeopleWithSalaryCount(people: Pick<LegacyPerson, 'salary'>[]): number {
  return people.filter(hasLegacySalaryConfigured).length
}

// ── Reconciling stale person references ─────────────────────────────────
// Bills/loans/cards reference a person via ownerId (personal items) or
// payee (the joint split target). Removing a person should always clean
// these up (see LedgerContext.removePerson), but this is also run as part
// of the regular load/migration pipeline (ledgerStorage.ts) so that data
// already saved from before that fix — or a backup restored from that
// state — self-heals rather than staying broken: a personal item with a
// dangling ownerId silently drops out of that owner's totals/summary
// rings everywhere (see lib/bills.ts's personalBillsTotal, Home.tsx's
// loan/card filtering), and a leftover location: 'joint' item with fewer
// than 2 people keeps joint-only UI (the What-if page's Household toggle,
// Home.tsx's Joint summary card) visible with nothing real behind it.

export function reconcilePersonReferences(data: AppDataV2): AppDataV2 {
  if (data.people.length === 0) return data // nothing to reconcile against

  const validIds = new Set(data.people.map((p) => p.id))
  const fallbackOwnerId = validIds.has(data.primaryPersonId) ? data.primaryPersonId : data.people[0].id
  const stillHasMultiplePeople = data.people.length >= 2

  function reassign<T extends { location: BillLocation; ownerId: string; payee: string; payeeSharePercent: number }>(item: T): T {
    if (item.location === 'joint') {
      if (!stillHasMultiplePeople) {
        return { ...item, location: 'personal', ownerId: fallbackOwnerId, payee: '', payeeSharePercent: 100 }
      }
      return validIds.has(item.payee) ? item : { ...item, payee: fallbackOwnerId }
    }
    return validIds.has(item.ownerId) ? item : { ...item, ownerId: fallbackOwnerId }
  }

  // Pots backlog item (2026-09-03) — same fallback-reassignment treatment
  // as pensions/savingsPots below, closing the same class of gap for the
  // third top-level personId-owned entity.
  const reconciledPots = (data.pots ?? []).map((p) => (validIds.has(p.personId) ? p : { ...p, personId: fallbackOwnerId }))
  const validPotIds = new Set(reconciledPots.map((p) => p.id))

  // A bill/loan's own `ownerId` is already reassigned by `reassign` above
  // regardless of location — but a 'pot'-located one also needs its
  // `potId` checked: if that pot no longer exists at all (not just
  // reassigned to a different owner above — genuinely deleted), fall back
  // to 'personal' rather than leaving a dangling potId that nothing
  // generates against. LedgerContext.removePot already does this
  // proactively for the normal in-app delete path; this is the same
  // self-healing backstop reconcilePersonReferences already gives every
  // other reference, for a backup/import that predates that.
  function fallBackDanglingPot<T extends { location: BillLocation; potId?: string }>(item: T): T {
    if (item.location === 'pot' && !validPotIds.has(item.potId ?? '')) {
      return { ...item, location: 'personal', potId: undefined }
    }
    return item
  }

  // ── PROMPT-05 (2026-09-16) — references nothing used to clean up. The
  // delete guard (lib/deleteReassign.ts) stops the UI creating these; this
  // is the backstop for older data and imported backups.
  const validSavingsPotIds = new Set((data.savingsPots ?? []).map((p) => p.id))
  function endpointExists(location: TransferLocation | undefined): boolean {
    if (location?.type === 'pot') return validPotIds.has(location.potId ?? '')
    if (location?.type === 'savings') return validSavingsPotIds.has(location.savingsPotId ?? '')
    return true
  }

  // A recurring transfer into or out of a pot/savings pot that no longer
  // exists kept materialising real money movements against Personal — £50
  // a month into nothing, in the PROMPT-05 repro. The dead endpoint becomes
  // Personal and the template is switched OFF: silently redirecting money
  // somewhere the user never chose would be worse than stopping it, and
  // deleting the template would be a cascade.
  function fallBackDanglingTransfer(t: RecurringTemplate): RecurringTemplate {
    if (t.kind !== 'transfer' || (endpointExists(t.transferFrom) && endpointExists(t.transferTo))) return t
    const from: TransferLocation = endpointExists(t.transferFrom) && t.transferFrom ? t.transferFrom : { type: 'personal' }
    const to: TransferLocation = endpointExists(t.transferTo) && t.transferTo ? t.transferTo : { type: 'personal' }
    return { ...t, transferFrom: from, transferTo: to, location: locationTypeForTransfer(from, to), categoryId: categoryForTransfer(from, to), active: false }
  }

  // A PENDING row pointing at a missing pot/savings pot hasn't happened and
  // now never will — same rule as the sweep on delete. Checks both transfer
  // endpoints, not just the flat potId/savingsPotId (APP-KNOWLEDGE §1.4).
  // Cleared rows are history and are never touched.
  function pendingRowIsDangling(t: Transaction): boolean {
    if (t.status !== 'pending') return false
    if (t.potId && !validPotIds.has(t.potId)) return true
    if (t.savingsPotId && !validSavingsPotIds.has(t.savingsPotId)) return true
    return !endpointExists(t.fromLocation) || !endpointExists(t.toLocation)
  }
  const transactions = data.transactions.some(pendingRowIsDangling) ? data.transactions.filter((t) => !pendingRowIsDangling(t)) : data.transactions
  const validTransactionIds = new Set(transactions.map((t) => t.id))

  return {
    ...data,
    primaryPersonId: fallbackOwnerId,
    transactions,
    recurringTemplates: data.recurringTemplates.map(reassign).map(fallBackDanglingPot).map(fallBackDanglingTransfer),
    loans: data.loans
      .map(reassign)
      .map(fallBackDanglingPot)
      .map((l) =>
        // A recurring overpayment funded from a missing pot goes back to
        // following the loan — the field's own absent-default, same as
        // removePot does.
        l.recurringOverpayment?.location === 'pot' && !validPotIds.has(l.recurringOverpayment.potId ?? '')
          ? { ...l, recurringOverpayment: { ...l.recurringOverpayment, location: undefined, potId: undefined } }
          : l,
      ),
    // A Salary Sort target whose transaction is gone (swept with a deleted
    // pot) is dropped, and an emptied sort with it — the same rule
    // removeTransaction applies.
    salarySorts: (data.salarySorts ?? [])
      .map((s) => (s.targets.every((tg) => validTransactionIds.has(tg.transactionId)) ? s : { ...s, targets: s.targets.filter((tg) => validTransactionIds.has(tg.transactionId)) }))
      .filter((s) => s.targets.length > 0),
    payCycles: data.payCycles.map((pc) =>
      pc.followsIncomeSource?.type === 'pension' && !(data.pensions ?? []).some((p) => p.id === (pc.followsIncomeSource as { pensionId: string }).pensionId)
        ? { ...pc, followsIncomeSource: { type: 'salary' } }
        : pc,
    ),
    creditCards: data.creditCards
      .map((c) => (validIds.has(c.ownerId) ? c : { ...c, ownerId: fallbackOwnerId }))
      // 2026-09-16 — a minimum payment paid from a pot that no longer exists goes back to Personal.
      .map((c) => (c.location === 'pot' && !validPotIds.has(c.potId ?? '') ? { ...c, location: 'personal' as const, potId: undefined } : c)),
    // Closes the gap flagged in the UI consistency review (§3/§5 of the
    // data-model review) — these two were the only top-level,
    // personId-owned entities NOT covered here, silently left pointing at
    // a person who no longer exists. Same fallback-reassignment instinct
    // as everything above, not a cascade delete: a pension/pot someone
    // else can see and reassign again later beats one that's vanished
    // from every list because nothing matches its personId any more.
    pensions: (data.pensions ?? []).map((p) => (validIds.has(p.personId) ? p : { ...p, personId: fallbackOwnerId })),
    savingsPots: (data.savingsPots ?? []).map((p) => {
      const owned = validIds.has(p.personId) ? p : { ...p, personId: fallbackOwnerId }
      return endpointExists(owned.interestDestination) ? owned : { ...owned, interestDestination: undefined }
    }),
    pots: reconciledPots,
  }
}
