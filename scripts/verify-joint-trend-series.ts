import { buildJointTrendSeries } from '../src/lib/jointAccountLedger'
import { defaultPayCycleConfig } from '../src/lib/ledgerStorage'
import type { AppDataV2, Person, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const me: Person = { id: 'me', name: 'Me', color: '#fff', salaryHistory: [], salaryOverrides: [] }
const payCycle = { ...defaultPayCycleConfig('me'), openingBalance: 0, openingBalanceDate: '2020-01-01' }

const txns: Transaction[] = [
  { id: 'j1', date: '2026-09-03', amount: 200, direction: 'in', categoryId: 'category-income', paymentMethod: 'bank_transfer', status: 'cleared', type: 'joint_deposit', location: 'joint', ownerId: 'me' },
  { id: 'j2', date: '2026-09-12', amount: 75, direction: 'out', categoryId: 'category-bills', paymentMethod: 'direct_debit', status: 'cleared', type: 'joint_withdrawal', location: 'joint', ownerId: 'me' },
]

const dataNoJoint: AppDataV2 = {
  primaryPersonId: 'me',
  people: [me],
  categories: [],
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  pensions: [],
  savingsPots: [],
  pots: [],
  transactions: [],
  payCycles: [payCycle],
  scenarios: [],
  jointAccount: null,
}
check('No joint account set up yet -> null, same convention as computeJointAccountProjection', buildJointTrendSeries(dataNoJoint, 'this_cycle', new Date(2026, 8, 15)), null)

const data: AppDataV2 = {
  ...dataNoJoint,
  transactions: txns,
  jointAccount: { openingBalance: 500, openingBalanceDate: '2020-01-01' },
}

const asOfDate = new Date(2026, 8, 15)
const series = buildJointTrendSeries(data, 'this_cycle', asOfDate)!
check('Joint series builds once a joint account exists', series !== null, true)
check('days span the current calendar-month cycle', [series.days[0], series.days[series.days.length - 1]], ['2026-09-01', '2026-09-30'])
check('Opening balance carries through before any activity', series.balance[0].clearedBalance, 500)
check('Deposit (3 Sep) increases clearedBalance to 700', series.balance.find((b) => b.date === '2026-09-03')!.clearedBalance, 700)
check('Withdrawal (12 Sep) reduces clearedBalance to 625', series.balance.find((b) => b.date === '2026-09-12')!.clearedBalance, 625)
check('Cumulative joint spend by 12 Sep = 75 (the one outgoing withdrawal)', series.spend.find((s) => s.date === '2026-09-12')!.spendToDate, 75)

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`)
  process.exit(1)
} else {
  console.log('\nAll Joint trend-series checks passed.')
}
