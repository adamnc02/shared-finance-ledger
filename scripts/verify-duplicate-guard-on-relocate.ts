// Batch 7, Bug 8.1 (2026-09-07, Adam-reported): "Repeatedly moving a
// bill's location from Personal -> Pot -> Personal, with a 'changes take
// effect from' date on/before an already-cleared occurrence, created a
// duplicate transaction in the personal ledger — repeating it a second
// time created a THIRD."
//
// Root cause (see autoClear.ts's own comment on `globalExistingKeys`):
// Step 2 (personal materialization) and Step 3 (pot-funded materialization)
// each used to build their OWN existingKeys set scoped to a single
// location — `location === 'personal'` for Step 2, `potId === pot.id` for
// Step 3 — rather than sharing one global set, even though dedupeKey
// (sourceType:sourceId:date) is already meant to uniquely key an
// occurrence "regardless of which entities are on either end" (Step 4's
// own pre-existing comment). Reassigning a bill's location with an
// effective-from date on/before an already-materialized occurrence
// rewrites that stored transaction's location/potId via
// reassignTransactionsForLocationChange — but the very next autoClear
// pass, if it read the data in a moment where that rewrite hadn't landed
// yet (or ran once right before, once right after two rapid
// reassignments), would find the existing transaction sitting under a
// location a given step's own narrow existingKeys wasn't scanning, so it
// materialized a brand new one for the exact same occurrence.
//
// This script simulates the actual repro end to end: create a bill
// (location: personal), let its first occurrence materialize and clear,
// simulate the Bills-page "move to pot, effective from an ALREADY-PAST
// date" relocation via reassignTransactionsForLocationChange (mirroring
// assignRecurringTemplateLocation's own two-part update), then "move
// back to personal" the same way with the SAME past effective-from date
// — then runs autoClearDuePayments and asserts there is still exactly
// ONE transaction for that occurrence, not two or three.

import { autoClearDuePayments } from '../src/lib/autoClear'
import { reassignTransactionsForLocationChange } from '../src/lib/locationChange'
import { defaultCategories } from '../src/lib/categories'
import { BILLS_CATEGORY_ID } from '../src/types/ledger'
import type { AppDataV2, PayCycleConfig, Person, Pot, RecurringTemplate } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const payCycle: PayCycleConfig = {
  personId: 'adam',
  openingBalance: 1000,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 1,
}

const person: Person = {
  id: 'adam',
  name: 'Adam',
  color: '#ff5b4c',
  salaryHistory: [],
  salaryOverrides: [],
}

const testBill: RecurringTemplate = {
  id: 'bill-test',
  name: 'Test',
  amount: 10,
  categoryId: BILLS_CATEGORY_ID,
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-09-03',
  location: 'personal',
  ownerId: 'adam',
  payee: '',
  payeeSharePercent: 100,
  active: true,
}

const billsPot: Pot = {
  id: 'pot-bills',
  personId: 'adam',
  name: 'Bills Pot',
  openingBalance: 24,
  openingDate: '2026-09-06',
  active: true,
}

const baseData: AppDataV2 = {
  people: [person],
  categories: defaultCategories(),
  recurringTemplates: [testBill],
  loans: [],
  creditCards: [],
  transactions: [],
  payCycles: [payCycle],
  pensions: [],
  scenarios: [],
  pots: [billsPot],
  primaryPersonId: 'adam',
}

// Step 1 — let the 3rd Sept occurrence materialize and clear, as of a date
// after it's due (matching "the cleared payment" in Adam's own repro).
const asOf = new Date(2026, 8, 7) // 7 Sept 2026, today per this session
let data = autoClearDuePayments(baseData, asOf)
const testBillTxns = () => data.transactions.filter((t) => t.sourceType === 'recurring_template' && t.sourceId === 'bill-test')

check('Exactly one Test bill transaction exists after the first materialization pass', testBillTxns().length, 1)
check('That transaction is dated 2026-09-03', testBillTxns()[0]?.date, '2026-09-03')
check('That transaction is location personal', testBillTxns()[0]?.location, 'personal')

// Step 2 — tag the bill to the Bills Pot, same two-part update
// assignRecurringTemplateLocation performs, effective from TODAY (as the
// pot's own "manage payments" checklist form defaults to) — this must
// NOT touch the already-cleared 3rd Sept transaction, matching "cleared
// payment still in my personal ledger" from Adam's own report.
function relocate(location: 'personal' | 'pot', effectiveFrom: string, potId?: string) {
  const template = data.recurringTemplates.find((t) => t.id === 'bill-test')!
  const updated: RecurringTemplate = { ...template, location, potId: location === 'pot' ? potId : undefined, locationEffectiveFrom: effectiveFrom }
  data = {
    ...data,
    recurringTemplates: data.recurringTemplates.map((t) => (t.id === 'bill-test' ? updated : t)),
    transactions: reassignTransactionsForLocationChange(data.transactions, 'recurring_template', 'bill-test', effectiveFrom, location, potId),
  }
  data = autoClearDuePayments(data, asOf)
}

relocate('pot', '2026-09-06', 'pot-bills')
check('After tagging to the pot (effective 09-06), the 09-03 cleared payment is untouched (still personal)', testBillTxns().find((t) => t.date === '2026-09-03')?.location, 'personal')
check('Still exactly one Test bill transaction after tagging to the pot', testBillTxns().length, 1)

// Step 3 — move it BACK to Current Account from the BILLS PAGE, with a
// "changes take effect from" date of 3rd Sept 2026 — a date ON/BEFORE
// the already-materialized occurrence. This is the exact repro: before
// the fix, this created a SECOND "Test £10" transaction in the personal
// ledger alongside the first.
relocate('personal', '2026-09-03', undefined)
check('Exactly ONE Test bill transaction after moving back to personal (no duplicate)', testBillTxns().length, 1)
check('The single remaining transaction is dated 09-03 and personal', testBillTxns()[0]?.date === '2026-09-03' && testBillTxns()[0]?.location === 'personal', true)

// Step 4 — repeat the same round-trip a second time (Adam's own repro:
// "I repeated the same test, and a third payment appeared") — must still
// be exactly one transaction, not two or three.
relocate('pot', '2026-09-06', 'pot-bills')
relocate('personal', '2026-09-03', undefined)
check('Still exactly ONE Test bill transaction after a second full round-trip', testBillTxns().length, 1)

console.log(failures === 0 ? '\nAll duplicate-guard-on-relocate checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
