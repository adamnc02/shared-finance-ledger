// The first date whose transactions count against an account's opening
// balance.
//
// An opening balance is either the balance at the START of its date (account
// setup: a deposit made that day still has to be added) or at the END of it
// (Rebalance: the figure is read from the bank after the day's activity has
// already gone through, so adding that day's transactions again would count
// them twice). `openingExcludesDate` records which.
//
// 🚨 Every ledger floor goes through here. The tempting shortcut is to turn
// `t.date >= openingDate` into `>` everywhere, and that breaks account setup:
// a pot opened today with its first deposit today would lose the deposit.
//
// The savings-interest crediting walk deliberately does NOT use this: crediting
// dates are anchored on the opening date itself, and rebalancing does not move
// them.
import { parseLocalDate, toLocalIsoDate } from './date'

export interface OpeningPoint {
  /** ISO date. */
  date: string
  excludesDate?: boolean
}

/** ISO date of the first day whose transactions count against the opening balance. */
export function countsFromIso(opening: OpeningPoint): string {
  if (!opening.excludesDate) return opening.date
  const d = parseLocalDate(opening.date)
  return toLocalIsoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))
}

/** The same, as a local-midnight Date for the generators' range starts. */
export function countsFromDate(opening: OpeningPoint): Date {
  return parseLocalDate(countsFromIso(opening))
}

/** Pot / SavingsPot. */
export const potOpening = (p: { openingDate: string; openingExcludesDate?: boolean }): OpeningPoint => ({ date: p.openingDate, excludesDate: p.openingExcludesDate })
/** PayCycleConfig / JointAccountConfig. */
export const accountOpening = (a: { openingBalanceDate: string; openingExcludesDate?: boolean }): OpeningPoint => ({ date: a.openingBalanceDate, excludesDate: a.openingExcludesDate })

/**
 * Applies an edit to an account's opening fields. Only Rebalance means "end of
 * the day", and it says so by passing `openingExcludesDate: true`; any other
 * edit that actually CHANGES the opening balance or date (pot settings, the
 * pay-cycle form, joint setup) is account setup again, so the flag is cleared.
 * An edit that leaves both alone (a rename, a colour) keeps it.
 */
export function applyOpeningEdit<T extends { openingBalance: number; openingExcludesDate?: boolean }>(
  existing: T,
  updates: Partial<NoInfer<T>>,
  dateKey: 'openingDate' | 'openingBalanceDate',
): T {
  const next = { ...existing, ...updates }
  if (updates.openingExcludesDate !== undefined) return next
  const ex = existing as unknown as Record<string, unknown>
  const up = updates as unknown as Record<string, unknown>
  const balanceChanged = up.openingBalance !== undefined && up.openingBalance !== existing.openingBalance
  const dateChanged = up[dateKey] !== undefined && up[dateKey] !== ex[dateKey]
  if ((balanceChanged || dateChanged) && existing.openingExcludesDate) return { ...next, openingExcludesDate: false }
  return next
}
