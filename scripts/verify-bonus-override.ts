import { computeNetPayForPeriod, computeSnapshotNetPayForPeriod, computeNetBonusAmount } from '../src/lib/salaryLedger'
import type { Person } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

const person: Person = {
  id: 'p1',
  name: 'Adam',
  color: '#000',
  salaryHistory: [
    {
      id: 's1',
      personId: 'p1',
      effectiveFrom: '2026-01-01',
      grossAnnual: 60000,
      taxCode: '1257L',
      studentLoanPlan: 'none',
      payFrequency: 'monthly',
      deductions: [],
      employerPensionPercent: 5,
    },
  ],
  salaryOverrides: [],
}

const baseNet = computeSnapshotNetPayForPeriod(person, '2026-09-30')!
check('Base net pay (no override) matches computeNetPayForPeriod', computeNetPayForPeriod(person, '2026-09-30'), baseNet)

// Simulate attaching a £1000 gross bonus the way AttachBonusButton does now.
const bonusNet = computeNetBonusAmount(person, '2026-09-30', 1000)!
const withBonus: Person = {
  ...person,
  salaryOverrides: [
    { id: 'o1', personId: 'p1', payPeriodDate: '2026-09-30', netPayOverride: baseNet + bonusNet, reason: 'Bonus (£1,000.00 gross)', bonusGrossAmount: 1000 },
  ],
}
check('Net pay for the period reflects base + taxed bonus', computeNetPayForPeriod(withBonus, '2026-09-30'), Math.round((baseNet + bonusNet) * 100) / 100)
check('Bonus net pay is less than the gross amount (it was taxed)', bonusNet < 1000, true)
check('Snapshot-only net pay for the SAME date ignores the override entirely', computeSnapshotNetPayForPeriod(withBonus, '2026-09-30'), baseNet)
check('A different, unrelated period is completely untouched by this override', computeNetPayForPeriod(withBonus, '2026-10-30'), computeSnapshotNetPayForPeriod(withBonus, '2026-10-30'))

// Simulate a plain manual net-pay override (the "Override net pay" control).
const manualOverride: Person = {
  ...person,
  salaryOverrides: [{ id: 'o2', personId: 'p1', payPeriodDate: '2026-09-30', netPayOverride: 2500, reason: 'Net pay manually overridden (this payment only)' }],
}
check('Manual override returns exactly the typed figure, bypassing the tax engine', computeNetPayForPeriod(manualOverride, '2026-09-30'), 2500)
check('Manual override has no bonusGrossAmount tag', manualOverride.salaryOverrides[0].bonusGrossAmount, undefined)
check('A manual override on one period never affects the next period', computeNetPayForPeriod(manualOverride, '2026-10-30'), baseNet)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll bonus/override checks passed.')
