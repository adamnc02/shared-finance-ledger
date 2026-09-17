import { calculateScenarioImpact, calculateHouseholdScenarioImpact, resolveTargets } from '../src/lib/scenarios'
import { simulateCardPayoffMonths } from '../src/lib/creditCards'
import type { AppData, Loan, Person, Scenario } from '../src/types/models'
import type { CreditCard } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}
function checkTrue(label: string, actual: boolean) {
  console.log(`${actual ? '✓' : '✗ FAIL'} ${label}`)
  if (!actual) failures++
}

function person(id: string): Person {
  return {
    id,
    name: id,
    color: '#000',
    salary: { grossAnnual: 30000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] },
  }
}

function loan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: 'loan-1',
    name: 'Car loan',
    firstPaymentDate: '2020-01-01', // deep in the past, but totalAmount below is sized so it's still genuinely mid-schedule today, not already paid off
    totalAmount: 20000,
    monthlyPayment: 200,
    location: 'personal',
    ownerId: 'me',
    payee: 'me',
    payeeSharePercent: 100,
    ...overrides,
  }
}

function card(overrides: Partial<CreditCard> = {}): CreditCard {
  return {
    id: 'card-1',
    name: 'Visa',
    categoryId: 'cat-1',
    color: '#000',
    interestRatePercent: 22.9,
    currentBalance: 1000,
    minimumPayment: { type: 'fixed', amount: 100 },
    paymentDayOfMonth: 1,
    ownerId: 'me',
    lumpPayments: [],
    active: true,
    ...overrides,
  }
}

function baseData(overrides: Partial<AppData> = {}): AppData {
  return {
    people: [person('me')],
    bills: [],
    loans: [],
    creditCards: [],
    scenarios: [],
    primaryPersonId: 'me',
    ...overrides,
  }
}

// ── resolveTargets back-compat chain ──

check('New unified `targets` field takes priority', resolveTargets({ id: 'a', type: 'pay_off_loan', label: '', value: 0, targets: [{ kind: 'credit_card', id: 'c1' }] }), [
  { kind: 'credit_card', id: 'c1' },
])
check(
  'Old `loanAllocations` maps to loan-kind targets',
  resolveTargets({ id: 'a', type: 'pay_off_loan', label: '', value: 0, loanAllocations: [{ loanId: 'l1', amount: 50 }] }),
  [{ kind: 'loan', id: 'l1', amount: 50 }],
)
check(
  'Single-target `linkedTargetKind`/`linkedTargetId` resolves correctly',
  resolveTargets({ id: 'a', type: 'exclude_loan', label: '', value: 0, linkedTargetKind: 'credit_card', linkedTargetId: 'c1' }),
  [{ kind: 'credit_card', id: 'c1' }],
)
check(
  'Oldest `linkedLoanId` shape still resolves, as loan-kind',
  resolveTargets({ id: 'a', type: 'exclude_loan', label: '', value: 0, linkedLoanId: 'l1' }),
  [{ kind: 'loan', id: 'l1' }],
)
check('No target fields at all resolves to an empty list', resolveTargets({ id: 'a', type: 'exclude_loan', label: '', value: 0 }), [])

// ── Credit card: lump sum (payoff) ──

const cardPayoffScenario: Scenario = {
  id: 's1',
  name: 'Pay off card',
  includeInCumulative: true,
  actions: [{ id: 'a1', type: 'pay_off_loan', label: '', value: 400, targets: [{ kind: 'credit_card', id: 'card-1' }] }],
}
const cardPayoffData = baseData({ creditCards: [card()] })
const cardPayoffImpact = calculateScenarioImpact(cardPayoffScenario, cardPayoffData, 'me', 0)
check("Card lump sum reduces the card impact's remaining balance", cardPayoffImpact.loanImpacts[0]?.newRemaining, 600)
check('Card lump sum impact reports the right target kind', cardPayoffImpact.loanImpacts[0]?.targetKind, 'credit_card')
checkTrue('A £400 lump sum against a £1000 balance does not fully pay it off', !cardPayoffImpact.loanImpacts[0]?.fullyPaidOff)

const cardFullPayoffScenario: Scenario = {
  id: 's2',
  name: 'Clear the card',
  includeInCumulative: true,
  actions: [{ id: 'a1', type: 'pay_off_loan', label: '', value: 2000, targets: [{ kind: 'credit_card', id: 'card-1' }] }],
}
const cardFullPayoffImpact = calculateScenarioImpact(cardFullPayoffScenario, cardPayoffData, 'me', 0)
checkTrue('A lump sum bigger than the balance fully pays off the card', cardFullPayoffImpact.loanImpacts[0]?.fullyPaidOff ?? false)
// CHANGED 2026-09-17 (Adam): paying a card off is money out of pocket, so
// one-off cash is minus the £1,000 the card actually took. The other £1,000
// was never needed and never left the account.
check('Clearing the card costs what it took, not the whole earmarked amount', cardFullPayoffImpact.oneOffCashImpact, -1000)

// ── Credit card: exclude ──

const cardExcludeScenario: Scenario = {
  id: 's3',
  name: 'Exclude the card',
  includeInCumulative: true,
  actions: [{ id: 'a1', type: 'exclude_loan', label: '', value: 0, linkedTargetKind: 'credit_card', linkedTargetId: 'card-1' }],
}
const cardExcludeImpact = calculateScenarioImpact(cardExcludeScenario, cardPayoffData, 'me', 0)
check('Excluding a card leaves its balance unchanged', cardExcludeImpact.loanImpacts[0]?.newRemaining, 1000)
check('Excluding a card frees up its minimum payment as monthly impact', cardExcludeImpact.monthlyImpact, 100) // fixed £100 minimum

