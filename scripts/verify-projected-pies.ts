// Sanity checks for the "Next 3 cycles" projected-segment math added to
// the Home page's Loans/Savings pie charts. No DOM here, so this exercises
// the underlying calculations (summarizeLoan-at-a-future-date, and the
// three-cycle horizon) the component
// reads from directly — not the SVG rendering itself.

import { summarizeLoan } from '../src/lib/ledgerLoans'
import { computeProjection, horizonRangeEnd } from '../src/lib/projection'
import { withLiveBalance } from '../src/lib/creditCards'
import type { AppDataV2, CreditCard, Loan, Person, PayCycleConfig, Transaction } from '../src/types/ledger'
import { defaultLedgerData } from '../src/lib/ledgerStorage'
import { toLocalIsoDate } from '../src/lib/date'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

// ── Loan projection: a £1200 loan, £100/month, no overpayments ─────────
const loan: Loan = {
  id: 'loan-1',
  name: 'Sofa',
  principal: 1200, // 0%-equivalent (100 × 12) — this suite is about the projection horizon, not interest
  monthlyPayment: 100,
  termMonths: 12,
  startDate: '2026-01-01',
  categoryId: 'cat-loans',
  location: 'personal',
  ownerId: 'adam',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
}

const todaySummary = summarizeLoan(loan, new Date('2026-06-15'))
check('As of 15 June, 6 payments have landed (Jan–Jun), £600 remains', todaySummary.remainingBalance, 600)

const threeMonthsOutSummary = summarizeLoan(loan, new Date('2026-09-15'))
check('As of 15 Sept (3 months later), 9 payments have landed, £300 remains — this is exactly the "projected" figure the ring reads', threeMonthsOutSummary.remainingBalance, 300)

check("Projected remaining is strictly less than today's remaining (the ring genuinely projects forward, not sideways)", threeMonthsOutSummary.remainingBalance < todaySummary.remainingBalance, true)

// A one-off overpayment logged for a FUTURE date should already be
// reflected in a projection that reaches past it, without needing "today"
// to have arrived yet.
const loanWithFutureOverpayment: Loan = { ...loan, overpayments: [{ id: 'op1', date: '2026-07-01', amount: 200 }] }
const withOverpaymentProjection = summarizeLoan(loanWithFutureOverpayment, new Date('2026-09-15'))
check(
  'A future-dated overpayment already logged is baked into the projection ahead of time (300 - 200 = 100)',
  withOverpaymentProjection.remainingBalance,
  100,
)

// ── Horizon: the savings goal checks that used this setup were removed with savingsEntries (2026-09-17) ──
const person: Person = {
  id: 'adam',
  name: 'Adam',
  color: '#000',
  salaryHistory: [
    { id: 's1', personId: 'adam', effectiveFrom: '2026-01-01', grossAnnual: 40000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [], employerPensionPercent: 0 },
  ],
  salaryOverrides: [],
}

const payCycle: PayCycleConfig = {
  personId: 'adam',
  openingBalance: 1000,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 1,
}

const base = defaultLedgerData()
const data: AppDataV2 = { ...base, people: [person], payCycles: [payCycle], primaryPersonId: 'adam', transactions: [] }

const asOf = new Date('2026-06-15')
const threeCycleEnd = horizonRangeEnd(data, 'adam', 'three_cycles', asOf)
const projection = computeProjection(data, 'adam', payCycle, 'three_cycles', asOf)

// NB: date-only formatting here MUST go through the shared toLocalIsoDate
// helper (src/lib/date.ts), never `d.toISOString().slice(0, 10)` — this
// test previously reimplemented that exact banned pattern locally, which
// silently rolled threeCycleEnd back a day during BST (Aug 31 -> Aug 30)
// since toISOString() converts to UTC first. threeCycleEnd itself was
// always correct; only this comparison's own formatting was broken.
check('Horizon end used for the loan check is the same kind of date (three_cycles)', toLocalIsoDate(threeCycleEnd), projection.horizonEnd)

// ── Credit card: Home page hero card / pie chart, "Next 3 cycles" (Batch 8, 2026-09-07, Bug 9.1) ──
// The bug: a purchase dated LATER in the current cycle (or in a future
// cycle within the horizon) never showed up in the Home page's "Next 3
// cycles" balance/pie for a credit card — withLiveBalance was always
// called with its default asOfDate (today), never the horizon's own end
// date, unlike every other hero card on this page (Savings pot got this
// exact fix on 2026-09-03; the credit card cases were simply never
// updated to match).
const card: CreditCard = {
  id: 'card-1',
  name: 'Visa',
  categoryId: 'cat-cc',
  color: '#8b5cf6',
  interestRatePercent: 20,
  currentBalance: 0,
  balanceAsOfDate: '2026-09-06',
  minimumPayment: { type: 'fixed', amount: 25 },
  paymentDayOfMonth: 14,
  statementStartDay: 19,
  statementEndDay: 18,
  ownerId: 'adam',
  lumpPayments: [],
  active: true,
}
const fuelPurchase: Transaction = {
  id: 'txn-fuel',
  type: 'credit_card_spend',
  amount: 50,
  date: '2026-09-12',
  categoryId: 'cat-cc',
  paymentMethod: 'card',
  status: 'cleared',
  direction: 'out',
  location: 'personal',
  ownerId: 'adam',
  creditCardId: 'card-1',
}
const cardTransactions = [fuelPurchase]

// asOf "today" (06 Sept, before the 12 Sept purchase) correctly shows £0 —
// this transaction is dated in the future relative to that asOf.
check('Balance as of 6 Sept (before the purchase) is still £0', withLiveBalance(card, cardTransactions, new Date('2026-09-06')).currentBalance, 0)

// asOf the "Next 3 cycles" horizon end (reaches well past 12 Sept) must
// show the £50 purchase — this is exactly what Home.tsx's DeckHero/
// CreditCardDetail/CreditCardsCombinedDetail now compute via
// horizonRangeEnd(data, primaryPersonId, 'three_cycles', new Date()).
const ccData: AppDataV2 = { ...defaultLedgerData(), creditCards: [card], transactions: cardTransactions, primaryPersonId: 'adam' }
const threeCycleEndForCard = horizonRangeEnd(ccData, 'adam', 'three_cycles', new Date('2026-09-06'))
check('Horizon end (three cycles from 6 Sept) reaches past the 12 Sept purchase date', toLocalIsoDate(threeCycleEndForCard) >= '2026-09-12', true)
// >= the raw £50 purchase, not exactly it — cardBalanceAsOf also accrues
// interest month to month over a 3-cycle horizon (this card carries a
// 20% APR), so the true figure is £50 plus whatever interest has accrued
// since — the point of this check is that it's no longer £0, not the
// exact accrued total.
check('Balance as of the three-cycle horizon end includes (at least) the £50 purchase', withLiveBalance(card, cardTransactions, threeCycleEndForCard).currentBalance >= 50, true)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll projected-pie checks passed.')
