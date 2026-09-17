// Regression checks for the salary end-date field (backlog item b — see
// SUPABASE-MIGRATION-PLAN.md's "Personal-Ledger feature backlog"). Covers:
//  1. findApplicableSnapshot respects endDate — a snapshot stops governing
//     any date after its own end.
//  2. A later snapshot with no end date correctly takes back over, even
//     though an earlier one in the same history has already ended.
//  3. computeNetPayForPeriod returns null past the end, INCLUDING for a
//     period that already has a manual override or an attached bonus —
//     an end date must be able to suppress those too, not just the plain
//     snapshot-derived figure.
//  4. generateSalaryTransactions stops producing pending occurrences past
//     the end date, and produces nothing at all for a range entirely past
//     it — without needing a real Transaction to already exist (this is
//     the generator, not the ledger; "already cleared payments are
//     unaffected" is a property of what the caller does with already-
//     materialized Transaction rows, which this generator never touches).
//  5. latestSalarySnapshot finds the governing-for-editing snapshot even
//     once it's ended — the whole reason it's a separate lookup from
//     findApplicableSnapshot.
//  6. Clearing endDate (back to undefined) resumes indefinite generation,
//     exactly as if it had never been set.

import { findApplicableSnapshot, latestSalarySnapshot, computeNetPayForPeriod, generateSalaryTransactions } from '../src/lib/salaryLedger'
import type { Person, PayCycleConfig } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// ---- 1 & 2. findApplicableSnapshot respects endDate, and a later snapshot still wins where it should ----
const retiring: Person = {
  id: 'p1',
  name: 'Pat',
  color: '#ff5b4c',
  salaryHistory: [{ id: 's1', personId: 'p1', effectiveFrom: '2026-01-01', grossAnnual: 40000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [], endDate: '2026-06-30' }],
  salaryOverrides: [],
}
check('Before end date: snapshot still applies', findApplicableSnapshot(retiring, '2026-06-15')?.id, 's1')
check('On end date: snapshot still applies (final payment)', findApplicableSnapshot(retiring, '2026-06-30')?.id, 's1')
check('After end date: no snapshot applies', findApplicableSnapshot(retiring, '2026-07-01'), null)
check('Well after end date: still no snapshot applies', findApplicableSnapshot(retiring, '2026-12-25'), null)

const newJob: Person = {
  id: 'p2',
  name: 'Sam',
  color: '#4c9aff',
  salaryHistory: [
    { id: 's1', personId: 'p2', effectiveFrom: '2026-01-01', grossAnnual: 35000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [], endDate: '2026-05-31' },
    { id: 's2', personId: 'p2', effectiveFrom: '2026-06-01', grossAnnual: 42000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] },
  ],
  salaryOverrides: [],
}
check('A later snapshot with no end date supersedes an earlier ended one', findApplicableSnapshot(newJob, '2026-06-15')?.id, 's2')
check('The ended snapshot still governs its own (pre-handover) window', findApplicableSnapshot(newJob, '2026-03-01')?.id, 's1')
check('New job has no end date of its own — keeps applying indefinitely', findApplicableSnapshot(newJob, '2027-01-01')?.id, 's2')

// ---- 3. computeNetPayForPeriod: end date suppresses overrides and bonuses too, not just the plain figure ----
const withOverride: Person = {
  ...retiring,
  salaryOverrides: [
    { id: 'o1', personId: 'p1', payPeriodDate: '2026-05-29', netPayOverride: 3000, reason: 'manual bump' },
    // A period past the end date that ALREADY has a manual override —
    // simulates the override having been set before the end date was
    // pulled backward. The end date must win.
    { id: 'o2', personId: 'p1', payPeriodDate: '2026-08-31', netPayOverride: 3000, reason: 'stale override past the end' },
    { id: 'o3', personId: 'p1', payPeriodDate: '2026-08-31', netPayOverride: 3000, reason: 'stale bonus past the end', bonusGrossAmount: 500 },
  ],
}
check('A manual override BEFORE the end date still applies', computeNetPayForPeriod(withOverride, '2026-05-29'), 3000)
check('A manual override AFTER the end date is suppressed', computeNetPayForPeriod({ ...withOverride, salaryOverrides: [withOverride.salaryOverrides[1]] }, '2026-08-31'), null)
check(
  'An attached-bonus override AFTER the end date is also suppressed',
  computeNetPayForPeriod({ ...withOverride, salaryOverrides: [withOverride.salaryOverrides[2]] }, '2026-08-31'),
  null,
)
check('Plain net pay after the end date is null (no snapshot governs it)', computeNetPayForPeriod(retiring, '2026-09-01'), null)
check('Plain net pay before the end date is unaffected', computeNetPayForPeriod(retiring, '2026-02-15') !== null, true)

// ---- 4. generateSalaryTransactions stops producing pending occurrences past the end date ----
const payCycle: PayCycleConfig = {
  personId: 'p1',
  openingBalance: 0,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 1,
}
const generatedAcrossEnd = generateSalaryTransactions(retiring, payCycle, new Date(2026, 4, 1), new Date(2026, 7, 31)) // May–Aug 2026
check('Generates May, June — nothing for July/August (past the 30 Jun end)', generatedAcrossEnd.map((t) => t.date).sort(), ['2026-05-28', '2026-06-26'].sort())
// Nov 2026's 28th is a Saturday — resolves to Fri 27th (see verify-ledger.ts §3), still before the retiring test's own end date's month; use a range entirely past it instead.
const generatedFullyPast = generateSalaryTransactions(retiring, payCycle, new Date(2026, 8, 1), new Date(2026, 10, 30)) // Sep–Nov 2026, entirely past 30 Jun
check('A range entirely past the end date generates nothing at all', generatedFullyPast.length, 0)

// ---- 5. latestSalarySnapshot finds the governing-for-editing snapshot even once it's ended ----
check('latestSalarySnapshot finds the ended snapshot (findApplicableSnapshot would return null here)', latestSalarySnapshot(retiring)?.id, 's1')
check('latestSalarySnapshot picks the later of two, regardless of either one\'s end date', latestSalarySnapshot(newJob)?.id, 's2')
check('latestSalarySnapshot returns null for a person with no salary history at all', latestSalarySnapshot({ ...retiring, salaryHistory: [] }), null)

// ---- 6. Clearing endDate resumes indefinite generation ----
const cleared: Person = { ...retiring, salaryHistory: [{ ...retiring.salaryHistory[0], endDate: undefined }] }
check('Clearing endDate: a date that used to be past-end now resolves again', findApplicableSnapshot(cleared, '2026-09-01')?.id, 's1')
check('Clearing endDate: net pay resumes for a previously-suppressed period', computeNetPayForPeriod(cleared, '2026-09-01') !== null, true)

process.exit(failures === 0 ? 0 : 1)
