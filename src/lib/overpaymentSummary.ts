// The laptop Overpayments tab's figures (lib/laptop.ts): what a loan's
// overpayments save in interest and time, and what has been overpaid this
// year.
//
// Interest saved is the loan engine's own schedule, run twice: as the loan
// stands, and as the same nominal loan loanFinishInfo compares against (no
// one-off overpayments, no recurring one). The difference in the interest
// each schedule applies is what the overpayments save. Never a separate
// estimate, so it moves with every rate calibration and recast mode the
// schedule already honours (scripts/verify-overpayment-summary.ts).

import type { CreditCard, Loan } from '../types/ledger'
import { buildLoanSchedule, loanFinishInfo } from './ledgerLoans'
import { toLocalIsoDate } from './date'

const round2 = (n: number) => Math.round(n * 100) / 100

export interface LoanOverpaymentSavings {
  /** Interest the overpayments save over the loan's life. */
  interestSaved: number
  /** Months earlier the loan finishes (loanFinishInfo's own figure). */
  monthsEarly: number
  /** When the loan now finishes. */
  finishDate: string | null
}

/** The nominal loan: the same loan with no overpayments — exactly as loanFinishInfo builds it. */
function nominal(loan: Loan): Loan {
  return { ...loan, overpayments: [], recurringOverpayment: undefined }
}

export function loanOverpaymentSavings(loan: Loan): LoanOverpaymentSavings {
  const finish = loanFinishInfo(loan)
  if (!loan.active) return { interestSaved: 0, monthsEarly: 0, finishDate: finish.finishDate }
  const interest = (l: Loan) => buildLoanSchedule(l).reduce((n, e) => n + e.interestApplied, 0)
  return { interestSaved: round2(Math.max(0, interest(nominal(loan)) - interest(loan))), monthsEarly: finish.monthsEarly, finishDate: finish.finishDate }
}

/** Loan overpayments and card lump payments dated this calendar year, up to and including today. */
export function overpaidThisYear(loans: Loan[], cards: CreditCard[], today: Date): number {
  const todayIso = toLocalIsoDate(today)
  const yearStart = `${today.getFullYear()}-01-01`
  const inYear = (d: string) => d >= yearStart && d <= todayIso
  const fromLoans = loans.flatMap((l) => l.overpayments).filter((p) => inYear(p.date))
  const fromCards = cards.flatMap((c) => c.lumpPayments).filter((p) => inYear(p.date))
  return round2([...fromLoans, ...fromCards].reduce((n, p) => n + p.amount, 0))
}
