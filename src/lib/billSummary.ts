// The laptop Bills page's figures (lib/laptop.ts): what the listed bills
// cost this pay cycle, the person's own share of that, how much of it pots
// pay, and each bill's next payment date.
//
// Every figure is built from the schedule engine's own occurrences
// (generateTransactionsForTemplate, templateOccurrencePreviews) — the same
// rows the ledger and "Manage upcoming payments" show — never from a bill's
// headline `amount`. A bill whose amount changes mid-cycle, a paused
// occurrence or a moved date is therefore counted exactly as the ledger
// counts it. scripts/verify-bill-summary.ts holds that.

import type { AppDataV2, RecurringTemplate } from '../types/ledger'
import { generateTransactionsForTemplate, payCycleForTemplate, templateOccurrencePreviews } from './schedule'
import { personShareOfJointAmount } from './jointLedger'
import { toLocalIsoDate } from './date'

const round2 = (n: number) => Math.round(n * 100) / 100

export interface BillsCycleSummary {
  /** Every listed bill's payments inside the cycle. */
  total: number
  /** The person's part of `total`: their own personal and pot bills in full, their split of each joint bill. */
  yourShare: number
  /** The part of `total` paid from a pot. */
  fromPots: number
  /** Each bill's next payment on or after today, by template id; absent for a paused bill or one with none left. */
  nextById: Map<string, string>
}

export function billsCycleSummary(data: AppDataV2, bills: RecurringTemplate[], personId: string, cycle: { start: Date; end: Date }, today: Date): BillsCycleSummary {
  let total = 0
  let yourShare = 0
  let fromPots = 0
  const nextById = new Map<string, string>()
  const todayIso = toLocalIsoDate(today)

  for (const bill of bills) {
    if (!bill.active) continue
    const payCycle = payCycleForTemplate(bill, data.payCycles, data.primaryPersonId)
    for (const t of generateTransactionsForTemplate(bill, cycle.start, cycle.end, payCycle)) {
      total += t.amount
      if (t.location === 'pot') fromPots += t.amount
      // The joint split exactly as the joint ledger takes it (jointLedger.ts): from the bill's own payee and share.
      if (t.location === 'joint') yourShare += personShareOfJointAmount(t.amount, bill.payee, bill.payeeSharePercent, personId)
      else if (t.ownerId === personId) yourShare += t.amount
    }
    const next = templateOccurrencePreviews(bill, today, 3, payCycle).find((o) => o.date >= todayIso)
    if (next) nextById.set(bill.id, next.date)
  }

  return { total: round2(total), yourShare: round2(yourShare), fromPots: round2(fromPots), nextById }
}
