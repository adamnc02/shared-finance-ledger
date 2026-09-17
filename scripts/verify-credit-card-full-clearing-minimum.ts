// PROMPT-01 Part C — a card whose minimum payment is 100% of the balance
// always clears itself, so the Borrowing page shows a read-only "Set to
// Clear" indication instead of a Clear button, and its ledger rows carry no
// override entry point (Adam, 2026-09-15: "Row is untappable, wording is
// 'Set to Clear'").
//
// WHY THE PREDICATE IS ABOUT CONFIGURATION, NOT THIS MONTH'S FIGURES.
// A FIXED £200 minimum against a £150 balance also clears it, but that is a
// transient fact about one cycle rather than a property of the card. Adam
// chose 100%-percent-only explicitly (2026-09-16): his mum's Natwest is a
// fixed £200 card whose Clear button and Balance due rows must keep
// behaving exactly as they do today, including in April 2027 when its final
// £200 charge happens to cover the whole remaining balance. That case is
// asserted below precisely because it is the tempting one to get wrong.
//
// NOTE: the original PROMPT-01 diagnosis attributed the missing due row to
// buildCreditCardBalanceDueRows' "balance must exceed the minimum" filter.
// That function is dead code — nothing outside creditCards.ts calls it. The
// Borrowing page renders buildCreditCardDueOverviewRows, which is
// unfiltered, so the row was missing purely because Part A generated no
// pending charges at all. Asserted here so that stays true.
import { readFileSync } from 'node:fs'
import { creditCardMinimumClearsFullBalance, buildCreditCardDueOverviewRows } from '../src/lib/creditCards'
import type { CreditCard, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const base = { id: 'c1', name: 'T', categoryId: 'category-credit-card', color: '#000000', interestRatePercent: 0, currentBalance: 0, balanceAsOfDate: '2026-08-01', paymentDayOfMonth: 14, ownerId: 'p1', active: true, lumpPayments: [] } as unknown as CreditCard
const withMin = (m: CreditCard['minimumPayment']) => ({ ...base, minimumPayment: m }) as CreditCard

console.log('--- which cards clear themselves ---')
check('100% of balance → yes', creditCardMinimumClearsFullBalance(withMin({ type: 'percent_of_balance', percent: 100 })), true)
check('over 100% → yes (cannot leave a residue either)', creditCardMinimumClearsFullBalance(withMin({ type: 'percent_of_balance', percent: 150 })), true)
check('99% → no (leaves a real gap)', creditCardMinimumClearsFullBalance(withMin({ type: 'percent_of_balance', percent: 99 })), false)
check('5% → no', creditCardMinimumClearsFullBalance(withMin({ type: 'percent_of_balance', percent: 5 })), false)
check('fixed £200 → no, however large', creditCardMinimumClearsFullBalance(withMin({ type: 'fixed', amount: 200 })), false)
check('fixed £999999 → still no: a fixed minimum is never a 100% rule', creditCardMinimumClearsFullBalance(withMin({ type: 'fixed', amount: 999999 })), false)

console.log('\n--- against the real cards ---')
const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15-mum.json', 'utf8'))
const txns: Transaction[] = raw.transactions
const cardOf = (id: string): CreditCard => {
  const c = (raw.creditCards as CreditCard[]).find((x) => x.id === id)!
  return { ...c, lumpPayments: c.lumpPayments ?? [] }
}
const asOf = new Date(2026, 8, 15)
const santander = cardOf('lhF0fbR8')
const natwest = cardOf('M2Ak3QNc')

check('Santander (100%) gets the "Set to Clear" treatment', creditCardMinimumClearsFullBalance(santander), true)
check('Natwest (fixed £200) does NOT — Part C must not change this card', creditCardMinimumClearsFullBalance(natwest), false)

// The row itself must exist to be labelled — this is what Part A restored.
const sUpcoming = buildCreditCardDueOverviewRows(santander, txns, asOf).filter((r) => !r.isPast)
check('Santander shows its upcoming due balance at all', sUpcoming.map((r) => `${r.date}/${r.balanceDue}`), ['2026-10-14/91.24'])

// Natwest's final row: £200 owed, £200 minimum. It DOES fully clear that
// month, and must still be treated as an ordinary clearable row.
const nRows = buildCreditCardDueOverviewRows(natwest, txns, asOf).filter((r) => !r.isPast)
check('Natwest final row is 2027-04-14 owing exactly its £200 minimum', `${nRows[nRows.length - 1]?.date}/${nRows[nRows.length - 1]?.balanceDue}`, '2027-04-14/200')
check('...and Natwest still keeps its Clear button there', creditCardMinimumClearsFullBalance(natwest), false)

console.log(`\n${failures === 0 ? '✓ ALL CHECKS PASSED' : `✗ ${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
