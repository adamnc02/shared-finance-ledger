// Shared rules for per-occurrence overrides (`RecurringOccurrenceOverride`),
// used by every schedule that carries them: recurring templates
// (schedule.ts), pensions (pensionLedger.ts), pots (potLedger.ts) and
// savings pots (savingsPotLedger.ts).

import { differenceInCalendarDays } from 'date-fns'
import { parseLocalDate } from './date'
import type { RecurringOccurrenceOverride } from '../types/ledger'

/**
 * 2026-09-19 (PROMPT-08c Part B, Adam-reported) — how many days past a
 * range's end a schedule walk must go so an occurrence moved EARLIER into
 * the range is still found.
 *
 * Every walk here steps through ORIGINAL slot dates and stops at rangeEnd,
 * applying an override's moved date afterwards. A slot after rangeEnd whose
 * override moves it inside the range was therefore never seen: mum's
 * "Weekly shopping" moved from 19 Sep to 18 Sep did not auto-clear until
 * the 19th, because on the 18th autoClear's walk never reached the 19 Sep
 * slot. The answer is the furthest any override moves a slot earlier, so a
 * schedule with no early move walks exactly as it always did (0).
 *
 * Slots walked only because of this lookahead must be range-checked by
 * their MOVED date, or a slot moved from inside the range to beyond it (or
 * never moved at all) would leak in.
 */
export function earlyMoveLookaheadDays(overrides: RecurringOccurrenceOverride[] | undefined): number {
  let days = 0
  for (const o of overrides ?? []) {
    if (o.deleted || !o.date || o.date >= o.originalDate) continue
    days = Math.max(days, differenceInCalendarDays(parseLocalDate(o.originalDate), parseLocalDate(o.date)))
  }
  return days
}
