// PROMPT-03 (2026-09-16) — Household's "Group by Person" is cycle-outer,
// person-inner, matching Joint. HouseholdDetail now renders
// CycleGroupedList over the combined list with groupByPerson, and each
// expanded cycle's rows are split by buildHouseholdPersonGroups.
//
// CycleGroupedList lives in Home.tsx (not importable here), so this
// rebuilds its per-cycle row selection exactly — `t.date >= startIso &&
// t.date <= endIso` over the combined list, then the "Show cleared" filter
// — and PersonPills' empty-group hiding (`transactions.length > 0`).
//
// The property that matters: the grouped and ungrouped views must never
// disagree. Every cycle's person totals must sum to that cycle's own
// ungrouped total, with no row lost or double-counted.

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { computeHouseholdProjections, buildHouseholdPersonGroups, type HouseholdPersonProjection } from '../src/lib/householdLedger'
import { horizonCycles, type ProjectionHorizon } from '../src/lib/projection'
import { signedAmount } from '../src/lib/runningBalance'
import { toLocalIsoDate } from '../src/lib/date'
import { defaultPayCycleConfig, parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import type { AppDataV2, Person, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.005) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const round2 = (n: number) => Math.round(n * 100) / 100
const sum = (rows: Transaction[]) => round2(rows.reduce((s, t) => s + signedAmount(t), 0))

interface GroupedCycle {
  startIso: string
  endIso: string
  rows: Transaction[]
  pills: { id: string; name: string; transactions: Transaction[]; total: number }[]
}

/** HouseholdDetail → CycleGroupedList(groupByPerson) → PersonPills, minus the JSX. */
function groupedView(data: AppDataV2, horizon: ProjectionHorizon, asOf: Date, showCleared: boolean): { pps: HouseholdPersonProjection[]; cycles: GroupedCycle[] } {
  const pps = computeHouseholdProjections(data, horizon, asOf)
  const combined = pps.flatMap((pp) => pp.transactions)
  const cycles = horizonCycles(data, data.primaryPersonId, horizon, asOf).map((c) => {
    const startIso = toLocalIsoDate(c.start)
    const endIso = toLocalIsoDate(c.end)
    const rows = combined.filter((t) => t.date >= startIso && t.date <= endIso).filter((t) => showCleared || t.status !== 'cleared')
    const pills = buildHouseholdPersonGroups(pps, rows)
      .filter((g) => g.transactions.length > 0)
      .map((g) => ({ ...g, total: sum(g.transactions) }))
    return { startIso, endIso, rows, pills }
  })
  return { pps, cycles }
}

/** The invariants that must hold for ANY data set. */
function assertReconciles(label: string, pps: HouseholdPersonProjection[], cycles: GroupedCycle[]) {
  for (const c of cycles) {
    const where = `${label} ${c.startIso}→${c.endIso}`
    check(`${where}: person totals sum to the cycle's ungrouped total`, round2(c.pills.reduce((s, p) => s + p.total, 0)), sum(c.rows))
    check(`${where}: every row lands in exactly one pill`, c.pills.reduce((n, p) => n + p.transactions.length, 0), c.rows.length)
    check(`${where}: no empty pill is shown`, c.pills.every((p) => p.transactions.length > 0), true)
    for (const p of c.pills) {
      const own = pps.find((pp) => pp.personId === p.id)!.transactions.filter((t) => t.date >= c.startIso && t.date <= c.endIso)
      const ownVisible = own.filter((t) => c.rows.includes(t))
      check(`${where}: ${p.name}'s pill total equals the sum of their own rows in this cycle`, p.total, sum(ownVisible))
      check(`${where}: ${p.name}'s pill holds only their own rows, all inside this cycle`, p.transactions.every((t) => own.includes(t)), true)
    }
  }
}

// ── 1. Synthetic: two people, rows in two cycles ─────────────────────────
const adam: Person = { id: 'adam', name: 'Adam', color: '#fff', salaryHistory: [], salaryOverrides: [] }
const ella: Person = { id: 'ella', name: 'Ella', color: '#000', salaryHistory: [], salaryOverrides: [] }

function row(id: string, date: string, amount: number, direction: 'in' | 'out', ownerId: string, status: 'cleared' | 'pending'): Transaction {
  return { id, date, amount, direction, categoryId: 'category-shopping', paymentMethod: 'card', status, type: direction === 'in' ? 'income' : 'expense', location: 'personal', ownerId }
}

const synthetic: AppDataV2 = {
  primaryPersonId: 'adam',
  people: [adam, ella],
  categories: [],
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  pensions: [],
  savingsPots: [],
  pots: [],
  transactions: [
    // September (current cycle): both people
    row('a-sep', '2026-09-05', 40, 'out', 'adam', 'cleared'),
    row('e-sep', '2026-09-08', 25, 'out', 'ella', 'cleared'),
    row('a-sep2', '2026-09-20', 10, 'out', 'adam', 'pending'),
    // October: Adam only — Ella must not appear in this cycle
    row('a-oct', '2026-10-10', 60, 'out', 'adam', 'pending'),
    row('a-oct-in', '2026-10-12', 200, 'in', 'adam', 'pending'),
  ],
  payCycles: [
    { ...defaultPayCycleConfig('adam'), openingBalance: 100, openingBalanceDate: '2020-01-01' },
    { ...defaultPayCycleConfig('ella'), openingBalance: 50, openingBalanceDate: '2020-01-01' },
  ],
  scenarios: [],
  jointAccount: null,
}
const asOf = new Date(2026, 8, 15)

{
  const { pps, cycles } = groupedView(synthetic, 'three_cycles', asOf, true)
  const sep = cycles.find((c) => c.startIso === '2026-09-01')!
  const oct = cycles.find((c) => c.startIso === '2026-10-01')!
  check('Synthetic: structure is Cycle > Person — September has pills [Adam, Ella]', sep.pills.map((p) => p.name), ['Adam', 'Ella'])
  check("Synthetic: Adam's September total = -40 - 10", sep.pills[0].total, -50)
  check("Synthetic: Ella's September total = -25", sep.pills[1].total, -25)
  check('Synthetic: October has only Adam — Ella has no rows there, so no pill', oct.pills.map((p) => p.name), ['Adam'])
  check("Synthetic: Adam's October total = +200 - 60", oct.pills[0].total, 140)
  check('Synthetic: a cycle with no rows at all has no pills', cycles.filter((c) => c.rows.length === 0).every((c) => c.pills.length === 0), true)
  assertReconciles('Synthetic (show cleared)', pps, cycles)
}

{
  // "Show cleared" OFF hides cleared rows from pills, exactly as it hides them from the ungrouped cycle list.
  const { pps, cycles } = groupedView(synthetic, 'three_cycles', asOf, false)
  const sep = cycles.find((c) => c.startIso === '2026-09-01')!
  check('Synthetic, cleared hidden: September shows only Adam (Ella has only a cleared row)', sep.pills.map((p) => [p.name, p.total]), [['Adam', -10]])
  assertReconciles('Synthetic (cleared hidden)', pps, cycles)
}

{
  // Fallback: a row that isn't one of the projections' own objects is attributed by ownerId.
  const pps = computeHouseholdProjections(synthetic, 'three_cycles', asOf)
  const copy = { ...pps[1].transactions[0] }
  const groups = buildHouseholdPersonGroups(pps, [copy])
  check('A copied row (not from a projection) falls back to its ownerId', groups.map((g) => g.transactions.length), [0, 1])
  check('Every person with a projection is returned, in projection order (PersonPills does the hiding)', groups.map((g) => g.id), ['adam', 'ella'])
}

// ── 2. Adam's real backup: Adam monthly/31st, Ella four-weekly/10th ──────
const backupPath = `${homedir()}/Downloads/finance-ledger-backup-2026-09-15.json`
let backup: AppDataV2 | null = null
try {
  backup = parseLedgerBackupJson(readFileSync(backupPath, 'utf8'))
} catch {
  console.log(`(skipped real-backup checks — ${backupPath} not found)`)
}

if (backup) {
  const realAsOf = new Date(2026, 8, 16)
  for (const horizon of ['current_cycle', 'three_cycles'] as const) {
    for (const showCleared of [true, false]) {
      const { pps, cycles } = groupedView(backup, horizon, realAsOf, showCleared)
      const label = `Real backup (${horizon}, ${showCleared ? 'show cleared' : 'cleared hidden'})`
      check(`${label}: both people have a projection`, pps.map((pp) => pp.personName), ['Adam', 'Ella'])
      assertReconciles(label, pps, cycles)
      if (horizon === 'three_cycles' && showCleared) {
        for (const c of cycles) console.log(`    ${c.startIso}→${c.endIso}: ${c.pills.map((p) => `${p.name} ${p.total} (${p.transactions.length} rows)`).join(' · ') || '(nothing)'}`)
      }
    }
  }
  // The grouped view must cover the WHOLE combined list the ungrouped view shows, not a subset.
  const { pps, cycles } = groupedView(backup, 'three_cycles', realAsOf, true)
  const combined = pps.flatMap((pp) => pp.transactions)
  const firstStart = cycles[0].startIso
  const lastEnd = cycles[cycles.length - 1].endIso
  check(
    'Real backup: every combined row inside the horizon appears in exactly one cycle pill',
    cycles.reduce((n, c) => n + c.pills.reduce((m, p) => m + p.transactions.length, 0), 0),
    combined.filter((t) => t.date >= firstStart && t.date <= lastEnd).length,
  )
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`)
  process.exit(1)
} else {
  console.log('\nAll Household person-grouping checks passed.')
}
