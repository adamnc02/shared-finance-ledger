// The laptop Bills page's figures (src/lib/billSummary.ts).
//
// The trap: summing each bill's headline `amount` for "Bills this cycle".
// That figure is the bill's CURRENT amount, so a change dated mid-cycle, a
// paused payment or a weekly bill (several payments a cycle) all come out
// wrong while every ordinary monthly bill looks right. The summary must
// count the schedule engine's own occurrences, the rows the ledger shows.
// Each section below has a control computed the headline way, which fails.
//
// 1. Real backup: every figure equals a recount of the engine's occurrences.
// 2. A mid-cycle amount change counts the new amount from its date only.
// 3. A paused payment is not counted, and "next" moves past it.
// 4. A weekly bill counts every payment in the cycle.
// 5. Joint split: the payee's share and the other person's share, as the
//    joint ledger takes them; a paused bill counts nothing and has no next.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { billsCycleSummary } from '../src/lib/billSummary'
import { isBillTemplate } from '../src/lib/bills'
import { generateTransactionsForTemplate, payCycleForTemplate, applyTemplateAmountChange, setPausedTemplateOccurrences, templateOccurrencePreviews } from '../src/lib/schedule'
import { horizonCycles } from '../src/lib/projection'
import { toLocalIsoDate } from '../src/lib/date'
import type { AppDataV2, RecurringTemplate } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}
const round2 = (n: number) => Math.round(n * 100) / 100

const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-22-PROD.json', 'utf8'))
const data: AppDataV2 = migrateLedgerData(raw.data ?? raw)
const me = data.primaryPersonId
const other = data.people.find((p) => p.id !== me)?.id ?? 'someone-else'
// Pinned, so the checks never depend on the day they run.
const today = new Date(2026, 9, 1)
const cycle = horizonCycles(data, me, 'current_cycle', today)[0]
const bills = data.recurringTemplates.filter(isBillTemplate)
const pcFor = (b: RecurringTemplate) => payCycleForTemplate(b, data.payCycles, data.primaryPersonId)
const occurrencesOf = (b: RecurringTemplate) => (b.active ? generateTransactionsForTemplate(b, cycle.start, cycle.end, pcFor(b)) : [])

console.log(`\n── 1. Real backup, cycle ${toLocalIsoDate(cycle.start)} → ${toLocalIsoDate(cycle.end)}, ${bills.length} bills ──`)
{
  const s = billsCycleSummary(data, bills, me, cycle, today)
  const all = bills.flatMap(occurrencesOf)
  check('total = every occurrence the engine generates', s.total, round2(all.reduce((n, t) => n + t.amount, 0)))
  check('from pots = the pot-located occurrences', s.fromPots, round2(all.filter((t) => t.location === 'pot').reduce((n, t) => n + t.amount, 0)))
  check('the total is not zero (a sweep that finds nothing is suspect)', s.total > 0, true)
  check('every active bill has a next date', bills.filter((b) => b.active).every((b) => s.nextById.has(b.id)), true)
  check('every next date is on or after today', [...s.nextById.values()].every((d) => d >= toLocalIsoDate(today)), true)
}

// A plain monthly personal bill of mine, paid on a date inside the cycle.
const base: RecurringTemplate = {
  ...(bills.find((b) => b.location === 'personal' && b.ownerId === me && b.frequency === 'monthly' && b.active) ?? bills[0]),
  location: 'personal',
  ownerId: me,
  active: true,
}
const [firstDate] = occurrencesOf(base).map((t) => t.date)

console.log('\n── 2. A mid-cycle amount change ──')
{
  // The change starts at the cycle's first payment: the whole cycle pays the new amount.
  const changed = { ...base, ...applyTemplateAmountChange(base, base.amount + 10, firstDate) }
  const s = billsCycleSummary(data, [changed], me, cycle, today)
  check('the cycle counts the new amount', s.total, round2(base.amount + 10))
  // Starting AFTER the cycle: this cycle still pays the old amount, even though `amount` is already the new one.
  const later = { ...base, ...applyTemplateAmountChange(base, base.amount + 10, toLocalIsoDate(new Date(cycle.end.getFullYear(), cycle.end.getMonth() + 1, 1))) }
  check('a change dated after the cycle leaves this cycle on the old amount', billsCycleSummary(data, [later], me, cycle, today).total, round2(base.amount))
  check('CONTROL: the headline amount says otherwise', round2(later.amount), round2(base.amount + 10))
}

console.log('\n── 3. A paused payment ──')
{
  const window = templateOccurrencePreviews(base, today, 3, pcFor(base)).map((o) => o.originalDate)
  const paused = { ...base, ...setPausedTemplateOccurrences(base, window, [window[0]]) }
  const s = billsCycleSummary(data, [paused], me, { start: today, end: cycle.end }, today)
  const unpaused = billsCycleSummary(data, [base], me, { start: today, end: cycle.end }, today)
  check('the paused payment is not counted', round2(unpaused.total - s.total), round2(base.amount))
  check('next moves past the paused payment', s.nextById.get(base.id) !== unpaused.nextById.get(base.id), true)
}

console.log('\n── 4. A weekly bill ──')
{
  const weekly: RecurringTemplate = { ...base, frequency: 'weekly', anchorDate: toLocalIsoDate(cycle.start), amount: 5, amountHistory: undefined, amountEffectiveFrom: undefined, occurrenceOverrides: undefined }
  const n = occurrencesOf(weekly).length
  check('a weekly bill pays four or five times a cycle', n >= 4 && n <= 5, true)
  check('every one of them is counted', billsCycleSummary(data, [weekly], me, cycle, today).total, round2(5 * n))
  check('CONTROL: the headline amount counts one', weekly.amount, 5)
}

console.log('\n── 5. Shares ──')
{
  const joint: RecurringTemplate = { ...base, location: 'joint', ownerId: '', payee: me, payeeSharePercent: 70 }
  check('joint, I am the payee at 70%: my share is 70%', billsCycleSummary(data, [joint], me, cycle, today).yourShare, round2(base.amount * 0.7))
  check('joint, the other person is the payee at 70%: my share is 30%', billsCycleSummary(data, [{ ...joint, payee: other }], me, cycle, today).yourShare, round2(base.amount * 0.3))
  check('joint: the total is the whole bill', billsCycleSummary(data, [joint], me, cycle, today).total, round2(base.amount))
  check("someone else's personal bill: none of it is mine", billsCycleSummary(data, [{ ...base, ownerId: other }], me, cycle, today).yourShare, 0)
  const off = billsCycleSummary(data, [{ ...base, active: false }], me, cycle, today)
  check('a paused bill counts nothing', off.total, 0)
  check('a paused bill has no next date', off.nextById.has(base.id), false)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n✗ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
