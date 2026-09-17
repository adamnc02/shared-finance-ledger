// Item d verification — What-if scenario loan action timing + reduce-term
// math (SUPABASE-MIGRATION-PLAN.md, backlog item d). Two things this
// checks specifically because they're the whole point of the item:
//
// 1. A lump sum and a recurring overpayment against the SAME loan
//    genuinely interact through the real amortisation engine
//    (lib/ledgerLoans.ts's buildLoanSchedule), not two independent,
//    isolated calculations — a reduce-monthly lump sum really does reset
//    the payment BEFORE a later-dated recurring overpayment starts
//    shrinking the term from there.
// 2. Action ORDERING is date-driven, not creation-order-driven — Adam's
//    own worked examples (kept verbatim in the migration doc) require two
//    scenarios (or one scenario with the same two actions added in the
//    opposite order) to produce byte-identical results.

import { calculateScenarioImpact, mergeScenarios } from '../src/lib/scenarios'
import { toLocalIsoDate, todayIso } from '../src/lib/date'
import { addDays } from 'date-fns'
import type { AppData, Loan, Person, Scenario } from '../src/types/models'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

function person(id: string): Person {
  return {
    id,
    name: id,
    color: '#000',
    salary: { grossAnnual: 30000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] },
  }
}

// A loan with a real calibrated rate, starting TODAY (mirrors
// legacyBridge.ts's own convention of resetting firstPaymentDate to "now"
// and totalAmount to the real remaining balance) — so simulateScenarioLoan
// actually delegates to the real engine rather than falling back to the
// flat, dateless treatment.
function testLoan(): Loan {
  return {
    id: 'loan-1',
    name: 'Car loan',
    firstPaymentDate: todayIso(),
    totalAmount: 2000,
    monthlyPayment: 200,
    location: 'personal',
    ownerId: 'me',
    payee: 'me',
    payeeSharePercent: 100,
    calibratedMonthlyRate: 0.01, // 1%/month flat — simple, real, non-zero interest
    interestConventionId: 'flat_monthly',
  }
}

function baseData(): AppData {
  return {
    people: [person('me')],
    bills: [],
    loans: [testLoan()],
    creditCards: [],
    scenarios: [],
    primaryPersonId: 'me',
  }
}

const lumpDate = toLocalIsoDate(addDays(new Date(), 1)) // "tomorrow", matching Adam's own example's shape
const recurringStartDate = toLocalIsoDate(addDays(new Date(), 13)) // 12 days after the lump sum, matching the doc's 12-day gap

// ─────────────────────────────────────────────────────────────────────
// Scenario 1 — two SEPARATE scenarios, as in the doc's worked example
// ─────────────────────────────────────────────────────────────────────
const scenarioLump: Scenario = {
  id: 's-lump',
  name: 'Lump sum',
  includeInCumulative: true,
  actions: [{ id: 'a-lump', type: 'pay_off_loan', label: '', value: 500, targets: [{ kind: 'loan', id: 'loan-1' }], date: lumpDate, recastMode: 'reduce_payment' }],
}
const scenarioRecurring: Scenario = {
  id: 's-recurring',
  name: 'Recurring overpayment',
  includeInCumulative: true,
  actions: [{ id: 'a-recurring', type: 'loan_overpayment', label: '', value: 100, targets: [{ kind: 'loan', id: 'loan-1' }], date: recurringStartDate }],
}
const merged1 = mergeScenarios([scenarioLump, scenarioRecurring])
const impact1 = calculateScenarioImpact(merged1, baseData(), 'me', 0)

// ─────────────────────────────────────────────────────────────────────
// Scenario 2 — the SAME two actions, in ONE scenario, overpayment added
// FIRST and the lump sum added SECOND (reversed creation order)
// ─────────────────────────────────────────────────────────────────────
const scenarioCombined: Scenario = {
  id: 's-combined',
  name: 'Combined (reversed order)',
  includeInCumulative: true,
  actions: [
    { id: 'a-recurring-2', type: 'loan_overpayment', label: '', value: 100, targets: [{ kind: 'loan', id: 'loan-1' }], date: recurringStartDate },
    { id: 'a-lump-2', type: 'pay_off_loan', label: '', value: 500, targets: [{ kind: 'loan', id: 'loan-1' }], date: lumpDate, recastMode: 'reduce_payment' },
  ],
}
const merged2 = mergeScenarios([scenarioCombined])
const impact2 = calculateScenarioImpact(merged2, baseData(), 'me', 0)

