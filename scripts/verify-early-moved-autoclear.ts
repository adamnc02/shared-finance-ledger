// PROMPT-08c Part B — an occurrence moved EARLIER must auto-clear on its
// moved date, not wait for its original one.
//
// Adam, 2026-09-19, on mum's backup: "after changing the date of the Tesco
// weekly shopping recurring expense transaction date from 19th sept to
// 18th … the ledger showed the correct date but the cleared flag seem to
// wait until the transactions original 19th September date."
//
// ROOT CAUSE. walkOccurrences (schedule.ts) walks ORIGINAL slot dates and
// stops at rangeEnd. autoClearDuePayments generates candidates over
// [rangeStart, asOf], so on the 18th the walk never reached the 19 Sep
// slot, and the override moving it to the 18th was never seen. The
// existing resolvedRangeLookback only widened the walk for follows-payday
// transfers.
//
// The same walk shape was in pensions, pots and savings pots, and a
// pension's non-working-day adjustment (Sunday the 1st paid Friday the
// 30th) hit it too. All four now share earlyMoveLookaheadDays
// (src/lib/occurrenceOverrides.ts).
//
// WHAT FAILS AGAINST THE PRE-FIX CODE (8): "asOf 18 Sep clears the moved
// occurrence", the two template-range checks, both pension "is generated"
// checks, the pension "next range does not generate it again" check, and
// the pot and savings-pot "is generated" checks. Everything else is a guard
// against a plausible WRONG fix: clearing too early, duplicating the row
// the next day, showing a moved payment in two adjacent windows, or
// disturbing a backup that has no early move.

import { readFileSync } from 'node:fs'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { generateTransactionsForTemplate } from '../src/lib/schedule'
import { generatePensionTransactions } from '../src/lib/pensionLedger'
import { generatePotDepositTransactions } from '../src/lib/potLedger'
import { generateSavingsDepositTransactions } from '../src/lib/savingsPotLedger'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import type { AppDataV2, Pension, Pot, RecurringTemplate, SavingsPot } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures'
function load(file: string): AppDataV2 {
  const raw = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'))
  return migrateLedgerData(raw.data ?? raw)
}
const day = (d: number) => new Date(2026, 8, d) // September 2026

const TEMPLATE_ID = 'QSF9e_W8' // mum's "Weekly shopping"
const shoppingRows = (data: AppDataV2) =>
  data.transactions
    .filter((t) => t.sourceType === 'recurring_template' && t.sourceId === TEMPLATE_ID && t.date >= '2026-09-13' && t.date <= '2026-09-26')
    .map((t) => ({ date: t.date, amount: t.amount, status: t.status }))
    .sort((a, b) => a.date.localeCompare(b.date))

console.log('\n── The reported case: mum 17 Sep backup, 19 Sep moved to 18 Sep (£100) ──')
const mum = load('finance-ledger-backup-2026-09-17-mum.json')
const template = mum.recurringTemplates.find((t) => t.id === TEMPLATE_ID)!
check('the override is really in the backup', template.occurrenceOverrides?.find((o) => o.originalDate === '2026-09-19'), { originalDate: '2026-09-19', amount: 100, date: '2026-09-18' })

const on17 = autoClearDuePayments(mum, day(17))
check('asOf 17 Sep: nothing for the 18th yet', shoppingRows(on17), [])

const on18 = autoClearDuePayments(on17, day(18))
check('asOf 18 Sep clears the moved occurrence, once, on the 18th, at £100', shoppingRows(on18), [{ date: '2026-09-18', amount: 100, status: 'cleared' }])

const on19 = autoClearDuePayments(on18, day(19))
check('asOf 19 Sep: still exactly one row for that slot (no duplicate on the original date)', shoppingRows(on19), [{ date: '2026-09-18', amount: 100, status: 'cleared' }])

const on26 = autoClearDuePayments(on19, day(26))
check('asOf 26 Sep: the next, unmoved week clears normally at the standing £150', shoppingRows(on26), [
  { date: '2026-09-18', amount: 100, status: 'cleared' },
  { date: '2026-09-26', amount: 150, status: 'cleared' },
])

console.log('\n── The generator itself, a range ending on the moved date ──')
check(
  'generateTransactionsForTemplate(5 Sep → 18 Sep) includes the 19th slot at its moved date',
  generateTransactionsForTemplate(template, day(5), day(18)).map((t) => [t.date, t.occurrenceOriginalDate, t.amount]),
  [
    ['2026-09-05', '2026-09-05', 75],
    ['2026-09-12', '2026-09-12', 80],
    ['2026-09-18', '2026-09-19', 100],
  ],
)
check('a range ending the day BEFORE the moved date does not include it', generateTransactionsForTemplate(template, day(5), day(17)).map((t) => t.date), ['2026-09-05', '2026-09-12'])

console.log('\n── A move LATER must not clear early ──')
const later: RecurringTemplate = { ...template, occurrenceOverrides: [{ originalDate: '2026-09-19', date: '2026-09-20', amount: 100 }] }
const laterData: AppDataV2 = { ...mum, recurringTemplates: mum.recurringTemplates.map((t) => (t.id === TEMPLATE_ID ? later : t)) }
const l19 = autoClearDuePayments(laterData, day(19))
check('asOf 19 Sep, moved to the 20th: nothing cleared for that slot', shoppingRows(l19), [])
const l20 = autoClearDuePayments(l19, day(20))
check('asOf 20 Sep: cleared once, on the 20th', shoppingRows(l20), [{ date: '2026-09-20', amount: 100, status: 'cleared' }])

