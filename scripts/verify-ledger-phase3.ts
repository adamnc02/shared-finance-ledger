import { computeNetPayForPeriod, findApplicableSnapshot, generateSalaryTransactions, computeNetBonusAmount, upcomingPaydays, closedPaydays } from '../src/lib/salaryLedger'
import { computeProjection, horizonRangeEnd, transactionsInRange } from '../src/lib/projection'
import { personShareOfJointAmount, generateJointContributionTransactions, computeJointSummary, jointSharesReconcile } from '../src/lib/jointLedger'
import { isLedgerTransaction, signedAmount } from '../src/lib/runningBalance'
import { defaultCategories } from '../src/lib/categories'
import { INCOME_CATEGORY_ID } from '../src/types/ledger'
import type { AppDataV2, Loan, PayCycleConfig, Person, RecurringTemplate, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ---- 1. Salary snapshot selection + net pay computation ----
const person: Person = {
  id: 'me',
  name: 'Me',
  color: '#ff5b4c',
  salaryHistory: [
    { id: 's1', personId: 'me', effectiveFrom: '2026-01-01', grossAnnual: 40000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] },
    { id: 's2', personId: 'me', effectiveFrom: '2026-07-01', grossAnnual: 45000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] },
  ],
  salaryOverrides: [],
}

check('findApplicableSnapshot picks the £40k snapshot for a June date', findApplicableSnapshot(person, '2026-06-15')?.id, 's1')
check('findApplicableSnapshot picks the £45k snapshot for an August date (after the raise)', findApplicableSnapshot(person, '2026-08-15')?.id, 's2')
check('findApplicableSnapshot returns null before any snapshot is effective', findApplicableSnapshot(person, '2025-12-31'), null)

const juneNetPay = computeNetPayForPeriod(person, '2026-06-15')
const augustNetPay = computeNetPayForPeriod(person, '2026-08-15')
check('August net pay (post-raise) is higher than June (pre-raise)', (augustNetPay ?? 0) > (juneNetPay ?? 0), true)
check('Net pay is a sensible fraction of £40k/12 (not a wildly broken tax calc)', juneNetPay, 40000 / 12, 700) // loose tolerance — this is a sanity bound (tax+NI takes a real bite), not re-testing the tax engine itself

const personWithOverride: Person = {
  ...person,
  salaryOverrides: [{ id: 'o1', personId: 'me', payPeriodDate: '2026-06-30', netPayOverride: 5000, reason: 'Manual override test' }],
}
check('A SalaryOverride for an exact date takes precedence over the computed figure', computeNetPayForPeriod(personWithOverride, '2026-06-30'), 5000)
check('A SalaryOverride does NOT affect a different date', computeNetPayForPeriod(personWithOverride, '2026-06-15'), juneNetPay)

const personWithNoHistory: Person = { ...person, salaryHistory: [] }
check('No salary history at all -> null, not zero', computeNetPayForPeriod(personWithNoHistory, '2026-06-15'), null)

// ---- 1b. Bonus taxation (marginal, not face-value) ----
check('A £0 bonus nets £0, trivially', computeNetBonusAmount(person, '2026-06-15', 0), 0)
check('No applicable snapshot -> null, not zero', computeNetBonusAmount(personWithNoHistory, '2026-06-15', 1000), null)

const modestBonusNet = computeNetBonusAmount(person, '2026-06-15', 500)
check('A modest £500 bonus on a £40k salary nets LESS than £500 (basic-rate + NI bite)', (modestBonusNet ?? 0) < 500, true)
check('...but nets MORE than £500 × 68% (sanity floor — basic rate + NI shouldn\'t exceed ~32% combined for a modest amount)', (modestBonusNet ?? 0) > 500 * 0.68, true)

// A big bonus that tips a £40k earner over the £50,270 higher-rate
// threshold should be taxed at a noticeably worse marginal rate on the
// portion crossing that line than a bonus that stays under it.
const bonusStayingUnderThreshold = computeNetBonusAmount(person, '2026-06-15', 5000) // £40k + £5k = £45k, still basic rate
const bonusCrossingThreshold = computeNetBonusAmount(person, '2026-06-15', 15000) // £40k + £15k = £55k, crosses into higher rate
const marginalRateUnder = 1 - (bonusStayingUnderThreshold ?? 0) / 5000
const marginalRateCrossing = 1 - (bonusCrossingThreshold ?? 0) / 15000
check('A bonus large enough to cross into the higher-rate band has a worse blended marginal rate than one that stays under it', marginalRateCrossing > marginalRateUnder, true)