const payoff1 = impact1.loanImpacts.find((li) => li.kind === 'payoff')
const overpayment1 = impact1.loanImpacts.find((li) => li.kind === 'overpayment')
const payoff2 = impact2.loanImpacts.find((li) => li.kind === 'payoff')
const overpayment2 = impact2.loanImpacts.find((li) => li.kind === 'overpayment')

check('Scenario 1 has a payoff impact for the loan', Boolean(payoff1), true)
check('Scenario 1 has an overpayment impact for the loan', Boolean(overpayment1), true)

// ── The core "date order, not creation order" assertion ──
check('Identical newMonthlyCostForPerson regardless of creation order (payoff record)', payoff2?.newMonthlyCostForPerson, payoff1?.newMonthlyCostForPerson)
check('Identical newMonthlyCostForPerson regardless of creation order (overpayment record)', overpayment2?.newMonthlyCostForPerson, overpayment1?.newMonthlyCostForPerson)
check('Identical newMonthsRemaining regardless of creation order (payoff record)', payoff2?.newMonthsRemaining, payoff1?.newMonthsRemaining)
check('Identical newMonthsRemaining regardless of creation order (overpayment record)', overpayment2?.newMonthsRemaining, overpayment1?.newMonthsRemaining)
check('Identical newEndDate regardless of creation order (payoff record)', payoff2?.newEndDate, payoff1?.newEndDate)
check('Identical newEndDate regardless of creation order (overpayment record)', overpayment2?.newEndDate, overpayment1?.newEndDate)
check('Identical monthlyImpact for the whole combined scenario regardless of order', impact2.monthlyImpact, impact1.monthlyImpact)

// ── The interaction itself: reduce_payment lump sum resets the payment
//    BEFORE the later recurring overpayment starts shrinking the term ──
check('The reduce-payment lump sum genuinely lowers the payment (not the original £200)', payoff1?.newMonthlyCostForPerson !== undefined && payoff1.newMonthlyCostForPerson < 200, true)
// BUGFIX (Adam-reported, 2026-09 session — "the Extra Per month label is
// wrong"/no negative monthly-cash impact showing at all for a recurring
// overpayment) — this used to assert the overpayment record's own
// newMonthlyCostForPerson was IDENTICAL to the lump sum record's, which
// was the bug itself: both were reading scenarios.ts's shared combined
// schedule at their own dates via scheduledPayment alone, missing the
// £100/month the recurring overpayment actually adds on top each period
// (schedule.overpaymentApplied, not scheduledPayment — see scenarios.ts's
// own comment on why). The two records SHOULD differ, by exactly the
// overpayment amount — that gap IS the "£100/month you're now paying"
// this test's own file header describes checking for.
check(
  "The recurring overpayment record's own cost is the lump sum record's reduced payment PLUS the £100/month overpayment itself (not identical to it)",
  overpayment1?.newMonthlyCostForPerson,
  (payoff1?.newMonthlyCostForPerson ?? 0) + 100,
)
// A reduce_payment lump sum this large drops the scheduled payment so far
// (£200 → ~£12/month) that the loan can legitimately finish LATER than
// the original schedule even with the recurring overpayment layered on
// top later — original.monthsRemaining isn't the right baseline for "did
// the recurring overpayment help." The right comparison is lump-only vs
// lump-plus-recurring.
const lumpOnlyScenario: Scenario = {
  id: 's-lump-only',
  name: 'Lump sum only',
  includeInCumulative: true,
  actions: [{ id: 'a-lump-only', type: 'pay_off_loan', label: '', value: 500, targets: [{ kind: 'loan', id: 'loan-1' }], date: lumpDate, recastMode: 'reduce_payment' }],
}
const lumpOnlyImpact = calculateScenarioImpact(mergeScenarios([lumpOnlyScenario]), baseData(), 'me', 0)
const lumpOnlyPayoff = lumpOnlyImpact.loanImpacts.find((li) => li.kind === 'payoff')
check(
  'The recurring overpayment genuinely shortens the schedule vs. the reduce-payment lump sum alone',
  overpayment1 !== undefined && lumpOnlyPayoff !== undefined && overpayment1.newMonthsRemaining < lumpOnlyPayoff.newMonthsRemaining,
  true,
)

