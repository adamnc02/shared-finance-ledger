// Money paid in from OUTSIDE the household straight onto a savings pot or a
// credit card — a refund to a card, a relative paying a card down, a gift into
// savings. One-off: an `income` row with `location: 'savings'` + savingsPotId,
// or `location: 'credit_card'` + creditCardId. Recurring: a `kind:
// 'transaction'` income template with the same location and id.
//
// Nothing of the household's is debited, which is why the location is never
// 'personal': every `location === 'personal'` filter keeps these rows off the
// current account by default, and only the savings-pot and card engines opt in
// through the predicates below.
//
// 🚨 On a card this is an OVERPAYMENT, not the minimum payment. It reduces the
// balance from its date — through cardBalanceAsOf once dated on or before the
// day, and as a pending lump payment inside the minimum simulation before
// that — so every later minimum falls. It must never be a `credit_card_payment`
// with no sourceType: that shape is what the engine reads as "the minimum was
// paid" (APP-KNOWLEDGE §1.15), and it would also sit on the current account.
import type { AppDataV2, RecurringTemplate, Transaction } from '../types/ledger'
import { generateTransactionsForTemplate } from './schedule'
import { parseLocalDate } from './date'

/** The display rows' `sourceType` for money paid in from outside (never stored). */
export const OUTSIDE_INCOME_SOURCE = 'outside_income'

/** A recurring income template paid in from outside to a savings pot or card. */
export function isOutsideIncomeTemplate(t: RecurringTemplate): boolean {
  return t.kind === 'transaction' && t.active && t.recurringTransactionType === 'income' && (t.location === 'savings' || t.location === 'credit_card')
}

export function isOutsideIncomeToSavings(t: Pick<Transaction, 'type' | 'location' | 'savingsPotId'>, savingsPotId: string): boolean {
  return t.type === 'income' && t.location === 'savings' && t.savingsPotId === savingsPotId
}

export function isOutsideIncomeToCard(t: Pick<Transaction, 'type' | 'location' | 'creditCardId'>, creditCardId: string): boolean {
  return t.type === 'income' && t.location === 'credit_card' && t.creditCardId === creditCardId
}

/**
 * `transactions` plus every not-yet-stored occurrence of a recurring income
 * paid onto a card, up to `rangeEnd`, so the card's minimum simulation
 * (generateMinimumPaymentTransactions) sees future overpayments the way it
 * sees a future lump payment. Without this, a recurring payment onto a card
 * only starts lowering the minimum once each occurrence has cleared.
 * A stored row wins over its generated twin (same template + date).
 */
export function withCardCredits(transactions: Transaction[], templates: RecurringTemplate[], rangeEnd: Date): Transaction[] {
  const cardTemplates = templates.filter((t) => isOutsideIncomeTemplate(t) && t.location === 'credit_card')
  if (cardTemplates.length === 0) return transactions
  const stored = new Set(transactions.filter((t) => t.sourceType === 'recurring_template').map((t) => `${t.sourceId}:${t.date}`))
  const generated = cardTemplates.flatMap((tpl) =>
    generateTransactionsForTemplate(tpl, parseLocalDate(tpl.anchorDate), rangeEnd)
      .filter((occ) => !stored.has(`${tpl.id}:${occ.date}`))
      .map((occ) => ({ ...occ, id: `generated:card-credit:${tpl.id}:${occ.date}` })),
  )
  return [...transactions, ...generated]
}

/** What every card engine call should be given: the stored rows plus future recurring payments onto cards, far enough ahead for any horizon the app shows. */
export function cardActivity(data: Pick<AppDataV2, 'transactions' | 'recurringTemplates'>, rangeEnd?: Date): Transaction[] {
  const now = new Date()
  return withCardCredits(data.transactions, data.recurringTemplates, rangeEnd ?? new Date(now.getFullYear() + 3, now.getMonth(), now.getDate()))
}
