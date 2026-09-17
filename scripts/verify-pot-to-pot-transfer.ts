// Verifies transfers with NO personal leg at all — Pot -> Pot, Pot ->
// Savings, Savings -> Savings (2026-09 UAT session, "Transfer form
// 'From' location made editable" — Batch 2 item 3). Previously
// unreachable from the UI; the underlying engine had a real gap: a
// single flat `potId`/`savingsPotId` field on a Transaction can't
// identify BOTH endpoints of a same-type-different-id transfer, so the
// entity on the "wrong" side of that field would silently lose the
// transaction from its own stored/dedupe lookups once materialized.
// This script exercises exactly that scenario end to end — balance
// folding, the schedule-row modal's deposit/withdrawal labelling, and
// autoClear's own dedicated materialization pass for a recurring
// transfer where `location` is never 'personal' at all.

import { defaultLedgerData, defaultPayCycleConfig } from '../src/lib/ledgerStorage'
import { newSavingsPot, savingsPotBalanceAsOf, buildSavingsPotScheduleRows } from '../src/lib/savingsPotLedger'
import { potBalanceAsOf, buildPotScheduleRows } from '../src/lib/potLedger'
import { buildTransferTransaction, locationTypeForTransfer } from '../src/lib/transferLedger'
import { autoClearDuePayments } from '../src/lib/autoClear'
import type { AppDataV2, Pot, RecurringTemplate, SavingsPot, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const base = defaultLedgerData()
const meId = base.primaryPersonId

const potA: Pot = { id: 'pot-a', personId: meId, name: 'Bills', openingBalance: 500, openingDate: '2026-01-01', active: true }
const potB: Pot = { id: 'pot-b', personId: meId, name: 'Holiday', openingBalance: 100, openingDate: '2026-01-01', active: true }
const savingsA: SavingsPot = {
  ...newSavingsPot({ personId: meId, name: 'Rainy day', openingBalance: 1000, openingDate: '2026-01-01', interestMethod: { type: 'aer_credited', aer: 4.8, creditingFrequency: 'monthly' } }),
  id: 'savings-a',
}

const data: AppDataV2 = {
  ...base,
  pots: [potA, potB],
  savingsPots: [savingsA],
  payCycles: [{ ...defaultPayCycleConfig(meId), openingBalance: 2000, openingBalanceDate: '2026-01-01', paydayDayOfMonth: 25 }],
}

// ---- 1. locationTypeForTransfer never says 'personal' when neither side is ----
check("locationTypeForTransfer: Pot -> Pot resolves to 'pot', not 'personal'", locationTypeForTransfer({ type: 'pot', potId: potA.id }, { type: 'pot', potId: potB.id }), 'pot')
check("locationTypeForTransfer: Savings -> Pot resolves to 'pot'", locationTypeForTransfer({ type: 'savings', savingsPotId: savingsA.id }, { type: 'pot', potId: potA.id }), 'pot')
check("locationTypeForTransfer: Pot -> Joint resolves to 'joint'", locationTypeForTransfer({ type: 'pot', potId: potA.id }, { type: 'joint' }), 'joint')
check("locationTypeForTransfer: Pot -> Personal still resolves to 'personal'", locationTypeForTransfer({ type: 'pot', potId: potA.id }, { type: 'personal' }), 'personal')

// ---- 2. One-off Pot A -> Pot B: BOTH pots' own balances see it, regardless of which one the flat potId field landed on ----
const potToPot = buildTransferTransaction({ type: 'pot', potId: potA.id }, { type: 'pot', potId: potB.id }, 80, '2026-01-10', meId)
check('buildTransferTransaction: Pot -> Pot location is not personal', potToPot.location, 'pot')
check('buildTransferTransaction: flat potId lands on the FROM side (informational only)', potToPot.potId, potA.id)
check('Pot A (the source) balance decreases by 80', potBalanceAsOf(potA, [potToPot], new Date('2026-01-11')), 420)
check('Pot B (the destination, NOT what the flat potId field says) balance increases by 80', potBalanceAsOf(potB, [potToPot], new Date('2026-01-11')), 180)

// ---- 3. One-off Savings A -> Pot A ----
const savingsToPot = buildTransferTransaction({ type: 'savings', savingsPotId: savingsA.id }, { type: 'pot', potId: potA.id }, 60, '2026-01-12', meId)
check('Savings A -> Pot A: savings pot balance decreases by 60', savingsPotBalanceAsOf(savingsA, [savingsToPot], new Date('2026-01-13')), 940)
check('Savings A -> Pot A: pot balance increases by 60', potBalanceAsOf(potA, [savingsToPot], new Date('2026-01-13')), 560)

// ---- 4. Schedule-row modal labelling: Pot A -> Pot B must show as a withdrawal on A's own rows and a deposit on B's ----
const rowsForA = buildPotScheduleRows({ ...data, transactions: [potToPot] }, potA, new Date('2026-02-01'))
const rowsForB = buildPotScheduleRows({ ...data, transactions: [potToPot] }, potB, new Date('2026-02-01'))
check('Pot A schedule row: type is pot_withdrawal (money left A)', rowsForA.find((r) => r.date === '2026-01-10')?.type, 'pot_withdrawal')
check('Pot B schedule row: type is pot_deposit (money arrived at B)', rowsForB.find((r) => r.date === '2026-01-10')?.type, 'pot_deposit')

// ---- 5. Same labelling check for a savings pot on both ends of a transfer ----
const savingsB: SavingsPot = { ...newSavingsPot({ personId: meId, name: 'ISA', openingBalance: 300, openingDate: '2026-01-01', interestMethod: { type: 'aer_credited', aer: 3, creditingFrequency: 'annual' } }), id: 'savings-b' }
const savingsToSavings = buildTransferTransaction({ type: 'savings', savingsPotId: savingsA.id }, { type: 'savings', savingsPotId: savingsB.id }, 40, '2026-01-15', meId)
const savingsRowsA = buildSavingsPotScheduleRows(savingsA, [savingsToSavings], new Date('2026-02-01'))
const savingsRowsB = buildSavingsPotScheduleRows(savingsB, [savingsToSavings], new Date('2026-02-01'))
check('Savings A schedule row: type is savings_withdrawal (money left A)', savingsRowsA.find((r) => r.date === '2026-01-15')?.type, 'savings_withdrawal')
check('Savings B schedule row: type is savings_deposit (money arrived at B)', savingsRowsB.find((r) => r.date === '2026-01-15')?.type, 'savings_deposit')

// ---- 6. Recurring Pot -> Pot: autoClear's dedicated non-personal materialization pass actually settles it ----
const recurringPotToPot: RecurringTemplate = {
  id: 'rt-pot-to-pot',
  name: 'Bills -> Holiday sweep',
  amount: 25,
  categoryId: 'category-savings',
  paymentMethod: 'bank_transfer',
  frequency: 'monthly',
  anchorDate: '2026-01-05',
  location: 'pot',
  ownerId: meId,
  payee: '',
  payeeSharePercent: 100,
  active: true,
  kind: 'transfer',
  transferFrom: { type: 'pot', potId: potA.id },
  transferTo: { type: 'pot', potId: potB.id },
}
const clearedData = autoClearDuePayments({ ...data, recurringTemplates: [recurringPotToPot], transactions: [] }, new Date('2026-03-06'))
const materialized = clearedData.transactions.filter((t: Transaction) => t.sourceId === 'rt-pot-to-pot')
check('autoClear materializes all 3 due recurring Pot -> Pot occurrences (Jan/Feb/Mar 5th)', materialized.length, 3)
check('Every materialized occurrence is cleared', materialized.every((t: Transaction) => t.status === 'cleared'), true)
check('Every materialized occurrence carries location: pot, never personal', materialized.every((t: Transaction) => t.location === 'pot'), true)
check('Pot A balance reflects 3 outgoing sweeps of 25 (500 - 75)', potBalanceAsOf(potA, clearedData.transactions, new Date('2026-03-07')), 425)
check('Pot B balance reflects 3 incoming sweeps of 25 (100 + 75)', potBalanceAsOf(potB, clearedData.transactions, new Date('2026-03-07')), 175)

// ---- 7. Re-running autoClear on already-settled data is a no-op (idempotent, same as every other generator) ----
const secondPass = autoClearDuePayments(clearedData, new Date('2026-03-06'))
check('Second autoClear pass changes nothing (same reference back)', secondPass === clearedData, true)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
