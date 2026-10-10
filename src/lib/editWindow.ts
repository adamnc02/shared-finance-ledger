// The edit window: how long a payment that has already cleared stays open
// to correction.
//
// A payment dated in the last EDIT_WINDOW_DAYS days, today included, is
// still "recent": it stays in view beside the pending items rather than
// folding into its month, it is listed in "Manage upcoming payments", and
// pausing it or deleting its generator removes it from the ledger. A
// payment dated on 9 Oct is open 9–13 Oct and folds on 14 Oct.
//
// Older than that, a cleared payment is historical fact and is never
// rewritten or deleted (APP-KNOWLEDGE §1.1). One rule, shared by every
// surface, so the fold, the list and the ledger cannot disagree about
// which payments can still be changed.
//
// The trap: a pause or a generator delete that removes a cleared row with
// no lower bound rewrites history, and Coin Jar balances and loan
// progress built on it move with no visible cause. Always ask this module,
// never compare against "today" directly.

import { addDays } from 'date-fns'
import { parseLocalDate, toLocalIsoDate } from './date'

export const EDIT_WINDOW_DAYS = 5

/** The last date that has LEFT the window as of `asOf`: anything dated on or before it is settled history. */
export function editWindowClosedOnOrBefore(asOf: Date | string = new Date()): string {
  const asOfDate = typeof asOf === 'string' ? parseLocalDate(asOf) : asOf
  return toLocalIsoDate(addDays(asOfDate, -EDIT_WINDOW_DAYS))
}

/** Whether a payment dated `dateIso` can still be corrected as of `asOf`. Future dates are inside the window. */
export function isInEditWindow(dateIso: string, asOf: Date | string = new Date()): boolean {
  return dateIso > editWindowClosedOnOrBefore(asOf)
}
