// UAT 2026-09-10 (mup-samedate-* rows, added mid-session at Adam's
// request while retesting the "Manage upcoming payments" redesign) —
// re-verifies the exact bug class the 2026-09-09 session fixed for
// salary/pension-display/recurring-template/loan
// (verify-reconcile-materialized-amount.ts) against the THREE BRAND NEW
// single-occurrence write functions this session added
// (applyPotSingleDepositAmountChange, applySavingsPotSingleDepositAmountChange,
// applyPensionSingleOccurrenceAmountChange), which never had this
// mechanism applied to them since Pot/SavingsPot had no single-occurrence
// write at all before today, and Pension's OWN standing-amount function
// (applyPensionAmountChange) predates today unchanged.
//
// Two distinct, CONFIRMED-live bugs fixed alongside this script:
//  1. Pot/SavingsPot recurring deposits had NO reconciler at all in
//     autoClear.ts — an already-materialized (cleared) deposit
//     transaction never revisited a same-day single-occurrence override.
//     Fixed: reconcilePotTransactions/reconcileSavingsPotTransactions.
//  2. Pension's reconciler existed but called the STANDING resolver
//     (resolvePensionAmount), which ignores occurrenceOverrides — so it
//     would actively stamp an already-cleared row back to the pre-edit
//     standing amount on the very next autoClear pass, undoing a
//     successful single-occurrence edit. Fixed: switched to
//     resolvePensionOccurrenceAmount.
//  3. Pension's applyPensionAmountChange never dropped forward-dated
//     amountHistory entries or forward-dated occurrenceOverrides the way
//     schedule.ts's applyTemplateAmountChange does — reproducing BOTH the
//     "single-occurrence override freezes forever" bug AND the
//     out-of-order-history bug from 2026-09-09, just never propagated to
//     Pension. Fixed to match applyTemplateAmountChange exactly.

import { autoClearDuePayments } from '../src/lib/autoClear'
import { applyPotSingleDepositAmountChange } from '../src/lib/potLedger'
import { applySavingsPotSingleDepositAmountChange } from '../src/lib/savingsPotLedger'
import { applyPensionAmountChange, applyPensionSingleOccurrenceAmountChange, resolvePensionAmount } from '../src/lib/pensionLedger'
import { defaultCategories } from '../src/lib/categories'
import type { AppDataV2, PayCycleConfig, Person, Pot, SavingsPot, Pension } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const payCycle: PayCycleConfig = {
  personId: 'me',
  openingBalance: 1000,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 1,
}
const person: Person = { id: 'me', name: 'Me', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [] }

const baseData: AppDataV2 = {
  people: [person],
  categories: defaultCategories(),
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  transactions: [],
  payCycles: [payCycle],
  pensions: [],
  savingsPots: [],
  pots: [],
  salarySorts: [],
  scenarios: [],
  primaryPersonId: 'me',
  jointAccount: null,
} as unknown as AppDataV2

const asOf = new Date(2026, 6, 20) // 2026-07-20 — matches the SavingsPot/Pot deposit day below

// ─────────────────────────────────────────────────────────────────────
// 1. SavingsPot recurring deposit — same-day double-edit staleness
// ─────────────────────────────────────────────────────────────────────
const savingsPot: SavingsPot = {
  id: 'sp-1',
  personId: 'me',
  name: 'Holiday Fund',
  openingBalance: 500,
  openingDate: '2026-01-01',
  active: true,
  interestMethod: { type: 'aer_credited', aer: 2.5, creditingFrequency: 'monthly' },
  recurringDepositAmount: 50,
  recurringDepositDayOfMonth: 20,
  recurringDepositStartDate: '2026-01-20',
}
const spData: AppDataV2 = { ...baseData, savingsPots: [savingsPot] }
const spAfterEdit1 = autoClearDuePayments({ ...spData, savingsPots: [{ ...savingsPot, ...applySavingsPotSingleDepositAmountChange(savingsPot, 80, '2026-07-20') }] }, asOf)
const spMaterialized = spAfterEdit1.transactions.find((t) => t.type === 'savings_deposit' && t.sourceId === 'sp-1' && t.date === '2026-07-20')
check('SavingsPot: single-occurrence edit materializes at the NEW amount (not stuck at standing 50)', spMaterialized?.amount, 80)

