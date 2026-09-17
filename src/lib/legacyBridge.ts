// "Reconnecting the What-if page" (doc Section 4.4), taken literally: the
// existing simulation engine (lib/scenarios.ts, ~380 lines) and its page
// (Scenarios.tsx, ~800 lines) are untouched — their logic was never the
// problem, only their data source was (they still read the pre-rebuild
// AppData). This file is an ADAPTER: it converts the current ledger state
// into a synthetic, correctly-computed AppData object, so the existing
// engine runs against real ledger data without being rewritten.
//
// This is a deliberate choice over rewriting the engine against the
// ledger types directly — that would mean re-deriving and re-testing 380
// lines of financial simulation logic (loan overpayment cascades, salary
// change deltas, household aggregation) with real
// risk of subtly changing behaviour that already works. Bridging the data
// is lower-risk and keeps exactly one thing changing at a time.
//
// KNOWN GAP, stated explicitly: credit card minimum payments ARE folded
// into the adapted bills list below (so they count toward the baseline
// monthly-outgoings figure), but they can't be individually TARGETED by a
// scenario action (pay_off_loan / exclude_loan / loan_overpayment all
// only accept a loanId). Doing that properly means generalising
// ScenarioAction.linkedLoanId to linkedDebtId + linkedDebtType — a real
// change to the existing Scenario shape in models.ts, flagged back when
// the credit card feature was first designed and still not applied here.

import type { AppData, Bill as LegacyBill, Loan as LegacyLoan, Person as LegacyPerson } from '../types/models'
import type { AppDataV2, RecurringTemplate } from '../types/ledger'
import { findApplicableSnapshot } from './salaryLedger'
import { summarizeLoan as summarizeLedgerLoan, resolveLoanRateAndConvention } from './ledgerLoans'
import { computeMinimumPaymentAmount, withLiveBalances } from './creditCards'

const round2 = (n: number) => Math.round(n * 100) / 100
import { toLocalIsoDate as toIso, parseLocalDate } from './date'

// Exported for lib/scenarios.ts's savings-pot recurring-deposit-change
// action, which needs the same weekly/every_n_weeks/quarterly/annual →
// monthly conversion this file already does for bills, to compare an
// existing transfer template's amount against a hypothetical new one.
export function monthlyEquivalentCost(template: RecurringTemplate): number {
  switch (template.frequency) {
    case 'weekly':
      return round2(template.amount * (52 / 12))
    case 'every_n_weeks':
      return round2(template.amount * (52 / Math.max(1, template.intervalWeeks ?? 1) / 12))
    case 'monthly':
      return template.amount
    case 'quarterly':
      return round2(template.amount / 3)
    case 'annual':
      return round2(template.amount / 12)
  }
}

export function buildLegacyAppData(ledgerData: AppDataV2, asOf: Date = new Date()): AppData {
  const asOfIso = toIso(asOf)

  const people: LegacyPerson[] = ledgerData.people.map((p) => {
    const snapshot = findApplicableSnapshot(p, asOfIso)
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      salary: snapshot
        ? {
            grossAnnual: snapshot.grossAnnual,
            taxCode: snapshot.taxCode,
            studentLoanPlan: snapshot.studentLoanPlan,
            payFrequency: snapshot.payFrequency,
            deductions: snapshot.deductions,
            employerPensionPercent: snapshot.employerPensionPercent,
          }
        : { grossAnnual: 0, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] },
    }
  })

  const bills: LegacyBill[] = ledgerData.recurringTemplates
    .filter((t) => t.active)
    .map((template) => {
      const category = ledgerData.categories.find((c) => c.id === template.categoryId)
      return {
        id: template.id,
        name: template.name,
        cost: monthlyEquivalentCost(template),
        dueDay: parseLocalDate(template.anchorDate).getDate(),
        location: template.location,
        payee: template.payee,
        payeeSharePercent: template.payeeSharePercent,
        category: category?.name ?? 'Other',
        ownerId: template.ownerId,
        isStandingOrder: template.paymentMethod === 'standing_order',
        icon: category?.icon,
        iconColor: category?.iconColor,
      }
    })

  // Credit card minimums — counted toward totals, not individually
  // targetable. See the file header for why.
  // Live balances, not the stored anchors — the What-if engine's whole
  // job is to reason about what's owed right now, so it must see the
  // derived figure (see cardBalanceAsOf in creditCards.ts).
  for (const card of withLiveBalances(ledgerData.creditCards.filter((c) => c.active), ledgerData.transactions)) {
    const minPayment = computeMinimumPaymentAmount(card)
    if (minPayment <= 0) continue
    bills.push({
      id: `credit-card-min:${card.id}`,
      name: `${card.name} (min. payment)`,
      cost: minPayment,
      dueDay: card.paymentDayOfMonth,
      location: 'personal',
      payee: '',
      payeeSharePercent: 100,
      category: 'Credit Card',
      ownerId: card.ownerId,
      isStandingOrder: true,
      icon: 'credit_card',
    })
  }

  // firstPaymentDate is set to "today" and totalAmount to the REMAINING
  // balance as of today (not the original nominal total) — this is what
  // makes the old engine's from-scratch schedule simulation correctly
  // pick up from wherever the loan actually is now, including any real
  // overpayments already logged against it in the ledger.
  //
  // calibratedMonthlyRate/interestConventionId/settlementMultiplier are
  // resolved from the REAL ledger loan (not just copied verbatim) so an
  // uncalibrated loan still carries a real, usable rate through the
  // bridge — resolveLoanRateAndConvention's back-solved baseline, same
  // as ledgerLoans.ts itself falls back to. See lib/loans.ts for the
  // delegation these enable.
  const loans: LegacyLoan[] = ledgerData.loans.filter((loan) => loan.active).map((loan) => {
    const summary = summarizeLedgerLoan(loan, asOf)
    const { monthlyRate, convention } = resolveLoanRateAndConvention(loan)
    return {
      id: loan.id,
      name: loan.name,
      firstPaymentDate: asOfIso,
      totalAmount: summary.remainingBalance,
      monthlyPayment: loan.monthlyPayment,
      location: loan.location,
      ownerId: loan.ownerId,
      payee: loan.payee,
      payeeSharePercent: loan.payeeSharePercent,
      calibratedMonthlyRate: monthlyRate,
      interestConventionId: convention.id,
      settlementMultiplier: loan.settlementMultiplier,
    }
  })

  return {
    people,
    bills,
    loans,
    // Real CreditCard entities, unchanged from the ledger shape — this is
    // separate from the minimum-payment-folded-into-bills loop above
    // (which only feeds baseline monthly totals). Only active cards are
    // exposed as scenario targets, same filter as that loop.
    creditCards: withLiveBalances(ledgerData.creditCards.filter((c) => c.active), ledgerData.transactions),
    scenarios: ledgerData.scenarios,
    primaryPersonId: ledgerData.primaryPersonId,

    // Savings pots (PROMPT-07 Part 1) — real shapes, not adapted. See
    // AppData.savingsPots's own comment for why.
    savingsPots: ledgerData.savingsPots.filter((p) => p.active),
    transactions: ledgerData.transactions,
    recurringTemplates: ledgerData.recurringTemplates,
    payCycles: ledgerData.payCycles,
  }
}
