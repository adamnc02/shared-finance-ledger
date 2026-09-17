// Schedule changes from a chosen payment, for the generators that are not
// RecurringTemplates (pensions, loans, recurring overpayments, credit card
// minimum payments, salary). 2026-09-16, Adam: "I need to know that this
// bug is eradicated everywhere."
//
// The bug: every generator re-creates occurrences on the fly and dedupes
// them against stored payments by DATE. Edit the date a schedule falls on
// and every stored payment's date stops matching, so the whole history is
// materialised again on the new day. Confirmed before fixing for a loan's
// first payment date, a recurring overpayment's start date, a card's
// payment day, the salary payday, and a pension's date/frequency.
//
// The fix mirrors lib/schedule.ts applyTemplateScheduleChange, which
// re-anchors a template. These generators can't simply move their anchor
// (a loan's start date drives its amortisation; a card's payment day is a
// day number), so instead:
//  - the payment the user picks, and every stored payment after it, are
//    re-dated one-to-one onto the new schedule (k-th old -> k-th new);
//  - the entity records `scheduleFrom`, the first new-schedule date, and
//    its generator emits nothing before it. Payments before it are stored
//    history, never re-created;
//  - date-keyed data after the picked payment (per-payment overrides,
//    pauses, amount changes) moves with its payment.
// Cleared payments before the picked one are never touched.

import type { Transaction } from '../types/ledger'

export interface ScheduleOccurrence {
  /** What per-payment data is keyed on (a pension's unadjusted originalDate; otherwise the date). */
  key: string
  /** The date a stored payment carries. */
  date: string
}

export interface ReschedulePlan {
  /** The picked payment's old occurrence. */
  from: ScheduleOccurrence
  /** Its new occurrence — the first date the new schedule generates. */
  firstNew: ScheduleOccurrence
  dateMap: Map<string, string>
  keyMap: Map<string, string>
  /** An effective-from boundary on/after the picked payment moves to the new date of the first payment on/after it. */
  boundary: (iso: string) => string
}

/**
 * Pairs the old schedule with the new one from the picked occurrence.
 * `oldOccurrences` must already respect any earlier scheduleFrom;
 * `newOccurrences` must ignore it. Both need to reach past the last date
 * anything is keyed on. The first new occurrence is the one nearest the
 * picked payment that is strictly after the payment before it (ties go to
 * the later date), so no period is paid twice and none is skipped.
 */
export function planReschedule(oldOccurrences: ScheduleOccurrence[], newOccurrences: ScheduleOccurrence[], pickedKey: string): ReschedulePlan | null {
  const oldSorted = [...oldOccurrences].sort((a, b) => a.date.localeCompare(b.date))
  const newSorted = [...newOccurrences].sort((a, b) => a.date.localeCompare(b.date))
  let fromIndex = oldSorted.findIndex((o) => o.key === pickedKey)
  if (fromIndex < 0) fromIndex = oldSorted.findIndex((o) => o.key >= pickedKey)
  if (fromIndex < 0) return null
  const from = oldSorted[fromIndex]
  const previousDate = fromIndex > 0 ? oldSorted[fromIndex - 1].date : null

  const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000
  let firstNewIndex = -1
  for (let i = 0; i < newSorted.length; i++) {
    if (previousDate !== null && newSorted[i].date <= previousDate) continue
    if (firstNewIndex < 0) {
      firstNewIndex = i
      continue
    }
    const best = Math.abs(dayNumber(newSorted[firstNewIndex].date) - dayNumber(from.date))
    const here = Math.abs(dayNumber(newSorted[i].date) - dayNumber(from.date))
    if (here <= best) firstNewIndex = i // `<=`: a tie goes to the later date
    else break // sorted, so distances only grow from here
  }
  if (firstNewIndex < 0) return null

  const dateMap = new Map<string, string>()
  const keyMap = new Map<string, string>()
  const mappedOld: ScheduleOccurrence[] = []
  for (let k = 0; fromIndex + k < oldSorted.length && firstNewIndex + k < newSorted.length; k++) {
    const oldOcc = oldSorted[fromIndex + k]
    const newOcc = newSorted[firstNewIndex + k]
    dateMap.set(oldOcc.date, newOcc.date)
    keyMap.set(oldOcc.key, newOcc.key)
    mappedOld.push(oldOcc)
  }

  const boundary = (iso: string) => {
    if (iso < from.key) return iso
    const firstOnOrAfter = mappedOld.find((o) => o.key >= iso)
    return (firstOnOrAfter && keyMap.get(firstOnOrAfter.key)) ?? iso
  }

  return { from, firstNew: newSorted[firstNewIndex], dateMap, keyMap, boundary }
}

/**
 * Re-dates the stored payments that belong to the rescheduled stream. A
 * payment moved into the future can't still be cleared (APP-KNOWLEDGE
 * §1.5b), so it goes back to pending; auto-clear settles it on the day.
 */
export function redateStoredPayments(transactions: Transaction[], belongs: (t: Transaction) => boolean, plan: ReschedulePlan, asOfIso: string): Transaction[] {
  return transactions.map((t) => {
    if (!belongs(t)) return t
    const date = plan.dateMap.get(t.date)
    if (!date || date === t.date) return t
    return { ...t, date, status: t.status === 'cleared' && date > asOfIso ? 'pending' : t.status }
  })
}

/** Most recent past occurrence and the next 3 — the "which payment" picker, same shape as recentAndUpcomingOccurrences. */
export function recentAndUpcomingFrom(dates: string[], asOfIso: string): { date: string; isPast: boolean }[] {
  const sorted = [...new Set(dates)].sort()
  const past = sorted.filter((d) => d <= asOfIso)
  const upcoming = sorted.filter((d) => d > asOfIso)
  return [...(past.length > 0 ? [{ date: past[past.length - 1], isPast: true }] : []), ...upcoming.slice(0, 3).map((date) => ({ date, isPast: false }))]
}