// ---- 2. generateSalaryTransactions ----
const payCycle: PayCycleConfig = {
  personId: 'me',
  openingBalance: 1000,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 1,
}
const salaryTxns = generateSalaryTransactions(person, payCycle, new Date(2026, 0, 1), new Date(2026, 2, 31))
check('3 months of salary transactions generated (Jan/Feb/Mar 2026)', salaryTxns.length, 3)
check('All generated salary transactions use the reserved Income category', salaryTxns.every((t) => t.categoryId === INCOME_CATEGORY_ID), true)
check('All generated salary transactions are pending (not yet materialized)', salaryTxns.every((t) => t.status === 'pending'), true)
check('Generated salary transactions are direction "in"', salaryTxns.every((t) => t.direction === 'in'), true)

// ---- 3. Horizon projection ----
const rent: RecurringTemplate = {
  id: 'rent-1',
  name: 'Rent',
  amount: 900,
  categoryId: 'home',
  paymentMethod: 'standing_order',
  frequency: 'monthly',
  anchorDate: '2026-01-01',
  location: 'personal',
  ownerId: 'me',
  payee: 'me',
  payeeSharePercent: 100,
  active: true,
}

const existingClearedTxn: Transaction = {
  id: 'x1',
  date: '2026-06-05',
  amount: 200,
  direction: 'out',
  categoryId: 'food',
  paymentMethod: 'card',
  status: 'cleared',
  type: 'expense',
  location: 'personal',
  ownerId: 'me',
}

// A rent payment that's already been generated/materialized for July —
// projection must NOT double-count this alongside a freshly generated one.
const alreadyMaterializedRent: Transaction = {
  id: 'x2',
  date: '2026-07-01',
  amount: 900,
  direction: 'out',
  categoryId: 'home',
  paymentMethod: 'standing_order',
  status: 'pending',
  type: 'bill_payment',
  location: 'personal',
  ownerId: 'me',
  sourceType: 'recurring_template',
  sourceId: 'rent-1',
}

const data: AppDataV2 = {
  people: [person],
  categories: defaultCategories(),
  recurringTemplates: [rent],
  loans: [],
  creditCards: [],
  transactions: [existingClearedTxn, alreadyMaterializedRent],
  payCycles: [payCycle],
  pensions: [],
  savingsPots: [],
  scenarios: [],
  primaryPersonId: 'me',
}

const asOf = new Date(2026, 5, 15) // 15 June 2026
const currentCycleEnd = horizonRangeEnd(data, 'me', 'current_cycle', asOf)
check('current_cycle horizon (cycleStartDayOfMonth=1) ends 30 June', fmt(currentCycleEnd), '2026-06-30')

const threeCycleEnd = horizonRangeEnd(data, 'me', 'three_cycles', asOf)
// current + THREE_CYCLES_AHEAD, so from a 15 June reference: June
// (current) + July + August + September, ending 30 Sept. Was 31 August
// back when the horizon covered current + 2.
check('three_cycles horizon ends 30 September (June + July + August + September)', fmt(threeCycleEnd), '2026-09-30')

const currentProjection = computeProjection(data, 'me', payCycle, 'current_cycle', asOf)
check('Current-cycle projection clearedBalance = opening + the one cleared expense', currentProjection.clearedBalance, 1000 - 200)
check('Current-cycle projection includes the June rent (generated) as pending', currentProjection.transactions.some((t) => t.date === '2026-06-01' && t.type === 'bill_payment'), true)
check('Current-cycle horizon (ends 30 June) does NOT include the July rent at all', currentProjection.transactions.some((t) => t.date === '2026-07-01'), false)

const threeCycleProjection = computeProjection(data, 'me', payCycle, 'three_cycles', asOf)
check('3-cycle projection DOES reach the already-materialized July rent', threeCycleProjection.transactions.some((t) => t.date === '2026-07-01' && t.id === 'x2'), true)
check(
  'Deduping works: exactly ONE July rent transaction, not a duplicate generated one alongside the real one',
  threeCycleProjection.transactions.filter((t) => t.date === '2026-07-01' && t.categoryId === 'home').length,
  1,
)
check('3-cycle projection also reaches August rent (freshly generated, no real one exists yet)', threeCycleProjection.transactions.some((t) => t.date === '2026-08-01'), true)

// NOTE: a 3-cycle horizon does NOT necessarily mean a lower projected
// balance than a 1-cycle horizon — it also pulls in more salary paydays,
// which for this test person comfortably outweigh the extra rent. So
// instead of asserting a direction, check the figure is internally
// consistent with the transaction list it returned alongside it —
// recomputing independently from the same building blocks the function
// itself exposes should land on exactly the same number.
const recomputedProjected =
  threeCycleProjection.openingBalance +
  threeCycleProjection.transactions.filter((t) => (t.status === 'cleared' || t.status === 'pending') && isLedgerTransaction(t)).reduce((sum, t) => sum + signedAmount(t), 0)
