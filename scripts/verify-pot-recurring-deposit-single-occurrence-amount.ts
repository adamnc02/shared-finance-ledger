// "Manage upcoming payments" redesign (2026-09-10) — Pot's recurring
// deposit (call site #5 in the redesign doc's inventory) gained a
// single-occurrence amount-write mechanism for the first time.
// Previously `recurringDepositOverrides` only ever carried
// {deleted: true} pause markers — nothing populated `.amount`, and
// nothing display-side resolved one even though the generator
// (walkPotDepositOccurrences, via generatePotDepositTransactions) already
// read override.amount when present. Verifies the new
// resolvePotDepositOccurrenceAmount/applyPotSingleDepositAmountChange
// pair, and that the resolver and the real generator agree.

import { generatePotDepositTransactions, resolvePotDepositOccurrenceAmount, applyPotSingleDepositAmountChange } from '../src/lib/potLedger'
import type { Pot } from '../src/types/ledger'
import { addMonths } from 'date-fns'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const pot: Pot = {
  id: 'pot1',
  personId: 'me',
  name: 'Test Pot',
  openingBalance: 0,
  openingDate: '2026-01-01',
  active: true,
  recurringDepositAmount: 200,
  recurringDepositDayOfMonth: 1,
  recurringDepositStartDate: '2026-06-01',
}

const rangeStart = new Date('2026-06-01')
const rangeEnd = addMonths(rangeStart, 6)

const overrideDate = '2026-08-01'
const patch = applyPotSingleDepositAmountChange(pot, 999, overrideDate)
const overridden: Pot = { ...pot, ...patch }
const transactions = generatePotDepositTransactions(overridden, rangeStart, rangeEnd)

check('resolvePotDepositOccurrenceAmount reflects the override at its own date', resolvePotDepositOccurrenceAmount(overridden, overrideDate), 999)
check('The real ledger (generatePotDepositTransactions) agrees with the resolver', transactions.find((t) => t.date === overrideDate)?.amount, 999)
check('The month before is completely unaffected', transactions.find((t) => t.date === '2026-07-01')?.amount, 200)
check('The month after reverts to the standing amount — no leak forward', transactions.find((t) => t.date === '2026-09-01')?.amount, 200)
check('resolvePotDepositOccurrenceAmount for an un-overridden date falls back to the flat recurringDepositAmount', resolvePotDepositOccurrenceAmount(overridden, '2026-09-01'), 200)
check('The standing recurringDepositAmount is completely untouched', overridden.recurringDepositAmount, 200)

// Merges onto an existing date-move override rather than clobbering it.
const movedPot: Pot = { ...pot, recurringDepositOverrides: [{ originalDate: overrideDate, date: '2026-08-15' }] }
const mergedPatch = applyPotSingleDepositAmountChange(movedPot, 777, overrideDate)
check('Merging an amount override onto an existing date-move override keeps the moved date', mergedPatch.recurringDepositOverrides, [{ originalDate: overrideDate, date: '2026-08-15', amount: 777 }])

// A pot with no recurringDepositAmount set at all (never configured) —
// resolver should fall back to 0, not throw/NaN.
const emptyPot: Pot = { id: 'pot2', personId: 'me', name: 'Empty', openingBalance: 0, openingDate: '2026-01-01', active: true }
check('resolvePotDepositOccurrenceAmount on a pot with no recurring deposit configured falls back to 0', resolvePotDepositOccurrenceAmount(emptyPot, '2026-08-01'), 0)

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll pot-recurring-deposit-single-occurrence-amount checks passed.')
