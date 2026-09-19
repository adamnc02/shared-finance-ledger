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

/**
 * 2026-09-19 (PROMPT-08c Part A, Adam-specified) — the one rule behind the
 * "· Adjusted" badge on every "Manage upcoming payments" row: a payment is
 * adjusted when its date OR its amount differs from what its schedule
 * alone would produce. The badge used to exist only on recurring
 * transactions, and only noticed a moved date.
 *
 * Compares the RESULT, not the presence of an override, so an override
 * that sets the amount back to the standing figure shows no badge. Amounts
 * are compared to the penny. Each schedule's own wrapper (schedule.ts,
 * pensionLedger.ts, potLedger.ts, savingsPotLedger.ts, ledgerLoans.ts)
 * works out `natural`, because each has its own rules for that (payday
 * resolution, working-day adjustment, amount history). A paused
 * (deleted) occurrence is never "adjusted"; it has its own badge.
 */
export function isOccurrenceAdjusted(actual: { date: string; amount: number }, natural: { date: string; amount: number }): boolean {
  return actual.date !== natural.date || Math.round(actual.amount * 100) !== Math.round(natural.amount * 100)
}
