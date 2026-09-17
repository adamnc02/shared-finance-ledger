// PROMPT-05 (2026-09-16) — delete-reassign flows, RESTRICT semantics
// (DECISIONS-2026-09-15.md Q5).
//
// Before this, deleting a Person silently handed everything they owned to
// the primary person, and deleting a Pot silently moved its bills/loans to
// Personal. Three references were never cleaned up at all, each confirmed
// by a repro against `bee3feef` before being fixed:
//  - Gap 2: a recurring transfer into/out of a deleted pot or savings pot
//    kept materialising — £50 a month out of Personal into a pot that no
//    longer existed.
//  - Gap 3: a pending Pot→Pot transfer escaped the sweep when the deleted
//    pot was the side the flat `potId` doesn't record (APP-KNOWLEDGE §1.4).
//  - Gap 4: a savings pot's `interestDestination` kept pointing at a
//    deleted pot.
// Section 1 uses only functions that existed before the fix, and fails
// against that commit.
//
// Also asserted: every blocker type blocks on its own; after resolving
// them, nothing anywhere in AppDataV2 points at an id that no longer
// exists; cleared transactions of a deleted person are untouched
// (APP-KNOWLEDGE §1.1); and both real backups either delete cleanly or
// block with a complete list.

import { readFileSync } from 'node:fs'
import { defaultLedgerData, defaultPayCycleConfig, parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { reconcilePersonReferences } from '../src/lib/household'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { buildTransferTransaction } from '../src/lib/transferLedger'
import { newSavingsPot } from '../src/lib/savingsPotLedger'
import {
  applyBlockerAction,
  applyBlockerActionToAll,
  blockerTargetOptions,
  canDeleteBlocker,
  findDeleteBlockers,
  removePersonFromData,
  removePotFromData,
  removeSavingsPotFromData,
  resolveBlockersAndDelete,
  type BlockerAction,
  type DeleteSubject,
} from '../src/lib/deleteReassign'
import type { AppDataV2, CreditCard, Loan, Pension, Person, Pot, RecurringTemplate, SavingsPot, Transaction, TransferLocation } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const ASOF = '2026-06-01'
const BACKUP_DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger'

// ── Independent dangling-reference scan ───────────────────────────────
// Deliberately NOT built from deleteReassign.ts — it walks every live id
// reference in AppDataV2 and reports any that no longer resolves.
// Excluded on purpose: CLEARED transactions (history, SET NULL later),
// locationHistory (audit trail), and '' used for "unset" (§11.1).
function danglingReferences(data: AppDataV2): string[] {
  const people = new Set(data.people.map((p) => p.id))
  const pots = new Set(data.pots.map((p) => p.id))
  const savings = new Set(data.savingsPots.map((p) => p.id))
  const pensions = new Set(data.pensions.map((p) => p.id))
  const txnIds = new Set(data.transactions.map((t) => t.id))
  const out: string[] = []
  const person = (where: string, id: string | undefined) => {
    if (id && !people.has(id)) out.push(`${where} → person ${id}`)
  }
  const endpoint = (where: string, l: TransferLocation | undefined) => {
    if (l?.type === 'pot' && !pots.has(l.potId ?? '')) out.push(`${where} → pot ${l.potId}`)
    if (l?.type === 'savings' && !savings.has(l.savingsPotId ?? '')) out.push(`${where} → savings pot ${l.savingsPotId}`)
  }
  if (!people.has(data.primaryPersonId)) out.push(`primaryPersonId → ${data.primaryPersonId}`)
  for (const p of data.pensions) person(`pension ${p.name}`, p.personId)
  for (const p of data.savingsPots) {
    person(`savings pot ${p.name}`, p.personId)
    endpoint(`savings pot ${p.name} interestDestination`, p.interestDestination)
  }
  for (const p of data.pots) person(`pot ${p.name}`, p.personId)
  for (const t of data.recurringTemplates) {
    if (t.location === 'joint') person(`template ${t.name} payee`, t.payee)
    else person(`template ${t.name} ownerId`, t.ownerId)
    person(`template ${t.name} personId`, t.personId)
    if (t.location === 'pot' && !pots.has(t.potId ?? '')) out.push(`template ${t.name} → pot ${t.potId}`)
    endpoint(`template ${t.name} transferFrom`, t.transferFrom)
    endpoint(`template ${t.name} transferTo`, t.transferTo)
  }
  for (const l of data.loans) {
    if (l.location === 'joint') person(`loan ${l.name} payee`, l.payee)
    else person(`loan ${l.name} ownerId`, l.ownerId)
    if (l.location === 'pot' && !pots.has(l.potId ?? '')) out.push(`loan ${l.name} → pot ${l.potId}`)
    if (l.recurringOverpayment?.location === 'pot' && !pots.has(l.recurringOverpayment.potId ?? '')) out.push(`loan ${l.name} overpayment → pot`)
  }
  for (const c of data.creditCards) person(`card ${c.name}`, c.ownerId)
  for (const pc of data.payCycles) {
    person('payCycle', pc.personId)
    if (pc.followsIncomeSource?.type === 'pension' && !pensions.has(pc.followsIncomeSource.pensionId)) out.push('payCycle → pension')
  }
  for (const t of data.transactions) {
    if (t.status !== 'pending') continue
    person(`pending ${t.id} ownerId`, t.ownerId)
    person(`pending ${t.id} personId`, t.personId)
    if (t.potId && !pots.has(t.potId)) out.push(`pending ${t.id} potId`)
    if (t.savingsPotId && !savings.has(t.savingsPotId)) out.push(`pending ${t.id} savingsPotId`)
    endpoint(`pending ${t.id} from`, t.fromLocation)
    endpoint(`pending ${t.id} to`, t.toLocation)
  }
  for (const s of data.salarySorts) for (const tg of s.targets) if (!txnIds.has(tg.transactionId)) out.push(`salary sort target → transaction ${tg.transactionId}`)
  return out
}

// ── Fixture ────────────────────────────────────────────────────────────
const base = defaultLedgerData()
const ADAM = base.primaryPersonId
const ELLA = 'ella'
const person = (id: string, name: string): Person => ({ id, name, color: '#7c6fe0', salaryHistory: [], salaryOverrides: [] })

function template(id: string, overrides: Partial<RecurringTemplate>): RecurringTemplate {
  return {
    id,
    name: id,
    amount: 50,
    categoryId: 'category-bills',
    paymentMethod: 'direct_debit',
    frequency: 'monthly',
    anchorDate: '2026-02-01',
    location: 'personal',
    ownerId: ADAM,
    payee: '',
    payeeSharePercent: 100,
    active: true,
    ...overrides,
  } as RecurringTemplate
}
const transfer = (id: string, from: TransferLocation, to: TransferLocation): RecurringTemplate =>
  template(id, { kind: 'transfer', transferFrom: from, transferTo: to, categoryId: 'category-savings', paymentMethod: 'bank_transfer' })

function loan(id: string, overrides: Partial<Loan>): Loan {
  return {
    id,
    name: id,
    monthlyPayment: 200,
    termMonths: 24,
    startDate: '2026-01-01',
    principal: 4000,
    categoryId: 'category-bills',
    location: 'personal',
    ownerId: ADAM,
    payee: '',
    payeeSharePercent: 100,
    overpayments: [],
    active: true,
    ...overrides,
  } as Loan
}

function txn(id: string, overrides: Partial<Transaction>): Transaction {
  return {
    id,
    date: '2026-03-01',
    amount: 25,
    direction: 'out',
    categoryId: 'category-bills',
    paymentMethod: 'card',
    status: 'cleared',
    type: 'expense',
    location: 'personal',
    ownerId: ADAM,
    ...overrides,
  } as Transaction
}

const pot = (id: string, personId: string, name: string): Pot => ({ id, personId, name, openingBalance: 100, openingDate: '2026-01-01', active: true, color: '#000' })
const savingsPot = (id: string, personId: string, name: string, interestDestination?: TransferLocation): SavingsPot => ({
  ...newSavingsPot({ personId, name, openingBalance: 1000, openingDate: '2026-01-01', interestMethod: { type: 'aer_credited', aer: 4, creditingFrequency: 'monthly' } } as Parameters<typeof newSavingsPot>[0]),
  id,
  interestDestination,
})

const pension: Pension = {
  id: 'ella-pension',
  personId: ELLA,
  name: 'Ella pension',
  amount: 300,
  frequency: 'monthly',
  anchorDate: '2026-01-15',
  active: true,
  adjustForNonWorkingDay: false,
  cycleStartFollowsPayday: false,
}
const card: CreditCard = {
  id: 'ella-card',
  name: 'Ella card',
  categoryId: 'category-credit-card',
  color: '#000',
  interestRatePercent: 20,
  currentBalance: 500,
  balanceAsOfDate: '2026-01-01',
  minimumPayment: { type: 'fixed', amount: 25 },
  paymentDayOfMonth: 14,
  ownerId: ELLA,
  lumpPayments: [],
  active: true,
} as CreditCard

function household(): AppDataV2 {
  return {
    ...base,
    people: [...base.people, person(ELLA, 'Ella')],
    payCycles: [defaultPayCycleConfig(ADAM), { ...defaultPayCycleConfig(ELLA), followsIncomeSource: { type: 'pension', pensionId: pension.id } }],
    jointAccount: { openingBalance: 0, openingBalanceDate: '2026-01-01' },
    pensions: [pension],
    savingsPots: [savingsPot('ella-savings', ELLA, 'Ella ISA'), savingsPot('adam-savings', ADAM, 'Adam ISA')],
    pots: [pot('ella-pot', ELLA, 'Ella bills'), pot('adam-pot', ADAM, 'Adam bills'), pot('adam-pot-2', ADAM, 'Holiday')],
    recurringTemplates: [
      template('ella-bill', { ownerId: ELLA }),
      template('ella-income', { kind: 'transaction', recurringTransactionType: 'income', ownerId: ELLA, personId: ELLA }),
      template('joint-ella-payee', { location: 'joint', ownerId: '', payee: ELLA, payeeSharePercent: 60 }),
      template('joint-adam-50', { location: 'joint', ownerId: '', payee: ADAM, payeeSharePercent: 50 }),
      template('joint-adam-100', { location: 'joint', ownerId: '', payee: ADAM, payeeSharePercent: 100 }), // Ella pays 0% — not involved
      template('adam-bill', {}),
    ],
    loans: [loan('ella-loan', { ownerId: ELLA, recurringOverpayment: { startDate: '2026-02-01', amount: { type: 'fixed', amount: 20 } } }), loan('joint-loan', { location: 'joint', ownerId: '', payee: ADAM, payeeSharePercent: 50 })],
    creditCards: [card],
    transactions: [
      // Ella's history — must survive every step byte-for-byte.
      txn('ella-cleared-1', { ownerId: ELLA, amount: 12.34 }),
      txn('ella-cleared-2', { ownerId: ELLA, personId: ELLA, type: 'income', direction: 'in', amount: 900 }),
      txn('ella-cleared-3', { ownerId: ELLA, creditCardId: 'ella-card', type: 'credit_card_spend' }),
      // A hand-logged upcoming expense of Ella's.
      txn('ella-pending', { ownerId: ELLA, status: 'pending', date: '2099-01-01' }),
    ],
  }
}

// ─────────────────────────────────────────────────────────────────────
// 1. Gaps 2–4 — FAIL against bee3feef (removeXFromData, pre-fix)
// ─────────────────────────────────────────────────────────────────────
{
  const data: AppDataV2 = {
    ...household(),
    savingsPots: [savingsPot('sav-a', ADAM, 'Rainy'), savingsPot('sav-b', ADAM, 'Interest into pot', { type: 'pot', potId: 'pot-b' }), savingsPot('sav-c', ADAM, 'Interest into sav-a', { type: 'savings', savingsPotId: 'sav-a' })],
    pots: [pot('pot-a', ADAM, 'Bills'), pot('pot-b', ADAM, 'Holiday')],
    recurringTemplates: [
      transfer('into-pot-b', { type: 'personal' }, { type: 'pot', potId: 'pot-b' }),
      transfer('out-of-pot-b', { type: 'pot', potId: 'pot-b' }, { type: 'pot', potId: 'pot-a' }),
      transfer('into-sav-a', { type: 'personal' }, { type: 'savings', savingsPotId: 'sav-a' }),
    ],
    loans: [],
    creditCards: [],
    transactions: [
      { ...buildTransferTransaction({ type: 'pot', potId: 'pot-a' }, { type: 'pot', potId: 'pot-b' }, 80, '2099-01-10', ADAM), id: 'pend-a-to-b', status: 'pending' },
      { ...buildTransferTransaction({ type: 'savings', savingsPotId: 'sav-c' }, { type: 'savings', savingsPotId: 'sav-a' }, 30, '2099-01-11', ADAM), id: 'pend-c-to-a', status: 'pending' },
    ],
  }
  check('[fixture] the Pot→Pot pending transfer records only its FROM pot in the flat potId', data.transactions[0].potId, 'pot-a')

  const noPotB = removePotFromData(data, 'pot-b', ASOF)
  const intoB = noPotB.recurringTemplates.find((t) => t.id === 'into-pot-b')
  check('Gap 2: a recurring transfer INTO a deleted pot no longer points at it', intoB?.transferTo?.potId === 'pot-b', false)
  check('Gap 2: a recurring transfer OUT OF a deleted pot no longer points at it', noPotB.recurringTemplates.find((t) => t.id === 'out-of-pot-b')?.transferFrom?.potId === 'pot-b', false)
  const materialised = autoClearDuePayments(noPotB, new Date(2026, 5, 1)).transactions.filter((t) => t.sourceId === 'into-pot-b')
  check('Gap 2: ...and it stops taking money out of Personal (no rows materialised after the delete)', materialised.length, 0)
  const noSavA = removeSavingsPotFromData(data, 'sav-a', ASOF)
  check('Gap 2: a recurring transfer into a deleted SAVINGS pot no longer points at it', noSavA.recurringTemplates.find((t) => t.id === 'into-sav-a')?.transferTo?.savingsPotId === 'sav-a', false)
  check('Gap 3: a pending Pot→Pot transfer whose TO pot is deleted is swept, not stranded', noPotB.transactions.some((t) => t.id === 'pend-a-to-b'), false)
  check('Gap 3: a pending Savings→Savings transfer whose TO savings pot is deleted is swept', noSavA.transactions.some((t) => t.id === 'pend-c-to-a'), false)
  check("Gap 4: a savings pot's interestDestination pointing at a deleted pot is reset to itself", noPotB.savingsPots.find((s) => s.id === 'sav-b')?.interestDestination, undefined)
  check("Gap 4: ...and one pointing at a deleted savings pot", noSavA.savingsPots.find((s) => s.id === 'sav-c')?.interestDestination, undefined)
  check('Gaps 2–4: nothing dangling after deleting the pot', danglingReferences(noPotB), [])
  check('Gaps 2–4: nothing dangling after deleting the savings pot', danglingReferences(noSavA), [])
  check('Gap 2 backstop: a transfer with a dead endpoint is switched off, not redirected', intoB?.active, false)
}

// ─────────────────────────────────────────────────────────────────────
// 2. Deleting a person is blocked, once per type
// ─────────────────────────────────────────────────────────────────────
const ellaSubject: DeleteSubject = { type: 'person', id: ELLA }
{
  const data = household()
  const blockers = findDeleteBlockers(data, ellaSubject)
  const keys = blockers.map((b) => b.key).sort()
  check('Ella is blocked by exactly these items', keys, [
    'creditCard:ella-card',
    'loan:ella-loan',
    'loan:joint-loan',
    'pension:ella-pension',
    'pot:ella-pot',
    'savingsPot:ella-savings',
    'template:ella-bill',
    'template:ella-income',
    'template:joint-adam-50',
    'template:joint-ella-payee',
    'transaction:ella-pending',
  ])
  const groupOf = (key: string) => blockers.find((b) => b.key === key)?.group
  check('pension → Pensions', groupOf('pension:ella-pension'), 'pensions')
  check('savings pot → Savings pots', groupOf('savingsPot:ella-savings'), 'savingsPots')
  check('pot → Pots', groupOf('pot:ella-pot'), 'pots')
  check('bill → Bills', groupOf('template:ella-bill'), 'bills')
  check('recurring income → Recurring transactions', groupOf('template:ella-income'), 'recurringTransactions')
  check('loan → Loans', groupOf('loan:ella-loan'), 'loans')
  check('credit card → Credit cards', groupOf('creditCard:ella-card'), 'creditCards')
  check('joint bill where Ella is payee → Joint account splits', groupOf('template:joint-ella-payee'), 'jointSplits')
  check("joint bill where Ella pays the other 50% → Joint account splits", groupOf('template:joint-adam-50'), 'jointSplits')
  check('joint LOAN split → Joint account splits', groupOf('loan:joint-loan'), 'jointSplits')
  check('hand-logged pending transaction → Upcoming transactions', groupOf('transaction:ella-pending'), 'upcomingTransactions')
  check("a joint bill Adam pays 100% of is NOT Ella's", keys.includes('template:joint-adam-100'), false)
  check("Adam's own bill is not listed", keys.includes('template:adam-bill'), false)
  check("Ella's CLEARED transactions never block", blockers.some((b) => b.id.startsWith('ella-cleared')), false)
  check('the split detail names what Ella pays', blockers.find((b) => b.key === 'template:joint-adam-50')?.detail, 'Ella pays 50%')

  // Each type blocks on its own.
  const only = (patch: Partial<AppDataV2>): AppDataV2 => ({ ...household(), pensions: [], savingsPots: [], pots: [], recurringTemplates: [], loans: [], creditCards: [], transactions: [], ...patch })
  const full = household()
  const soloCases: [string, Partial<AppDataV2>][] = [
    ['pension', { pensions: full.pensions }],
    ['savings pot', { savingsPots: full.savingsPots.filter((s) => s.personId === ELLA) }],
    ['pot', { pots: full.pots.filter((p) => p.personId === ELLA) }],
    ['bill', { recurringTemplates: full.recurringTemplates.filter((t) => t.id === 'ella-bill') }],
    ['loan', { loans: full.loans.filter((l) => l.id === 'ella-loan') }],
    ['credit card', { creditCards: full.creditCards }],
    ['joint split bill', { recurringTemplates: full.recurringTemplates.filter((t) => t.id === 'joint-adam-50') }],
  ]
  for (const [label, patch] of soloCases) check(`a person owning only a ${label} is blocked`, findDeleteBlockers(only(patch), ellaSubject).length, 1)
  check('a person owning nothing is not blocked', findDeleteBlockers(only({}), ellaSubject).length, 0)
}

// ─────────────────────────────────────────────────────────────────────
// 3. Reassigning each item, one at a time, then deleting
// ─────────────────────────────────────────────────────────────────────
{
  const start = household()
  const clearedBefore = start.transactions.filter((t) => t.status === 'cleared')
  let data = start
  const toAdam = { type: 'reassign', target: { type: 'person', personId: ADAM } } as const
  for (const b of findDeleteBlockers(start, ellaSubject)) {
    const before = findDeleteBlockers(data, ellaSubject).length
    data = applyBlockerAction(data, ellaSubject, b.key, toAdam, ASOF)
    check(`reassigning ${b.key} removes exactly that blocker`, findDeleteBlockers(data, ellaSubject).length, before - 1)
  }
  check('the list is empty once every item is reassigned', findDeleteBlockers(data, ellaSubject), [])
  check('pension now belongs to Adam', data.pensions[0].personId, ADAM)
  check('credit card now belongs to Adam', data.creditCards[0].ownerId, ADAM)
  check('recurring income: ownerId AND personId move', [data.recurringTemplates.find((t) => t.id === 'ella-income')?.ownerId, data.recurringTemplates.find((t) => t.id === 'ella-income')?.personId], [ADAM, ADAM])
  const jointEllaPayee = data.recurringTemplates.find((t) => t.id === 'joint-ella-payee')!
  check('joint split reassigned: payee Adam at 100% (still joint while Ella exists)', [jointEllaPayee.location, jointEllaPayee.payee, jointEllaPayee.payeeSharePercent], ['joint', ADAM, 100])
  check('a hand-logged pending transaction moves to Adam', data.transactions.find((t) => t.id === 'ella-pending')?.ownerId, ADAM)
  check('[before delete] cleared transactions are untouched by reassignment', data.transactions.filter((t) => t.status === 'cleared'), clearedBefore)

  const afterDelete = removePersonFromData(data, ELLA)
  check('the delete succeeds', afterDelete.people.map((p) => p.id), [ADAM])
  check("Ella's pay cycle row goes with her", afterDelete.payCycles.map((pc) => pc.personId), [ADAM])
  check('nothing anywhere points at an id that no longer exists', danglingReferences(afterDelete), [])
  const jointAfter = afterDelete.recurringTemplates.find((t) => t.id === 'joint-ella-payee')!
  check('with one person left, a reassigned joint bill moves to Personal at 100% (Adam, 2026-09-16)', [jointAfter.location, jointAfter.ownerId, jointAfter.payeeSharePercent], ['personal', ADAM, 100])
  // §1.1 — the one that proves cleared is immutable.
  const clearedAfter = afterDelete.transactions.filter((t) => t.status === 'cleared')
  check('CLEARED transactions belonging to the deleted person survive byte-for-byte', clearedAfter, clearedBefore)
  check('...with ownerId still set to the deleted person', clearedAfter.map((t) => t.ownerId), [ELLA, ELLA, ELLA])
  check('...and personId too', clearedAfter.find((t) => t.id === 'ella-cleared-2')?.personId, ELLA)
}

// One-tap "reassign everything", and a 3-person household
{
  const done = applyBlockerActionToAll(household(), ellaSubject, { type: 'person', personId: ADAM }, ASOF)
  check('one-tap: "Reassign everything to Adam" empties the list', findDeleteBlockers(done, ellaSubject), [])
  check('one-tap: delete then leaves nothing dangling', danglingReferences(removePersonFromData(done, ELLA)), [])

  const three: AppDataV2 = { ...household(), people: [...household().people, person('chris', 'Chris')], payCycles: [...household().payCycles, defaultPayCycleConfig('chris')] }
  check('with 3 people the target options are the two others', blockerTargetOptions(three, ellaSubject, findDeleteBlockers(three, ellaSubject)[0]).map((o) => o.label), ['Me', 'Chris'])
  const toChris = applyBlockerActionToAll(three, ellaSubject, { type: 'person', personId: 'chris' }, ASOF)
  const deleted = removePersonFromData(toChris, ELLA)
  const joint = deleted.recurringTemplates.find((t) => t.id === 'joint-ella-payee')!
  check('3 people: a reassigned joint bill stays joint, Chris at 100%', [joint.location, joint.payee, joint.payeeSharePercent], ['joint', 'chris', 100])
  check('3 people: nothing dangling', danglingReferences(deleted), [])
  check('a target that is not another person is refused (no-op)', applyBlockerAction(three, ellaSubject, 'pension:ella-pension', { type: 'reassign', target: { type: 'person', personId: ELLA } }, ASOF) === three, true)
}

// Deleting items from inside the modal
{
  let data = household()
  const potBlocked: AppDataV2 = { ...data, recurringTemplates: [...data.recurringTemplates, template('into-ella-pot', { kind: 'transfer', transferFrom: { type: 'personal' }, transferTo: { type: 'pot', potId: 'ella-pot' } })] }
  const ellaPot = findDeleteBlockers(potBlocked, ellaSubject).find((b) => b.key === 'pot:ella-pot')!
  check('a pot still referenced elsewhere cannot be deleted from the person modal', canDeleteBlocker(potBlocked, ellaPot), false)
  check('...and the delete action is refused', applyBlockerAction(potBlocked, ellaSubject, ellaPot.key, { type: 'delete' }, ASOF) === potBlocked, true)
  for (const b of findDeleteBlockers(data, ellaSubject)) data = applyBlockerAction(data, ellaSubject, b.key, { type: 'delete' }, ASOF)
  check('deleting every item empties the list', findDeleteBlockers(data, ellaSubject), [])
  const gone = removePersonFromData(data, ELLA)
  check('delete-everything path: nothing dangling (incl. followsIncomeSource → deleted pension)', danglingReferences(gone), [])
  check('delete-everything path: cleared history still intact', gone.transactions.filter((t) => t.status === 'cleared').length, 3)
}

// ─────────────────────────────────────────────────────────────────────
// 4. Deleting a Pot is blocked by every kind of reference
// ─────────────────────────────────────────────────────────────────────
const potSubject: DeleteSubject = { type: 'pot', id: 'adam-pot' }
function potFixture(): AppDataV2 {
  const data = household()
  return {
    ...data,
    savingsPots: [...data.savingsPots, savingsPot('interest-into-pot', ADAM, 'Pays pot', { type: 'pot', potId: 'adam-pot' })],
    recurringTemplates: [
      template('pot-bill', { location: 'pot', potId: 'adam-pot' }),
      transfer('pot-in', { type: 'personal' }, { type: 'pot', potId: 'adam-pot' }),
      transfer('pot-out', { type: 'pot', potId: 'adam-pot' }, { type: 'joint' }),
    ],
    loans: [loan('pot-loan', { location: 'pot', potId: 'adam-pot' }), loan('overpay-from-pot', { recurringOverpayment: { startDate: '2026-02-01', amount: { type: 'fixed', amount: 10 }, location: 'pot', potId: 'adam-pot' } })],
    transactions: [
      ...data.transactions,
      { ...buildTransferTransaction({ type: 'pot', potId: 'adam-pot' }, { type: 'pot', potId: 'adam-pot-2' }, 40, '2099-02-01', ADAM), id: 'pend-from-pot', status: 'pending' },
      { ...buildTransferTransaction({ type: 'pot', potId: 'adam-pot-2' }, { type: 'pot', potId: 'adam-pot' }, 45, '2099-02-02', ADAM), id: 'pend-to-pot', status: 'pending' },
      txn('cleared-pot-history', { location: 'pot', potId: 'adam-pot', type: 'bill_payment' }),
    ],
  }
}
{
  const data = potFixture()
  const keys = findDeleteBlockers(data, potSubject).map((b) => b.key).sort()
  check('the pot is blocked by exactly these items', keys, [
    'loan:pot-loan',
    'loanRecurringOverpayment:overpay-from-pot',
    'savingsPotInterest:interest-into-pot',
    'template:pot-bill',
    'template:pot-in',
    'template:pot-out',
    'transaction:pend-from-pot',
    'transaction:pend-to-pot',
  ])
  check('a pending Pot→Pot transfer blocks via its FROM end', keys.includes('transaction:pend-from-pot'), true)
  check('...and via its TO end, which the flat potId does not record', [data.transactions.find((t) => t.id === 'pend-to-pot')?.potId, keys.includes('transaction:pend-to-pot')], ['adam-pot-2', true])
  check("a cleared pot transaction never blocks", keys.includes('transaction:cleared-pot-history'), false)

  const opts = (key: string) => blockerTargetOptions(data, potSubject, findDeleteBlockers(data, potSubject).find((b) => b.key === key)!).map((o) => o.key)
  check('a pot bill can move to Personal or the owner’s other pots, never the pot being deleted', opts('template:pot-bill'), ['personal', 'pot:adam-pot-2'])
  check('a Personal→Pot transfer cannot be retargeted to Personal', opts('template:pot-in').includes('personal'), false)
  check('a Pot→Joint transfer cannot be retargeted to Joint', opts('template:pot-out').includes('joint'), false)
  check('an overpayment can go back to following its loan', opts('loanRecurringOverpayment:overpay-from-pot')[0], 'followsLoan')
  check('interest can go back into the savings pot itself', opts('savingsPotInterest:interest-into-pot')[0], 'self')
  check('an invalid target is refused (Personal→Personal)', applyBlockerAction(data, potSubject, 'template:pot-in', { type: 'reassign', target: { type: 'location', location: { type: 'personal' } } }, ASOF) === data, true)

  const holiday = { type: 'location', location: { type: 'pot', potId: 'adam-pot-2' } } as const
  let next = data
  next = applyBlockerAction(next, potSubject, 'template:pot-bill', { type: 'reassign', target: { type: 'location', location: { type: 'personal' } } }, ASOF)
  next = applyBlockerAction(next, potSubject, 'template:pot-in', { type: 'reassign', target: holiday }, ASOF)
  next = applyBlockerAction(next, potSubject, 'template:pot-out', { type: 'delete' }, ASOF)
  next = applyBlockerAction(next, potSubject, 'loan:pot-loan', { type: 'reassign', target: holiday }, ASOF)
  next = applyBlockerAction(next, potSubject, 'loanRecurringOverpayment:overpay-from-pot', { type: 'reassign', target: { type: 'followsLoan' } }, ASOF)
  next = applyBlockerAction(next, potSubject, 'savingsPotInterest:interest-into-pot', { type: 'reassign', target: { type: 'self' } }, ASOF)
  next = applyBlockerAction(next, potSubject, 'transaction:pend-from-pot', { type: 'reassign', target: { type: 'location', location: { type: 'personal' } } }, ASOF)
  next = applyBlockerAction(next, potSubject, 'transaction:pend-to-pot', { type: 'delete' }, ASOF)
  check('every pot blocker resolved', findDeleteBlockers(next, potSubject), [])

  const bill = next.recurringTemplates.find((t) => t.id === 'pot-bill')!
  check('pot bill moved to Personal, with a locationHistory entry dated today', [bill.location, bill.potId, bill.locationEffectiveFrom, bill.locationHistory?.at(-1)?.potId], ['personal', undefined, ASOF, 'adam-pot'])
  const potIn = next.recurringTemplates.find((t) => t.id === 'pot-in')!
  check('Personal→Pot transfer retargeted to Holiday', potIn.transferTo, { type: 'pot', potId: 'adam-pot-2' })
  const pend = next.transactions.find((t) => t.id === 'pend-from-pot')!
  check('pending Pot→Pot retargeted to Personal→Holiday re-derives location/potId/direction', [pend.location, pend.potId, pend.direction, pend.fromLocation], ['personal', 'adam-pot-2', 'out', { type: 'personal' }])
  check('overpayment follows the loan again', next.loans.find((l) => l.id === 'overpay-from-pot')?.recurringOverpayment?.location, undefined)

  const deleted = removePotFromData(next, 'adam-pot', ASOF)
  check('pot delete: nothing dangling', danglingReferences(deleted), [])
  check('pot delete: the cleared pot transaction is untouched', deleted.transactions.find((t) => t.id === 'cleared-pot-history'), data.transactions.find((t) => t.id === 'cleared-pot-history'))

  const allPersonal = applyBlockerActionToAll(data, potSubject, { type: 'location', location: { type: 'personal' } }, ASOF)
  check('"Move to Personal" leaves only the items Personal is not valid for', findDeleteBlockers(allPersonal, potSubject).map((b) => b.key).sort(), ['template:pot-in'])
}

// ─────────────────────────────────────────────────────────────────────
// 5. Deleting a Savings Pot
// ─────────────────────────────────────────────────────────────────────
{
  const sub: DeleteSubject = { type: 'savingsPot', id: 'adam-savings' }
  const data: AppDataV2 = {
    ...household(),
    savingsPots: [...household().savingsPots, savingsPot('into-adam-savings', ADAM, 'Feeder', { type: 'savings', savingsPotId: 'adam-savings' })],
    recurringTemplates: [transfer('sav-in', { type: 'personal' }, { type: 'savings', savingsPotId: 'adam-savings' })],
    transactions: [{ ...buildTransferTransaction({ type: 'savings', savingsPotId: 'ella-savings' }, { type: 'savings', savingsPotId: 'adam-savings' }, 70, '2099-03-01', ADAM), id: 'pend-sav', status: 'pending', sourceType: 'salary_sort', sourceId: 'sort-1' }],
    salarySorts: [{ id: 'sort-1', payDate: '2099-03-01', targets: [{ id: 'tg-1', to: { type: 'savings', savingsPotId: 'adam-savings' }, amount: 70, transactionId: 'pend-sav' }] }],
  }
  const keys = findDeleteBlockers(data, sub).map((b) => b.key).sort()
  check('the savings pot is blocked by its transfer, pending transfer and interest destination', keys, ['savingsPotInterest:into-adam-savings', 'template:sav-in', 'transaction:pend-sav'])
  const isa = { type: 'location', location: { type: 'savings', savingsPotId: 'ella-savings' } } as const
  let next = applyBlockerAction(data, sub, 'template:sav-in', { type: 'reassign', target: isa }, ASOF)
  next = applyBlockerAction(next, sub, 'transaction:pend-sav', { type: 'reassign', target: { type: 'location', location: { type: 'personal' } } }, ASOF)
  next = applyBlockerAction(next, sub, 'savingsPotInterest:into-adam-savings', { type: 'reassign', target: { type: 'self' } }, ASOF)
  check('every savings pot blocker resolved', findDeleteBlockers(next, sub), [])
  check('a Salary Sort target follows its retargeted transaction', next.salarySorts[0].targets[0].to, { type: 'personal' })
  check('savings pot delete: nothing dangling', danglingReferences(removeSavingsPotFromData(next, 'adam-savings', ASOF)), [])
}

// ─────────────────────────────────────────────────────────────────────
// 5a. Staged decisions (Adam, 2026-09-16): Move/Delete in the sheet are a
//     draft; only Delete applies them, together with the delete itself.
// ─────────────────────────────────────────────────────────────────────
{
  const data = household()
  const blockers = findDeleteBlockers(data, ellaSubject)
  const toAdam: BlockerAction = { type: 'reassign', target: { type: 'person', personId: ADAM } }
  const allButOne: [string, BlockerAction][] = blockers.slice(1).map((b) => [b.key, toAdam])
  check('[staged] with one item still undecided, Delete changes NOTHING (not even the decided moves)', resolveBlockersAndDelete(data, ellaSubject, allButOne, ASOF) === data, true)
  const all: [string, BlockerAction][] = blockers.map((b, i) => [b.key, i % 3 === 0 && canDeleteBlocker(data, b) ? { type: 'delete' } : toAdam])
  const done = resolveBlockersAndDelete(data, ellaSubject, all, ASOF)
  check('[staged] with every item decided, Delete applies them and deletes Ella', done.people.map((p) => p.id), [ADAM])
  check('[staged] items staged for deletion are gone', all.filter(([, a]) => a.type === 'delete').every(([key]) => {
    const [entity, id] = key.split(':')
    return entity === 'template' ? !done.recurringTemplates.some((t) => t.id === id) : entity === 'loan' ? !done.loans.some((l) => l.id === id) : entity === 'pension' ? !done.pensions.some((p) => p.id === id) : entity === 'savingsPot' ? !done.savingsPots.some((p) => p.id === id) : entity === 'creditCard' ? !done.creditCards.some((c) => c.id === id) : entity === 'transaction' ? !done.transactions.some((t) => t.id === id) : entity === 'pot' ? !done.pots.some((p) => p.id === id) : true
  }), true)
  check('[staged] nothing dangling', danglingReferences(done), [])
  check('[staged] cleared history untouched', done.transactions.filter((t) => t.status === 'cleared'), data.transactions.filter((t) => t.status === 'cleared'))

  const potData = potFixture()
  const potBlockers = findDeleteBlockers(potData, potSubject)
  const potDecisions: [string, BlockerAction][] = potBlockers.map((b) => {
    const options = blockerTargetOptions(potData, potSubject, b)
    return [b.key, options.length > 0 ? { type: 'reassign', target: options[0].target } : { type: 'delete' }]
  })
  const potDone = resolveBlockersAndDelete(potData, potSubject, potDecisions, ASOF)
  check('[staged pot] every item decided → pot deleted, nothing dangling', [potDone.pots.some((p) => p.id === 'adam-pot'), danglingReferences(potDone)], [false, []])
}

// ─────────────────────────────────────────────────────────────────────
// 5b. When a move takes effect (Adam, 2026-09-16): cleared rows are left
//     alone — INCLUDING one cleared today — and pending rows move. The
//     first build reused the Bills-page location flow for pot bills/loans/
//     overpayments, which also rewrites a row cleared today.
// ─────────────────────────────────────────────────────────────────────
{
  const potRow = (id: string, sourceType: Transaction['sourceType'], sourceId: string, date: string, status: 'cleared' | 'pending'): Transaction =>
    txn(id, { date, status, location: 'pot', potId: 'adam-pot', type: 'bill_payment', sourceType, sourceId })
  const transferRow = (id: string, date: string, status: 'cleared' | 'pending'): Transaction => ({
    ...buildTransferTransaction({ type: 'personal' }, { type: 'pot', potId: 'adam-pot' }, 30, date, ADAM),
    id,
    status,
    sourceType: 'recurring_template',
    sourceId: 'pot-in',
  })
  const rowsFor = (prefix: string, make: (id: string, date: string, status: 'cleared' | 'pending') => Transaction) => [
    make(`${prefix}-past-cleared`, '2026-05-01', 'cleared'),
    make(`${prefix}-today-cleared`, ASOF, 'cleared'),
    make(`${prefix}-future-pending`, '2026-07-01', 'pending'),
  ]
  const base5b = potFixture()
  const data: AppDataV2 = {
    ...base5b,
    transactions: [
      ...rowsFor('bill', (id, d, s) => potRow(id, 'recurring_template', 'pot-bill', d, s)),
      ...rowsFor('loan', (id, d, s) => potRow(id, 'loan', 'pot-loan', d, s)),
      ...rowsFor('overpay', (id, d, s) => potRow(id, 'loan_recurring_overpayment', 'overpay-from-pot', d, s)),
      ...rowsFor('transfer', transferRow),
    ],
  }
  const personal = { type: 'reassign', target: { type: 'location', location: { type: 'personal' } } } as const
  let moved = applyBlockerAction(data, potSubject, 'template:pot-bill', personal, ASOF)
  moved = applyBlockerAction(moved, potSubject, 'loan:pot-loan', personal, ASOF)
  moved = applyBlockerAction(moved, potSubject, 'loanRecurringOverpayment:overpay-from-pot', personal, ASOF)
  moved = applyBlockerAction(moved, potSubject, 'template:pot-in', { type: 'reassign', target: { type: 'location', location: { type: 'joint' } } }, ASOF)
  const find = (d: AppDataV2, id: string) => d.transactions.find((t) => t.id === id)
  for (const prefix of ['bill', 'loan', 'overpay', 'transfer']) {
    check(`[pot move: ${prefix}] a row cleared BEFORE today is untouched`, find(moved, `${prefix}-past-cleared`), find(data, `${prefix}-past-cleared`))
    check(`[pot move: ${prefix}] a row cleared TODAY is untouched`, find(moved, `${prefix}-today-cleared`), find(data, `${prefix}-today-cleared`))
    check(`[pot move: ${prefix}] a pending row moves`, JSON.stringify(find(moved, `${prefix}-future-pending`)) !== JSON.stringify(find(data, `${prefix}-future-pending`)), true)
  }
  check('[pot move: bill] the pending row is now Personal', [find(moved, 'bill-future-pending')?.location, find(moved, 'bill-future-pending')?.potId], ['personal', undefined])
  check('[pot move: transfer] the pending row now goes to Joint', find(moved, 'transfer-future-pending')?.toLocation, { type: 'joint' })

  const person5b: AppDataV2 = {
    ...household(),
    transactions: rowsFor('ella-bill', (id, d, s) => txn(id, { date: d, status: s, ownerId: ELLA, type: 'bill_payment', sourceType: 'recurring_template', sourceId: 'ella-bill' })),
  }
  const movedPerson = applyBlockerAction(person5b, ellaSubject, 'template:ella-bill', { type: 'reassign', target: { type: 'person', personId: ADAM } }, ASOF)
  check('[person move] a row cleared before today keeps Ella', find(movedPerson, 'ella-bill-past-cleared')?.ownerId, ELLA)
  check('[person move] a row cleared today keeps Ella', find(movedPerson, 'ella-bill-today-cleared')?.ownerId, ELLA)
  check('[person move] a pending row moves to Adam', find(movedPerson, 'ella-bill-future-pending')?.ownerId, ADAM)
}

// ─────────────────────────────────────────────────────────────────────
// 6. The two real backups
// ─────────────────────────────────────────────────────────────────────
for (const [label, file] of [
  ['Adam', 'finance-ledger-backup-2026-09-15.json'],
  ["Adam's mum", 'finance-ledger-backup-2026-09-15-mum.json'],
] as const) {
  let data: AppDataV2
  try {
    data = parseLedgerBackupJson(readFileSync(`${BACKUP_DIR}/${file}`, 'utf8'))
  } catch (e) {
    console.log(`✗ FAIL ${label}'s backup could not be loaded — ${(e as Error).message}`)
    failures++
    continue
  }
  check(`[${label}] the extended backstop is idempotent on real data`, JSON.stringify(reconcilePersonReferences(data)) === JSON.stringify(data), true)
  check(`[${label}] real data has nothing dangling to begin with`, danglingReferences(data), [])

  for (const p of data.people) {
    const subject: DeleteSubject = { type: 'person', id: p.id }
    const blockers = findDeleteBlockers(data, subject)
    // Completeness, by brute force: everything that names this person.
    const expected = [
      ...data.pensions.filter((x) => x.personId === p.id).map((x) => `pension:${x.id}`),
      ...data.savingsPots.filter((x) => x.personId === p.id).map((x) => `savingsPot:${x.id}`),
      ...data.pots.filter((x) => x.personId === p.id).map((x) => `pot:${x.id}`),
      ...data.recurringTemplates.filter((x) => (x.location === 'joint' ? x.payee === p.id || x.payeeSharePercent < 100 : x.ownerId === p.id || x.personId === p.id)).map((x) => `template:${x.id}`),
      ...data.loans.filter((x) => (x.location === 'joint' ? x.payee === p.id || x.payeeSharePercent < 100 : x.ownerId === p.id)).map((x) => `loan:${x.id}`),
      ...data.creditCards.filter((x) => x.ownerId === p.id).map((x) => `creditCard:${x.id}`),
      ...data.transactions.filter((x) => x.status === 'pending' && (x.ownerId === p.id || x.personId === p.id)).map((x) => `transaction:${x.id}`),
    ].sort()
    check(`[${label}] ${p.name}: the block list is complete`, blockers.map((b) => b.key).sort(), expected)

    const others = data.people.filter((o) => o.id !== p.id)
    if (others.length === 0) {
      check(`[${label}] ${p.name}: the only person cannot be deleted (no-op)`, removePersonFromData(data, p.id) === data, true)
      continue
    }
    const clearedBefore = data.transactions.filter((t) => t.status === 'cleared')
    const resolved = applyBlockerActionToAll(data, subject, { type: 'person', personId: others[0].id })
    check(`[${label}] ${p.name}: one-tap reassign to ${others[0].name} empties the list`, findDeleteBlockers(resolved, subject), [])
    const after = removePersonFromData(resolved, p.id)
    check(`[${label}] ${p.name}: deleted cleanly, nothing dangling`, danglingReferences(after), [])
    check(`[${label}] ${p.name}: every cleared transaction untouched`, after.transactions.filter((t) => t.status === 'cleared'), clearedBefore)
  }
  if (label === 'Adam') {
    const ella = data.people.find((x) => x.name === 'Ella')!
    const keys = findDeleteBlockers(data, { type: 'person', id: ella.id }).map((b) => b.name)
    check("[Adam] Ella is blocked by her Tesco loan, her Test card and the 50% joint splits", [keys.includes('Tesco'), keys.includes('Test'), keys.includes('Prime'), keys.includes('Netflix')], [true, true, true, false])
  }
  for (const potItem of data.pots) {
    const b = findDeleteBlockers(data, { type: 'pot', id: potItem.id })
    const expected = [
      ...data.recurringTemplates.filter((t) => (t.kind === 'transfer' ? t.transferFrom?.potId === potItem.id || t.transferTo?.potId === potItem.id : t.location === 'pot' && t.potId === potItem.id)).map((t) => `template:${t.id}`),
      ...data.loans.filter((l) => l.location === 'pot' && l.potId === potItem.id).map((l) => `loan:${l.id}`),
    ].sort()
    check(`[${label}] pot ${potItem.name}: block list is complete`, b.map((x) => x.key).sort(), expected)
  }
  for (const s of data.savingsPots) {
    const b = findDeleteBlockers(data, { type: 'savingsPot', id: s.id })
    const expected = data.recurringTemplates.filter((t) => t.kind === 'transfer' && (t.transferFrom?.savingsPotId === s.id || t.transferTo?.savingsPotId === s.id)).map((t) => `template:${t.id}`)
    check(`[${label}] savings pot ${s.name}: block list is complete`, b.map((x) => x.key).sort(), expected.sort())
  }
}

console.log(failures === 0 ? '\nAll delete-reassign checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)
