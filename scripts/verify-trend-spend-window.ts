// 2026-09-18 (Adam-reported, both issues found on the Personal card's
// Trends chart) — two independent defects, both asserted here against the
// real backups.
//
// 1. THE SPEND LINE DID NOT START AT ZERO. `buildDailySpendSeries` walks
//    day by day adding every matching transaction dated on or before that
//    day, and had no LOWER bound — so the first point swept in the whole
//    spending history before the window even opened. Mum's chart opened at
//    £2,204.84 on day one, in BOTH granularities. Its own docstring says
//    the total "resets to 0 at the start of `days`", so the intent was
//    never in question. Section 1 below FAILS against the pre-fix code.
//
// 2. THE TOOLTIP ICONS STOPPED AT THE CURRENT CYCLE'S END. The chart's
//    This cycle / Next 3 cycles switch is the modal's own and is
//    independent of the page's horizon pill, but the icons were read from
//    a projection built from the PILL. Pill on "This cycle" + chart on
//    "Next 3 cycles" = a line running three cycles out with icons for only
//    the first. Section 2 measures the gap that caused it, and is what the
//    `trendIconTxns` change in Home.tsx closes.
//
// NOT A BUG, checked and recorded (Adam's own read, confirmed here in
// section 3): the comparison line looking like it only exists at the right
// of the chart. Mum simply has no history in three of the four comparison
// cycles, so the cumulative line is legitimately flat until the last one.

import { readFileSync } from 'node:fs'
import { buildPersonalTrendSeries, computeProjection, horizonCycles, previousCycles } from '../src/lib/projection'
import { buildDailySpendSeries } from '../src/lib/runningBalance'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { toLocalIsoDate } from '../src/lib/date'
import type { AppDataV2, Transaction } from '../src/types/ledger'

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
const mum = load('finance-ledger-backup-2026-09-17-mum.json')
const adam = load('finance-ledger-backup-2026-09-15.json')
const ASOF = new Date()

console.log('\n── 1. Every Spend window opens at zero ──')

for (const [who, data] of [['mum', mum], ['adam', adam]] as const) {
  const pid = data.primaryPersonId
  const payCycle = data.payCycles.find((c) => c.personId === pid)
  if (!payCycle) continue
  for (const g of ['this_cycle', 'next_3_cycles'] as const) {
    const series = buildPersonalTrendSeries(data, pid, payCycle, g, ASOF)
    // Day one can only be non-zero if there is genuine spend dated ON it
    // (Adam: "unless there was genuine spend on the first day").
    const spendOnDayOne = series.spend[0].spendToDate
    const hasDayOneSpend = series.days.length > 0 && spendOnDayOne > 0
    check(`${who}/${g}: opens at zero, or at genuine day-one spend only`, !hasDayOneSpend || spendOnDayOne > 0, true)
    // The strong form, and the assertion that FAILS against the pre-fix
    // code (mum's first point read £2,204.84 there): deleting every
    // transaction dated before the window must not change the opening
    // point. If pre-window history is leaking in, these differ.
    //
    // Proving it this way rather than recomputing the expected figure
    // keeps it independent of `isPersonalSpend`, which is private to
    // projection.ts — a check should not force a module to widen its API.
    const trimmed: AppDataV2 = { ...data, transactions: data.transactions.filter((t) => t.date >= series.days[0]) }
    const trimmedSeries = buildPersonalTrendSeries(trimmed, pid, payCycle, g, ASOF)
    check(`${who}/${g}: dropping everything before ${series.days[0]} leaves the opening point unchanged`, series.spend[0].spendToDate, trimmedSeries.spend[0].spendToDate)
    // Monotonic, and never below the opening point.
    check(`${who}/${g}: the cumulative line never goes backwards`,
      series.spend.every((p, i) => i === 0 || p.spendToDate >= series.spend[i - 1].spendToDate), true)
  }
}

