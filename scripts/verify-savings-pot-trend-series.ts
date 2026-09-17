import { readFileSync } from 'fs'
import { homedir } from 'os'
import { buildSavingsPotTrendSeries, newSavingsPot, type SavingsPotTrendSeries } from '../src/lib/savingsPotLedger'
import { defaultPayCycleConfig, parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import type { AppDataV2, Person, SavingsPot, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const me: Person = { id: 'me', name: 'Me', color: '#fff', salaryHistory: [], salaryOverrides: [] }
const payCycle = { ...defaultPayCycleConfig('me'), openingBalanceDate: '2020-01-01' }
const pot: SavingsPot = {
  ...newSavingsPot({
    personId: 'me',
    name: 'Rainy day',
    openingBalance: 1000,
    openingDate: '2020-01-01',
    interestMethod: { type: 'aer_credited', aer: 0, creditingFrequency: 'monthly' },
    color: '#123456',
  }),
  id: 'sp-1',
}

const txns: Transaction[] = [
  { id: 's1', date: '2026-09-05', amount: 100, direction: 'out', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_deposit', location: 'personal', ownerId: 'me', savingsPotId: 'sp-1' },
  { id: 's2', date: '2026-09-20', amount: 40, direction: 'in', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_withdrawal', location: 'personal', ownerId: 'me', savingsPotId: 'sp-1' },
]

const data: AppDataV2 = {
  primaryPersonId: 'me',
  people: [me],
  categories: [],
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  pensions: [],
  savingsPots: [pot],
  pots: [],
  transactions: txns,
  payCycles: [payCycle],
  scenarios: [],
  jointAccount: null,
}

const asOfDate = new Date(2026, 8, 25)

// ---- This Cycle: one pill per day, end-of-day balance, sign-dependent net ----
const thisCycle = buildSavingsPotTrendSeries(data, pot, 'this_cycle', asOfDate)
check('This Cycle produces one point per day of the current calendar-month cycle', thisCycle.points.length, 30)
check('Day 1 (before any activity) end balance = opening balance', thisCycle.points[0].endBalance, 1000)
const depositDay = thisCycle.points.find((p) => p.periodStart === '2026-09-05')!
check('The deposit day end balance = 1100', depositDay.endBalance, 1100)
check('The deposit day netChange is POSITIVE (net saved)', depositDay.netChange > 0, true)
const withdrawalDay = thisCycle.points.find((p) => p.periodStart === '2026-09-20')!
check('The withdrawal day end balance = 1060', withdrawalDay.endBalance, 1060)
check('The withdrawal day netChange is NEGATIVE (net withdrawn) — sign-dependent tooltip metric', withdrawalDay.netChange < 0, true)
check('A day with no activity has netChange exactly 0', thisCycle.points.find((p) => p.periodStart === '2026-09-10')!.netChange, 0)

// ---- Last 6 Cycles: weekly buckets, w/c label ----
const last6 = buildSavingsPotTrendSeries(data, pot, 'last_6_cycles', asOfDate)
check('Last 6 Cycles produces at least 6 weekly columns', last6.points.length >= 6, true)
check('Every weekly column carries a "w/c" axis label', last6.points.every((p) => p.axisLabel.startsWith('w/c')), true)
check('Weekly columns are chronologically ascending', last6.points.every((p, i, arr) => i === 0 || p.periodStart >= arr[i - 1].periodStart), true)

// ---- Year: one pill per pay cycle, offset-labelled 0/-1/-2/... ----
const year = buildSavingsPotTrendSeries(data, pot, 'year', asOfDate)
check('Year produces 12 columns (current pay cycle + 11 before it)', year.points.length, 12)
check('The LAST column (current cycle) is offset 0', year.points[year.points.length - 1].axisLabel, '0')
check('The column before it is offset -1', year.points[year.points.length - 2].axisLabel, '-1')
check('The final column\'s end balance matches This Cycle\'s own final balance', year.points[year.points.length - 1].endBalance, thisCycle.points[thisCycle.points.length - 1].endBalance)

// ---- PROMPT-04 Bug B (2026-09-16): every point carries the gross money in/out behind its netChange ----
// The single assertion that catches both mis-bucketing and off-by-one period boundaries: for every
// point on every granularity, moneyIn - moneyOut must equal that point's own netChange.
const round2 = (n: number) => Math.round(n * 100) / 100
function assertFlowsReconcile(label: string, series: SavingsPotTrendSeries) {
  const bad = series.points.filter((p) => round2(p.moneyIn - p.moneyOut) !== p.netChange || p.moneyIn < 0 || p.moneyOut < 0)
  check(`${label}: every point's moneyIn - moneyOut equals its netChange (${series.points.length} points)`, bad.map((p) => `${p.periodStart}: in ${p.moneyIn} out ${p.moneyOut} net ${p.netChange}`), [])
}
function assertFlowTotals(label: string, series: SavingsPotTrendSeries, expectedIn: number, expectedOut: number) {
  check(`${label}: total in across all points`, round2(series.points.reduce((s, p) => s + p.moneyIn, 0)), expectedIn)
  check(`${label}: total out across all points`, round2(series.points.reduce((s, p) => s + p.moneyOut, 0)), expectedOut)
}
assertFlowsReconcile('This Cycle', thisCycle)
assertFlowsReconcile('Last 6 Cycles', last6)
assertFlowsReconcile('Year', year)
// Each granularity sees both fixture rows exactly once — not zero (dropped at a boundary), not twice (double-bucketed).
assertFlowTotals('This Cycle', thisCycle, 100, 40)
assertFlowTotals('Last 6 Cycles', last6, 100, 40)
assertFlowTotals('Year', year, 100, 40)
check('Deposit day: £100 in, £0 out', [depositDay.moneyIn, depositDay.moneyOut], [100, 0])
check('Withdrawal day: £0 in, £40 out', [withdrawalDay.moneyIn, withdrawalDay.moneyOut], [0, 40])
const quietDay = thisCycle.points.find((p) => p.periodStart === '2026-09-10')!
check('A period with no activity carries zero in and zero out', [quietDay.moneyIn, quietDay.moneyOut], [0, 0])

// A deposit and withdrawal that cancel: net 0, but the in/out figures must still show both.
const cancelData: AppDataV2 = {
  ...data,
  transactions: [
    { id: 'c1', date: '2026-09-08', amount: 75, direction: 'out', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_deposit', location: 'personal', ownerId: 'me', savingsPotId: 'sp-1' },
    { id: 'c2', date: '2026-09-08', amount: 75, direction: 'in', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_withdrawal', location: 'personal', ownerId: 'me', savingsPotId: 'sp-1' },
  ],
}
const cancelDay = buildSavingsPotTrendSeries(cancelData, pot, 'this_cycle', asOfDate).points.find((p) => p.periodStart === '2026-09-08')!
check('Same-day deposit + withdrawal: net 0 but £75 in and £75 out', [cancelDay.netChange, cancelDay.moneyIn, cancelDay.moneyOut], [0, 75, 75])

// Boundary: a row on the LAST day of a week and one on the FIRST day of the next must land in different weeks.
const boundaryData: AppDataV2 = {
  ...data,
  transactions: [
    { id: 'b1', date: '2026-09-13', amount: 10, direction: 'out', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_deposit', location: 'personal', ownerId: 'me', savingsPotId: 'sp-1' },
    { id: 'b2', date: '2026-09-14', amount: 20, direction: 'out', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_deposit', location: 'personal', ownerId: 'me', savingsPotId: 'sp-1' },
  ],
}
const boundaryWeeks = buildSavingsPotTrendSeries(boundaryData, pot, 'last_6_cycles', asOfDate)
assertFlowsReconcile('Week boundary (Sun 13 / Mon 14 Sep)', boundaryWeeks)
check('Sunday 13 Sep lands in w/c 7 Sep, Monday 14 Sep in w/c 14 Sep', ['2026-09-07', '2026-09-14'].map((d) => boundaryWeeks.points.find((p) => p.periodStart === d)?.moneyIn), [10, 20])

// ---- Column scale (Adam, 2026-09-16): fill = endBalance, full height = peak balance in the view ----
for (const [label, series] of [['This Cycle', thisCycle], ['Last 6 Cycles', last6], ['Year', year]] as const) {
  check(`${label}: peakBalance is the highest balance in the view (1000 opening + 100 deposit)`, series.peakBalance, 1100)
  check(`${label}: no column's end balance exceeds the peak`, series.points.every((p) => p.endBalance <= series.peakBalance), true)
}
// Adam's example: £500 + £500 in on one day, £300 out the same day — the day closes at £700 but the pot held £1,000.
const peakData: AppDataV2 = {
  ...data,
  savingsPots: [{ ...pot, openingBalance: 0 }],
  transactions: [
    { id: 'p1', date: '2026-09-08', amount: 500, direction: 'out', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_deposit', location: 'personal', ownerId: 'me', savingsPotId: 'sp-1' },
    { id: 'p2', date: '2026-09-08', amount: 300, direction: 'in', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_withdrawal', location: 'personal', ownerId: 'me', savingsPotId: 'sp-1' },
    { id: 'p3', date: '2026-09-08', amount: 500, direction: 'out', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_deposit', location: 'personal', ownerId: 'me', savingsPotId: 'sp-1' },
  ],
}
for (const granularity of ['this_cycle', 'last_6_cycles', 'year'] as const) {
  const series = buildSavingsPotTrendSeries(peakData, { ...pot, openingBalance: 0 }, granularity, asOfDate)
  check(`Intraday peak (${granularity}): £500 + £500 in, £300 out same day → peak £1,000, not the £700 close`, series.peakBalance, 1000)
}
const peakDay = buildSavingsPotTrendSeries(peakData, { ...pot, openingBalance: 0 }, 'this_cycle', asOfDate).points.find((p) => p.periodStart === '2026-09-08')!
check('Intraday peak: that day\'s column still fills to its £700 end balance', peakDay.endBalance, 700)

// ---- Year hides cycles that ended before the pot opened (Adam, 2026-09-16) ----
// Calendar-month cycles; asOf 25 Sep 2026. A pot opened 15 Jun 2026 keeps Jun..Sep (4 columns), offsets -3..0.
const juneOpened = { ...pot, openingDate: '2026-06-15' }
const juneYear = buildSavingsPotTrendSeries({ ...data, savingsPots: [juneOpened], transactions: [] }, juneOpened, 'year', asOfDate)
check('Year, pot opened 15 Jun: only cycles from the one containing the opening date', juneYear.points.map((p) => p.periodStart), ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'])
check('Year, pot opened 15 Jun: offsets still count back from the current cycle', juneYear.points.map((p) => p.axisLabel), ['-3', '-2', '-1', '0'])
check('Year, pot opened 15 Jun: in/out still reconciles', juneYear.points.every((p) => round2(p.moneyIn - p.moneyOut) === p.netChange), true)
const todayOpened = { ...pot, openingDate: '2026-09-25' }
const todayYear = buildSavingsPotTrendSeries({ ...data, savingsPots: [todayOpened], transactions: [] }, todayOpened, 'year', asOfDate)
check('Year, pot opened today: just the current cycle, labelled 0', todayYear.points.map((p) => p.axisLabel), ['0'])
const cycleStartOpened = { ...pot, openingDate: '2026-08-31' }
check('Year, pot opened on the last day of a cycle: that cycle is kept', buildSavingsPotTrendSeries({ ...data, savingsPots: [cycleStartOpened], transactions: [] }, cycleStartOpened, 'year', asOfDate).points[0].periodStart, '2026-08-01')

// ---- Adam's real backup — the acceptance case for Bug B ----
// His `Savings` pot (3W_cgSam) opened 2026-09-12 with £242.85; `uhyY_plA` moved £242 out to personal
// on 2026-09-13. That is the drop he described; its period must name it as £242 out on every granularity.
const backupPath = `${homedir()}/Downloads/finance-ledger-backup-2026-09-15.json`
let backup: AppDataV2 | null = null
try {
  backup = parseLedgerBackupJson(readFileSync(backupPath, 'utf8'))
} catch {
  console.log(`(skipped real-backup checks — ${backupPath} not found)`)
}
if (backup) {
  const realPot0 = backup.savingsPots.find((p) => p.id === '3W_cgSam')!
  const realDays = buildSavingsPotTrendSeries(backup, realPot0, 'this_cycle', new Date(2026, 8, 16)).points
  check('Real backup (this_cycle): 12 Sep is a FULL column (£242.85), 13 Sep a near-empty one (£0.85)', realDays.slice(0, 2).map((p) => [p.periodStart, p.endBalance]), [['2026-09-12', 242.85], ['2026-09-13', 0.85]])
  const realPot = backup.savingsPots.find((p) => p.id === '3W_cgSam')!
  const realAsOf = new Date(2026, 8, 16)
  for (const [granularity, periodStart] of [['this_cycle', '2026-09-13'], ['last_6_cycles', '2026-09-07'], ['year', '2026-08-28']] as const) {
    const series = buildSavingsPotTrendSeries(backup, realPot, granularity, realAsOf)
    assertFlowsReconcile(`Real backup (${granularity})`, series)
    const drop = series.points.find((p) => p.periodStart === periodStart)
    check(`Real backup (${granularity}): the period holding 13 Sep shows £242 withdrawn, £242 out, £0 in`, drop && [drop.netChange, drop.moneyOut, drop.moneyIn], [-242, 242, 0])
    check(`Real backup (${granularity}): full column height = £242.85, the most the pot held`, series.peakBalance, 242.85)
    if (granularity === 'year') check('Real backup (year): pot opened 12 Sep 2026, so only the current cycle shows — no £242.85 columns back to Sep 2025', series.points.map((p) => [p.axisLabel, p.periodStart, p.endBalance]), [['0', '2026-08-28', 0.85]])
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`)
  process.exit(1)
} else {
  console.log('\nAll Savings Pot pill-chart trend-series checks passed.')
}
