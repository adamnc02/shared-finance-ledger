// Verifies lib/jointAccountLedger.ts (needsJointAccountSetup,
// jointAccountSignedAmount, computeJointAccountProjection) and
// lib/householdLedger.ts (joint-bill-share filtering) against a small,
// real AppDataV2 fixture — not synthetic assertions against invented
// numbers, but the actual generation/projection engine run end to end,
// same convention as this app's other verify-*.ts scripts.

import { computeProjection } from '../src/lib/projection'
import { computeJointAccountProjection, jointAccountSignedAmount, needsJointAccountSetup } from '../src/lib/jointAccountLedger'
import { computeHouseholdPersonProjection } from '../src/lib/householdLedger'
import { defaultCategories } from '../src/lib/categories'
import type { AppDataV2, Loan, Person, RecurringTemplate, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const CATS = defaultCategories()
const BILLS_CAT = CATS.find((c) => c.name === 'Bills')!.id

function person(id: string, name: string): Person {
  return { id, name, color: '#000000', salaryHistory: [], salaryOverrides: [] }
}

const personA = person('a', 'Adam')
const personB = person('b', 'Beverley')

const jointTemplate: RecurringTemplate = {
  id: 'joint-rent',
  name: 'Rent',
  amount: 100,
  categoryId: BILLS_CAT,
  paymentMethod: 'standing_order',
  frequency: 'monthly',
  anchorDate: '2026-09-15',
  location: 'joint',
  ownerId: '',
  payee: 'a',
  payeeSharePercent: 60,
  active: true,
}

const personalBillA: RecurringTemplate = {
  id: 'personal-phone-a',
  name: 'Phone',
  amount: 40,
  categoryId: BILLS_CAT,
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-09-10',
  location: 'personal',
  ownerId: 'a',
  payee: '',
  payeeSharePercent: 100,
  active: true,
}

// ---- 1. needsJointAccountSetup: true once a joint template exists with no jointAccount, false once set ----
const baseData: AppDataV2 = {
  people: [personA, personB],
  categories: CATS,
  recurringTemplates: [jointTemplate, personalBillA],
  loans: [],
  creditCards: [],
  pensions: [],
  savingsPots: [],
  transactions: [],
  payCycles: [
    { personId: 'a', openingBalance: 1000, openingBalanceDate: '2026-09-01', paydayDayOfMonth: 28, paydayAdjustForNonWorkingDay: true, cycleStartDayOfMonth: 1 },
    { personId: 'b', openingBalance: 500, openingBalanceDate: '2026-09-01', paydayDayOfMonth: 28, paydayAdjustForNonWorkingDay: true, cycleStartDayOfMonth: 1 },
  ],
  scenarios: [],
  jointAccount: null,
}

check('needsJointAccountSetup: true once a joint bill exists with no jointAccount', needsJointAccountSetup(baseData), true)
const withJointAccount: AppDataV2 = { ...baseData, jointAccount: { openingBalance: 500, openingBalanceDate: '2026-09-01' } }
check('needsJointAccountSetup: false once jointAccount is set', needsJointAccountSetup(withJointAccount), false)
check('needsJointAccountSetup: false with no joint-location bill/loan at all', needsJointAccountSetup({ ...baseData, recurringTemplates: [personalBillA], jointAccount: null }), false)

// ---- 2. jointAccountSignedAmount: type-derived, opposite of the personal-ledger sign for deposit/withdrawal ----
check('jointAccountSignedAmount: deposit is positive on the joint ledger', jointAccountSignedAmount({ type: 'joint_deposit', amount: 50 }), 50)
check('jointAccountSignedAmount: withdrawal is negative on the joint ledger', jointAccountSignedAmount({ type: 'joint_withdrawal', amount: 20 }), -20)
check('jointAccountSignedAmount: a joint bill payment is always negative', jointAccountSignedAmount({ type: 'bill_payment', amount: 100 }), -100)

// ---- 3. computeJointAccountProjection: opening balance + real deposit/withdrawal + real cleared joint bill ----
const clearedJointBill: Transaction = {
  id: 'jb1',
  date: '2026-09-05',
  amount: 100,
  direction: 'out',
  categoryId: BILLS_CAT,
  paymentMethod: 'standing_order',
  status: 'cleared',
  type: 'bill_payment',
  location: 'joint',
  ownerId: '',
  payee: 'a',
  payeeSharePercent: 60,
  sourceType: 'recurring_template',
  sourceId: 'joint-rent',
}
const deposit: Transaction = {
  id: 'dep1',
  date: '2026-09-03',
  amount: 50,
  direction: 'out',
  categoryId: 'category-seed-joint',
  paymentMethod: 'bank_transfer',
  status: 'cleared',
  type: 'joint_deposit',
  location: 'personal',
  ownerId: 'a',
  personId: 'a',
}
const withdrawal: Transaction = {
  id: 'wd1',
  date: '2026-09-04',
  amount: 20,
  direction: 'in',
  categoryId: 'category-seed-joint',
  paymentMethod: 'bank_transfer',
  status: 'cleared',
  type: 'joint_withdrawal',
  location: 'personal',
  ownerId: 'b',
  personId: 'b',
}

const jointData: AppDataV2 = {
  ...withJointAccount,
  transactions: [clearedJointBill, deposit, withdrawal],
}

const jointProjection = computeJointAccountProjection(jointData, 'current_cycle', new Date('2026-09-20'))
check('computeJointAccountProjection: exists once jointAccount is set', jointProjection !== null, true)
check('computeJointAccountProjection: clearedBalance = 500 - 100 (bill) + 50 (deposit) - 20 (withdrawal) = 430', jointProjection?.clearedBalance, 430)
check(
  'computeJointAccountProjection: transaction list includes the deposit, withdrawal, and the real joint bill (deduped against the generated occurrence)',
  jointProjection?.transactions.filter((t) => ['dep1', 'wd1', 'jb1'].includes(t.id)).length,
  3,
)

check('computeJointAccountProjection: null before a joint account exists', computeJointAccountProjection(baseData, 'current_cycle'), null)

// ---- 4. computeHouseholdPersonProjection: personal bill + joint_deposit included, joint-bill SHARE excluded ----
const personalDataForA: AppDataV2 = {
  ...jointData,
  transactions: [
    ...jointData.transactions,
    {
      id: 'phone-a-cleared',
      date: '2026-09-08',
      amount: 40,
      direction: 'out',
      categoryId: BILLS_CAT,
      paymentMethod: 'direct_debit',
      status: 'cleared',
      type: 'bill_payment',
      location: 'personal',
      ownerId: 'a',
      sourceType: 'recurring_template',
      sourceId: 'personal-phone-a',
    },
  ],
}

// UAT Batch 4 (2026-09-04, Adam-specified): the Personal ledger used to
// include a synthetic share of the joint bill — deliberately reversed,
// Personal now shows nothing about joint bills at all. The Household
// filter (householdLedger.ts) is kept regardless, since it's still
// correct for any already-stored cleared row from before that change.
const personACycle = personalDataForA.payCycles.find((pc) => pc.personId === 'a')!
const personalProjectionA = computeProjection(personalDataForA, 'a', personACycle, 'current_cycle', new Date('2026-09-20'))
const personalHasJointShare = personalProjectionA.transactions.some((t) => t.sourceType === 'recurring_template' && t.sourceId === 'joint-rent')
check('Person A\'s OWN personal projection does NOT include their share of the joint rent', personalHasJointShare, false)

const householdA = computeHouseholdPersonProjection(personalDataForA, 'a', 'current_cycle', new Date('2026-09-20'))
const householdHasJointShare = householdA?.transactions.some((t) => t.sourceType === 'recurring_template' && t.sourceId === 'joint-rent')
check('computeHouseholdPersonProjection: joint-bill SHARE is excluded from the Household card', householdHasJointShare, false)
const householdHasPersonalBill = householdA?.transactions.some((t) => t.id === 'phone-a-cleared')
check('computeHouseholdPersonProjection: personal bill IS included', householdHasPersonalBill, true)
const householdHasDeposit = householdA?.transactions.some((t) => t.id === 'dep1')
check('computeHouseholdPersonProjection: joint_deposit IS included (the one joint-related item Household shows)', householdHasDeposit, true)
check(
  "computeHouseholdPersonProjection: clearedBalance excludes the joint share (1000 - 40 phone - 50 deposit = 910, NOT further reduced by the joint rent share)",
  householdA?.clearedBalance,
  910,
)

// ---- Summary ----
console.log('\n' + (failures === 0 ? `All checks passed.` : `${failures} check(s) FAILED.`))
process.exit(failures === 0 ? 0 : 1)