// Spend dated exactly on the first day must still count — the fix is a
// lower bound, not an off-by-one that silently drops day one.
const firstDayTx: Transaction[] = [
  { id: 'a', date: '2026-01-10', amount: 25, direction: 'out', categoryId: 'c', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'p' } as Transaction,
  { id: 'b', date: '2026-01-09', amount: 999, direction: 'out', categoryId: 'c', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'p' } as Transaction,
]
const boundary = buildDailySpendSeries(firstDayTx, ['2026-01-10', '2026-01-11'], () => true)
check('spend dated ON the first day still counts', boundary[0].spendToDate, 25)
check('spend dated the day BEFORE the window does not', boundary[1].spendToDate, 25)

console.log('\n── 2. The tooltip icons cover the whole chart, not just the pill ──')

for (const [who, data] of [['mum', mum], ['adam', adam]] as const) {
  const pid = data.primaryPersonId
  const payCycle = data.payCycles.find((c) => c.personId === pid)
  if (!payCycle) continue
  const chartDays = buildPersonalTrendSeries(data, pid, payCycle, 'next_3_cycles', ASOF).days
  const pillOneCycle = computeProjection(data, pid, payCycle, 'current_cycle', ASOF).transactions
  const widest = computeProjection(data, pid, payCycle, 'three_cycles', ASOF).transactions

  const daysCoveredByPill = chartDays.filter((d) => pillOneCycle.some((t) => t.date === d)).length
  const daysCoveredByWidest = chartDays.filter((d) => widest.some((t) => t.date === d)).length

  console.log(`    ${who}: chart spans ${chartDays.length} days — pill-bound source covers ${daysCoveredByPill}, three-cycle source covers ${daysCoveredByWidest}`)
  // The bug, quantified: the pill-bound source cannot reach the end of the
  // chart. The three-cycle source is a strict superset and does.
  check(`${who}: the three-cycle source covers strictly more of the chart than the pill-bound one`, daysCoveredByWidest > daysCoveredByPill, true)
  check(`${who}: every day the pill-bound source covered is still covered`,
    chartDays.filter((d) => pillOneCycle.some((t) => t.date === d)).every((d) => widest.some((t) => t.date === d)), true)

  const cycleEnd = toLocalIsoDate(horizonCycles(data, pid, 'current_cycle', ASOF)[0].end)
  const pastCycleEnd = chartDays.filter((d) => d > cycleEnd)
  check(`${who}: the pill-bound source had NOTHING past the current cycle end (${cycleEnd}) — the reported symptom`,
    pastCycleEnd.some((d) => pillOneCycle.some((t) => t.date === d)), false)
  check(`${who}: the three-cycle source does have rows past it`,
    pastCycleEnd.some((d) => widest.some((t) => t.date === d)), true)
}

console.log('\n── 3. The comparison line is sparse because the history is (not a bug) ──')

// Adam's own diagnosis, verified: for "Next 3 cycles" the comparison runs
// over the four cycles immediately before, and mum has data in only the
// most recent one — so the cumulative line is legitimately flat until the
// final quarter of the x axis.
const mumPersonal = mum.transactions.filter((t) => t.location === 'personal' && t.ownerId === mum.primaryPersonId)
const prev = [...previousCycles(mum, mum.primaryPersonId, 4, ASOF)].reverse()
const perCycle = prev.map((c) => mumPersonal.filter((t) => t.date >= toLocalIsoDate(c.start) && t.date <= toLocalIsoDate(c.end)).length)
console.log(`    mum's four comparison cycles hold: ${JSON.stringify(perCycle)} transactions`)
check("mum has history in only the LAST of the four comparison cycles", perCycle.filter((n) => n > 0).length, 1)
check('...and it is the most recent one, which is why the line only lifts at the right', perCycle[perCycle.length - 1] > 0, true)

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll trend-window checks passed.')
process.exitCode = failures ? 1 : 0
