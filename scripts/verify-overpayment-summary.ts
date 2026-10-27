// The laptop Overpayments tab's figures (src/lib/overpaymentSummary.ts).
//
// The trap: estimating "interest saved" separately from the schedule — for
// instance amount × rate × months left. That ignores the loan's calibrated
// convention and the recast mode, so it drifts from what the ledger shows.
// The figure must be the engine's own schedule run with and without the
// overpayments, against the same nominal loan loanFinishInfo uses.
//
// 1. Real backup: a loan with overpayments saves interest, and its months
//    early equal loanFinishInfo's.
// 2. CONTROL: the same loan with its overpayments removed saves nothing.
// 3. A bigger overpayment saves more; a settled loan saves nothing here.
// 4. "Overpaid this year" counts this year up to today, not before or after.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { loanOverpaymentSavings, overpaidThisYear } from '../src/lib/overpaymentSummary'
import { loanFinishInfo } from '../src/lib/ledgerLoans'
import type { AppDataV2, Loan } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-10-06-mum.json', 'utf8'))
const data: AppDataV2 = migrateLedgerData(raw.data ?? raw)
const loan = data.loans.find((l) => l.active && (l.overpayments.length > 0 || l.recurringOverpayment))

console.log('\n── 1. Real backup ──')
check('the backup has a loan with overpayments (a sweep that finds nothing is suspect)', !!loan, true)
if (loan) {
  const s = loanOverpaymentSavings(loan)
  check('it saves some interest', s.interestSaved > 0, true)
  check("months early are loanFinishInfo's own", s.monthsEarly, loanFinishInfo(loan).monthsEarly)
  check("the finish date is loanFinishInfo's own", s.finishDate, loanFinishInfo(loan).finishDate)

  console.log('\n── 2. CONTROL: no overpayments ──')
  const bare: Loan = { ...loan, overpayments: [], recurringOverpayment: undefined }
  check('the same loan without them saves nothing', loanOverpaymentSavings(bare).interestSaved, 0)
  check('…and finishes no earlier', loanOverpaymentSavings(bare).monthsEarly, 0)

  console.log('\n── 3. More saves more ──')
  const firstDate = loan.overpayments[0]?.date ?? loan.recurringOverpayment?.startDate ?? '2026-10-01'
  const more: Loan = { ...loan, overpayments: [...loan.overpayments, { id: 'extra', date: firstDate, amount: 500 }] }
  check('an extra £500 overpayment saves more interest', loanOverpaymentSavings(more).interestSaved > s.interestSaved, true)
  check('a settled loan reports nothing saved', loanOverpaymentSavings({ ...loan, active: false }).interestSaved, 0)
}

console.log('\n── 4. Overpaid this year ──')
{
  const today = new Date(2026, 9, 6)
  const l = (date: string, amount: number) => ({ id: date, date, amount })
  const loans = [{ ...(data.loans[0] as Loan), overpayments: [l('2025-12-31', 100), l('2026-01-01', 10), l('2026-10-06', 20), l('2026-10-07', 1000)] }]
  const cards = data.creditCards.length ? [{ ...data.creditCards[0], lumpPayments: [{ id: 'c', date: '2026-03-01', amount: 5 }] }] : []
  check('counts 1 Jan to today only', overpaidThisYear(loans, cards, today), cards.length ? 35 : 30)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n✗ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
