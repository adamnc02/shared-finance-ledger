import { reconcilePersonReferences } from '../src/lib/household'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { defaultCategories } from '../src/lib/categories'
import type { AppDataV2, Loan, RecurringTemplate, CreditCard, Person } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

function person(id: string, name: string): Person {
  return { id, name, color: '#000000', salaryHistory: [], salaryOverrides: [] }
}

function bill(overrides: Partial<RecurringTemplate>): RecurringTemplate {
  return {
    id: 'bill-1',
    name: 'Rent',
    amount: 100,
    categoryId: 'cat-1',
    paymentMethod: 'standing_order',
    frequency: 'monthly',
    anchorDate: '2026-01-01',
    location: 'personal',
    ownerId: 'me',
    payee: '',
    payeeSharePercent: 100,
    active: true,
    ...overrides,
  }
}

function loan(overrides: Partial<Loan>): Loan {
  return {
    id: 'loan-1',
    name: 'Car',
    monthlyPayment: 200,
    termMonths: 12,
    startDate: '2026-01-01',
    categoryId: 'cat-2',
    location: 'personal',
    ownerId: 'me',
    payee: '',
    payeeSharePercent: 100,
    overpayments: [],
    ...overrides,
  }
}

function card(overrides: Partial<CreditCard>): CreditCard {
  return {
    id: 'card-1',
    name: 'Visa',
    categoryId: 'cat-3',
    color: '#fff',
    interestRatePercent: 0,
    currentBalance: 0,
    minimumPayment: { type: 'percent_of_balance', percent: 5 },
    paymentDayOfMonth: 1,
    ownerId: 'me',
    lumpPayments: [],
    active: true,
    ...overrides,
  }
}

function baseData(overrides: Partial<AppDataV2>): AppDataV2 {
  return {
    people: [person('me', 'Me')],
    categories: defaultCategories(),
    recurringTemplates: [],
    loans: [],
    creditCards: [],
    transactions: [],
    payCycles: [],
    pensions: [],
    scenarios: [],
    primaryPersonId: 'me',
    ...overrides,
  }
}

// ---- 1. The reported scenario: rename "Me" by adding a new person then deleting "Me",
// with a joint bill created while both existed. The joint bill should NOT keep the
// Household toggle alive once only one real person is left. ----
const renamedFlow = reconcilePersonReferences(
  baseData({
    people: [person('adam', 'Adam')], // "me" already removed by the time this runs
    recurringTemplates: [bill({ id: 'joint-bill', location: 'joint', ownerId: '', payee: 'me', payeeSharePercent: 60 })],
    primaryPersonId: 'me', // stale — the removed person was primary
  }),
)
check('Orphaned joint bill falls back to personal', renamedFlow.recurringTemplates[0].location, 'personal')
check('...owned by the one remaining person', renamedFlow.recurringTemplates[0].ownerId, 'adam')
check('...payee cleared (no longer meaningful for a personal item)', renamedFlow.recurringTemplates[0].payee, '')
check('...payeeSharePercent reset to 100', renamedFlow.recurringTemplates[0].payeeSharePercent, 100)
check('Stale primaryPersonId is reassigned to the remaining person', renamedFlow.primaryPersonId, 'adam')

// ---- 2. A personal bill/loan/card owned by the removed person should reassign to
// whoever's left, not silently vanish from that person's totals/rings. ----
const personalReassign = reconcilePersonReferences(
  baseData({
    people: [person('adam', 'Adam')],
    recurringTemplates: [bill({ ownerId: 'me' })],
    loans: [loan({ ownerId: 'me' })],
    creditCards: [card({ ownerId: 'me' })],
    primaryPersonId: 'adam',
  }),
)
check('Orphaned personal bill reassigned to remaining person', personalReassign.recurringTemplates[0].ownerId, 'adam')
check('Orphaned personal loan reassigned to remaining person', personalReassign.loans[0].ownerId, 'adam')
check('Orphaned personal credit card reassigned to remaining person', personalReassign.creditCards[0].ownerId, 'adam')

