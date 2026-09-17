import type { Loan, Transaction } from '../types/ledger'
import { toLocalIsoDate as toIso } from './date'
const todayIso = () => toIso(new Date())

// ── Pending-transaction sweep on delete (UI consistency review §3/§10
// Phase 1, confirmed 2026-09 session: "all pending transactions are
// deleted, with only cleared items retained as historic fact, and
// immutable" — refined by UAT Batch 4, see isSweepableOnGeneratorDelete
// below: a cleared item dated TODAY is the one exception) ─────────────
// Deleting a Loan/CreditCard/RecurringTemplate/Pension/SavingsPot never
// touched `transactions` at all before this — a CLEARED row correctly
// stayed untouched (it already happened, deleting its generator doesn't
// un-happen it), but a PENDING one silently stuck around too: still
// shown as due, permanently orphaned from a generator that no longer
// exists. This removes the pending ones, plus any cleared-today ones.
//
// Loans need their own matcher rather than reusing the generic one below
// — a loan's overpayments carry sourceId: <overpayment's own id>, not the
// loan's id, so a transaction can belong to a loan without sourceId
// equalling loan.id at all. Every OTHER loan-generated sourceType
// (loan/loan_recurring_overpayment/loan_settlement) does use loan.id
// directly — see ledgerLoans.ts's own transaction-building code for the
// convention this mirrors.
// UAT Batch 4 (2026-09-04, Adam-specified): a CLEARED transaction is
// normally immutable historic fact and survives every sweep below — but
// one dated TODAY is an exception, since "cleared" for a same-day item
// generally just means auto-clear already ran for it moments ago, not
// that it's settled history worth preserving. This is also the root fix
// for the stray-pot-balance bug (a recurring transfer's already-cleared
// TODAY occurrence surviving deletion of its generator). There's no
// creation-timestamp field anywhere on Transaction, so the transaction's
// own `date` is the only "today" signal available.
function isSweepableOnGeneratorDelete(t: Transaction, asOfIso: string): boolean {
  return t.status === 'pending' || t.date === asOfIso
}

export function sweepPendingForLoan(transactions: Transaction[], loan: Loan, asOfIso: string = todayIso()): Transaction[] {
  const overpaymentIds = new Set(loan.overpayments.map((o) => o.id))
  return transactions.filter((t) => {
    if (!isSweepableOnGeneratorDelete(t, asOfIso)) return true
    if (t.sourceType === 'loan' || t.sourceType === 'loan_recurring_overpayment' || t.sourceType === 'loan_settlement') return t.sourceId !== loan.id
    if (t.sourceType === 'loan_overpayment') return !overpaymentIds.has(t.sourceId ?? '')
    return true
  })
}

// CreditCard and SavingsPot both carry a direct FK field on Transaction
// (creditCardId/savingsPotId) covering every way a transaction can be
// tied to them — generated minimum payments (no sourceType at all),
// logged lump payments/deposits (sourceType set), and spend/withdrawals
// alike — so one plain filter on that field is correct and complete,
// unlike loans above.
export function sweepPendingForCreditCard(transactions: Transaction[], cardId: string, asOfIso: string = todayIso()): Transaction[] {
  return transactions.filter((t) => !isSweepableOnGeneratorDelete(t, asOfIso) || t.creditCardId !== cardId)
}
export function sweepPendingForSavingsPot(transactions: Transaction[], potId: string, asOfIso: string = todayIso()): Transaction[] {
  return transactions.filter((t) => !isSweepableOnGeneratorDelete(t, asOfIso) || t.savingsPotId !== potId)
}
// Pots backlog item (2026-09-03) — same "one direct FK field covers
// everything" reasoning as sweepPendingForSavingsPot/sweepPendingForCreditCard
// above: potId is stamped on pot_deposit/pot_withdrawal AND on any
// pot-funded bill_payment/loan_payment row (see RecurringTemplate.potId's
// comment), so one plain filter is correct and complete here too.
export function sweepPendingForPot(transactions: Transaction[], potId: string, asOfIso: string = todayIso()): Transaction[] {
  return transactions.filter((t) => !isSweepableOnGeneratorDelete(t, asOfIso) || t.potId !== potId)
}
// RecurringTemplate and Pension only ever get linked via sourceType/
// sourceId (no direct FK field on Transaction the way cards/pots have).
export function sweepPendingForSource(transactions: Transaction[], sourceType: NonNullable<Transaction['sourceType']>, sourceId: string, asOfIso: string = todayIso()): Transaction[] {
  return transactions.filter((t) => !isSweepableOnGeneratorDelete(t, asOfIso) || t.sourceType !== sourceType || t.sourceId !== sourceId)
}
