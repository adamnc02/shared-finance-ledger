// D4 verification — settlement figure estimate (scope §6) and the
// close-loan flow (scope §7): estimateSettlementFigure,
// defaultSettlementMultiplier, settleLoan, and summarizeLoan's
// closed-loan short-circuit.

import { buildLoanSchedule, summarizeLoan, estimateSettlementFigure, defaultSettlementMultiplier, settleLoan, generateLoanPaymentTransactions, nominalTotalPayable } from '../src/lib/ledgerLoans'
import { SANTANDER_FIXTURE } from '../src/lib/interestConventions'
import type { Loan } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// ---- 1. defaultSettlementMultiplier: matches the UK statutory cap rule (scope §6) ----
check('More than 12 months remaining -> k=2', defaultSettlementMultiplier(22), 2)
check('Exactly 12 months remaining -> k=1 (not >12, so the shorter-term cap applies)', defaultSettlementMultiplier(12), 1)
check('Fewer than 12 months remaining -> k=1', defaultSettlementMultiplier(3), 1)

// ---- 2. estimateSettlementFigure against the real Santander fixture ----
const santanderLoan: Loan = {
  id: 'santander',
  name: 'Santander loan',
  categoryId: 'cat-loans',
  location: 'personal',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
  principal: SANTANDER_FIXTURE.principal,
  monthlyPayment: SANTANDER_FIXTURE.contractualPayment,
  termMonths: SANTANDER_FIXTURE.termMonths,
  startDate: SANTANDER_FIXTURE.firstPaymentDate,
  advanceDate: SANTANDER_FIXTURE.advanceDate,
  interestConventionId: 'flat_monthly',
  calibratedMonthlyRate: SANTANDER_FIXTURE.empiricalMonthlyRate,
}

const asOfTwoPayments = new Date('2026-08-15') // just after the 2nd real payment (2026-08-02)
const summaryAtCheckpoint = summarizeLoan(santanderLoan, asOfTwoPayments)
check('Sanity: reconciled balance at this checkpoint really is £7,796.00 (matches D3\'s fixture)', summaryAtCheckpoint.remainingBalance, SANTANDER_FIXTURE.balanceAfterTwoRealPayments, 0.1)
check(
  // Was 23 before the loan-term-drift fix: the empirical rate sits a hair
  // above the exact back-solved rate, which used to let the schedule spill
  // into a stray 25th period rather than landing exactly on the agreed
  // 24-month term. buildLoanSchedule now hard-clears the balance on the
  // contractually-final period instead of letting small calibration
  // imprecision silently extend (or shorten) the loan beyond what was
  // actually agreed — see its own comment for the full reasoning. 22
  // is now correct: 24 total periods, 2 real payments already made.
  '22 months remain at this checkpoint — the loan term never drifts from the agreed 24 months regardless of calibration imprecision',
  summaryAtCheckpoint.monthsRemaining,
  22,
)

const defaultEstimate = estimateSettlementFigure(santanderLoan, asOfTwoPayments)
check('Default (uncalibrated k=2) settlement estimate at the checkpoint', defaultEstimate, 8000.66, 0.05)

const calibratedLoan: Loan = { ...santanderLoan, settlementMultiplier: 3 }
const calibratedEstimate = estimateSettlementFigure(calibratedLoan, asOfTwoPayments)
check('Calibrated (k=3, matching the real reconciled multiplier) settlement estimate', calibratedEstimate, 8102.99, 0.05)
check('Calibrated estimate lands within 39p of the real settlement quote (£8,103.37) — the fixture\'s own tolerance', Math.abs(calibratedEstimate - SANTANDER_FIXTURE.realSettlementQuoteAfterTwoPayments), 0.39, 0.02)

