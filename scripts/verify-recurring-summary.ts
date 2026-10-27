// The laptop Recurring tab's figures (src/lib/recurringSummary.ts).
//
// The trap is the Bills one again (verify-bill-summary.ts): totalling each
// template's headline `amount`. That is its CURRENT amount, so a change
// dated after the cycle, a paused payment and a weekly schedule all come out
// wrong while every plain monthly item looks right. The summary must count
// the engines' own occurrences. Controls compute the headline way.
//
// 1. Real backup: going out / coming in equal a recount of the engine's
//    occurrences, split by expense and income.
// 2. A change dated after the cycle leaves this cycle on the old amount.
// 3. A paused payment is not counted; a weekly one counts every payment.
// 4. A recurring savings-pot deposit counts in going out and in
//    "into savings and pots", and is the next payment when it is soonest;
//    none is counted before the pot opens, as the engine makes none.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { recurringCycleSummary } from '../src/lib/recurringSummary'
import { generateTransactionsForTemplate, payCycleForTemplate, applyTemplateAmountChange, setPausedTemplateOccurrences, templateOccurrencePreviews } from '../src/lib/schedule'
import { horizonCycles } from '../src/lib/projection'
import { toLocalIsoDate } from '../src/lib/date'
import type { AppDataV2, RecurringTemplate, SavingsPot } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}
const round2 = (n: number) => Math.round(n * 100) / 100

const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-10-06-mum.json', 'utf8'))
const data: AppDataV2 = migrateLedgerData(raw.data ?? raw)
const me = data.primaryPersonId
// Pinned, so the checks never depend on the day they run.
const today = new Date(2026, 9, 6)
const cycle = horizonCycles(data, me, 'current_cycle', today)[0]
const templates = data.recurringTemplates.filter((t) => t.kind === 'transaction')
const occ = (t: RecurringTemplate) => (t.active ? generateTransactionsForTemplate(t, cycle.start, cycle.end, payCycleForTemplate(t, data.payCycles, me)) : [])

console.log(`\n── 1. Real backup, cycle ${toLocalIsoDate(cycle.start)} → ${toLocalIsoDate(cycle.end)}, ${templates.length} recurring transactions ──`)
{
  const s = recurringCycleSummary(data, templates, [], [], cycle, today)
  const sum = (list: RecurringTemplate[]) => round2(list.flatMap(occ).reduce((n, t) => n + t.amount, 0))
  check('going out = every expense occurrence', s.goingOut, sum(templates.filter((t) => t.recurringTransactionType !== 'income')))
  check('coming in = every income occurrence', s.comingIn, sum(templates.filter((t) => t.recurringTransactionType === 'income')))
  check('the backup really has both (a sweep that finds nothing is suspect)', s.goingOut > 0 && s.comingIn > 0, true)
  check('every active template has a next date on or after today', templates.filter((t) => t.active).every((t) => (s.nextById.get(t.id) ?? '') >= toLocalIsoDate(today)), true)
  check('the next payment is the soonest of them', s.next?.date, [...s.nextById.values()].sort()[0])
}

const base: RecurringTemplate = { ...(templates.find((t) => t.recurringTransactionType !== 'income') ?? templates[0]), recurringTransactionType: 'expense', frequency: 'monthly', active: true, occurrenceOverrides: undefined, amountHistory: undefined, amountEffectiveFrom: undefined }

console.log('\n── 2. A change dated after the cycle ──')
{
  const later = { ...base, ...applyTemplateAmountChange(base, base.amount + 10, toLocalIsoDate(new Date(cycle.end.getFullYear(), cycle.end.getMonth() + 1, 1))) }
  check('this cycle stays on the old amount', recurringCycleSummary(data, [later], [], [], cycle, today).goingOut, round2(base.amount * occ(base).length))
  check('CONTROL: the headline amount is already the new one', round2(later.amount), round2(base.amount + 10))
}

console.log('\n── 3. Paused and weekly ──')
{
  const window = templateOccurrencePreviews(base, cycle.start, 3, payCycleForTemplate(base, data.payCycles, me)).map((o) => o.originalDate)
  const paused = { ...base, ...setPausedTemplateOccurrences(base, window, [window[0]]) }
  check('a paused payment is not counted', round2(recurringCycleSummary(data, [base], [], [], cycle, today).goingOut - recurringCycleSummary(data, [paused], [], [], cycle, today).goingOut), round2(base.amount))
  const weekly: RecurringTemplate = { ...base, frequency: 'weekly', anchorDate: toLocalIsoDate(cycle.start), amount: 5 }
  const n = occ(weekly).length
  check('a weekly payment lands four or five times', n >= 4 && n <= 5, true)
  check('…and every one is counted', recurringCycleSummary(data, [weekly], [], [], cycle, today).goingOut, round2(5 * n))
}

console.log('\n── 4. A recurring savings-pot deposit ──')
{
  const day = cycle.start.getDate() + 1 > 28 ? 1 : cycle.start.getDate() + 1
  const pot = { ...(data.savingsPots[0] ?? {}), id: 'sp-test', name: 'Test pot', openingDate: '2026-01-01', recurringDepositAmount: 40, recurringDepositDayOfMonth: day, recurringDepositStartDate: toLocalIsoDate(new Date(2026, 0, 1)) } as SavingsPot
  const s = recurringCycleSummary(data, [], [pot], [], cycle, today)
  check('one monthly deposit lands in the cycle', s.intoSavingsAndPots, 40)
  check('it counts in going out too', s.goingOut, 40)
  check('it has a next date', s.nextById.has('sp-test'), true)
  check('with nothing else listed it is the next payment', s.next?.name, 'Test pot')
  // The engine makes no deposit before a pot opens; nor may the summary count one.
  const lateOpen = { ...pot, openingDate: toLocalIsoDate(new Date(cycle.end.getFullYear(), cycle.end.getMonth(), cycle.end.getDate() - 1)) }
  check('a pot opening at the end of the cycle has no deposit counted in it', recurringCycleSummary(data, [], [lateOpen], [], cycle, today).intoSavingsAndPots, 0)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n✗ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