check('3-cycle projectedBalance is internally consistent with its own returned transaction list', Math.round(recomputedProjected * 100) / 100, threeCycleProjection.projectedBalance)
check('3-cycle projection has strictly more transactions than the 1-cycle projection (longer horizon, more occurrences)', threeCycleProjection.transactions.length > currentProjection.transactions.length, true)

// ---- 4. transactionsInRange ----
const juneOnly = transactionsInRange(threeCycleProjection.transactions, new Date(2026, 5, 1), new Date(2026, 5, 30))
check('transactionsInRange for June only returns June-dated entries', juneOnly.every((t) => t.date.startsWith('2026-06')), true)
check('transactionsInRange excludes July/August entries when asked for June', juneOnly.some((t) => t.date.startsWith('2026-07')), false)

// ---- 5. Joint cost-splitting ----
check('An even 50/50 split: the payee gets exactly half', personShareOfJointAmount(1000, 'alice', 50, 'alice'), 500)
check('An even 50/50 split: the other person also gets exactly half', personShareOfJointAmount(1000, 'alice', 50, 'bob'), 500)
check('An uneven 70/30 split: the payee gets 70%', personShareOfJointAmount(1000, 'alice', 70, 'alice'), 700)
check('An uneven 70/30 split: the other person gets the remaining 30%', personShareOfJointAmount(1000, 'alice', 70, 'bob'), 300)

const alice: Person = { id: 'alice', name: 'Alice', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [] }
const bob: Person = { id: 'bob', name: 'Bob', color: '#4cd08a', salaryHistory: [], salaryOverrides: [] }

const jointRent: RecurringTemplate = {
  id: 'joint-rent',
  name: 'Joint Rent',
  amount: 1000,
  categoryId: 'home',
  paymentMethod: 'standing_order',
  frequency: 'monthly',
  anchorDate: '2026-06-01',
  location: 'joint',
  ownerId: '',
  payee: 'alice',
  payeeSharePercent: 60,
  active: true,
}
const jointLoan: Loan = {
  id: 'joint-loan',
  name: 'Joint Car Loan',
  principal: 4800, // 0%-equivalent (200 × 24) — this suite is about joint-split mechanics, not interest
  monthlyPayment: 200,
  termMonths: 24,
  startDate: '2026-01-01',
  categoryId: 'car',
  location: 'joint',
  ownerId: '',
  payee: 'alice',
  payeeSharePercent: 60,
  overpayments: [],
  active: true,
}

const jointData: AppDataV2 = {
  people: [alice, bob],
  categories: defaultCategories(),
  recurringTemplates: [jointRent],
  loans: [jointLoan],
  creditCards: [],
  transactions: [],
  payCycles: [],
  pensions: [],
  savingsPots: [],
  scenarios: [],
  primaryPersonId: 'alice',
}

const juneBounds = { start: new Date(2026, 5, 1), end: new Date(2026, 5, 30) }
const jointSummary = computeJointSummary(jointData, juneBounds.start, juneBounds.end)
check('Joint summary totalOutgoings = full rent + full loan payment for June', jointSummary.totalOutgoings, 1000 + 200)
check('Alice (60% payee) owes 60% of the combined joint total', jointSummary.perPerson.find((p) => p.personId === 'alice')?.amount, (1000 + 200) * 0.6)
check('Bob (the other 40%) owes the rest', jointSummary.perPerson.find((p) => p.personId === 'bob')?.amount, (1000 + 200) * 0.4)
check('Shares reconcile back to the full total (no money lost/invented in the split)', jointSharesReconcile(jointSummary), true)

const aliceShareTxns = generateJointContributionTransactions(jointData, 'alice', juneBounds.start, juneBounds.end)
check('Alice gets exactly 2 synthetic contribution transactions (rent + loan) for June', aliceShareTxns.length, 2)
check(
  'Alice\'s synthetic transactions are tagged to HER personal account, not "joint"',
  aliceShareTxns.every((t) => t.location === 'personal' && t.ownerId === 'alice'),
  true,
)
check("Alice's rent share is 60% of £1000", aliceShareTxns.find((t) => t.note?.includes('Rent'))?.amount, 600)

