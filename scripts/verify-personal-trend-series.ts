import { buildPersonalTrendSeries } from '../src/lib/projection'
import { defaultPayCycleConfig } from '../src/lib/ledgerStorage'
import type { AppDataV2, Person, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const me: Person = { id: 'me', name: 'Me', color: '#fff', salaryHistory: [], salaryOverrides: [] }
const payCycle = { ...defaultPayCycleConfig('me'), openingBalance: 100, openingBalanceDate: '2020-01-01', cycleStartDayOfMonth: 1 }

const txns: Transaction[] = [
  { id: 't1', date: '2026-09-05', amount: 50, direction: 'in', categoryId: 'category-income', paymentMethod: 'bank_transfer', status: 'cleared', type: 'income', location: 'personal', ownerId: 'me' },
  { id: 't2', date: '2026-09-10', amount: 30, direction: 'out', categoryId: 'category-shopping', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'me' },
  { id: 't3', date: '2026-09-20', amount: 20, direction: 'out', categoryId: 'category-shopping', paymentMethod: 'card', status: 'pending', type: 'expense', location: 'personal', ownerId: 'me' },
]

const data: AppDataV2 = {
  primaryPersonId: 'me',
  people: [me],
  categories: [],
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  pensions: [],
  savingsPots: [],
  pots: [],
  transactions: txns,
  payCycles: [payCycle],
  scenarios: [],
  jointAccount: null,
}

const asOfDate = new Date(2026, 8, 15) // 15 Sep 2026

const series = buildPersonalTrendSeries(data, 'me', payCycle, 'this_cycle', asOfDate)
check('This Cycle: days span exactly the current calendar-month cycle (1 Sep - 30 Sep)', [series.days[0], series.days[series.days.length - 1]], ['2026-09-01', '2026-09-30'])
check('balance array is day-aligned with days', series.balance.length, series.days.length)
check('spend array is day-aligned with days', series.spend.length, series.days.length)
check('Before any transaction, clearedBalance = opening balance', series.balance[0].clearedBalance, 100)
check('After the income lands (5 Sep), clearedBalance = 150', series.balance.find((b) => b.date === '2026-09-05')!.clearedBalance, 150)
check('After the cleared £30 expense (10 Sep), clearedBalance = 120', series.balance.find((b) => b.date === '2026-09-10')!.clearedBalance, 120)
check('The £20 PENDING expense (20 Sep) does not touch clearedBalance', series.balance.find((b) => b.date === '2026-09-20')!.clearedBalance, 120)
check('...but does reduce projectedBalance from that date on', series.balance.find((b) => b.date === '2026-09-20')!.projectedBalance, 100)
check('spendToDate accumulates the cleared £30 by 10 Sep', series.spend.find((s) => s.date === '2026-09-10')!.spendToDate, 30)
check('spendToDate is monotonically non-decreasing across the period', series.spend.every((s, i, arr) => i === 0 || s.spendToDate >= arr[i - 1].spendToDate), true)
// Previous period length can legitimately differ from the current period's
// (calendar months vary in length) — index-aligned for the chart's
// comparison line, not date-aligned, so equal length isn't guaranteed.
check('previousPeriodSpend is non-empty for This Cycle', series.previousPeriodSpend.length > 0, true)

const next3 = buildPersonalTrendSeries(data, 'me', payCycle, 'next_3_cycles', asOfDate)
check('Next 3 Cycles spans more days than This Cycle', next3.days.length > series.days.length, true)
check('Next 3 Cycles starts on the same day as This Cycle (both start at the current cycle)', next3.days[0], series.days[0])

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`)
  process.exit(1)
} else {
  console.log('\nAll Personal trend-series checks passed.')
}
