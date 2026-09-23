// 2026-09-17 (Adam-reported): on Home, "Group by category" let cleared rows
// from before "This cycle"/"Next 3 cycles" show. Every card's projection
// list reaches back to the account's opening-balance date (the running
// balance needs those rows). The date list and CycleGroupedList bounded
// what they DISPLAY; the category list, the amount-ordered list and the
// Personal pull-down breakdown (Income/Outgoings) did not. The date list
// also had no end bound, so a Household row after the last cycle end
// showed there but not in the cycle-totals view.
//
// Fix: inCycleWindow (lib/projection.ts) bounds every displayed list to
// first cycle start → last cycle end; computeCycleSummary takes the same
// window for its buckets, while pending (Available) stays unbounded.
//
// 1. Real backups, both horizons, every card: the bound removes what it should.
// 2. computeCycleSummary with a window: buckets bounded, Available unchanged.
// 3. Source checks: every list call site in Home.tsx passes the bound.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { computeProjection, horizonCycles, inCycleWindow, type ProjectionHorizon } from '../src/lib/projection'
import { computeJointAccountProjection } from '../src/lib/jointAccountLedger'
import { computeHouseholdProjections } from '../src/lib/householdLedger'
import { computePotProjection } from '../src/lib/potLedger'
import { isLedgerTransaction } from '../src/lib/runningBalance'
import { computeCycleSummary } from '../src/lib/cycleSummary'
import { distinctByCategory } from '../src/lib/categories'
import { toLocalIsoDate } from '../src/lib/date'
import type { AppDataV2, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`)
  if (!ok) failures++
}
/** Same, comparing two values rather than taking a boolean. */
function checkEq(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(`${label}${ok ? '' : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`, ok)
}

const BACKUPS = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/'

console.log('1. Real backups: every card, both horizons')
let sawPreWindowRows = false
for (const file of ['finance-ledger-backup-2026-09-15.json', 'finance-ledger-backup-2026-09-15-mum.json']) {
  const data: AppDataV2 = migrateLedgerData(JSON.parse(readFileSync(BACKUPS + file, 'utf8')))
  for (const horizon of ['current_cycle', 'three_cycles'] as ProjectionHorizon[]) {
    const cycles = horizonCycles(data, data.primaryPersonId, horizon, new Date())
    const startIso = toLocalIsoDate(cycles[0].start)
    const endIso = toLocalIsoDate(cycles[cycles.length - 1].end)
    const cards: [string, Transaction[]][] = []
    const payCycle = data.payCycles.find((c) => c.personId === data.primaryPersonId)
    if (payCycle) cards.push(['Personal', computeProjection(data, data.primaryPersonId, payCycle, horizon).transactions.filter(isLedgerTransaction)])
    const joint = computeJointAccountProjection(data, horizon)
    if (joint) cards.push(['Joint', joint.transactions])
    cards.push(['Household', computeHouseholdProjections(data, horizon).flatMap((p) => p.transactions)])
    for (const pot of data.pots ?? []) cards.push([`Pot ${pot.name}`, computePotProjection(data, pot, horizon, new Date()).transactions])

    for (const [card, txns] of cards) {
      const bounded = inCycleWindow(txns, cycles)
      const outside = txns.filter((t) => t.date < startIso || t.date > endIso)
      if (txns.some((t) => t.date < startIso && t.status === 'cleared')) sawPreWindowRows = true
      check(`${file.includes('mum') ? 'mum' : 'Adam'} · ${horizon} · ${card}: ${outside.length} out-of-range rows removed, ${bounded.length} kept`, bounded.length + outside.length === txns.length && bounded.every((t) => t.date >= startIso && t.date <= endIso))
    }

    if (payCycle) {
      const p = computeProjection(data, data.primaryPersonId, payCycle, horizon)
      const unbounded = computeCycleSummary(p.transactions, p.clearedBalance)
      const windowed = computeCycleSummary(p.transactions, p.clearedBalance, { startIso, endIso })
      const inRange = computeCycleSummary(inCycleWindow(p.transactions, cycles), p.clearedBalance)
      check(`${file.includes('mum') ? 'mum' : 'Adam'} · ${horizon} · breakdown buckets match the in-range rows`, JSON.stringify([windowed.income, windowed.outgoings]) === JSON.stringify([inRange.income, inRange.outgoings]), { windowed, inRange })
      check(`${file.includes('mum') ? 'mum' : 'Adam'} · ${horizon} · breakdown Available and Current balance unchanged by the window`, windowed.available === unbounded.available && windowed.currentBalance === unbounded.currentBalance)
    }
  }
}
check("Mum's backup exercises the bug: cleared rows before the cycle start exist in the raw list", sawPreWindowRows)

console.log('\n2. computeCycleSummary window on a fixture')
{
  const row = (id: string, date: string, amount: number, direction: 'in' | 'out', status: 'cleared' | 'pending', type: Transaction['type'] = 'expense'): Transaction => ({
    id,
    date,
    amount,
    direction,
    status,
    type,
    categoryId: 'c',
    paymentMethod: 'card',
    location: 'personal',
    ownerId: 'me',
  })
  const txns = [row('old-in', '2026-08-01', 1000, 'in', 'cleared', 'salary'), row('old-out', '2026-08-02', 300, 'out', 'cleared'), row('stale-pending', '2026-08-03', 50, 'out', 'pending'), row('in', '2026-09-28', 2000, 'in', 'pending', 'salary'), row('out', '2026-10-01', 400, 'out', 'pending')]
  const s = computeCycleSummary(txns, 500, { startIso: '2026-09-01', endIso: '2026-10-31' })
  check('Income counts only in-range rows (£2,000, not £3,000)', s.income.total === 2000, s.income)
  check('Outgoings count only in-range rows (£400, not £750)', s.outgoings.total === 400, s.outgoings)
  check('Available still counts a pending row dated before the range (500 + 2000 − 400 − 50)', s.available === 2050, s.available)
  check('No window: unchanged behaviour', computeCycleSummary(txns, 500).income.total === 3000)
}

console.log('\n3. Home.tsx: every list is bounded')
{
  const src = readFileSync(new URL('../src/pages/Home.tsx', import.meta.url), 'utf8')
  const categoryAndAmount = src.match(/<(CategoryGroupedList|AmountOrderedList) transactions=\{[^}]*\}/g) ?? []
  check(`CategoryGroupedList/AmountOrderedList: ${categoryAndAmount.length} call sites, all via inCycleWindow`, categoryAndAmount.length === 8 && categoryAndAmount.every((c) => c.includes('inCycleWindow(')), categoryAndAmount)
  const dateLists = src.match(/<DateOrderedList[\s\S]*?\/>/g) ?? []
  check(`DateOrderedList: ${dateLists.length} call sites, all with cycleStartIso and cycleEndIso`, dateLists.length === 4 && dateLists.every((c) => c.includes('cycleStartIso=') && c.includes('cycleEndIso=')))
  check('DateOrderedList filters by cycleEndIso', /t\.date <= cycleEndIso/.test(src))
  check('Personal breakdown passes a window to computeCycleSummary', /computeCycleSummary\(projection\.transactions, projection\.clearedBalance, \{/.test(src))
}

console.log('\n4b. Home default view (2026-09-17)')
{
  const src = readFileSync(new URL('../src/pages/Home.tsx', import.meta.url), 'utf8')
  check("Default horizon is This cycle", /useState<ProjectionHorizon>\('current_cycle'\)/.test(src))
  check('Default grouping is list, order is date', /useState<Grouping>\('list'\)/.test(src) && /useState<Order>\('date'\)/.test(src))
  check('Show cleared defaults off, cycle-end totals default on (so This cycle is one collapsed pill)', /const \[showCleared, setShowCleared\] = useState\(false\)/.test(src) && /const \[cycleTotals, setCycleTotals\] = useState\(true\)/.test(src))
  check('Group by direction and the forecast default off', /const \[groupByDirection, setGroupByDirection\] = useState\(false\)/.test(src) && /const \[averageSpendForecast, setAverageSpendForecast\] = useState\(false\)/.test(src))
  const labels = src.slice(src.indexOf('function activeFilterLabels'), src.indexOf('function activeFilterLabels') + 1200)
  check('The non-default counter matches those defaults', /grouping !== 'list'/.test(labels) && /order !== 'date'/.test(labels) && /if \(showCleared\)/.test(labels) && /if \(!cycleTotals\)/.test(labels) && /if \(groupByDirection\)/.test(labels))
  check('...and ignores the horizon, which is its own pill', !/horizon/.test(labels))
  // 2026-09-17 (Adam-reported): This cycle fell back to the flat list because
  // cycle-end totals required the three_cycles horizon, so the default view
  // was not the collapsed pill he asked for.
  const canShow = src.slice(src.indexOf('function canShowCycleTotals'), src.indexOf('function canShowCycleTotals') + 500)
  check('Cycle-end totals no longer require the Next 3 cycles range', !/three_cycles/.test(canShow))
  check('...but still require list/person grouping and date order', /order === 'date'/.test(canShow) && /grouping !== 'category'/.test(canShow))
  const reset = src.slice(src.indexOf('function resetToDefault'), src.indexOf('function resetToDefault') + 400)
  check('Reset restores those same defaults and leaves the horizon alone', /setShowCleared\(false\)/.test(reset) && /setCycleTotals\(true\)/.test(reset) && !/setHorizon/.test(reset))
}

console.log('\n5. Trend tooltip icons are one per category (2026-09-17)')
{
  const rows = [
    { id: 'a', categoryId: 'food' },
    { id: 'b', categoryId: 'food' },
    { id: 'c', categoryId: 'fuel' },
    { id: 'd' },
    { id: 'e' },
  ]
  checkEq('Repeats collapse, first occurrence kept, order preserved', distinctByCategory(rows).map((r) => r.id), ['a', 'c', 'd'])
  checkEq('Nothing to dedupe: unchanged', distinctByCategory([{ id: 'x', categoryId: 'food' }]).map((r) => r.id), ['x'])
  checkEq('Empty day', distinctByCategory([]), [])

  // Real backups: every day the tooltip can land on.
  for (const file of ['finance-ledger-backup-2026-09-15.json', 'finance-ledger-backup-2026-09-15-mum.json']) {
    const data: AppDataV2 = migrateLedgerData(JSON.parse(readFileSync(BACKUPS + file, 'utf8')))
    const who = file.includes('mum') ? 'mum' : 'Adam'
    const byDay = new Map<string, Transaction[]>()
    for (const t of data.transactions.filter(isLedgerTransaction)) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t])
    const sameCategoryDays = [...byDay.values()].filter((rows) => distinctByCategory(rows).length < rows.length)
    check(`${who}: every day shows one icon per distinct category`, [...byDay.values()].every((rows) => {
      const distinct = distinctByCategory(rows)
      return distinct.length === new Set(rows.map((r) => r.categoryId || 'uncategorised')).size && distinct.length <= rows.length
    }))
    check(`${who}: has ${sameCategoryDays.length} day(s) that previously repeated an icon`, sameCategoryDays.length > 0)
  }
}

console.log(failures === 0 ? '\nAll Home list window checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