// ---- 6. Joint contribution NOT folded into the person's OWN projection ----
// UAT Batch 4 (2026-09-04, Adam-specified): the Personal ledger used to
// fold in each person's own SHARE of every joint bill/loan — deliberately
// reversed. Personal shows nothing about joint bills at all now; the
// Joint card (jointAccountLedger.ts) is the only place they appear, at
// full amount.
const alicePayCycle: PayCycleConfig = {
  personId: 'alice',
  openingBalance: 2000,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 1,
}
const jointDataWithCycle: AppDataV2 = { ...jointData, payCycles: [alicePayCycle] }
const aliceProjection = computeProjection(jointDataWithCycle, 'alice', alicePayCycle, 'current_cycle', new Date(2026, 5, 15))
check("Alice's own projection does NOT include her joint rent share", aliceProjection.transactions.some((t) => t.note?.includes('Rent')), false)
check("Alice's own projection does NOT include the full £1000 rent anywhere either", aliceProjection.transactions.some((t) => t.amount === 1000), false)
check(
  "Alice's projected balance is unaffected by the joint bills entirely",
  aliceProjection.projectedBalance,
  aliceProjection.clearedBalance,
)

// ---- 7. Upcoming / closed payday lists ----
const fmtDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const upcoming3 = upcomingPaydays(payCycle, new Date(2026, 5, 15), 3) // asOf 15 June 2026, payday=28th adjusted
check('upcomingPaydays returns exactly 3 dates when asked for 3', upcoming3.length, 3)
check('First upcoming payday (28 June 2026, a Sunday) adjusts back to Fri 26 June', fmtDate(upcoming3[0]), '2026-06-26')
check('Upcoming paydays are in chronological order', upcoming3.every((d, i) => i === 0 || d > upcoming3[i - 1]), true)
check('upcomingPaydays never includes today itself (strictly after)', upcoming3.every((d) => d > new Date(2026, 5, 15)), true)

const closed3 = closedPaydays(payCycle, new Date(2026, 5, 15), 3)
check('closedPaydays returns exactly 3 dates when asked for 3', closed3.length, 3)
check('Closed paydays are in chronological order (oldest first)', closed3.every((d, i) => i === 0 || d > closed3[i - 1]), true)
check('closedPaydays never includes a date after "today"', closed3.every((d) => d <= new Date(2026, 5, 15)), true)
check('The most recent closed payday is strictly before the first upcoming one', closed3[closed3.length - 1] < upcoming3[0], true)

// closedPaydays must never walk back past the opening balance date — no
// use showing payday history from before the point the balance was
// actually reconciled from. Set the opening balance date to a point
// where only ONE closed payday should exist before "today" (15 June),
// even though 3 were requested.
const recentOpeningPayCycle: PayCycleConfig = { ...payCycle, openingBalanceDate: '2026-05-01' }
const closedWithFloor = closedPaydays(recentOpeningPayCycle, new Date(2026, 5, 15), 3)
check('closedPaydays returns FEWER than requested when the opening balance date cuts the history short', closedWithFloor.length, 1)
check('The one closed payday returned is on/after the opening balance date', closedWithFloor.every((d) => d >= new Date(2026, 4, 1)), true)
check('That one closed payday is the 28 May payday (the only one between 1 May and 15 June)', fmtDate(closedWithFloor[0]), '2026-05-28')

// ---- 8. "All future" salary change correctly becomes applicable from its effectiveFrom date onward ----
// Directly reproduces the reported "pension change doesn't seem to save"
// flow: adding a new snapshot with effectiveFrom = an upcoming payday
// must make findApplicableSnapshot pick IT UP for that date and beyond,
// while leaving earlier dates on the old snapshot. Net pay itself is
// separately confirmed to be unaffected by employerPensionPercent, by
// design (see SalaryInput in tax.ts) — that's not a bug, just why the
// net-pay figure alone isn't the right thing to check after such a change.
const snapshotA = { id: 'sA', personId: 'me', effectiveFrom: '2026-01-01', grossAnnual: 40000, taxCode: '1257L', studentLoanPlan: 'none' as const, payFrequency: 'monthly' as const, deductions: [], employerPensionPercent: 3 }
const snapshotB = { ...snapshotA, id: 'sB', effectiveFrom: '2026-09-28', employerPensionPercent: 8 }
const personWithFutureChange = { ...person, salaryHistory: [snapshotA, snapshotB] }
check('A snapshot with a future effectiveFrom is NOT yet applicable for an earlier date', findApplicableSnapshot(personWithFutureChange, '2026-08-15')?.id, 'sA')
check('...but IS applicable exactly on its effectiveFrom date', findApplicableSnapshot(personWithFutureChange, '2026-09-28')?.id, 'sB')
check('...and for every date after it', findApplicableSnapshot(personWithFutureChange, '2026-12-25')?.id, 'sB')
check("The new snapshot's pension % is what's actually applicable from that date", findApplicableSnapshot(personWithFutureChange, '2026-09-28')?.employerPensionPercent, 8)

console.log(failures === 0 ? '\nAll Phase 3 checks passed.' : `\n${failures} Phase 3 check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