// ─────────────────────────────────────────────────────────────────────
// Sanity: without item d's dating at all (both actions default to
// "today"), the lump sum and overpayment still combine sensibly through
// one shared schedule — a basic regression guard for the no-date/legacy-
// saved-scenario fallback path.
// ─────────────────────────────────────────────────────────────────────
const undatedScenario: Scenario = {
  id: 's-undated',
  name: 'No dates set (legacy-saved scenario shape)',
  includeInCumulative: true,
  actions: [
    { id: 'a1', type: 'pay_off_loan', label: '', value: 500, targets: [{ kind: 'loan', id: 'loan-1' }] },
    { id: 'a2', type: 'loan_overpayment', label: '', value: 100, targets: [{ kind: 'loan', id: 'loan-1' }] },
  ],
}
const undatedImpact = calculateScenarioImpact(mergeScenarios([undatedScenario]), baseData(), 'me', 0)
check('An action with no date set still resolves without throwing (defaults to today)', undatedImpact.loanImpacts.length, 2)

// ─────────────────────────────────────────────────────────────────────
// reduce_term (the default, and the ONLY mode a recurring overpayment
// ever gets) — payment stays the same, term shortens instead.
// ─────────────────────────────────────────────────────────────────────
const reduceTermScenario: Scenario = {
  id: 's-reduce-term',
  name: 'Reduce term',
  includeInCumulative: true,
  actions: [{ id: 'a-rt', type: 'pay_off_loan', label: '', value: 500, targets: [{ kind: 'loan', id: 'loan-1' }], date: lumpDate }], // recastMode omitted — defaults to reduce_term
}
const reduceTermImpact = calculateScenarioImpact(mergeScenarios([reduceTermScenario]), baseData(), 'me', 0)
const reduceTermPayoff = reduceTermImpact.loanImpacts.find((li) => li.kind === 'payoff')
check('reduce_term (default) keeps the payment at the original £200', reduceTermPayoff?.newMonthlyCostForPerson, 200)
check('reduce_term genuinely shortens the term vs. the original schedule', (reduceTermPayoff?.monthsSaved ?? 0) > 0, true)

// ─────────────────────────────────────────────────────────────────────
// Two SEPARATE recurring loan_overpayment actions on the SAME loan, with
// different start dates — the real ledger Loan type only has room for
// ONE recurringOverpayment slot, so this only works because both get
// materialized as dated one-off events instead (Adam's confirmed call).
// ─────────────────────────────────────────────────────────────────────
const earlyRecurringStart = toLocalIsoDate(addDays(new Date(), 1))
const lateRecurringStart = toLocalIsoDate(addDays(new Date(), 60))
const twoRecurringScenario: Scenario = {
  id: 's-two-recurring',
  name: 'Two recurring overpayments on the same loan',
  includeInCumulative: true,
  actions: [
    { id: 'a-r1', type: 'loan_overpayment', label: '', value: 50, targets: [{ kind: 'loan', id: 'loan-1' }], date: earlyRecurringStart },
    { id: 'a-r2', type: 'loan_overpayment', label: '', value: 50, targets: [{ kind: 'loan', id: 'loan-1' }], date: lateRecurringStart },
  ],
}
const twoRecurringImpact = calculateScenarioImpact(mergeScenarios([twoRecurringScenario]), baseData(), 'me', 0)
check('Two recurring overpayment actions on the same loan resolve without throwing', twoRecurringImpact.loanImpacts.length, 1)
const twoRecurringOnly = twoRecurringImpact.loanImpacts.find((li) => li.kind === 'overpayment')

const oneRecurringScenario: Scenario = {
  id: 's-one-recurring',
  name: 'Just the early one',
  includeInCumulative: true,
  actions: [{ id: 'a-r1-solo', type: 'loan_overpayment', label: '', value: 50, targets: [{ kind: 'loan', id: 'loan-1' }], date: earlyRecurringStart }],
}
const oneRecurringImpact = calculateScenarioImpact(mergeScenarios([oneRecurringScenario]), baseData(), 'me', 0)
const oneRecurringOnly = oneRecurringImpact.loanImpacts.find((li) => li.kind === 'overpayment')
check(
  'Two combined recurring overpayments on one loan pay it off sooner than just one of them alone',
  twoRecurringOnly !== undefined && oneRecurringOnly !== undefined && twoRecurringOnly.newMonthsRemaining < oneRecurringOnly.newMonthsRemaining,
  true,
)

if (failures > 0) {
  console.log(`\n${failures} loan-scenario timing check(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll loan-scenario timing checks passed.')
}