const spEdited1 = { ...savingsPot, ...applySavingsPotSingleDepositAmountChange(savingsPot, 80, '2026-07-20') }
const spEdited2 = { ...spEdited1, ...applySavingsPotSingleDepositAmountChange(spEdited1, 65, '2026-07-20') }
const spAfterEdit2 = autoClearDuePayments({ ...spAfterEdit1, savingsPots: [spEdited2] }, asOf)
const spResynced = spAfterEdit2.transactions.find((t) => t.type === 'savings_deposit' && t.sourceId === 'sp-1' && t.date === '2026-07-20')
check('SavingsPot: SAME-DAY second edit resyncs the already-cleared row to the newest value (65, not stuck at 80)', spResynced?.amount, 65)

// ─────────────────────────────────────────────────────────────────────
// 2. Pot recurring deposit — same-day double-edit staleness
// ─────────────────────────────────────────────────────────────────────
const pot: Pot = {
  id: 'pot-1',
  personId: 'me',
  name: 'Bills Pot',
  openingBalance: 200,
  openingDate: '2026-01-01',
  active: true,
  recurringDepositAmount: 100,
  recurringDepositDayOfMonth: 20,
  recurringDepositStartDate: '2026-01-20',
}
const potData: AppDataV2 = { ...baseData, pots: [pot] }
const potAfterEdit1 = autoClearDuePayments({ ...potData, pots: [{ ...pot, ...applyPotSingleDepositAmountChange(pot, 150, '2026-07-20') }] }, asOf)
const potMaterialized = potAfterEdit1.transactions.find((t) => t.type === 'pot_deposit' && t.sourceId === 'pot-1' && t.date === '2026-07-20')
check('Pot: single-occurrence edit materializes at the NEW amount (not stuck at standing 100)', potMaterialized?.amount, 150)

const potEdited1 = { ...pot, ...applyPotSingleDepositAmountChange(pot, 150, '2026-07-20') }
const potEdited2 = { ...potEdited1, ...applyPotSingleDepositAmountChange(potEdited1, 120, '2026-07-20') }
const potAfterEdit2 = autoClearDuePayments({ ...potAfterEdit1, pots: [potEdited2] }, asOf)
const potResynced = potAfterEdit2.transactions.find((t) => t.type === 'pot_deposit' && t.sourceId === 'pot-1' && t.date === '2026-07-20')
check('Pot: SAME-DAY second edit resyncs the already-cleared row to the newest value (120, not stuck at 150)', potResynced?.amount, 120)

// ─────────────────────────────────────────────────────────────────────
// 3. Pension — reconciler must honour occurrenceOverrides, not just the
//    standing resolver (must not undo a successful single-occurrence edit)
// ─────────────────────────────────────────────────────────────────────
const pension: Pension = {
  id: 'pen-1',
  personId: 'me',
  name: 'State Pension',
  amount: 850,
  frequency: 'monthly',
  anchorDate: '2026-01-15',
  active: true,
  adjustForNonWorkingDay: false,
  cycleStartFollowsPayday: false,
}
const penAsOf = new Date(2026, 6, 15) // 2026-07-15
const penData: AppDataV2 = { ...baseData, pensions: [pension] }
const penAfterEdit1 = autoClearDuePayments({ ...penData, pensions: [{ ...pension, ...applyPensionSingleOccurrenceAmountChange(pension, 900, '2026-07-15') }] }, penAsOf)
const penMaterialized = penAfterEdit1.transactions.find((t) => t.type === 'pension_income' && t.sourceId === 'pen-1' && t.date === '2026-07-15')
check('Pension: single-occurrence edit materializes at the NEW amount (not the standing 850)', penMaterialized?.amount, 900)

