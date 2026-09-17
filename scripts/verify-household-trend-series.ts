import { buildHouseholdTrendSeries } from '../src/lib/householdLedger'
import { defaultPayCycleConfig } from '../src/lib/ledgerStorage'
import type { AppDataV2, Person, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const adam: Person = { id: 'adam', name: 'Adam', color: '#fff', salaryHistory: [], salaryOverrides: [] }
const ella: Person = { id: 'ella', name: 'Ella', color: '#000', salaryHistory: [], salaryOverrides: [] }
const adamCycle = { ...defaultPayCycleConfig('adam'), openingBalance: 100, openingBalanceDate: '2020-01-01' }
const ellaCycle = { ...defaultPayCycleConfig('ella'), openingBalance: 50, openingBalanceDate: '2020-01-01' }

const txns: Transaction[] = [
  { id: 'h1', date: '2026-09-06', amount: 40, direction: 'out', categoryId: 'category-shopping', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'adam' },
  { id: 'h2', date: '2026-09-08', amount: 25, direction: 'out', categoryId: 'category-shopping', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'ella' },
]

const data: AppDataV2 = {
  primaryPersonId: 'adam',
  people: [adam, ella],
  categories: [],
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  pensions: [],
  savingsPots: [],
  pots: [],
  transactions: txns,
  payCycles: [adamCycle, ellaCycle],
  scenarios: [],
  jointAccount: null,
}

const asOfDate = new Date(2026, 8, 15)
const series = buildHouseholdTrendSeries(data, 'this_cycle', asOfDate)
check('days span the current calendar-month cycle', [series.days[0], series.days[series.days.length - 1]], ['2026-09-01', '2026-09-30'])
check('Opening balance is the SUM of every member\'s own opening balance (100+50)', series.balance[0].clearedBalance, 150)
check('After Adam\'s £40 spend (6 Sep), combined balance = 110', series.balance.find((b) => b.date === '2026-09-06')!.clearedBalance, 110)
check('After Ella\'s £25 spend too (8 Sep), combined balance = 85', series.balance.find((b) => b.date === '2026-09-08')!.clearedBalance, 85)
check('Combined spend-to-date by 8 Sep = 40+25 = 65', series.spend.find((s) => s.date === '2026-09-08')!.spendToDate, 65)

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`)
  process.exit(1)
} else {
  console.log('\nAll Household trend-series checks passed.')
}
