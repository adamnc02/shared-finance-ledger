import { costForPerson } from '../src/lib/bills'
import { buildLegacyAppData } from '../src/lib/legacyBridge'
import { summarizeLoan as summarizeLegacyLoan } from '../src/lib/loans'
import { summarizeLoan as summarizeLedgerLoan } from '../src/lib/ledgerLoans'
import { calculateScenarioImpact } from '../src/lib/scenarios'
import { defaultCategories } from '../src/lib/categories'
import type { AppDataV2, CreditCard, Loan, Person, RecurringTemplate } from '../src/types/ledger'
import type { Scenario } from '../src/types/models'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const me: Person = {
  id: 'me',
  name: 'Me',
  color: '#ff5b4c',
  salaryHistory: [{ id: 's1', personId: 'me', effectiveFrom: '2026-01-01', grossAnnual: 40000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] }],
  salaryOverrides: [],
}

const carLoan: Loan = {
  id: 'car-loan',
  name: 'Car Loan',
  principal: 3000, // 0%-equivalent (250 × 12) — this suite is about the legacy-bridge adapter, not interest
  monthlyPayment: 250,
  termMonths: 12,
  startDate: '2026-01-15',
  categoryId: 'car',
  location: 'personal',
  ownerId: 'me',
  payee: 'me',
  payeeSharePercent: 100,
  // Two overpayments already logged for a total of £1200 extra —
  // exactly what the bridge needs to correctly carry forward, since the
  // old engine has no concept of overpayments at all.
  overpayments: [
    { id: 'o1', date: '2026-02-10', amount: 700, note: 'Tax refund' },
    { id: 'o2', date: '2026-03-10', amount: 500 },
  ],
  active: true,
}

const weeklyGroceries: RecurringTemplate = {
  id: 'groceries',
  name: 'Groceries',
  amount: 50,
  categoryId: 'food',
  paymentMethod: 'card',
  frequency: 'weekly',
  anchorDate: '2026-01-05',
  location: 'personal',
  ownerId: 'me',
  payee: 'me',
  payeeSharePercent: 100,
  active: true,
}

const pausedGym: RecurringTemplate = {
  id: 'gym',
  name: 'Gym',
  amount: 30,
  categoryId: 'fitness',
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-01-01',
  location: 'personal',
  ownerId: 'me',
  payee: 'me',
  payeeSharePercent: 100,
  active: false,
}

const card: CreditCard = {
  id: 'card-1',
  name: 'Amex',
  categoryId: 'category-credit-card',
  color: '#8b5cf6',
  interestRatePercent: 20,
  currentBalance: 1000,
  balanceAsOfDate: '2026-01-01',
  minimumPayment: { type: 'fixed', amount: 40 },
  paymentDayOfMonth: 15,
  ownerId: 'me',
  lumpPayments: [],
  active: true,
}

const testScenario: Scenario = {
  id: 'sc-1',
  name: 'Overpay the car loan',
  includeInCumulative: true,
  actions: [{ type: 'pay_off_loan', linkedLoanId: 'car-loan', value: 500 }],
}

const ledgerData: AppDataV2 = {
  people: [me],
  categories: defaultCategories(),
  recurringTemplates: [weeklyGroceries, pausedGym],
  loans: [carLoan],
  creditCards: [card],
  transactions: [],
  payCycles: [],
  savingsPots: [],
  scenarios: [testScenario],
  primaryPersonId: 'me',
}

const asOf = new Date(2026, 5, 1) // 1 June 2026
const legacy = buildLegacyAppData(ledgerData, asOf)

// ---- 1. Structural shape ----
check('Adapted people count matches', legacy.people.length, 1)
check('Adapted person salary carries the correct gross annual', legacy.people[0].salary.grossAnnual, 40000)
check('Scenarios pass through unchanged (same array, same content)', legacy.scenarios, [testScenario])
check('primaryPersonId passes through unchanged', legacy.primaryPersonId, 'me')

// ---- 2. Bills: active-only, frequency converted to a monthly equivalent ----
check('Only the active template (Groceries) is included — the paused Gym is excluded entirely', legacy.bills.some((b) => b.name === 'Gym'), false)
const groceriesBill = legacy.bills.find((b) => b.name === 'Groceries')
check('Weekly £50 groceries converts to a monthly-equivalent cost (£50 × 52/12)', groceriesBill?.cost, (50 * 52) / 12)

// ---- 3. Credit card minimum payments counted toward bills, clearly labelled ----
const cardBill = legacy.bills.find((b) => b.id === 'credit-card-min:card-1')
check('The credit card minimum payment is folded into bills for baseline totals', cardBill?.cost, 40)
check('...clearly labelled so it is not mistaken for a real bill', cardBill?.name.includes('Amex'), true)

