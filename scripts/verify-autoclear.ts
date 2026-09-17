import { autoClearDuePayments } from '../src/lib/autoClear'
import { defaultCategories } from '../src/lib/categories'
import { SAVINGS_CATEGORY_ID, BILLS_CATEGORY_ID } from '../src/types/ledger'
import type { AppDataV2, CreditCard, PayCycleConfig, Person, RecurringTemplate } from '../src/types/ledger'

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

const person: Person = {
  id: 'me',
  name: 'Me',
  color: '#ff5b4c',
  salaryHistory: [{ id: 's1', personId: 'me', effectiveFrom: '2026-01-01', grossAnnual: 40000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] }],
  salaryOverrides: [],
}

const monthlyBill: RecurringTemplate = {
  id: 'bill-1',
  name: 'Netflix',
  amount: 15,
  categoryId: BILLS_CATEGORY_ID,
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-06-10',
  location: 'personal',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  active: true,
}

const card: CreditCard = {
  id: 'card-1',
  name: 'Amex',
  categoryId: SAVINGS_CATEGORY_ID,
  color: '#8b5cf6',
  interestRatePercent: 20,
  currentBalance: 500,
  balanceAsOfDate: '2026-01-01',
  minimumPayment: { type: 'fixed', amount: 40 },
  paymentDayOfMonth: 12,
  ownerId: 'me',
  lumpPayments: [],
  active: true,
}

const data: AppDataV2 = {
  people: [person],
  categories: defaultCategories(),
  recurringTemplates: [monthlyBill],
  loans: [],
  creditCards: [card],
  transactions: [],
  payCycles: [payCycle],
  pensions: [],
  scenarios: [],
  primaryPersonId: 'me',
}

// asOf mid-July 2026 — several months of bills, salary, savings, and one
// credit card minimum payment should all have come due since Jan 1.
const asOf = new Date(2026, 6, 15)
const settled = autoClearDuePayments(data, asOf)

// ---- 1. Due items are materialized as real, cleared transactions ----
check('Some transactions were actually created (settled !== original data)', settled !== data, true)
const clearedBills = settled.transactions.filter((t) => t.sourceId === 'bill-1')
check('Netflix (monthly since June) has cleared occurrences materialized', clearedBills.length > 0, true)
check('All materialized bill occurrences are status "cleared", not pending', clearedBills.every((t) => t.status === 'cleared'), true)
check('None of the materialized occurrences are dated after asOf', clearedBills.every((t) => t.date <= '2026-07-15'), true)

const clearedSalary = settled.transactions.filter((t) => t.type === 'salary')
check('Salary paydays that have passed are also auto-cleared (not just outgoing types)', clearedSalary.length > 0 && clearedSalary.every((t) => t.status === 'cleared'), true)

// ---- 2. Card payments are materialized too, with no clear-time side effect ----

const clearedCardPayment = settled.transactions.find((t) => t.type === 'credit_card_payment' && t.creditCardId === 'card-1')
check('A credit card minimum payment that came due was materialized', !!clearedCardPayment, true)
// The balance is DERIVED now, not mutated in place — so the assertion
// is about cardBalanceAsOf, not about the stored figure changing. The
// stored anchor deliberately stays put; that immutability is the fix.
check("The card's stored anchor is deliberately NOT mutated by clearing", settled.creditCards[0].currentBalance, 500)
check("The card's DERIVED balance drops once the payment is materialized", cardBalanceAsOf(settled.creditCards[0], settled.transactions, asOf) < 500, true)

// ---- 3. Idempotency — the property that makes it safe to run on every data change ----
const secondPass = autoClearDuePayments(settled, asOf)
check('Running it again with nothing new due returns the EXACT SAME reference (no-op, prevents an infinite update loop)', secondPass === settled, true)

// ---- 4. Never settles anything in the future ----
const nearFuture = new Date(2026, 6, 20) // 20 July — 5 days after asOf
const futureCheck = autoClearDuePayments(data, nearFuture)
check('No materialized transaction is ever dated after the asOf passed in', futureCheck.transactions.every((t) => t.date <= '2026-07-20'), true)