// The critical regression check: a SECOND autoClear pass (e.g. the next
// render, with nothing new edited) must NOT silently revert the override
// back to the standing amount.
const penAfterSecondPass = autoClearDuePayments(penAfterEdit1, penAsOf)
const penStillOverridden = penAfterSecondPass.transactions.find((t) => t.type === 'pension_income' && t.sourceId === 'pen-1' && t.date === '2026-07-15')
check('Pension: a SUBSEQUENT autoClear pass does not undo the override (the actively-destructive variant of this bug)', penStillOverridden?.amount, 900)

const penEdited1 = { ...pension, ...applyPensionSingleOccurrenceAmountChange(pension, 900, '2026-07-15') }
const penEdited2 = { ...penEdited1, ...applyPensionSingleOccurrenceAmountChange(penEdited1, 950, '2026-07-15') }
const penAfterEdit2 = autoClearDuePayments({ ...penAfterEdit1, pensions: [penEdited2] }, penAsOf)
const penResynced = penAfterEdit2.transactions.find((t) => t.type === 'pension_income' && t.sourceId === 'pen-1' && t.date === '2026-07-15')
check('Pension: SAME-DAY second edit resyncs the already-cleared row to the newest value (950, not stuck at 900)', penResynced?.amount, 950)

// ─────────────────────────────────────────────────────────────────────
// 4. Pension — single-occurrence override must not freeze forever
//    against a LATER "all future" standing-amount change reaching the
//    same date (mirrors retest-bills-just-single / retest-bills-all-
//    future-samedate from 2026-09-09).
// ─────────────────────────────────────────────────────────────────────
const freezeBase: Pension = { ...pension, amount: 850 }
const freezeWithOverride = { ...freezeBase, ...applyPensionSingleOccurrenceAmountChange(freezeBase, 999, '2026-08-15') }
const freezeAllFuture = { ...freezeWithOverride, ...applyPensionAmountChange(freezeWithOverride, 860, '2026-07-01') }
check(
  'Pension: an "all future from 1 Jul" change reaching an overridden 15 Aug date clears that override (860 wins, not frozen at 999)',
  resolvePensionAmount(freezeAllFuture, '2026-08-15'),
  860,
)
check(
  'Pension: the override on a date BEFORE the new effective date is left untouched (single-occurrence editing a date, all-future starting later, should not retroactively touch it)',
  (() => {
    const before = { ...pension, amount: 850 }
    const withOverrideEarly = { ...before, ...applyPensionSingleOccurrenceAmountChange(before, 999, '2026-06-15') }
    const laterAllFuture = { ...withOverrideEarly, ...applyPensionAmountChange(withOverrideEarly, 860, '2026-08-01') }
    return laterAllFuture.occurrenceOverrides?.find((o) => o.originalDate === '2026-06-15')?.amount
  })(),
  999,
)

// ─────────────────────────────────────────────────────────────────────
// 5. Pension — out-of-order standing-amount changes (retest3-bills-out-
//    of-order's exact repro, replayed against Pension).
// ─────────────────────────────────────────────────────────────────────
const oooBase: Pension = { ...pension, amount: 37 }
const oooAfterNov = { ...oooBase, ...applyPensionAmountChange(oooBase, 40, '2026-11-01') } // "£40 from 1 Nov" recorded first
const oooAfterSept = { ...oooAfterNov, ...applyPensionAmountChange(oooAfterNov, 37, '2026-09-01') } // then "£37 from 1 Sept" — earlier than the already-recorded Nov change
check('Pension out-of-order: a date in December (after BOTH changes) resolves to 37, not stuck at the stale Nov-recorded 40', resolvePensionAmount(oooAfterSept, '2026-12-01'), 37)
check('Pension out-of-order: amountHistory no longer carries the fully-superseded Nov entry', oooAfterSept.amountHistory?.some((h) => h.effectiveFrom === '2026-11-01'), false)

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll reconcile-pot-savingspot-pension-samedate checks passed.')
