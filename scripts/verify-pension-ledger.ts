// Regression checks for Pension (backlog item c). Covers:
//  1. generatePensionTransactions across weekly/monthly frequency, amount
//     history, occurrence overrides (edit + delete), and an inactive
//     pension generating nothing.
//  2. resolvePensionAmount / applyPensionAmountChange — same tie-break and
//     patch-building contract as schedule.ts's RecurringTemplate versions.
//  3. Every generated transaction's shape: direction/category/sourceType/
//     sourceId/personId/note, matching Pension's "treated as income
//     exactly like salary" spec.
//  4. autoClearDuePayments actually materializes a due pension payment
//     (not just computes it) and reconcilePensionTransactions corrects an
//     already-cleared one after the pension's amount changes.
//  5. convertClearedSalaryToStandaloneIncome — the confirmed "silently
//     convert cleared payments" behaviour when a salary is deleted:
//     cleared rows convert, pending rows and other people's rows don't.

import { generatePensionTransactions, resolvePensionAmount, applyPensionAmountChange, pensionOccurrencePreviews, newPension, pensionCycleBounds, resolveCycleBounds } from '../src/lib/pensionLedger'
import { convertClearedSalaryToStandaloneIncome } from '../src/lib/salaryLedger'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { cycleBoundsForDate } from '../src/lib/payCycle'
import { toLocalIsoDate as toIso } from '../src/lib/date'
import { INCOME_CATEGORY_ID } from '../src/types/ledger'
import { defaultPayCycleConfig } from '../src/lib/ledgerStorage'
import type { AppDataV2, PayCycleConfig, Pension, Person, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// ---- 1. Basic generation: monthly, and weekly ----
const statePension: Pension = {
  id: 'pen-state',
  personId: 'p1',
  name: 'State Pension',
  amount: 221.2,
  frequency: 'weekly',
  anchorDate: '2026-01-05', // a Monday
  active: true,
  adjustForNonWorkingDay: false,
  cycleStartFollowsPayday: false,
}
const stateOccurrences = generatePensionTransactions(statePension, new Date(2026, 0, 1), new Date(2026, 0, 31))
check('Weekly pension: 4 Mondays fall within January 2026 (5th, 12th, 19th, 26th)', stateOccurrences.length, 4)
check('Each weekly occurrence is £221.20', stateOccurrences.every((t) => t.amount === 221.2), true)

const privatePension: Pension = {
  id: 'pen-private',
  personId: 'p1',
  name: 'Private Pension',
  amount: 500,
  frequency: 'monthly',
  anchorDate: '2026-01-15',
  active: true,
  adjustForNonWorkingDay: false,
  cycleStartFollowsPayday: false,
}
const privateOccurrences = generatePensionTransactions(privatePension, new Date(2026, 0, 1), new Date(2026, 5, 30))
check('Monthly pension: 6 occurrences Jan–Jun 2026', privateOccurrences.length, 6)
check('Monthly pension dates land on the 15th every month', privateOccurrences.map((t) => t.date).sort(), ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15'].sort())

// ---- 2. Transaction shape — "treated as income exactly like salary" ----
const one = privateOccurrences[0]
check('direction is "in"', one.direction, 'in')
check('categoryId is the reserved Income category', one.categoryId, INCOME_CATEGORY_ID)
check('type is pension_income, distinct from salary', one.type, 'pension_income')
check('status starts pending', one.status, 'pending')
check('sourceType/sourceId link back to the Pension', [one.sourceType, one.sourceId], ['pension', 'pen-private'])
check('personId set (so it counts as this person\'s income)', one.personId, 'p1')
check('note carries the pension\'s own name, not a generic "Salary" label', one.note, 'Private Pension')

// ---- 3. Inactive pension generates nothing ----
const paused: Pension = { ...privatePension, active: false }
check('An inactive pension generates zero occurrences', generatePensionTransactions(paused, new Date(2026, 0, 1), new Date(2026, 11, 31)).length, 0)

// ---- 4. resolvePensionAmount + amountHistory (standing change, "all future") ----
const raised: Pension = {
  ...privatePension,
  amount: 550,
  amountEffectiveFrom: '2026-04-15',
  amountHistory: [{ effectiveFrom: '2026-01-15', amount: 500 }],
}
check('Before the raise: old amount applies', resolvePensionAmount(raised, '2026-03-15'), 500)
check('On the raise date: new amount applies', resolvePensionAmount(raised, '2026-04-15'), 550)
check('After the raise: new amount still applies', resolvePensionAmount(raised, '2026-06-15'), 550)

const raisedOccurrences = generatePensionTransactions(raised, new Date(2026, 0, 1), new Date(2026, 5, 30))
check('Generated occurrences reflect the historized raise, not a flat amount', raisedOccurrences.map((t) => t.amount), [500, 500, 500, 550, 550, 550])

// ---- 5. applyPensionAmountChange builds the correct patch ----
const patch = applyPensionAmountChange(privatePension, 600, '2026-07-15')
check('New amount is the patch\'s amount', patch.amount, 600)
check('amountEffectiveFrom is the chosen date', patch.amountEffectiveFrom, '2026-07-15')
check('Prior value preserved in amountHistory', patch.amountHistory, [{ effectiveFrom: '2026-01-15', amount: 500 }])

// ---- 6. occurrenceOverrides — single-row edit + delete, same shape as RecurringTemplate ----
const withOverrides: Pension = {
  ...privatePension,
  occurrenceOverrides: [
    { originalDate: '2026-02-15', amount: 750 }, // one-off higher payment this month only
    { originalDate: '2026-03-15', deleted: true }, // skipped entirely
  ],
}
const overriddenOccurrences = generatePensionTransactions(withOverrides, new Date(2026, 0, 1), new Date(2026, 3, 30))
check('Deleted occurrence is dropped entirely (Jan, Feb, Apr remain — Mar gone)', overriddenOccurrences.map((t) => t.date), ['2026-01-15', '2026-02-15', '2026-04-15'])
check('Overridden amount applies to just that one occurrence', overriddenOccurrences.find((t) => t.date === '2026-02-15')?.amount, 750)
check('Every other occurrence keeps the standing amount', overriddenOccurrences.find((t) => t.date === '2026-01-15')?.amount, 500)

// ---- 7. pensionOccurrencePreviews — Wallet.tsx's "next N upcoming" pills ----
const previews = pensionOccurrencePreviews(privatePension, new Date(2026, 0, 1), 3)
check('Returns exactly `count` previews', previews.length, 3)
check('Each preview carries its originalDate alongside the resolved date', previews[0].originalDate, previews[0].date)

// ---- 8. newPension constructor ----
const built = newPension({ personId: 'p1', name: 'Test', amount: 100, frequency: 'monthly', anchorDate: '2026-01-01' })
check('newPension defaults to active', built.active, true)

// ---- 9. autoClearDuePayments actually materializes a due pension payment ----
const person: Person = { id: 'p1', name: 'Pat', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [] }
const payCycle = { ...defaultPayCycleConfig('p1'), openingBalanceDate: '2026-01-01' }
const baseData: AppDataV2 = {
  people: [person],
  categories: [],
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  pensions: [{ ...privatePension, anchorDate: '2026-01-15' }],
  transactions: [],
  payCycles: [payCycle],
  scenarios: [],
  primaryPersonId: 'p1',
}
const afterAutoClear = autoClearDuePayments(baseData, new Date(2026, 1, 20)) // 20 Feb — Jan + Feb payments due
const materialized = afterAutoClear.transactions.filter((t) => t.type === 'pension_income')
check('Two pension payments materialized as real, cleared transactions', materialized.length, 2)
check('Both are cleared, not pending', materialized.every((t) => t.status === 'cleared'), true)

// A second pass on the SAME data (asOf unchanged) must be a no-op — the
// dedupeKey (sourceType:sourceId:date) should suppress re-materializing
// what's already there.
const secondPass = autoClearDuePayments(afterAutoClear, new Date(2026, 1, 20))
check('A second pass with nothing new due changes nothing (idempotent)', secondPass === afterAutoClear, true)

// ---- 10. reconcilePensionTransactions corrects an already-cleared row after the amount changes ----
const raisedAfterClearing: AppDataV2 = { ...afterAutoClear, pensions: [{ ...afterAutoClear.pensions[0], amount: 700 }] }
const reconciled = autoClearDuePayments(raisedAfterClearing, new Date(2026, 1, 20))
const reconciledAmounts = reconciled.transactions.filter((t) => t.type === 'pension_income').map((t) => t.amount)
check('Already-cleared pension transactions re-sync to the new amount', reconciledAmounts, [700, 700])

// ---- 11. convertClearedSalaryToStandaloneIncome — the confirmed salary-deletion behaviour ----
const salaryTx: Transaction = {
  id: 't1',
  date: '2026-01-28',
  amount: 3000,
  direction: 'in',
  categoryId: INCOME_CATEGORY_ID,
  paymentMethod: 'bank_transfer',
  status: 'cleared',
  type: 'salary',
  location: 'personal',
  ownerId: 'p1',
  personId: 'p1',
}
const pendingSalaryTx: Transaction = { ...salaryTx, id: 't2', date: '2026-03-28', status: 'pending' }
const otherPersonSalaryTx: Transaction = { ...salaryTx, id: 't3', personId: 'p2', ownerId: 'p2' }
const unrelatedTx: Transaction = { ...salaryTx, id: 't4', type: 'expense', direction: 'out' }

const converted = convertClearedSalaryToStandaloneIncome([salaryTx, pendingSalaryTx, otherPersonSalaryTx, unrelatedTx], 'p1')
check('The cleared salary transaction for THIS person converts to plain income', converted.find((t) => t.id === 't1')?.type, 'income')
check('A PENDING salary transaction is left alone (still salary)', converted.find((t) => t.id === 't2')?.type, 'salary')
check("Another person's cleared salary transaction is left alone", converted.find((t) => t.id === 't3')?.type, 'salary')
check('A non-salary transaction is untouched', converted.find((t) => t.id === 't4')?.type, 'expense')
check('The converted transaction keeps its amount/date/status — only type changes', converted.find((t) => t.id === 't1'), { ...salaryTx, type: 'income' })

// ---- 12. Weekend/bank-holiday adjustment (adjustForNonWorkingDay) ----
// 2026-08-15 is a Saturday; adjustToWorkingDay should walk it back to Fri 14th.
const weekendPension: Pension = { ...privatePension, anchorDate: '2026-08-15', adjustForNonWorkingDay: true }
const weekendOccurrences = generatePensionTransactions(weekendPension, new Date(2026, 7, 1), new Date(2026, 7, 31))
check('Weekend payday shifts to the last working day before it', weekendOccurrences[0]?.date, '2026-08-14')

const noAdjustPension: Pension = { ...privatePension, anchorDate: '2026-08-15', adjustForNonWorkingDay: false }
const noAdjustOccurrences = generatePensionTransactions(noAdjustPension, new Date(2026, 7, 1), new Date(2026, 7, 31))
check('Without adjustment, the weekend date is used as-is', noAdjustOccurrences[0]?.date, '2026-08-15')

// An occurrence override's own date always wins over the automatic
// adjustment — a deliberate per-occurrence edit shouldn't be silently
// re-adjusted on top of.
const overriddenWeekendPension: Pension = {
  ...weekendPension,
  occurrenceOverrides: [{ originalDate: '2026-08-15', date: '2026-08-17' }],
}
const overriddenWeekendOccurrences = generatePensionTransactions(overriddenWeekendPension, new Date(2026, 7, 1), new Date(2026, 7, 31))
check('An explicit occurrence-date override beats automatic weekend adjustment', overriddenWeekendOccurrences[0]?.date, '2026-08-17')

// ---- 13. pensionCycleBounds — frequency-aware cycle boundaries ----
const weeklyForCycles: Pension = { ...statePension, anchorDate: '2026-01-05', cycleStartFollowsPayday: true } // Monday
const weeklyCycle = pensionCycleBounds(new Date(2026, 0, 20), weeklyForCycles) // a Tuesday, between the 19th and 26th paydays
check('Weekly cycle start is the most recent Monday payday on/before the reference date', toIso(weeklyCycle.start), '2026-01-19')
check('Weekly cycle end is the day before the next payday', toIso(weeklyCycle.end), '2026-01-25')

const monthlyForCycles: Pension = { ...privatePension, anchorDate: '2026-01-15', cycleStartFollowsPayday: true }
const monthlyCycle = pensionCycleBounds(new Date(2026, 2, 20), monthlyForCycles) // 20 March, between 15 Mar and 15 Apr
check('Monthly-pension cycle start is 15 March', toIso(monthlyCycle.start), '2026-03-15')
check('Monthly-pension cycle end is the day before 15 April', toIso(monthlyCycle.end), '2026-04-14')

// ---- 14. resolveCycleBounds — the actual dispatcher every call site now goes through ----
const personForCycles: Person = { id: 'p1', name: 'Pat', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [] }
const salaryPayCycle: PayCycleConfig = { ...defaultPayCycleConfig('p1'), paydayDayOfMonth: 28, paydayAdjustForNonWorkingDay: true, cycleStartDayOfMonth: 1 }
const baseDataForCycles: AppDataV2 = {
  people: [personForCycles],
  categories: [],
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  pensions: [monthlyForCycles],
  transactions: [],
  payCycles: [salaryPayCycle],
  scenarios: [],
  primaryPersonId: 'p1',
}
const salaryBounds = resolveCycleBounds(baseDataForCycles, 'p1', new Date(2026, 2, 20))
check('No followsIncomeSource set: falls back to salary/PayCycleConfig cycle math unchanged', toIso(salaryBounds.start), toIso(cycleBoundsForDate(new Date(2026, 2, 20), salaryPayCycle).start))

const followingPensionCycle: AppDataV2 = {
  ...baseDataForCycles,
  pensions: [{ ...monthlyForCycles, id: 'pen-1' }],
  payCycles: [{ ...salaryPayCycle, followsIncomeSource: { type: 'pension', pensionId: 'pen-1' } }],
}
const pensionBounds = resolveCycleBounds(followingPensionCycle, 'p1', new Date(2026, 2, 20))
check('Following a pension with cycleStartFollowsPayday on: uses that pension\'s own schedule', toIso(pensionBounds.start), '2026-03-15')

const followingPensionFixedCycle: AppDataV2 = {
  ...followingPensionCycle,
  pensions: [{ ...monthlyForCycles, id: 'pen-1', cycleStartFollowsPayday: false }],
}
const pensionFixedBounds = resolveCycleBounds(followingPensionFixedCycle, 'p1', new Date(2026, 2, 20))
check(
  'Following a pension with cycleStartFollowsPayday OFF: falls back to the fixed day-of-month boundary (cycleStartDayOfMonth), not that pension\'s payday',
  toIso(pensionFixedBounds.start),
  toIso(cycleBoundsForDate(new Date(2026, 2, 20), { ...salaryPayCycle, cycleStartFollowsPayday: false }).start),
)

const danglingReference: AppDataV2 = {
  ...baseDataForCycles,
  pensions: [],
  payCycles: [{ ...salaryPayCycle, followsIncomeSource: { type: 'pension', pensionId: 'gone' } }],
}
const danglingBounds = resolveCycleBounds(danglingReference, 'p1', new Date(2026, 2, 20))
check('A dangling followsIncomeSource reference (pension deleted) falls through to salary rather than throwing', toIso(danglingBounds.start), toIso(cycleBoundsForDate(new Date(2026, 2, 20), salaryPayCycle).start))

process.exit(failures === 0 ? 0 : 1)
