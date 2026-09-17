// PROMPT-07 Part 1: What-if savings-pot actions (savings_pot_lump_sum,
// savings_pot_withdrawal, savings_pot_recurring_deposit_change), rebuilt
// against real savings pots after Q6's legacy savings-goal removal took
// out the old savings_lump_sum action (DECISIONS-2026-09-15.md Q6).
//
// Design (Adam, 2026-09-17): one card per pot. The pot now, then one
// section per date, each building on the ones before, then all changes
// against now. Every action has a date.
//
// Section 0: projectedTargetDate folds in stored activity dated after today.
// Section 1: synthetic pots.
// Section 2: Adam's real backup. The follows-payday deposit is counted and
//   dated on payday (Batch 21, APP-KNOWLEDGE.md §1.13a), and a lump sum
//   raises the projected balance (it didn't: projectedBalanceAt ignores
//   `currentBalance`).
// Section 3: mum's real backup (no savings pots): no pot impacts, no errors.
//
// The engine uses the real `new Date()`, so every date here is relative to
// today, and the real-backup checks are relational.

import { readFileSync } from 'node:fs'
import { addMonths, addYears, startOfMonth } from 'date-fns'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { buildLegacyAppData } from '../src/lib/legacyBridge'
import { calculateScenarioImpact, calculateHouseholdScenarioImpact } from '../src/lib/scenarios'
import { newSavingsPot, projectedTargetDate } from '../src/lib/savingsPotLedger'
import { toLocalIsoDate, todayIso } from '../src/lib/date'
import type { AppDataV2, PayCycleConfig, Person, RecurringTemplate, SavingsPot, Transaction } from '../src/types/ledger'
import type { AppData, Scenario } from '../src/types/models'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}
function checkTrue(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`)
  if (!ok) failures++
}

type Action = Scenario['actions'][number]
function scenario(...actions: Omit<Action, 'id' | 'label'>[]): Scenario {
  return { id: 'sc', name: 'Test', includeInCumulative: true, actions: actions.map((a, i) => ({ id: `a${i}`, label: '', ...a })) }
}
const noInterest = { type: 'aer_credited', aer: 0, creditingFrequency: 'monthly' } as const
const today = todayIso()
const monthStart = (n: number) => toLocalIsoDate(addMonths(startOfMonth(new Date()), n)) // 1st of the month, n months ahead
const d1 = monthStart(2)
const d2 = monthStart(4)
const farTargetDate = toLocalIsoDate(addYears(new Date(), 8))

const me: Person = {
  id: 'me',
  name: 'Me',
  color: '#ff5b4c',
  salaryHistory: [{ id: 's1', personId: 'me', effectiveFrom: '2026-01-01', grossAnnual: 40000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] }],
  salaryOverrides: [],
}
const pot = (id: string, overrides: Partial<Parameters<typeof newSavingsPot>[0]>): SavingsPot => ({
  ...newSavingsPot({ personId: 'me', name: id, openingBalance: 5000, openingDate: '2026-01-01', interestMethod: noInterest, color: '#8b5cf6', ...overrides }),
  id,
})
const transfer = (id: string, potId: string, amount: number, frequency: RecurringTemplate['frequency']): RecurringTemplate => ({
  id,
  name: id,
  amount,
  categoryId: 'category-savings',
  paymentMethod: 'bank_transfer',
  frequency,
  anchorDate: '2026-01-15',
  location: 'personal',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  kind: 'transfer',
  transferFrom: { type: 'personal' },
  transferTo: { type: 'savings', savingsPotId: potId },
  active: true,
})
const payCycle: PayCycleConfig = { personId: 'me', openingBalance: 0, openingBalanceDate: '2026-01-01', paydayDayOfMonth: 28, paydayAdjustForNonWorkingDay: true, cycleStartDayOfMonth: 1 }

console.log('0. projectedTargetDate counts stored activity dated after today')
{
  const p = pot('p0', { targetAmount: 8000 })
  const templates = [transfer('t0', 'p0', 500, 'monthly')]
  const deposit = (date: string, amount: number): Transaction => ({
    id: `dep-${date}`,
    date,
    amount,
    direction: 'out',
    categoryId: 'category-savings',
    paymentMethod: 'bank_transfer',
    status: 'pending',
    type: 'savings_deposit',
    location: 'personal',
    ownerId: 'me',
    savingsPotId: 'p0',
  })
  const now = new Date()
  const without = projectedTargetDate(p, 5000, [], now, templates, payCycle)
  const withFuture = projectedTargetDate(p, 5000, [deposit(d1, 2000)], now, templates, payCycle)
  checkTrue('A logged £2,000 deposit dated in two months brings the reach date forward', Boolean(without && withFuture && withFuture < without), { without, withFuture })
  const withPast = projectedTargetDate(p, 5000, [deposit('2026-02-01', 2000)], now, templates, payCycle)
  check('A past-dated deposit (already inside currentBalance) is not counted twice', withPast, without)
}

console.log('\n1. Synthetic pots')
{
  const ledgerData: AppDataV2 = {
    people: [me],
    categories: [],
    recurringTemplates: [transfer('tpl-target', 'pot-target', 500, 'monthly'), transfer('tpl-amount', 'pot-amount-only', 500, 'monthly'), transfer('tpl-weekly', 'pot-weekly', 100, 'weekly')],
    loans: [],
    creditCards: [],
    transactions: [],
    payCycles: [payCycle],
    savingsPots: [
      pot('pot-target', { targetAmount: 50000, targetDate: farTargetDate }),
      pot('pot-amount-only', { targetAmount: 50000 }),
      pot('pot-no-target', { openingBalance: 2000 }),
      pot('pot-reached', { openingBalance: 3000, targetAmount: 2500 }),
      pot('pot-weekly', { targetAmount: 50000 }),
      pot('pot-no-deposit', { openingBalance: 1000, targetAmount: 3000 }),
    ],
    scenarios: [],
    primaryPersonId: 'me',
  }
  const data = buildLegacyAppData(ledgerData)
  const run = (...actions: Omit<Action, 'id' | 'label'>[]) => calculateScenarioImpact(scenario(...actions), data, 'me', 1000)
  const lump = (value: number, date: string | undefined, savingsPotId = 'pot-target') => ({ type: 'savings_pot_lump_sum' as const, value, date, savingsPotId })
  const withdraw = (value: number, date: string, savingsPotId = 'pot-target') => ({ type: 'savings_pot_withdrawal' as const, value, date, savingsPotId })
  const deposit = (value: number, date: string, savingsPotId = 'pot-target') => ({ type: 'savings_pot_recurring_deposit_change' as const, value, date, savingsPotId })

  // ---- Now ----
  const nowOnly = run(lump(1, d1)).savingsPotImpacts[0]
  check('Now: balance', nowOnly.balanceNow, 5000)
  check('Now: target', [nowOnly.targetAmount, nowOnly.targetDate], [50000, farTargetDate])
  checkTrue('Now: on-track-for date and months behind/ahead are set', Boolean(nowOnly.currentReachDate) && typeof nowOnly.monthsBehindTarget === 'number')

  // ---- One dated lump sum ----
  const single = run(lump(2000, d1))
  const s = single.savingsPotImpacts[0].sections
  check('Dated lump sum: one section', s.length, 1)
  check('Dated lump sum: section is on its date', s[0].date, d1)
  check('Dated lump sum: balance on that date goes up by the lump sum', s[0].balanceOnDateAfter - s[0].balanceOnDateBefore, 2000)
  checkTrue("Dated lump sum: 'before' includes the scheduled deposits up to that date", s[0].balanceOnDateBefore > 5000, s[0].balanceOnDateBefore)
  checkTrue('Dated lump sum: reaches target sooner', s[0].monthsSaved > 0, s[0])
  check('Dated lump sum: balance on the target date up by the lump sum', (s[0].balanceOnTargetDateAfter ?? 0) - (s[0].balanceOnTargetDateBefore ?? 0), 2000)
  check('Dated lump sum: section one-off cash', s[0].oneOffCash, -2000)
  check('Dated lump sum: scenario one-off cash', single.oneOffCashImpact, -2000)
  check('Dated lump sum: no monthly change', [s[0].monthlyCashChange, single.monthlyImpact], [0, 0])

  const later = run(lump(2000, d2)).savingsPotImpacts[0].sections[0]
  checkTrue('A later lump sum saves less time than an earlier one (or the same)', later.monthsSaved <= s[0].monthsSaved, { d1: s[0].monthsSaved, d2: later.monthsSaved })

  const todayLump = run(lump(2000, today)).savingsPotImpacts[0].sections[0]
  check('Lump sum today: balance today £5,000 → £7,000', [todayLump.balanceOnDateBefore, todayLump.balanceOnDateAfter], [5000, 7000])
  check('Undated (saved before dates existed): treated as today', run(lump(2000, undefined)).savingsPotImpacts[0].sections[0].date, today)
  check('Past-dated: treated as today', run(lump(2000, '2020-01-01')).savingsPotImpacts[0].sections[0].date, today)

  // ---- Deposit change from a date ----
  const fromD2 = run(deposit(800, d2))
  const r = fromD2.savingsPotImpacts[0].sections[0]
  check('Deposit change: old and new monthly amounts', [r.oldRecurringMonthlyAmount, r.newRecurringMonthlyAmount], [500, 800])
  check('Deposit change: section available cash', r.monthlyCashChange, -300)
  check('Deposit change: scenario monthly impact', fromD2.monthlyImpact, -300)
  check('Deposit change: no one-off cash', r.oneOffCash, 0)
  const fromToday = run(deposit(800, today)).savingsPotImpacts[0].sections[0]
  checkTrue('Deposit change from a later date reaches the target later than from today', Boolean(r.reachDateAfter && fromToday.reachDateAfter && r.reachDateAfter > fromToday.reachDateAfter), {
    fromD2: r.reachDateAfter,
    fromToday: fromToday.reachDateAfter,
  })
  checkTrue('Deposit change: balance on the target date rises', (r.balanceOnTargetDateAfter ?? 0) > (r.balanceOnTargetDateBefore ?? 0))
  // Deposits land on the 15th; the change starts on the 1st, so the balance on the 1st itself is unchanged.
  check('Deposit change: balance on its own start date unchanged (no deposit that day)', r.balanceOnDateAfter, r.balanceOnDateBefore)

  // ---- Two dates build on each other ----
  const combined = run(lump(2000, d1), deposit(800, d2))
  const c = combined.savingsPotImpacts[0]
  check('Two dates: two sections, in date order', c.sections.map((x) => x.date), [d1, d2])
  check("Two dates: section 2's reach 'before' is section 1's 'after'", c.sections[1].reachDateBefore, c.sections[0].reachDateAfter)
  check("Two dates: section 2's target-date balance 'before' is section 1's 'after'", c.sections[1].balanceOnTargetDateBefore, c.sections[0].balanceOnTargetDateAfter)
  checkTrue("Two dates: section 2's balance on its date includes section 1's lump sum", c.sections[1].balanceOnDateBefore >= c.sections[0].balanceOnDateAfter)
  check('Two dates: summary reach date is the last section after', c.finalReachDate, c.sections[1].reachDateAfter)
  check('Two dates: summary starts from now', c.balanceOnTargetDateNow, c.sections[0].balanceOnTargetDateBefore)
  check('Two dates: summary target-date balance is the last section after', c.balanceOnTargetDateAfterAll, c.sections[1].balanceOnTargetDateAfter)
  checkTrue('Two dates: all changes save more time than either alone', c.totalMonthsSaved >= Math.max(c.sections[0].monthsSaved, c.sections[1].monthsSaved) && c.totalMonthsSaved > 0, c.totalMonthsSaved)
  check('Two dates: totals', [c.totalOneOffCash, c.totalMonthlyCashChange, combined.oneOffCashImpact, combined.monthlyImpact], [-2000, -300, -2000, -300])

  const reversed = run(deposit(800, d2), lump(2000, d1)).savingsPotImpacts[0]
  check('Action order in the form does not matter, only dates', JSON.stringify(reversed), JSON.stringify(c))

  const sameDay = run(lump(2000, d1), deposit(800, d1)).savingsPotImpacts[0]
  check('Lump sum and deposit change on the same date: one section', sameDay.sections.length, 1)
  checkTrue('...holding both', sameDay.sections[0].lumpSum === 2000 && sameDay.sections[0].newRecurringMonthlyAmount === 800)

  const twoDeposits = run(deposit(800, d1), deposit(600, d2))
  const td = twoDeposits.savingsPotImpacts[0].sections
  check("Two deposit changes: the second's 'old' amount is the first's new one", [td[0].oldRecurringMonthlyAmount, td[1].oldRecurringMonthlyAmount, td[1].newRecurringMonthlyAmount], [500, 800, 600])
  check('Two deposit changes: section cash changes -£300 then +£200', [td[0].monthlyCashChange, td[1].monthlyCashChange], [-300, 200])
  check('Two deposit changes: net monthly impact -£100', twoDeposits.monthlyImpact, -100)
  check('Two deposit changes on one date: the later action wins', run(deposit(800, d1), deposit(700, d1)).savingsPotImpacts[0].sections[0].newRecurringMonthlyAmount, 700)

  // ---- Withdrawals ----
  const w = run(withdraw(1500, d1)).savingsPotImpacts[0].sections[0]
  check('Withdrawal: balance on that date falls by it', w.balanceOnDateAfter - w.balanceOnDateBefore, -1500)
  check('Withdrawal: one-off cash', w.oneOffCash, 1500)
  checkTrue('Withdrawal: reaches target later', w.monthsSaved < 0, w.monthsSaved)
  const capped = run(withdraw(999999, d1)).savingsPotImpacts[0].sections[0]
  check('Withdrawal capped at the expected balance on its date (scheduled deposits included)', capped.withdrawal, capped.balanceOnDateBefore)
  check('...leaving £0', capped.balanceOnDateAfter, 0)
  const lumpThenAll = run(lump(1000, d1), withdraw(999999, d2)).savingsPotImpacts[0].sections[1]
  check('A later withdrawal can take an earlier lump sum too', lumpThenAll.withdrawal, lumpThenAll.balanceOnDateBefore)

  // ---- Template frequencies, missing templates ----
  check('Weekly template: old amount shown as its monthly equivalent (£100 × 52/12)', run(deposit(866.67, d1, 'pot-weekly')).savingsPotImpacts[0].sections[0].oldRecurringMonthlyAmount, 433.33)
  const brandNew = run(deposit(200, d1, 'pot-no-deposit')).savingsPotImpacts[0]
  check('No existing deposit: old amount £0', brandNew.sections[0].oldRecurringMonthlyAmount, 0)
  checkTrue('No existing deposit: never reaches target now, does with the new deposit', brandNew.currentReachDate === null && Boolean(brandNew.sections[0].reachDateAfter) && brandNew.sections[0].reachDateAfter! > d1, brandNew.sections[0])

  // ---- Targets ----
  const amountOnly = run(lump(2000, d1, 'pot-amount-only')).savingsPotImpacts[0].sections[0]
  checkTrue('Target amount, no date: reach dates shown', Boolean(amountOnly.reachDateBefore && amountOnly.reachDateAfter))
  check('Target amount, no date: no target-date balance', amountOnly.balanceOnTargetDateAfter, null)
  const noTarget = run(lump(500, d1, 'pot-no-target')).savingsPotImpacts[0]
  check('No target: no reach dates, no target-date balance', [noTarget.currentReachDate, noTarget.sections[0].reachDateAfter, noTarget.sections[0].balanceOnTargetDateAfter], [null, null, null])
  check('No target: balance on the date still shown', noTarget.sections[0].balanceOnDateAfter - noTarget.sections[0].balanceOnDateBefore, 500)
  const reached = run(lump(100, d1, 'pot-reached')).savingsPotImpacts[0]
  check('Target already reached: flagged, no reach dates', [reached.targetReached, reached.currentReachDate, reached.sections[0].reachDateAfter], [true, null, null])

  const nearTarget: AppData = { ...data, savingsPots: data.savingsPots.map((p) => (p.id === 'pot-target' ? { ...p, targetDate: monthStart(3) } : p)) }
  const afterTarget = calculateScenarioImpact(scenario(lump(100, d2)), nearTarget, 'me', 0).savingsPotImpacts[0]
  check('Section dated after the target date: no target-date balance for it', afterTarget.sections[0].balanceOnTargetDateAfter, null)
  const pastTarget: AppData = { ...data, savingsPots: data.savingsPots.map((p) => (p.id === 'pot-target' ? { ...p, targetDate: '2020-01-01' } : p)) }
  const past = calculateScenarioImpact(scenario(lump(100, d1)), pastTarget, 'me', 0).savingsPotImpacts[0]
  checkTrue('Target date in the past: no target-date balances, shown as late', past.balanceOnTargetDateNow === null && (past.monthsBehindTarget ?? 0) > 0)

  // ---- Viewer scoping and household ----
  const mum: Person = { ...me, id: 'mum', name: 'Mum', salaryHistory: [{ ...me.salaryHistory[0], id: 's2', personId: 'mum' }] }
  const householdData = buildLegacyAppData({ ...ledgerData, people: [me, mum] })
  const recurringScenario = scenario(deposit(800, d1))
  check("Deposit change on my pot: no monthly impact in mum's view", calculateScenarioImpact(recurringScenario, householdData, 'mum', 0).monthlyImpact, 0)
  const household = calculateHouseholdScenarioImpact(recurringScenario, householdData, 0)
  check('Household: monthly impact counted once, one card', [household.monthlyImpact, household.savingsPotImpacts.length], [-300, 1])

  const missing = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 100, date: d1 }), data, 'me', 0)
  check('No pot chosen: no impact, no one-off cash, no throw', [missing.savingsPotImpacts.length, missing.oneOffCashImpact], [0, 0])
}

console.log("\n2. Adam's real backup")
{
  const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15.json', 'utf8'))
  const data = buildLegacyAppData(migrateLedgerData(raw.data ?? raw))
  const savings = data.savingsPots.find((p) => p.name === 'Savings')!
  checkTrue("'Savings' pot exposed with its real target (£10,000 by 31 Mar 2027)", savings?.targetAmount === 10000 && savings?.targetDate === '2027-03-31')
  const nextMonth = monthStart(1)

  const lump = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 1000, date: nextMonth, savingsPotId: savings.id }), data, data.primaryPersonId, 0).savingsPotImpacts[0]
  const ls = lump.sections[0]
  checkTrue('£1,000 lump sum next month: reaches the target no later', ls.monthsSaved >= 0 && Boolean(ls.reachDateAfter), ls)
  if (savings.targetDate! > nextMonth) {
    const gain = (ls.balanceOnTargetDateAfter ?? 0) - (ls.balanceOnTargetDateBefore ?? 0)
    checkTrue('£1,000 lump sum: balance on 31 Mar 2027 rises by £1,000 plus a little interest (was £0 before the fix)', gain >= 1000 && gain < 1100, gain)
  } else {
    console.log('  (skipped the target-date balance check: 31 Mar 2027 has passed)')
  }

  const combined = calculateScenarioImpact(
    scenario({ type: 'savings_pot_recurring_deposit_change', value: 1500, date: monthStart(3), savingsPotId: savings.id }, { type: 'savings_pot_lump_sum', value: 1000, date: nextMonth, savingsPotId: savings.id }),
    data,
    data.primaryPersonId,
    0,
  )
  const cs = combined.savingsPotImpacts[0].sections
  check('Lump sum next month + £1,500 deposit from month 3: one card, two sections', [combined.savingsPotImpacts.length, cs.length], [1, 2])
  check("Old deposit read off 'Savings Deposit'", cs[1].oldRecurringMonthlyAmount, 1000)
  check('-£500/month, -£1,000 one-off', [combined.monthlyImpact, combined.oneOffCashImpact], [-500, -1000])
  check('Sections build on each other', cs[1].reachDateBefore, cs[0].reachDateAfter)

  // 🚨 Batch 21: the £1,000/mo follows-payday deposit must be counted (strip
  // the templates and the pot never reaches its target) and dated on
  // payday, not its 12th-of-the-month slot (strip the pay cycle and the
  // reach date moves).
  const reachReal = lump.currentReachDate
  const reachNoTemplates = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 1000, date: nextMonth, savingsPotId: savings.id }), { ...data, recurringTemplates: [] }, data.primaryPersonId, 0).savingsPotImpacts[0].currentReachDate
  const reachNoPayCycle = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 1000, date: nextMonth, savingsPotId: savings.id }), { ...data, payCycles: [] }, data.primaryPersonId, 0).savingsPotImpacts[0].currentReachDate
  checkTrue('Without the recurring templates the deposit vanishes: target not reached for years', reachNoTemplates === null || (reachReal !== null && reachNoTemplates > reachReal), { reachReal, reachNoTemplates })
  checkTrue('Without the pay cycle the deposit lands on the wrong day: the reach date changes', reachReal !== reachNoPayCycle, { reachReal, reachNoPayCycle })
}

console.log("\n3. Mum's real backup (no savings pots)")
{
  const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15-mum.json', 'utf8'))
  const data = buildLegacyAppData(migrateLedgerData(raw.data ?? raw))
  check('No savings pots at all', data.savingsPots.length, 0)
  let threw = false
  let impact: ReturnType<typeof calculateScenarioImpact> | undefined
  try {
    impact = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 100, date: d1, savingsPotId: 'nonexistent' }), data, data.primaryPersonId, 0)
  } catch {
    threw = true
  }
  checkTrue('A pot action pointing at a missing pot does not throw', !threw)
  check('...and produces no pot impacts', impact?.savingsPotImpacts.length, 0)
}

console.log(failures === 0 ? '\nAll savings-pot scenario checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
