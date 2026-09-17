import { buildPotTrendSeries, newPot } from '../src/lib/potLedger'
import { defaultPayCycleConfig } from '../src/lib/ledgerStorage'
import type { AppDataV2, Person, Pot, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const me: Person = { id: 'me', name: 'Me', color: '#fff', salaryHistory: [], salaryOverrides: [] }
const payCycle = { ...defaultPayCycleConfig('me'), openingBalance: 0, openingBalanceDate: '2020-01-01' }
const pot: Pot = { ...newPot({ personId: 'me', name: 'Bills', openingBalance: 300, openingDate: '2020-01-01', color: '#123' }), id: 'pot-1' }

const txns: Transaction[] = [
  { id: 'p1', date: '2026-09-05', amount: 60, direction: 'out', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'pot_deposit', location: 'personal', ownerId: 'me', potId: 'pot-1' },
  { id: 'p2', date: '2026-09-14', amount: 20, direction: 'out', categoryId: 'category-bills', paymentMethod: 'direct_debit', status: 'cleared', type: 'bill_payment', location: 'pot', ownerId: 'me', potId: 'pot-1', sourceType: 'recurring_template', sourceId: 'bill-x' },
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
  pots: [pot],
  transactions: txns,
  payCycles: [payCycle],
  scenarios: [],
  jointAccount: null,
}

const asOfDate = new Date(2026, 8, 15)
const series = buildPotTrendSeries(data, pot, 'this_cycle', asOfDate)
check('days span the current calendar-month cycle', [series.days[0], series.days[series.days.length - 1]], ['2026-09-01', '2026-09-30'])
check('Opening balance carries through before any activity', series.balance[0].clearedBalance, 300)
check('Deposit (5 Sep) increases balance to 360', series.balance.find((b) => b.date === '2026-09-05')!.clearedBalance, 360)
check('Pot-funded bill payment (14 Sep) reduces balance to 340 (internal drawdown)', series.balance.find((b) => b.date === '2026-09-14')!.clearedBalance, 340)
check('Drawdown-only spend series counts the £20 bill payment, not the £60 deposit', series.spend.find((s) => s.date === '2026-09-14')!.spendToDate, 20)

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`)
  process.exit(1)
} else {
  console.log('\nAll Pot trend-series checks passed.')
}