// ---- 3. Settlement figure sits between true balance and the OLD flat model's "remaining scheduled payments" figure (scope §13) ----
check(
  "Settlement estimate is strictly more than the true outstanding balance (there's always a cost to settling early)",
  calibratedEstimate > summaryAtCheckpoint.remainingBalance,
  true,
)
check(
  "Settlement estimate is strictly less than the old flat model's naive 'sum of remaining scheduled payments' figure",
  calibratedEstimate < SANTANDER_FIXTURE.oldFlatModelRemainingAfterTwoPayments,
  true,
)

// ---- 4. estimateSettlementFigure returns 0 once nothing's left to settle ----
const paidOffLoan: Loan = { ...santanderLoan, principal: 100, monthlyPayment: 100, termMonths: 1 }
check('A fully paid-off loan (as of well after its single payment) has no settlement figure', estimateSettlementFigure(paidOffLoan, new Date('2027-01-01')), 0)

// ---- 5. settleLoan: real transaction + loan marked inactive with closedDate/settledAmount ----
const { updatedLoan, transaction } = settleLoan(santanderLoan, 8050, '2026-08-20', 'Paid off via savings')
check('settleLoan marks the loan inactive', updatedLoan.active, false)
check('settleLoan records the real closedDate', updatedLoan.closedDate, '2026-08-20')
check('settleLoan records the real settledAmount (which may differ from any estimate)', updatedLoan.settledAmount, 8050)
check("settleLoan does NOT touch the loan's recorded overpayments — settlement is its own distinct event, not one more overpayment", updatedLoan.overpayments, santanderLoan.overpayments)
check('settleLoan\'s transaction is a cleared, real cash-out', transaction.status, 'cleared')
check('settleLoan\'s transaction direction is out', transaction.direction, 'out')
check('settleLoan\'s transaction amount is the REAL amount paid, not any estimate', transaction.amount, 8050)
check("settleLoan's transaction is tagged sourceType 'loan_settlement' — distinguishable from a regular overpayment", transaction.sourceType, 'loan_settlement')
check("settleLoan's transaction links back to the loan via sourceId", transaction.sourceId, santanderLoan.id)

// ---- 6. summarizeLoan short-circuits for a closed loan — reports 0 remaining regardless of what the mechanical schedule would say ----
const closedSummary = summarizeLoan(updatedLoan, new Date('2026-09-01'))
check('A closed loan reports £0 remaining balance', closedSummary.remainingBalance, 0)
check('A closed loan reports 0 months remaining', closedSummary.monthsRemaining, 0)
check("A closed loan's payoffDate is its real closedDate, not a schedule-predicted date", closedSummary.payoffDate, '2026-08-20')
check(
  "A closed loan's totalPayable is unaffected — nominalTotalPayable stays the stable nominal-schedule figure regardless of active state",
  closedSummary.totalPayable,
  nominalTotalPayable(santanderLoan),
)

// This is the core scope §7 assertion: the mechanical schedule (if you
// ran it) would still show a real remaining balance at this point (the
// loan wasn't naturally due to finish for another ~20 months) — proving
// summarizeLoan's 0 above is a deliberate override, not a coincidence.
const mechanicalScheduleStillHasBalance = buildLoanSchedule(santanderLoan).find((e) => e.date <= '2026-09-01')
check(
  "Sanity: the underlying mechanical schedule (ignoring active/closedDate) would NOT naturally reach zero this early — confirms summarizeLoan's override is doing real work",
  (mechanicalScheduleStillHasBalance?.balanceAfter ?? 0) > 100,
  true,
)

// ---- 7. generateLoanPaymentTransactions generates nothing further for a closed loan (scope §7, matches creditCards.ts's active-card pattern) ----
const futureTxns = generateLoanPaymentTransactions(updatedLoan, new Date('2026-09-01'), new Date('2027-09-01'))
check('A closed loan generates no further pending payment transactions', futureTxns.length, 0)

console.log(failures === 0 ? '\nAll loan-settlement checks passed.' : `\n${failures} loan-settlement check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