// A bill due tomorrow relative to a given asOf must NOT be cleared today.
const dataForTomorrowTest: AppDataV2 = {
  ...data,
  recurringTemplates: [{ ...monthlyBill, anchorDate: '2026-07-16' }], // due the day AFTER our asOf
}
const tomorrowCheck = autoClearDuePayments(dataForTomorrowTest, asOf)
check('A bill due the day after asOf is NOT auto-cleared yet', tomorrowCheck.transactions.some((t) => t.date === '2026-07-16'), false)

// ---- 5. Future-dated LOGGED payments (not just generated ones) must also wait until their date arrives ----
// The exact reported bug: a manually-logged credit card lump payment
// dated in the future was clearing (and reducing the balance)
// immediately at logging time, ignoring its date entirely.
import { cardBalanceAsOf, recordCreditCardLumpPayment } from '../src/lib/creditCards'

const cardForLumpTest: CreditCard = { ...card, id: 'card-2', currentBalance: 500, minimumPayment: { type: 'fixed', amount: 0 } }
// Hardcoded well into the future rather than relative to "today" -
// recordCreditCardLumpPayment's status assignment reads the REAL system
// clock (todayIso()), not a passed-in asOf, so a date that was
// comfortably "the future" when this test was written silently becomes
// "the past" as real time simply passes — confirmed as exactly what
// happened here once real-world time caught up to the date this
// originally used. A date decades out won't need touching again for a
// very long time.
const lumpResult = recordCreditCardLumpPayment(cardForLumpTest, 200, '2099-08-20')
check("Logging a FUTURE-dated lump payment creates it as 'pending', not 'cleared'", lumpResult.transaction.status, 'pending')
// interestRatePercent forced to 0 for these three: the point under test
// is purely whether a FUTURE-dated payment counts yet, and this fixture's
// dates are decades apart (see the note above about why), so leaving 20%
// APR on would compound the anchor into the millions and drown the
// signal. Interest replay itself is covered in verify-credit-card-balance.
check("Logging a future-dated lump payment does NOT touch the card's balance immediately", cardBalanceAsOf({ ...lumpResult.updatedCard, interestRatePercent: 0 }, [{ ...lumpResult.transaction, id: 'x' }], new Date(2026, 6, 15)), 500)

const lumpData: AppDataV2 = {
  ...data,
  creditCards: [lumpResult.updatedCard],
  transactions: [{ ...lumpResult.transaction, id: 'lump-tx' }],
}
const beforeDueDate = autoClearDuePayments(lumpData, new Date(2099, 7, 19)) // 19 Aug — one day before due
check('The day before its date, the lump payment is STILL pending', beforeDueDate.transactions.find((t) => t.id === 'lump-tx')?.status, 'pending')
check('The day before its date, the balance is STILL untouched', cardBalanceAsOf({ ...beforeDueDate.creditCards[0], interestRatePercent: 0 }, beforeDueDate.transactions, new Date(2099, 7, 19)), 500)

const onDueDate = autoClearDuePayments(lumpData, new Date(2099, 7, 20)) // 20 Aug — exactly its date
check('On its exact date, the lump payment settles to cleared', onDueDate.transactions.find((t) => t.id === 'lump-tx')?.status, 'cleared')
check("On its exact date, the balance reduces (500 - 200 = 300)", cardBalanceAsOf({ ...onDueDate.creditCards[0], interestRatePercent: 0 }, onDueDate.transactions, new Date(2099, 7, 20)), 300)

// A same-day (not future) lump payment should still clear immediately, unaffected by this fix.
const immediateLump = recordCreditCardLumpPayment({ ...card, id: 'card-3', currentBalance: 500, minimumPayment: { type: 'fixed', amount: 0 } }, 100, '2026-08-15', undefined)
check('A same-day (not future-dated) lump payment is still created as cleared immediately', immediateLump.transaction.status, 'cleared')

console.log(failures === 0 ? '\nAll auto-clear checks passed.' : `\n${failures} auto-clear check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
