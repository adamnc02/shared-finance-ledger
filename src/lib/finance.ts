import { aprToMonthlyRate, standardPayment } from './interestConventions'

export interface FinanceAgreementInput {
  borrowAmount: number
  aprPercent: number // used for the actual repayment calculation
  termMonths: number
}

export interface FinanceAgreementResult {
  monthlyPayment: number
  totalRepayable: number
  totalInterest: number
}

/**
 * Standard amortising-loan calculation: a fixed monthly payment that clears
 * the borrowed amount plus interest over the given term. Uses APR (rather
 * than a separate nominal "interest rate") as the actual cost driver, since
 * APR is the standardised figure meant for comparing credit costs.
 *
 * Delegates the APR->monthly-rate conversion and PMT formula to
 * interestConventions.ts (loan-amortisation-engine scope §5.2) rather than
 * a separate `aprPercent / 100 / 12` shortcut this function used to use —
 * that shortcut understates the true rate (APR is a compound annual
 * figure, not a nominal one divided evenly by 12), the exact class of bug
 * the amortisation engine work was built to fix elsewhere. A "new finance
 * agreement" scenario action is exactly the kind of loan-like calculation
 * that should use the SAME correct maths as everything else, not a
 * second, separately-wrong implementation.
 */
export function calculateFinanceAgreement(input: FinanceAgreementInput): FinanceAgreementResult {
  const { borrowAmount, aprPercent, termMonths } = input

  if (borrowAmount <= 0 || termMonths <= 0) {
    return { monthlyPayment: 0, totalRepayable: 0, totalInterest: 0 }
  }

  const monthlyRate = aprToMonthlyRate(aprPercent / 100)
  const monthlyPayment = standardPayment(borrowAmount, monthlyRate, termMonths)

  const totalRepayable = round2(monthlyPayment * termMonths)

  return {
    monthlyPayment: round2(monthlyPayment),
    totalRepayable,
    totalInterest: round2(totalRepayable - borrowAmount),
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
