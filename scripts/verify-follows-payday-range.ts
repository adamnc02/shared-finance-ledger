// 2026-09-17 (Adam-reported) — a follows-payday / follows-cycle-start
// recurring transfer is range-checked by the date it is actually PAID, not
// its natural slot.
//
// Adam's Bills £61 / Joint £800 / Savings £1,000 deposits are anchored on
// 12 Sep and follow payday (last working day, 30 Sep). On 17 Sep:
//  - "Manage upcoming payments" showed 30 Sep, 30 Oct, 30 Nov (right);
//  - the Home personal ledger had the three 30 Sep rows (right);
//  - the transfer card header said "Next 30 Oct" (wrong);
//  - the Savings pot ledger (pot opened 12 Sep) had no 30 Sep deposit (wrong).
//
// Root cause: schedule.ts walkOccurrences/scheduledTemplateDates kept an
// occurrence only if its SLOT was inside [rangeStart, rangeEnd]. Slot
// 12 Sep < 17 Sep, so every "from today" view dropped the payment due
// 30 Sep. Views whose range started before the 12th (Manage upcoming,
// Home) were unaffected, hence the disagreement. The header was wrong
// between the 13th and payday every month.
//
// Section 1 fails against 64f50119 (before the fix).

import { readFileSync } from 'node:fs'
import { addDays, addMonths } from 'date-fns'
import { generateTransactionsForTemplate, scheduledTemplateDates, templateOccurrencePreviews } from '../src/lib/schedule'
import { buildSavingsPotScheduleRows } from '../src/lib/savingsPotLedger'
import { computeProjection } from '../src/lib/projection'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { toLocalIsoDate } from '../src/lib/date'
import type { AppDataV2, PayCycleConfig, RecurringTemplate } from '../src/types/ledger'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) {
    failures++
    if (detail !== undefined) console.log('     ', JSON.stringify(detail))
  }
}

const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-15.json', 'utf8'))
const data: AppDataV2 = migrateLedgerData(raw.data ?? raw)
const payCycle = data.payCycles.find((c) => c.personId === data.primaryPersonId)!
const transfers = data.recurringTemplates.filter((t) => t.kind === 'transfer' && t.followsPayday)
const pot = data.savingsPots.find((p) => p.name === 'Savings')!

console.log("\n1. Adam's backup on 17 Sep 2026 (the reported state)")
const asOf = new Date(2026, 8, 17, 9, 30) // with a time of day, as `new Date()` has in the app
check('three follows-payday transfers found', transfers.length === 3, transfers.map((t) => t.name))
for (const t of transfers) {
  check(`${t.name}: card header "Next" is 30 Sep, not 30 Oct`, templateOccurrencePreviews(t, asOf, 1, payCycle)[0]?.date === '2026-09-30', templateOccurrencePreviews(t, asOf, 1, payCycle)[0])
  const manage = scheduledTemplateDates(t, addMonths(asOf, -2), addMonths(asOf, 12), payCycle)
  check(`${t.name}: Manage upcoming payments still starts 30 Sep, 30 Oct, 30 Nov`, JSON.stringify(manage.slice(0, 3).map((m) => m.date)) === JSON.stringify(['2026-09-30', '2026-10-30', '2026-11-30']), manage.slice(0, 3))
  check(`${t.name}: the Sept payment keeps its slot identity (12 Sep)`, manage[0]?.originalDate === '2026-09-12')
}
const potRows = buildSavingsPotScheduleRows(pot, data.transactions, asOf, data.recurringTemplates, payCycle)
check('Savings pot ledger has the 30 Sep £1,000 deposit', potRows.some((r) => r.date === '2026-09-30' && r.type === 'savings_deposit' && r.amount === 1000), potRows.slice(0, 4))
const home = computeProjection(data, data.primaryPersonId, payCycle, 'three_cycles', asOf)
for (const t of transfers) {
  check(`Home ledger still has ${t.name} on 30 Sep, once`, home.transactions.filter((x) => x.sourceId === t.id && x.date === '2026-09-30').length === 1)
}

