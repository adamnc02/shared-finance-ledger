// Sanity checks for how a credit card's own, freely-assignable categoryId
// flows onto its transactions. Two different rules apply depending on
// WHICH kind of transaction it is:
//  - Logged spend and logged lump payments carry the card's own real
//    category (e.g. "Shopping"), same as a loan's payments carry the
//    loan's own real category.
//  - The GENERATED minimum-charge payment is deliberately the exception:
//    it's always hardcoded to the builtin Credit Card category and its
//    note gets " - Minimum Charge" appended, so it reads unambiguously
//    in the category-grouped view rather than blending in as an
//    ordinary card-categorised item.

import { generateMinimumPaymentTransactions, recordCreditCardSpend, recordCreditCardLumpPayment } from '../src/lib/creditCards'
import { CREDIT_CARD_CATEGORY_ID, type CreditCard } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

const card: CreditCard = {
  id: 'card-1',
  name: 'Amex',
  categoryId: 'category-seed-shopping', // the user picked something other than the builtin default
  color: '#8b5cf6',
  interestRatePercent: 20,
  currentBalance: 500,
  balanceAsOfDate: '2026-06-01',
  minimumPayment: { type: 'fixed', amount: 50 },
  paymentDayOfMonth: 15,
  ownerId: 'adam',
  lumpPayments: [],
  active: true,
}

const generated = generateMinimumPaymentTransactions(card, new Date('2026-06-01'), new Date('2026-06-30'))
check('Generated minimum payment is hardcoded to the builtin Credit Card category, NOT the card\'s own real category', generated.every((t) => t.categoryId === CREDIT_CARD_CATEGORY_ID), true)
check('Generated minimum payment note has " - Minimum Charge" appended to the card name', generated.every((t) => t.note === 'Amex - Minimum Charge'), true)

const { transaction: spendTxn } = recordCreditCardSpend(card, 100, '2026-06-10', 'Groceries')
check('A logged spend still carries the card\'s own real category (unaffected by the minimum-payment exception)', spendTxn.categoryId, 'category-seed-shopping')

const { transaction: lumpTxn } = recordCreditCardLumpPayment(card, 200, '2026-06-12')
check('A logged lump payment still carries the card\'s own real category (unaffected too)', lumpTxn.categoryId, 'category-seed-shopping')

// A card still on the builtin default behaves the same either way, since
// the category and the hardcoded id happen to coincide.
const defaultCard: CreditCard = { ...card, id: 'card-2', categoryId: CREDIT_CARD_CATEGORY_ID }
const { transaction: defaultSpendTxn } = recordCreditCardSpend(defaultCard, 50, '2026-06-10')
check('A card still on the default category carries that through unchanged', defaultSpendTxn.categoryId, CREDIT_CARD_CATEGORY_ID)
const defaultGenerated = generateMinimumPaymentTransactions(defaultCard, new Date('2026-06-01'), new Date('2026-06-30'))
check('Its generated minimum payment is still Credit Card category and still gets the suffix', defaultGenerated.every((t) => t.categoryId === CREDIT_CARD_CATEGORY_ID && t.note === 'Amex - Minimum Charge'), true)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll card-category-assignment checks passed.')
