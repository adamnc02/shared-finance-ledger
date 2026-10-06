// Changing the date of a schedule's FIRST payment moves its start to exactly that date.
//
// THE BUG: a new pot's two recurring transfers were due every 2 weeks from
// 21 Oct. Moving them to start on 7 Oct (two weeks earlier) saved and changed
// nothing: the pot looked frozen until 21 Oct.
//
// ROOT CAUSE: applyTemplateScheduleChange places the new anchor on "the slot of
// the new pattern nearest the chosen payment, after the last payment before
// it". That keeps every earlier payment where it was, which is the point once
// a schedule has started. Before its first payment there is nothing to keep,
// and the rule turned a date edit into a phase edit: every 2 weeks from 7 Oct
// is the same pattern as every 2 weeks from 21 Oct, whose slot nearest 21 Oct
// is 21 Oct. A not-yet-started monthly moved from 21 Oct to 7 Nov went to
// 7 Oct instead, the nearer of the two.
//
// THE RULE NOW: when the chosen payment is the first slot and the date was
// edited, the edited date is the new anchor. Every other case is unchanged —
// the control below moves a started bill and checks its earlier payment stays.
//
// WHAT FAILS AGAINST THE PRE-FIX CODE: the three "first payment" checks and the
// pot check. The started-bill control passes either way.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { applyTemplateScheduleChange, generateTransactionsForTemplate } from '../src/lib/schedule'
import { computePotProjection } from '../src/lib/potLedger'
import type { RecurringTemplate } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const FILE = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-10-06-mum.json'
const data = migrateLedgerData(JSON.parse(readFileSync(FILE, 'utf8')))
const payCycle = data.payCycles[0]
const today = '2026-10-06'
const tpl = (id: string) => data.recurringTemplates.find((t) => t.id === id)!
const dates = (t: RecurringTemplate, from: string, to: string) =>
  generateTransactionsForTemplate(t, new Date(`${from}T12:00:00`), new Date(`${to}T12:00:00`), payCycle).map((o) => o.date)
const move = (t: RecurringTemplate, anchorDate: string, fromPayment: string, frequency = t.frequency) => {
  const { patch, transactions } = applyTemplateScheduleChange(t, data.transactions, { frequency, intervalWeeks: t.intervalWeeks, anchorDate }, fromPayment, today, payCycle)
  return { moved: { ...t, ...patch } as RecurringTemplate, transactions }
}

console.log('\n── The real file: two transfers not yet started ──')
const intoSavings = tpl('I18M1eoL')
const intoPot = tpl('sIuz8HVL')
check('both start on 21 Oct, every 2 weeks', [intoSavings.anchorDate, intoPot.anchorDate, intoSavings.intervalWeeks], ['2026-10-21', '2026-10-21', 2])
check('neither has a stored payment', data.transactions.filter((t) => t.sourceId === intoSavings.id || t.sourceId === intoPot.id).length, 0)

const a = move(intoSavings, '2026-10-07', '2026-10-21').moved
check('Current Account → Savings moved to start 7 Oct', dates(a, '2026-10-01', '2026-11-30'), ['2026-10-07', '2026-10-21', '2026-11-04', '2026-11-18'])
const b = move(intoPot, '2026-10-07', '2026-10-21').moved
check('Savings → Jenn pot moved to start 7 Oct', dates(b, '2026-10-01', '2026-11-30'), ['2026-10-07', '2026-10-21', '2026-11-04', '2026-11-18'])

const pot = data.pots.find((p) => p.id === 'kdXqR6vL')!
const potRows = computePotProjection({ ...data, recurringTemplates: data.recurringTemplates.map((t) => (t.id === b.id ? b : t)) }, pot, 'current_cycle', new Date(2026, 9, 6, 12))
  .transactions.filter((t) => t.sourceId === b.id).map((t) => t.date)
check('…and the pot now receives the 7 Oct payment', potRows, ['2026-10-07'])

console.log('\n── A not-yet-started monthly moved LATER lands where it was put ──')
const monthly: RecurringTemplate = { ...intoSavings, id: 'M', frequency: 'monthly', intervalWeeks: undefined, anchorDate: '2026-10-21' }
check('21 Oct → 7 Nov starts 7 Nov (not 7 Oct)', move(monthly, '2026-11-07', '2026-10-21').moved.anchorDate, '2026-11-07')

console.log('\n── Control: a schedule that has started keeps its earlier payments ──')
const bill = tpl('27y8_g91') // Agria Pet Insurance - Pippa: monthly from 16 Sep, 16 Sep already cleared
check('the bill has a cleared 16 Sep payment', data.transactions.some((t) => t.sourceId === bill.id && t.date === '2026-09-16' && t.status === 'cleared'), true)
const { moved: billMoved, transactions: billRows } = move(bill, '2026-09-18', '2026-10-16')
check('moved to the 18th from the October payment: October becomes 18 Oct', dates(billMoved, '2026-10-01', '2026-11-30'), ['2026-10-18', '2026-11-18'])
check('…and September stays the one cleared 16 Sep row, never regenerated', billRows.filter((t) => t.sourceId === bill.id).map((t) => t.date), ['2026-09-16'])

console.log(failures === 0 ? '\nALL PASS' : `\nFAIL: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