// ---- 3. With 2+ people still remaining, a genuinely joint item should be left alone
// (still joint) UNLESS its specific payee was the one removed. ----
const stillJoint = reconcilePersonReferences(
  baseData({
    people: [person('adam', 'Adam'), person('ella', 'Ella')],
    recurringTemplates: [
      bill({ id: 'valid-joint', location: 'joint', ownerId: '', payee: 'adam', payeeSharePercent: 60 }),
      bill({ id: 'dangling-payee-joint', location: 'joint', ownerId: '', payee: 'removed-person', payeeSharePercent: 50 }),
    ],
    primaryPersonId: 'adam',
  }),
)
check('A joint item with a still-valid payee is untouched', stillJoint.recurringTemplates[0].location, 'joint')
check('...payee unchanged', stillJoint.recurringTemplates[0].payee, 'adam')
check('A joint item whose payee was removed falls back to the remaining primary person', stillJoint.recurringTemplates[1].payee, 'adam')
check('...but stays joint, since 2+ people still exist', stillJoint.recurringTemplates[1].location, 'joint')

// ---- 4. migrateLedgerData runs the same reconciliation, so data already saved from
// before this fix (or a backup restored from that state) self-heals on load. ----
const migrated = migrateLedgerData(
  baseData({
    people: [person('adam', 'Adam')],
    recurringTemplates: [bill({ location: 'joint', ownerId: '', payee: 'me', payeeSharePercent: 60 })],
    primaryPersonId: 'me',
  }),
)
check('migrateLedgerData also reconciles stale references on load', migrated.recurringTemplates[0].location, 'personal')
check('...and fixes the stale primaryPersonId', migrated.primaryPersonId, 'adam')

// ---- 5. A single person who was never involved in anything joint is a no-op — the
// fix should not touch data that was never broken. ----
const untouched = reconcilePersonReferences(
  baseData({
    people: [person('adam', 'Adam')],
    recurringTemplates: [bill({ ownerId: 'adam' })],
    primaryPersonId: 'adam',
  }),
)
check('A healthy single-person setup is left exactly as-is', untouched.recurringTemplates[0], bill({ ownerId: 'adam' }))

// ---- 6. Pensions and savings pots are ALSO reassigned, not just left dangling —
// this was a real gap found in the UI consistency review: everything above already
// worked, these two didn't. ----
const pensionAndPotReassigned = reconcilePersonReferences({
  ...baseData({ people: [person('adam', 'Adam')], primaryPersonId: 'adam' }),
  pensions: [{ id: 'p1', personId: 'me', name: 'State Pension', amount: 500, frequency: 'monthly', anchorDate: '2026-01-01', active: true, adjustForNonWorkingDay: false, cycleStartFollowsPayday: false }],
  savingsPots: [{ id: 'sp1', personId: 'me', name: 'Rainy day', openingBalance: 0, openingDate: '2026-01-01', active: true, interestMethod: { type: 'aer_credited', aer: 4, creditingFrequency: 'monthly' } }],
})
check('A pension owned by a removed person is reassigned to the fallback', pensionAndPotReassigned.pensions[0].personId, 'adam')
check('A savings pot owned by a removed person is reassigned to the fallback', pensionAndPotReassigned.savingsPots[0].personId, 'adam')

// ---- 7. A fixture that omits pensions/savingsPots entirely (the shape every fixture
// above already uses) must not crash — this is the exact regression a first pass at
// fix #6 introduced (data.pensions.map on undefined) before adding the `?? []` guard. ----
const missingArraysFixture = reconcilePersonReferences(
  baseData({ people: [person('adam', 'Adam')], primaryPersonId: 'adam' }),
)
check('Reconciling data with no pensions/savingsPots arrays at all does not throw', Array.isArray(missingArraysFixture.pensions), true)

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`)
  process.exit(1)
} else {
  console.log('\nAll household/person-reconciliation checks passed.')
}
