// Changing WHERE a bill/loan's regular payment is paid from (Pots
// backlog item, Adam-specified 2026-09-03). Confirmed as "an extension of
// location" (personal / joint / pot), not an additive field — see
// BillLocation's own comment in types/models.ts.
//
// This is deliberately NOT purely forward-looking the way an amount
// change is (contrast applyTemplateAmountChange in schedule.ts, which
// only ever affects future-generated occurrences). Adam's own spec: "the
// changes take effect from date... determine[s] which bill payments leave
// my personal ledger, and which remain (including cleared ones, the
// current balance on personal will need to update accordingly)." So a
// location change is a ONE-TIME REWRITE of every already-existing
// Transaction for this bill/loan dated on/after the chosen date —
// cleared ones included — not just a setting that future generation
// picks up. reassignTransactionsForLocationChange below is that rewrite;
// the LedgerContext action that calls it also updates the template/
// loan's own `location`/`potId` fields, which is what every FUTURE
// (not-yet-materialized) occurrence then generates against directly, per
// RecurringTemplate.potId's own comment on why no per-occurrence resolver
// is needed going forward.

import type { BillLocation } from '../types/models'
import type { AppDataV2, Transaction } from '../types/ledger'

/**
 * Rewrites every stored Transaction matching (sourceType, sourceId) and
 * dated on/after `effectiveFrom` to the new location/potId — cleared and
 * pending alike. Transactions dated BEFORE `effectiveFrom` are left
 * completely untouched, same as anything else in this app that predates
 * an effective-dated change.
 *
 * `sourceType`/`sourceId` scope this to exactly the ONE payment stream
 * being moved — for a Loan, callers must pass sourceType: 'loan' (the
 * regular scheduled payment only), never 'loan_recurring_overpayment' /
 * 'loan_overpayment' / 'loan_settlement', since those have their own,
 * independent funding source per Adam's spec ("if a loan is tagged to a
 * pot, that means ONLY the monthly payment is paid from the pot").
 */
export function reassignTransactionsForLocationChange(
  transactions: Transaction[],
  sourceType: NonNullable<Transaction['sourceType']>,
  sourceId: string,
  effectiveFrom: string,
  newLocation: BillLocation,
  newPotId: string | undefined,
): Transaction[] {
  return transactions.map((t) => {
    if (t.sourceType !== sourceType || t.sourceId !== sourceId) return t
    if (t.date < effectiveFrom) return t
    return { ...t, location: newLocation, potId: newLocation === 'pot' ? newPotId : undefined }
  })
}

/**
 * 2026-09-16 — the credit card equivalent of reassignTransactionsForLocationChange.
 * A stored minimum payment carries no sourceType/sourceId (see
 * buildCreditCardMinimumChargeRows), so it is matched by card id instead.
 * Logged/lump payments (sourceType set) keep their own funding source.
 */
export function reassignCreditCardPaymentsForLocationChange(
  transactions: Transaction[],
  creditCardId: string,
  effectiveFrom: string,
  newLocation: 'personal' | 'pot',
  newPotId: string | undefined,
): Transaction[] {
  return transactions.map((t) => {
    if (t.creditCardId !== creditCardId || t.type !== 'credit_card_payment' || t.sourceType) return t
    if (t.date < effectiveFrom) return t
    return { ...t, location: newLocation, potId: newLocation === 'pot' ? newPotId : undefined }
  })
}

/** LedgerContext.assignCreditCardLocation's whole update, pure so the verify script runs the same code. */
export function applyCreditCardLocationChange(data: AppDataV2, cardId: string, location: 'personal' | 'pot', effectiveFrom: string, potId?: string): AppDataV2 {
  const card = data.creditCards.find((c) => c.id === cardId)
  if (!card) return data
  const updated = {
    ...card,
    location,
    potId: location === 'pot' ? potId : undefined,
    locationEffectiveFrom: effectiveFrom,
    locationHistory: [
      ...(card.locationHistory ?? []),
      priorLocationEntry({ location: card.location ?? 'personal', potId: card.potId, locationEffectiveFrom: card.locationEffectiveFrom }, card.balanceAsOfDate),
    ],
  }
  return {
    ...data,
    creditCards: data.creditCards.map((c) => (c.id === cardId ? updated : c)),
    transactions: reassignCreditCardPaymentsForLocationChange(data.transactions, cardId, effectiveFrom, location, potId),
  }
}

/** Builds the locationHistory entry to append for the value being superseded — mirrors applyTemplateAmountChange's identical "prior value, falling back to the anchor date the first time this is ever changed" shape. */
export function priorLocationEntry(current: {
  location: BillLocation
  potId?: string
  locationEffectiveFrom?: string
}, fallbackDate: string): { effectiveFrom: string; location: BillLocation; potId?: string } {
  return {
    effectiveFrom: current.locationEffectiveFrom ?? fallbackDate,
    location: current.location,
    potId: current.potId,
  }
}
