// "Manage upcoming payments" redesign (2026-09-10) — SavingsPot's
// recurring deposit (call site #4 in the redesign doc's inventory),
// identical shape/reasoning to potLedger.ts's own
// verify-pot-recurring-deposit-single-occurrence-amount.ts — see that
// script's header comment for the full background. Verifies
// resolveSavingsPotDepositOccurrenceAmount/
// applySavingsPotSingleDepositAmountChange against SavingsPot instead.

import { generateSavingsDepositTransactions, resolveSavingsPotDepositOccurrenceAmount, applySavingsPotSingleDepositAmountChange } from '../src/lib/savingsPotLedger'
import type { SavingsPot } from '../src/types/ledger'
import { addMonths } from 'date-fns'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const pot: SavingsPot = {
  id: 'sp1',
  personId: 'me',
  name: 'Test Savings Pot',
  openingBalance: 0,
  openingDate: '2026-01-01',
  active: true,
  interestMethod: { type: 'aer_credited', aer: 4.5, creditingFrequency: 'monthly' },
  recurringDepositAmount: 150,
  recurringDepositDayOfMonth: 1,
  recurringDepositStartDate: '2026-06-01',
}

const rangeStart = new Date('2026-06-01')
const rangeEnd = addMonths(rangeStart, 6)

const overrideDate = '2026-08-01'
const patch = applySavingsPotSingleDepositAmountChange(pot, 999, overrideDate)
const overridden: SavingsPot = { ...pot, ...patch }
const transactions = generateSavingsDepositTransactions(overridden, rangeStart, rangeEnd)

check('resolveSavingsPotDepositOccurrenceAmount reflects the override at its own date', resolveSavingsPotDepositOccurrenceAmount(overridden, overrideDate), 999)
check('The real ledger (generateSavingsDepositTransactions) agrees with the resolver', transactions.find((t) => t.date === overrideDate)?.amount, 999)
check('The month before is completely unaffected', transactions.find((t) => t.date === '2026-07-01')?.amount, 150)
check('The month after reverts to the standing amount — no leak forward', transactions.find((t) => t.date === '2026-09-01')?.amount, 150)
check('resolveSavingsPotDepositOccurrenceAmount for an un-overridden date falls back to the flat recurringDepositAmount', resolveSavingsPotDepositOccurrenceAmount(overridden, '2026-09-01'), 150)
check('The standing recurringDepositAmount is completely untouched', overridden.recurringDepositAmount, 150)

// Merges onto an existing date-move override rather than clobbering it.
const movedPot: SavingsPot = { ...pot, recurringDepositOverrides: [{ originalDate: overrideDate, date: '2026-08-15' }] }
const mergedPatch = applySavingsPotSingleDepositAmountChange(movedPot, 777, overrideDate)
check('Merging an amount override onto an existing date-move override keeps the moved date', mergedPatch.recurringDepositOverrides, [{ originalDate: overrideDate, date: '2026-08-15', amount: 777 }])

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll savingspot-recurring-deposit-single-occurrence-amount checks passed.')