// ---- 4. THE key correctness property: loan overpayments already made are reflected ----
// £250 × 12 = £3000 nominal. £700 + £500 = £1200 in overpayments already
// logged. Rather than hand-deriving the exact expected remaining balance
// (which would duplicate the schedule logic under test), this checks
// against the ledger's OWN summarizeLoan for the same asOf date — the
// adapter's whole job is to carry that figure over faithfully.
const ledgerSummary = summarizeLedgerLoan(carLoan, asOf)
const adaptedLoan = legacy.loans.find((l) => l.id === 'car-loan')
check("Adapted loan's totalAmount equals the REMAINING balance (not the original £3000 nominal total)", adaptedLoan?.totalAmount, ledgerSummary.remainingBalance)
check('Adapted loan totalAmount is meaningfully less than the £3000 nominal total (overpayments genuinely reduced it)', (adaptedLoan?.totalAmount ?? 0) < 3000, true)
// CHANGED 2026-09-23 (Adam-reported). This used to assert firstPaymentDate
// === today, and §5 below tolerated the consequence: the old engine counts a
// payment dated exactly "today" as already made, so the bridged loan read one
// whole instalment lighter than the ledger's own figure. That tolerance was a
// user-visible wrong number — a £10,050 loan whose first payment was not due
// for another week showed as £9,906.51 on the What-if page, while the loan
// card, the pie charts and the Borrowing form all showed £10,050. The bridge
// now dates the schedule from the next payment genuinely DUE, so the as-of
// balance matches the rest of the app exactly rather than within a payment.
check(
  "Adapted loan's firstPaymentDate is the next payment genuinely DUE, not today (so the as-of balance is not a payment light)",
  adaptedLoan?.firstPaymentDate,
  '2026-06-15',
)

// ---- 5. The OLD loan engine, fed the adapted loan, computes a sane remaining schedule ----
// lib/loans.ts still treats a payment dated exactly "today" as already made
// (inclusive date <= today) — that is unchanged. What changed on 2026-09-23 is
// that the bridge no longer HANDS it a payment dated today, so the two figures
// should now agree EXACTLY. The <= one-payment bound is kept as the assertion
// (a tighter equality check follows it) so this check keeps its original
// meaning if the dating ever regresses.
const legacySummary = summarizeLegacyLoan(adaptedLoan!, asOf)
check(
  "Old engine's remaining balance is within one payment of the adapted totalAmount",
  Math.abs((adaptedLoan?.totalAmount ?? 0) - legacySummary.remaining) <= carLoan.monthlyPayment,
  true,
)
// The point of the dating fix: not "close", but the same number the rest of
// the app shows. This is the check that would have caught Adam's £9,906.51.
check(
  "Old engine's remaining balance now equals the adapted totalAmount EXACTLY (no phantom payment)",
  legacySummary.remaining,
  adaptedLoan?.totalAmount,
)

// ---- 5b. A POT-funded item keeps its 'pot' location through the bridge ----
// 🚨 CORRECTED 2026-09-23, same day. This first asserted the OPPOSITE — that
// the bridge rewrites 'pot' to 'personal' so costForPerson() can see it. That
// fixed the What-if impact but DOUBLE-COUNTED the baseline: the monthly
// transfer INTO a pot is already a personal bill, so counting what the pot
// then pays adds the same money twice. Adam's Bills pot takes £256.03/month
// and pays exactly £256.03 of items, so "Available now (per month)" came out
// £256.03 too low. The 'pot' -> 'personal' mapping now lives in
// scenarios.ts's virtualLoanBill(), which is the IMPACT question, not the
// baseline one. The bridge must leave the location alone.
{
  const potLoan: Loan = { ...carLoan, id: 'pot-loan', location: 'pot', potId: 'bills-pot', payee: '', payeeSharePercent: 100 }
  const bridged = buildLegacyAppData({ ...ledgerData, loans: [...ledgerData.loans, potLoan] }, asOf)
  const bl = bridged.loans.find((l) => l.id === 'pot-loan')
  check('The bridge leaves a pot-funded loan as "pot" — the pot deposit is what costs personal cash', bl?.location, 'pot')
  check(
    'A pot-funded loan adds NOTHING to the personal baseline (its deposit already did)',
    costForPerson({ ...(bl as never as object), cost: 250 } as never, 'me', bridged.people),
    0,
  )
  const jointLoan: Loan = { ...carLoan, id: 'joint-loan', location: 'joint', ownerId: '', payee: 'me', payeeSharePercent: 50 }
  const jb = buildLegacyAppData({ ...ledgerData, loans: [...ledgerData.loans, jointLoan] }, asOf).loans.find((l) => l.id === 'joint-loan')
  check('CONTROL: a joint loan keeps its joint location', jb?.location, 'joint')
}

// ---- 6. The scenario engine itself runs end-to-end against bridged data without throwing, and produces a sane result ----
const impact = calculateScenarioImpact(testScenario, legacy, 'me', 0)
check('calculateScenarioImpact runs against bridged data without throwing, returns a finite monthly impact', Number.isFinite(impact.monthlyImpact), true)

console.log(failures === 0 ? '\nAll legacy-bridge checks passed.' : `\n${failures} legacy-bridge check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
