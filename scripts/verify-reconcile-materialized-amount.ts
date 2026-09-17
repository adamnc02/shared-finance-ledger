// UAT 2026-09-09 (ed-bills-all-future / ed-recurring-tx-unchanged) — a
// same-day double-edit (e.g. Gym £37 -> £38, then immediately back to
// £37) left the Home page showing the stale £38: the first edit's
// effective date landed on-or-before "today", so autoClearDuePayments
// immediately materialized a real, permanently-cleared £38 Transaction;
// the second edit only patched the template, and nothing ever revisited
// that already-materialized row. Fixed via reconcileRecurringTemplateTransactions/
// reconcileLoanTransactions in autoClear.ts, mirroring the existing
// reconcileSalaryTransactions/reconcilePensionTransactions pattern. This
// reproduces the exact repro end-to-end through autoClearDuePayments
// itself, not just the resolver functions in isolation.

import { autoClearDuePayments } from '../src/lib/autoClear'
import { applyTemplateAmountChange, applyTemplateSingleOccurrenceAmountChange } from '../src/lib/schedule'
import { applyLoanMonthlyPaymentChange } from '../src/lib/ledgerLoans'
import { defaultCategories } from '../src/lib/categories'
import { BILLS_CATEGORY_ID } from '../src/types/ledger'
import type { AppDataV2, Loan, PayCycleConfig, Person, RecurringTemplate } from '../src/types/ledger'
import { SANTANDER_FIXTURE } from '../src/lib/interestConventions'

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

const gym: RecurringTemplate = {
  id: 'bill-gym',
  name: 'Gym',
  amount: 37,
  categoryId: BILLS_CATEGORY_ID,
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-06-01',
  location: 'personal',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  active: true,
}

const baseData: AppDataV2 = {
  people: [person],
  categories: defaultCategories(),
  recurringTemplates: [gym],
  loans: [],
  creditCards: [],
  transactions: [],
  payCycles: [payCycle],
  pensions: [],
  scenarios: [],
  primaryPersonId: 'me',
}

const asOf = new Date(2026, 6, 1) // 2026-07-01 — same date as Gym's occurrence, so it's due today and materializes immediately

// ─────────────────────────────────────────────────────────────────────
// Repro: edit 1 (£37 -> £38, effective today) materializes a cleared
// £38 transaction. Edit 2 (£38 -> £37, same effective date) must
// resync that same already-cleared row back to £37.
// ─────────────────────────────────────────────────────────────────────
const afterEdit1 = autoClearDuePayments({ ...baseData, recurringTemplates: [{ ...gym, ...applyTemplateAmountChange(gym, 38, '2026-07-01') }] }, asOf)
const materialized = afterEdit1.transactions.find((t) => t.sourceType === 'recurring_template' && t.sourceId === 'bill-gym' && t.date === '2026-07-01')
check('Edit 1 materializes a cleared £38 transaction for 1 Jul', materialized?.amount, 38)
check('...and it is genuinely cleared, not pending', materialized?.status, 'cleared')

const revertedTemplate = { ...gym, ...applyTemplateAmountChange(gym, 38, '2026-07-01') }
const revertedTemplate2 = { ...revertedTemplate, ...applyTemplateAmountChange(revertedTemplate, 37, '2026-07-01') }
const afterEdit2 = autoClearDuePayments({ ...afterEdit1, recurringTemplates: [revertedTemplate2] }, asOf)
const resynced = afterEdit2.transactions.find((t) => t.sourceType === 'recurring_template' && t.sourceId === 'bill-gym' && t.date === '2026-07-01')
check('Edit 2 resyncs the ALREADY-CLEARED row back to £37 (the actual bug)', resynced?.amount, 37)
check('Idempotent — running again with nothing new changed makes no further change', autoClearDuePayments(afterEdit2, asOf) === afterEdit2, true)

// ─────────────────────────────────────────────────────────────────────
// A single-occurrence override on an already-materialized date also
// resyncs correctly (not just permanent amountHistory changes).
// ─────────────────────────────────────────────────────────────────────
const singleOverrideTemplate = { ...gym, ...applyTemplateSingleOccurrenceAmountChange(gym, 999, '2026-07-01') }
const afterSingleOverride = autoClearDuePayments({ ...afterEdit1, recurringTemplates: [singleOverrideTemplate] }, asOf)
const singleResynced = afterSingleOverride.transactions.find((t) => t.sourceType === 'recurring_template' && t.sourceId === 'bill-gym' && t.date === '2026-07-01')
check('A single-occurrence override resyncs an already-cleared row too', singleResynced?.amount, 999)

// ─────────────────────────────────────────────────────────────────────
// Same class of bug for a Loan's own scheduled payment.
// ─────────────────────────────────────────────────────────────────────
const loan: Loan = {
  id: 'loan-1',
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
  startDate: '2026-07-02',
  advanceDate: SANTANDER_FIXTURE.advanceDate,
  interestConventionId: 'flat_monthly',
  calibratedMonthlyRate: SANTANDER_FIXTURE.empiricalMonthlyRate,
}
const loanAsOf = new Date(2026, 6, 2) // matches the loan's own first payment date
const loanData: AppDataV2 = { ...baseData, recurringTemplates: [], loans: [loan] }
const loanAfterEdit1 = autoClearDuePayments({ ...loanData, loans: [{ ...loan, ...applyLoanMonthlyPaymentChange(loan, loan.monthlyPayment + 50, '2026-07-02') }] }, loanAsOf)
const loanMaterialized = loanAfterEdit1.transactions.find((t) => t.sourceType === 'loan' && t.sourceId === 'loan-1' && t.date === '2026-07-02')
check('Loan payment edit materializes at the bumped amount', loanMaterialized?.amount, round2(loan.monthlyPayment + 50))

const revertedLoan1 = { ...loan, ...applyLoanMonthlyPaymentChange(loan, loan.monthlyPayment + 50, '2026-07-02') }
const revertedLoan2 = { ...revertedLoan1, ...applyLoanMonthlyPaymentChange(revertedLoan1, loan.monthlyPayment, '2026-07-02') }
const loanAfterEdit2 = autoClearDuePayments({ ...loanAfterEdit1, loans: [revertedLoan2] }, loanAsOf)
const loanResynced = loanAfterEdit2.transactions.find((t) => t.sourceType === 'loan' && t.sourceId === 'loan-1' && t.date === '2026-07-02')
check('Loan payment revert resyncs the already-cleared row back to the original payment', loanResynced?.amount, round2(loan.monthlyPayment))

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll reconcile-materialized-amount checks passed.')