console.log('\n── A move far earlier (a week) is still reached ──')
const weekEarly: RecurringTemplate = { ...template, occurrenceOverrides: [{ originalDate: '2026-09-26', date: '2026-09-19', amount: 60 }] }
check(
  'range ending 19 Sep includes both the 19th slot and the 26th slot moved onto the 19th',
  generateTransactionsForTemplate(weekEarly, day(19), day(19)).map((t) => [t.date, t.occurrenceOriginalDate, t.amount]),
  [
    ['2026-09-19', '2026-09-19', 150],
    ['2026-09-19', '2026-09-26', 60],
  ],
)

// The same walk shape existed in every other override-bearing generator.
// Neither backup has a pension or a recurring pot deposit, so these are
// built on the real pot records from Adam's backup with only the schedule
// fields added.
const adam = load('finance-ledger-backup-2026-09-15.json')
const oct = (d: number) => new Date(2026, 9, d)

console.log('\n── A move back ACROSS a range boundary appears in exactly one range ──')
// Two adjacent windows, the second starting on the 19th. The 19th slot moved
// to the 18th belongs to the first window only. Emitting it from both would
// double it in any per-cycle view.
const first = generateTransactionsForTemplate(template, day(12), day(18)).map((t) => t.date)
const second = generateTransactionsForTemplate(template, day(19), day(25)).map((t) => t.date)
check('window 12–18 Sep has it', first, ['2026-09-12', '2026-09-18'])
check('window 19–25 Sep does not', second, [])

console.log('\n── Pensions ──')
const pension: Pension = {
  id: 'P-TEST', personId: adam.primaryPersonId, name: 'Test Pension', amount: 500, frequency: 'monthly',
  anchorDate: '2026-09-01', active: true, adjustForNonWorkingDay: false, cycleStartFollowsPayday: false,
  occurrenceOverrides: [{ originalDate: '2026-10-01', date: '2026-09-28' }],
}
check(
  'hand-moved 1 Oct → 28 Sep is generated in a range ending 28 Sep',
  generatePensionTransactions(pension, day(1), day(28)).map((t) => t.date),
  ['2026-09-01', '2026-09-28'],
)
check('…and not in a range ending 27 Sep', generatePensionTransactions(pension, day(1), day(27)).map((t) => t.date), ['2026-09-01'])
// 1 Nov 2026 is a Sunday, so with the working-day box ticked it is paid Fri 30 Oct.
const adjusted: Pension = { ...pension, occurrenceOverrides: undefined, adjustForNonWorkingDay: true }
check('1 Nov (Sunday) paid Fri 30 Oct is generated in a range ending 30 Oct', generatePensionTransactions(adjusted, oct(2), oct(30)).map((t) => t.date), ['2026-10-30'])
check('…and the next range does not generate it again', generatePensionTransactions(adjusted, oct(31), new Date(2026, 10, 29)).map((t) => t.date), [])

console.log('\n── Pots and savings pots ──')
const deposits = { recurringDepositAmount: 50, recurringDepositDayOfMonth: 20, recurringDepositStartDate: '2026-09-20', recurringDepositOverrides: [{ originalDate: '2026-10-20', date: '2026-10-17' }] }
const pot: Pot = { ...adam.pots![0], ...deposits, active: true, openingDate: '2026-09-01' }
check('pot deposit moved 20 Oct → 17 Oct is generated in a range ending 17 Oct', generatePotDepositTransactions(pot, oct(1), oct(17)).map((t) => t.date), ['2026-10-17'])
check('…and not in a range ending 16 Oct', generatePotDepositTransactions(pot, oct(1), oct(16)).map((t) => t.date), [])
const savingsPot: SavingsPot = { ...adam.savingsPots![0], ...deposits, active: true, openingDate: '2026-09-01' }
check(
  'savings-pot deposit moved 20 Oct → 17 Oct is generated in a range ending 17 Oct',
  generateSavingsDepositTransactions(savingsPot, oct(1), oct(17)).filter((t) => t.type !== 'transfer').map((t) => t.date),
  ['2026-10-17'],
)
check('…and not in a range ending 16 Oct', generateSavingsDepositTransactions(savingsPot, oct(1), oct(16)).filter((t) => t.type !== 'transfer').map((t) => t.date), [])

console.log('\n── Control: a backup with no early move is untouched ──')
const mum15 = load('finance-ledger-backup-2026-09-15-mum.json')
const t15 = mum15.recurringTemplates.find((t) => t.id === TEMPLATE_ID)!
check('15 Sep backup has no 19 Sep override', t15.occurrenceOverrides?.some((o) => o.originalDate === '2026-09-19'), false)
check(
  'asOf 18 Sep on the 15 Sep backup clears nothing for the 19th slot',
  shoppingRows(autoClearDuePayments(mum15, day(18))),
  [],
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