// ── Credit card: recurring overpayment ──

const cardOverpayScenario: Scenario = {
  id: 's4',
  name: 'Overpay the card',
  includeInCumulative: true,
  actions: [{ id: 'a1', type: 'loan_overpayment', label: '', value: 50, linkedTargetKind: 'credit_card', linkedTargetId: 'card-1' }],
}
const cardOverpayImpact = calculateScenarioImpact(cardOverpayScenario, cardPayoffData, 'me', 0)
checkTrue('Overpaying a card saves months compared to minimum-only', (cardOverpayImpact.loanImpacts[0]?.monthsSaved ?? 0) > 0)
check(
  "Overpaying a card increases the person's monthly cost by the overpayment",
  cardOverpayImpact.loanImpacts[0]!.newMonthlyCostForPerson - cardOverpayImpact.loanImpacts[0]!.originalMonthlyCostForPerson,
  50,
)

// ── Mixed cascade: a single lump sum split across a loan AND a card, in order ──

const mixedData = baseData({ loans: [loan({ totalAmount: 300, monthlyPayment: 300, firstPaymentDate: '2099-01-01' })], creditCards: [card({ currentBalance: 500 })] })
// loan's remaining balance with a future firstPaymentDate and totalAmount 300 is its full 300 (schedule hasn't started yet)
const mixedScenario: Scenario = {
  id: 's5',
  name: 'Sell something, clear loan then card',
  includeInCumulative: true,
  actions: [
    {
      id: 'a1',
      type: 'pay_off_loan',
      label: '',
      value: 600,
      targets: [
        { kind: 'loan', id: 'loan-1' },
        { kind: 'credit_card', id: 'card-1' },
      ],
    },
  ],
}
const mixedImpact = calculateScenarioImpact(mixedScenario, mixedData, 'me', 0)
const loanResult = mixedImpact.loanImpacts.find((li) => li.targetKind === 'loan')
const cardResult = mixedImpact.loanImpacts.find((li) => li.targetKind === 'credit_card')
checkTrue('Mixed cascade: the loan (first in order) is fully cleared', loanResult?.fullyPaidOff ?? false)
check('Mixed cascade: the card (second in order) receives the £300 left over', cardResult?.lumpSumApplied, 300)
check("Mixed cascade: the card's remaining balance drops accordingly", cardResult?.newRemaining, 200)

// ── Household de-duplication respects targetKind (a loan and a card with the same literal id string must never merge) ──

const collisionData = baseData({
  people: [person('me'), person('partner')],
  loans: [loan({ id: 'shared-id', ownerId: 'me', location: 'personal' })],
  creditCards: [card({ id: 'shared-id', ownerId: 'partner' })],
})
const collisionScenario: Scenario = {
  id: 's6',
  name: 'Exclude both',
  includeInCumulative: true,
  actions: [
    { id: 'a1', type: 'exclude_loan', label: '', value: 0, linkedTargetKind: 'loan', linkedTargetId: 'shared-id' },
    { id: 'a2', type: 'exclude_loan', label: '', value: 0, linkedTargetKind: 'credit_card', linkedTargetId: 'shared-id' },
  ],
}
const collisionImpact = calculateHouseholdScenarioImpact(collisionScenario, collisionData, 0)
check('A loan and a card sharing the same literal id produce two separate impacts, not one merged one', collisionImpact.loanImpacts.length, 2)

// ── simulateCardPayoffMonths sanity ──

const cheapCard = card({ currentBalance: 1000, interestRatePercent: 0, minimumPayment: { type: 'fixed', amount: 100 } })
const cheapPayoff = simulateCardPayoffMonths(cheapCard, 0)
check('A 0% interest card paying a flat £100/month off a £1000 balance clears in 10 months', cheapPayoff.months, 10)
check('A 0% interest card accrues no interest at all', cheapPayoff.totalInterestPaid, 0)

const stuckCard = card({ currentBalance: 1000, interestRatePercent: 40, minimumPayment: { type: 'fixed', amount: 1 } })
const stuckPayoff = simulateCardPayoffMonths(stuckCard, 0, 60)
checkTrue('A minimum payment that can never outpace interest hits the safety cap rather than looping forever', stuckPayoff.months <= 60)

// ── Regression: a pure loan-only scenario (old linkedLoanId shape) still behaves as before ──

const loanOnlyData = baseData({ loans: [loan()] })
const loanOnlyScenario: Scenario = {
  id: 's7',
  name: 'Exclude the loan (legacy shape)',
  includeInCumulative: true,
  actions: [{ id: 'a1', type: 'exclude_loan', label: '', value: 0, linkedLoanId: 'loan-1' }],
}
const loanOnlyImpact = calculateScenarioImpact(loanOnlyScenario, loanOnlyData, 'me', 0)
check('A legacy linkedLoanId-only exclude action still resolves and reports targetKind loan', loanOnlyImpact.loanImpacts[0]?.targetKind, 'loan')
checkTrue('A legacy exclude action still frees up monthly impact', loanOnlyImpact.monthlyImpact > 0)

console.log(failures === 0 ? '\nAll scenario credit-card checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
