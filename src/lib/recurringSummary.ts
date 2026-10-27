// The laptop Recurring tab's figures (lib/laptop.ts): what recurring
// transactions take out and bring in this pay cycle, what recurring
// deposits move into savings pots and pots, the next payment of all, and
// each item's next date.
//
// Every figure is built from the engines' own occurrences — the same rows
// the ledger shows: generateTransactionsForTemplate for a recurring
// transaction, the savings pot's and pot's own deposit walks for a
// deposit. Never a template's headline `amount`, so a mid-cycle amount
// change, a paused payment or a weekly schedule count exactly as the ledger
// counts them (scripts/verify-recurring-summary.ts).

import type { AppDataV2, Pot, RecurringTemplate, SavingsPot } from '../types/ledger'
import { generateTransactionsForTemplate, payCycleForTemplate, templateOccurrencePreviews } from './schedule'
import { depositOccurrencePreviews } from './savingsPotLedger'
import { potDepositOccurrencePreviews } from './potLedger'
import { toLocalIsoDate } from './date'

const round2 = (n: number) => Math.round(n * 100) / 100

/** How many deposit occurrences to walk to cover one pay cycle: a weekly deposit lands at most five times in a month. */
const DEPOSITS_PER_CYCLE = 6

export interface RecurringCycleSummary {
  /** Recurring expenses plus recurring deposits inside the cycle. */
  goingOut: number
  /** The part of `goingOut` that is deposits into savings pots and pots. */
  intoSavingsAndPots: number
  /** Recurring income inside the cycle. */
  comingIn: number
  /** The soonest payment on or after today, of everything listed. */
  next: { name: string; date: string; amount: number } | null
  /** Each item's next payment on or after today: template id, savings pot id or pot id. */
  nextById: Map<string, string>
}

export function recurringCycleSummary(
  data: AppDataV2,
  templates: RecurringTemplate[],
  savingsPots: SavingsPot[],
  pots: Pot[],
  cycle: { start: Date; end: Date },
  today: Date,
): RecurringCycleSummary {
  let expenses = 0
  let comingIn = 0
  let deposits = 0
  let next: RecurringCycleSummary['next'] = null
  const nextById = new Map<string, string>()
  const todayIso = toLocalIsoDate(today)
  const startIso = toLocalIsoDate(cycle.start)
  const endIso = toLocalIsoDate(cycle.end)
  const consider = (id: string, name: string, upcoming: { date: string; amount: number } | undefined) => {
    if (!upcoming) return
    nextById.set(id, upcoming.date)
    if (!next || upcoming.date < next.date) next = { name, date: upcoming.date, amount: upcoming.amount }
  }

  for (const t of templates) {
    if (!t.active) continue
    const payCycle = payCycleForTemplate(t, data.payCycles, data.primaryPersonId)
    for (const occ of generateTransactionsForTemplate(t, cycle.start, cycle.end, payCycle)) {
      if (t.recurringTransactionType === 'income') comingIn += occ.amount
      else expenses += occ.amount
    }
    consider(t.id, t.name, templateOccurrencePreviews(t, today, 3, payCycle).find((o) => o.date >= todayIso))
  }
  for (const pot of savingsPots) {
    if (!pot.recurringDepositAmount) continue
    for (const d of depositOccurrencePreviews(pot, cycle.start, DEPOSITS_PER_CYCLE)) if (d.date >= startIso && d.date <= endIso) deposits += d.amount
    consider(pot.id, pot.name, depositOccurrencePreviews(pot, today, 3).find((d) => d.date >= todayIso))
  }
  for (const pot of pots) {
    if (!pot.recurringDepositAmount) continue
    for (const d of potDepositOccurrencePreviews(pot, cycle.start, DEPOSITS_PER_CYCLE)) if (d.date >= startIso && d.date <= endIso) deposits += d.amount
    consider(pot.id, pot.name, potDepositOccurrencePreviews(pot, today, 3).find((d) => d.date >= todayIso))
  }

  return { goingOut: round2(expenses + deposits), intoSavingsAndPots: round2(deposits), comingIn: round2(comingIn), next, nextById }
}
