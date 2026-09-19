// Verifies the Salary Sorter data/logic layer (2026-09 session,
// App_Dev.md "Salary Sorter & Transfer Pill" — the session following the
// Transfer pill work). Covers: the smart-suggestion window/label/prefill
// logic (lib/salarySortLedger.ts), both conflict-detection directions,
// followsCycleStart resolution (lib/schedule.ts), and the two-way
// edit-sync + orphan-cleanup contract in LedgerContext.tsx's
// saveSalarySort/updateTransaction/removeTransaction — reimplemented
// here directly against the pure state-transition functions (not
// through React) the same way scripts/verify-pots.ts exercises
// LedgerContext's own exported pure helpers.

import { defaultLedgerData, defaultPayCycleConfig } from '../src/lib/ledgerStorage'
import { newSavingsPot } from '../src/lib/savingsPotLedger'
import { newPot } from '../src/lib/potLedger'
import { buildTransferTransaction, locationsEqual } from '../src/lib/transferLedger'
import { dropSalarySortTarget } from '../src/context/LedgerContext'
import {
  salarySortWindow,
  salarySortDestinations,
  hasSalarySortDestinations,
  dueAmountForLocation,
  lastSortedAmountFor,
  salarySortSuggestion,
  findOneOffTransferConflict,
  findRecurringTransferConflict,
  findSalarySortConflicts,
} from '../src/lib/salarySortLedger'
import { generateTransactionsForTemplate } from '../src/lib/schedule'
import type { AppDataV2, Loan, Pot, RecurringTemplate, SalarySort, SavingsPot, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// ── Fixture: Adam (primary) + Ella, mirroring the real household backup shape ──
const base = defaultLedgerData()
const meId = base.primaryPersonId
const ellaId = 'ella-1'

const billsPot: Pot = { ...newPot({ personId: meId, name: 'Bills', openingBalance: 200, openingDate: '2026-01-01' }), id: 'pot-bills' }
const savings: SavingsPot = { ...newSavingsPot({ personId: meId, name: 'Savings', openingBalance: 1000, openingDate: '2026-01-01', interestMethod: { type: 'aer_credited', aer: 3, creditingFrequency: 'monthly' } }), id: 'pot-savings' }
// Owned by the NON-primary person — must be excluded from salarySortDestinations (Adam's 2026-09 answer: "only my pots and/or joint account").
const ellaSavings: SavingsPot = { ...newSavingsPot({ personId: ellaId, name: "Ella's ISA", openingBalance: 500, openingDate: '2026-01-01', interestMethod: { type: 'aer_credited', aer: 3, creditingFrequency: 'monthly' } }), id: 'pot-ella' }

const potBill: RecurringTemplate = {
  id: 'rt-rent',
  name: 'Rent',
  amount: 300,
  categoryId: 'category-bills',
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-01-15',
  location: 'pot',
  potId: billsPot.id,
  ownerId: meId,
  payee: '',
  payeeSharePercent: 100,
  active: true,
}
const jointBill: RecurringTemplate = {
  id: 'rt-netflix',
  name: 'Netflix',
  amount: 20,
  categoryId: 'category-seed-streaming',
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-01-16',
  location: 'joint',
  ownerId: '',
  payee: meId,
  payeeSharePercent: 50, // Adam's own share
  active: true,
}

const data: AppDataV2 = {
  ...base,
  people: [...base.people, { id: ellaId, name: 'Ella', color: '#7c6fe0', salaryHistory: [], salaryOverrides: [] }],
  pots: [billsPot],
  savingsPots: [savings, ellaSavings],
  recurringTemplates: [potBill, jointBill],
  jointAccount: { openingBalance: 500, openingBalanceDate: '2026-01-01' },
  payCycles: [{ ...defaultPayCycleConfig(meId), openingBalance: 2000, openingBalanceDate: '2026-01-01', paydayDayOfMonth: 28, cycleStartDayOfMonth: 1 }],
}

// ---- 1. Destinations — only MY pots/savings pots + joint ----
const destinations = salarySortDestinations(data)
check('salarySortDestinations includes my Bills pot', destinations.some((d) => locationsEqual(d.location, { type: 'pot', potId: billsPot.id })), true)
check('salarySortDestinations includes my Savings', destinations.some((d) => locationsEqual(d.location, { type: 'savings', savingsPotId: savings.id })), true)
check("salarySortDestinations EXCLUDES Ella's own savings pot", destinations.some((d) => locationsEqual(d.location, { type: 'savings', savingsPotId: ellaSavings.id })), false)
check('salarySortDestinations includes Joint Account', destinations.some((d) => d.location.type === 'joint'), true)
check('hasSalarySortDestinations true when destinations exist', hasSalarySortDestinations(data), true)
check('hasSalarySortDestinations false with none available', hasSalarySortDestinations({ ...data, pots: [], savingsPots: [], jointAccount: null }), false)

// ---- 2. Window — payday basis (default) vs budget_cycle basis ----
const paydayCycle = data.payCycles[0] // salarySortBasis undefined -> defaults to 'payday'
const paydayWindow = salarySortWindow(paydayCycle, '2026-01-28')
check('payday-basis window starts on payDate', paydayWindow.start.toISOString().slice(0, 10), '2026-01-28')
// The next resolved payday after 2026-01-28 is 2026-02-27, not the 28th —
// 2026-02-28 falls on a Saturday, so paydayAdjustForNonWorkingDay pulls
// it back a day (confirmed directly against resolvePayday). The window
// therefore ends the day before THAT, not before the nominal 28th.
check('payday-basis window ends the day before the NEXT resolved (weekend-adjusted) payday', paydayWindow.end.toISOString().slice(0, 10), '2026-02-26')

const budgetCycleCycle = { ...paydayCycle, salarySortBasis: 'budget_cycle' as const, cycleStartDayOfMonth: 14 }
const budgetWindow = salarySortWindow(budgetCycleCycle, '2026-01-28')
check('budget_cycle-basis window uses the person\'s configured cycle boundary, not payday', budgetWindow.start.toISOString().slice(0, 10), '2026-01-14')

// ---- 3. Due-amount — pot (bills/loans tagged to it) and joint (my share only) ----
const dueForPot = dueAmountForLocation(data, { type: 'pot', potId: billsPot.id }, paydayWindow)
check('dueAmountForLocation: pot picks up the one Rent occurrence due in the window', dueForPot, 300)
const dueForJoint = dueAmountForLocation(data, { type: 'joint' }, paydayWindow)
check("dueAmountForLocation: joint is MY SHARE only (50% of £20 Netflix)", dueForJoint, 10)
const dueForSavings = dueAmountForLocation(data, { type: 'savings', savingsPotId: savings.id }, paydayWindow)
check('dueAmountForLocation: savings has no bill/loan linkage, always 0', dueForSavings, 0)

// ---- 4. Last-sorted amount + suggestion priority ----
const priorSort: SalarySort = {
  id: 'sort-jan',
  payDate: '2025-12-28',
  personId: meId, // PROMPT-11: a sort belongs to one person; the suggestion logic is scoped to them
  targets: [{ id: 'tgt-1', to: { type: 'savings', savingsPotId: savings.id }, amount: 250, transactionId: 'txn-old' }],
}
const dataWithPriorSort: AppDataV2 = { ...data, salarySorts: [priorSort], transactions: [...data.transactions, { ...buildTransferTransaction({ type: 'personal' }, { type: 'savings', savingsPotId: savings.id }, 250, '2025-12-28', meId), id: 'txn-old' }] }

check('lastSortedAmountFor finds the prior sort\'s amount for that exact destination', lastSortedAmountFor(dataWithPriorSort, { type: 'savings', savingsPotId: savings.id }, '2026-01-28'), 250)
check('lastSortedAmountFor returns null when never sorted to this destination before', lastSortedAmountFor(dataWithPriorSort, { type: 'joint' }, '2026-01-28'), null)

const savingsSuggestion = salarySortSuggestion(dataWithPriorSort, paydayCycle, '2026-01-28', { type: 'savings', savingsPotId: savings.id })
check('Suggestion PREFILL: last-sorted wins over 0 due (savings has no due amount)', savingsSuggestion.prefillAmount, 250)
check('Suggestion LABEL: falls back to last-sorted when due is 0', savingsSuggestion.reasonLabel, 'Last time you sorted: £250.00')

// Pot has a real amount due (£300) despite ALSO having a prior-sort figure on file for a different destination test below — label must always lead with "due" when non-zero, per Adam's explicit "total due always wins the label" rule, even if a prior sort exists and differs.
const dataWithPotPriorSort: AppDataV2 = {
  ...dataWithPriorSort,
  salarySorts: [...dataWithPriorSort.salarySorts, { id: 'sort-pot', payDate: '2025-12-28', personId: meId, targets: [{ id: 'tgt-2', to: { type: 'pot', potId: billsPot.id }, amount: 150, transactionId: 'txn-old-pot' }] }],
}
const potSuggestion = salarySortSuggestion(dataWithPotPriorSort, paydayCycle, '2026-01-28', { type: 'pot', potId: billsPot.id })
check('Suggestion PREFILL: last-sorted (£150) wins over due (£300) once a prior sort exists', potSuggestion.prefillAmount, 150)
check('Suggestion LABEL: due (£300) ALWAYS wins over last-sorted for the label text', potSuggestion.reasonLabel, 'Total due this pay cycle: £300.00')

const freshPotSuggestion = salarySortSuggestion(data, paydayCycle, '2026-01-28', { type: 'pot', potId: billsPot.id })
check('Suggestion PREFILL with no prior sort at all: falls back to due amount', freshPotSuggestion.prefillAmount, 300)

// ---- 5. Two-way sync via the exact same state-transition shape LedgerContext uses ----
// (Reimplemented against dropSalarySortTarget directly — the one exported pure helper — since saveSalarySort/updateTransaction/removeTransaction themselves are closures inside the React provider and not unit-callable outside it. This checks the shared primitive both React actions are built on.)
const savedSort: SalarySort = { id: 'sort-feb', payDate: '2026-02-28', targets: [
  { id: 't-a', to: { type: 'savings', savingsPotId: savings.id }, amount: 250, transactionId: 'txn-a' },
  { id: 't-b', to: { type: 'pot', potId: billsPot.id }, amount: 300, transactionId: 'txn-b' },
] }
const afterDropOne = dropSalarySortTarget([savedSort], savedSort.id, 'txn-a')
check('dropSalarySortTarget removes just the one target, leaves the sort record with the other', afterDropOne, [{ ...savedSort, targets: [savedSort.targets[1]] }])
const afterDropBoth = dropSalarySortTarget(afterDropOne, savedSort.id, 'txn-b')
check('dropSalarySortTarget removes the WHOLE SalarySort once its last target is gone (an empty sort isn\'t a sort)', afterDropBoth, [])

// ---- 6. buildTransferTransaction — sourceType/sourceId link + note convention ----
const salarySortTxn = buildTransferTransaction({ type: 'personal' }, { type: 'pot', potId: billsPot.id }, 300, '2026-02-28', meId, {
  note: 'Salary Sort → Bills',
  sourceType: 'salary_sort',
  sourceId: 'sort-feb',
})
check('buildTransferTransaction: salary-sort transaction carries sourceType/sourceId for the two-way link', { sourceType: salarySortTxn.sourceType, sourceId: salarySortTxn.sourceId }, { sourceType: 'salary_sort', sourceId: 'sort-feb' })
check('buildTransferTransaction: note follows the "Salary Sort → Destination" display convention', salarySortTxn.note, 'Salary Sort → Bills')
check('buildTransferTransaction: still a real, ordinary transfer otherwise (direction/potId, location flattened to personal since that\'s one endpoint)', { direction: salarySortTxn.direction, location: salarySortTxn.location, potId: salarySortTxn.potId }, { direction: 'out', location: 'personal', potId: billsPot.id })

// ---- 7. followsCycleStart resolution (schedule.ts) ----
const cycleFollowingTemplate: RecurringTemplate = {
  id: 'rt-transfer-cycle',
  name: 'Cycle sweep',
  amount: 100,
  categoryId: 'category-savings',
  paymentMethod: 'bank_transfer',
  frequency: 'monthly',
  anchorDate: '2026-01-05',
  location: 'personal',
  ownerId: meId,
  payee: '',
  payeeSharePercent: 100,
  active: true,
  kind: 'transfer',
  transferFrom: { type: 'personal' },
  transferTo: { type: 'savings', savingsPotId: savings.id },
  followsCycleStart: true,
}
const cycleOccurrences = generateTransactionsForTemplate(cycleFollowingTemplate, new Date('2026-01-01'), new Date('2026-03-31'), budgetCycleCycle)
check('followsCycleStart resolves each occurrence onto the actual cycle boundary (14th, per cycleStartDayOfMonth)', cycleOccurrences.every((o) => o.date.endsWith('-14')), true)
check('followsCycleStart is carried through onto the generated transaction for display', cycleOccurrences[0]?.followsCycleStart, true)

// followsPayday still wins if (incorrectly) both were set on the same template.
const bothSetTemplate: RecurringTemplate = { ...cycleFollowingTemplate, id: 'rt-both', followsPayday: true }
const bothOccurrences = generateTransactionsForTemplate(bothSetTemplate, new Date('2026-01-01'), new Date('2026-02-28'), paydayCycle)
check('followsPayday wins the tie-break when both followsPayday and followsCycleStart are set', bothOccurrences[0]?.date, '2026-01-28')

// ---- 8. Conflict detection — both directions, exact-location match only ----
const existingOneOff: Transaction = buildTransferTransaction({ type: 'personal' }, { type: 'pot', potId: billsPot.id }, 300, '2026-01-28', meId)
const dataWithOneOff: AppDataV2 = { ...data, transactions: [...data.transactions, existingOneOff] }
check('findOneOffTransferConflict finds an existing one-off transfer to the exact same destination/date', findOneOffTransferConflict(dataWithOneOff, '2026-01-28', { type: 'pot', potId: billsPot.id })?.id, existingOneOff.id)
check('findOneOffTransferConflict finds nothing for a DIFFERENT destination', findOneOffTransferConflict(dataWithOneOff, '2026-01-28', { type: 'joint' }), undefined)

const recurringConflictTemplate: RecurringTemplate = {
  ...cycleFollowingTemplate,
  id: 'rt-recurring-conflict',
  transferTo: { type: 'pot', potId: billsPot.id },
  followsCycleStart: false,
  followsPayday: true,
  // Deliberately NOT anchored on the 28th itself (paydayDayOfMonth) —
  // upcomingPaydays only ever returns dates STRICTLY AFTER its `fromDate`
  // (same convention salaryLedger.ts's own header describes), so an
  // occurrence whose NOMINAL (pre-adjustment) walked date already equals
  // that month's resolved payday exactly would resolve one whole cycle
  // too late. Anchoring on the 5th keeps the nominal walk safely inside
  // the month, ahead of the same month's resolved payday, which is the
  // realistic case (a person picks an actual start date, not literally
  // "day = paydayDayOfMonth"). Flagged here rather than silently
  // "fixed" — this quirk lives in the Transfer session's existing
  // upcomingPaydays-based resolution (lib/schedule.ts, unchanged by this
  // session), not in anything new to Salary Sort.
  anchorDate: '2025-06-05',
}
const dataWithRecurring: AppDataV2 = { ...data, recurringTemplates: [...data.recurringTemplates, recurringConflictTemplate] }
check('findRecurringTransferConflict finds an active recurring transfer whose next occurrence lands on this exact payday', findRecurringTransferConflict(dataWithRecurring, paydayCycle, '2026-01-28', { type: 'pot', potId: billsPot.id })?.id, recurringConflictTemplate.id)

const reverseConflicts = findSalarySortConflicts(dataWithPotPriorSort, { type: 'pot', potId: billsPot.id }, ['2025-12-28', '2026-01-28'])
check('findSalarySortConflicts (reverse guard) finds the prior sort targeting this exact destination on a scanned date', reverseConflicts, [{ payDate: '2025-12-28', amount: 150 }])
check('findSalarySortConflicts finds nothing for a date never sorted', findSalarySortConflicts(dataWithPotPriorSort, { type: 'pot', potId: billsPot.id }, ['2026-03-28']), [])

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