console.log('\n2. Every day for a year: "Next" agrees with Manage upcoming payments, and range queries drop nothing')
{
  let headerMismatches: string[] = []
  let rangeProblems: string[] = []
  for (let day = new Date(2026, 8, 1, 9, 30); day < new Date(2027, 8, 1); day = addDays(day, 1)) {
    const today = toLocalIsoDate(day)
    for (const t of transfers) {
      const upcoming = scheduledTemplateDates(t, addMonths(day, -3), addMonths(day, 14), payCycle).filter((m) => m.date >= today)
      const next = templateOccurrencePreviews(t, day, 1, payCycle)[0]?.date
      if (next !== upcoming[0]?.date) headerMismatches.push(`${today} ${t.name}: header ${next}, manage ${upcoming[0]?.date}`)
      const end = addMonths(day, 3)
      const expected = upcoming.filter((m) => m.date <= toLocalIsoDate(end)).map((m) => m.date)
      const generated = generateTransactionsForTemplate(t, day, end, payCycle).map((g) => g.date)
      if (JSON.stringify(generated) !== JSON.stringify(expected)) rangeProblems.push(`${today} ${t.name}: generated ${generated}, expected ${expected}`)
    }
  }
  check('header "Next" === first upcoming payment on all 365 days', headerMismatches.length === 0, headerMismatches.slice(0, 3))
  check('generating [today, +3 months] returns exactly the payments paid in that range, every day', rangeProblems.length === 0, rangeProblems.slice(0, 3))
}

console.log('\n3. Follows-cycle-start transfers get the same rule')
{
  const cycleStart: RecurringTemplate = { ...transfers[0], id: 'cs', name: 'Cycle start transfer', followsPayday: false, followsCycleStart: true }
  const pc: PayCycleConfig = payCycle
  const mismatches: string[] = []
  for (let day = new Date(2026, 8, 1, 9); day < new Date(2027, 2, 1); day = addDays(day, 1)) {
    const today = toLocalIsoDate(day)
    const upcoming = scheduledTemplateDates(cycleStart, addMonths(day, -3), addMonths(day, 14), pc).filter((m) => m.date >= today)
    const next = templateOccurrencePreviews(cycleStart, day, 1, pc)[0]?.date
    if (next !== upcoming[0]?.date) mismatches.push(`${today}: header ${next}, manage ${upcoming[0]?.date}`)
  }
  check('header "Next" === first upcoming payment every day for 6 months', mismatches.length === 0, mismatches.slice(0, 3))
}

console.log('\n4. Templates whose dates never move are untouched (slot === date)')
{
  const plain: RecurringTemplate = { ...transfers[0], id: 'plain', followsPayday: false, followsCycleStart: false }
  const gen = generateTransactionsForTemplate(plain, new Date(2026, 8, 17), new Date(2026, 11, 31), payCycle).map((g) => g.date)
  check('a plain monthly transfer on the 12th: 12 Oct, 12 Nov, 12 Dec', JSON.stringify(gen) === JSON.stringify(['2026-10-12', '2026-11-12', '2026-12-12']), gen)
  const noPayCycle = generateTransactionsForTemplate(transfers[0], new Date(2026, 8, 17), new Date(2026, 11, 31)).map((g) => g.date)
  check('without a pay cycle (nothing to resolve against) the slot rule still applies', JSON.stringify(noPayCycle) === JSON.stringify(['2026-10-12', '2026-11-12', '2026-12-12']), noPayCycle)
  const bill = data.recurringTemplates.find((t) => t.kind !== 'transfer' && t.frequency === 'monthly')
  if (bill) {
    const start = new Date(2026, 8, 17)
    const dates = generateTransactionsForTemplate(bill, start, new Date(2026, 11, 31), payCycle).map((g) => g.date)
    check(`a bill (${bill.name}) is still slot-ranged: nothing before 17 Sep`, dates.every((d) => d >= '2026-09-17') && dates.length > 0, dates)
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)
