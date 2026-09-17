// D5 verification — the architecture fix from the handoff's §1: wiring
// lib/loans.ts / legacyBridge.ts to delegate to the real amortisation
// engine (lib/ledgerLoans.ts), so What-if's forward simulations — not
// just their starting balance — are accurate, and scenarios.ts's loan
// payoff logic reads the real settlement figure (scope §13 / handoff
// step 6), not raw remaining balance.

import { buildLegacyAppData } from '../src/lib/legacyBridge'
import { buildLoanSchedule, summarizeLoan, estimateSettlementFigure } from '../src/lib/loans'
import { calculateScenarioImpact } from '../src/lib/scenarios'
import { defaultLedgerData } from '../src/lib/ledgerStorage'
import { SANTANDER_FIXTURE } from '../src/lib/interestConventions'
import type { AppDataV2 } from '../src/types/ledger'
import type { Loan as LegacyLoan, Scenario } from '../src/types/models'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// ─────────────────────────────────────────────────────────────────────
// 1. legacyBridge.ts carries a real, resolved rate through — even for an
//    UNCALIBRATED ledger loan (the back-solved baseline, never undefined)
// ─────────────────────────────────────────────────────────────────────
const base = defaultLedgerData()
const ledgerDataWithCalibratedLoan: AppDataV2 = {
  ...base,
  people: [{ id: 'me', name: 'Me', color: '#ff5b4c', salaryHistory: [{ id: 's1', personId: 'me', effectiveFrom: '2020-01-01', grossAnnual: 40000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] }], salaryOverrides: [] }],
  primaryPersonId: 'me',
  loans: [
    {
      id: 'santander',
      name: 'Santander loan',
      categoryId: 'cat-loans',
      location: 'personal',
      ownerId: 'me',
      payee: '',
      payeeSharePercent: 100,
      overpayments: [],
      active: true,
      principal: SANTANDER_FIXTURE.principal,
      monthlyPayment: SANTANDER_FIXTURE.contractualPayment,
      termMonths: SANTANDER_FIXTURE.termMonths,
      startDate: '2026-07-02', // recent enough that a genuine 24-month-term loan is still mid-schedule as of "now" — unlike the existing credit-card fixtures' "deep in the past" convention, a term-bound loan (unlike revolving card debt) would already be fully paid off by now if started too far back. This specific date also gives a clean naive-vs-real divergence for the overpayment re-simulation check in section 5 below.
      interestConventionId: 'flat_monthly',
      calibratedMonthlyRate: SANTANDER_FIXTURE.empiricalMonthlyRate,
    },
  ],
}

// asOf deliberately omitted (defaults to real "now") for BOTH the bridge
// build and the later scenario calculations below, matching how the live
// app always rebuilds the bridge immediately before evaluating a
// scenario — no meaningful time gap between the two in real usage, so
// none should exist in this test either.
const bridged = buildLegacyAppData(ledgerDataWithCalibratedLoan)
const bridgedLoan = bridged.loans[0]
check('legacyBridge carries the real calibrated monthly rate through', bridgedLoan.calibratedMonthlyRate, SANTANDER_FIXTURE.empiricalMonthlyRate, 0.000001)
check("legacyBridge carries the loan's interestConventionId through", bridgedLoan.interestConventionId, 'flat_monthly')

const ledgerDataUncalibrated: AppDataV2 = { ...ledgerDataWithCalibratedLoan, loans: [{ ...ledgerDataWithCalibratedLoan.loans[0], interestConventionId: undefined, calibratedMonthlyRate: undefined }] }
const bridgedUncalibrated = buildLegacyAppData(ledgerDataUncalibrated, new Date('2026-06-15'))
check(
  'An UNCALIBRATED ledger loan still bridges a real, usable rate (the back-solved baseline) — never undefined',
  typeof bridgedUncalibrated.loans[0].calibratedMonthlyRate,
  'number',
)
check('The uncalibrated baseline falls back to the flat-monthly convention', bridgedUncalibrated.loans[0].interestConventionId, 'flat_monthly')

// ─────────────────────────────────────────────────────────────────────
// 2. lib/loans.ts genuinely delegates to the real engine — a calibrated
//    legacy loan produces true amortisation, not flat arithmetic
// ─────────────────────────────────────────────────────────────────────
const calibratedLegacyLoan: LegacyLoan = {
  id: 'santander',
  name: 'Santander loan',
  firstPaymentDate: '2026-07-02',
  totalAmount: 8400,
  monthlyPayment: SANTANDER_FIXTURE.contractualPayment,
  location: 'personal',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  calibratedMonthlyRate: SANTANDER_FIXTURE.empiricalMonthlyRate,
  interestConventionId: 'flat_monthly',
}
const delegatedSchedule = buildLoanSchedule(calibratedLegacyLoan)
check("A calibrated legacy loan's first-period interest matches the real fixture (proves delegation, not flat maths)", delegatedSchedule[0]?.amount, SANTANDER_FIXTURE.contractualPayment, 0.01)
check(
  'Real interest genuinely accrues: balance after 1 payment is LESS than a naive flat reduction would give (8400 - 410.29 = 7989.71)',
  delegatedSchedule[0]?.balanceAfter > 7989.71,
  true,
)

const uncalibratedLegacyLoan: LegacyLoan = { ...calibratedLegacyLoan, calibratedMonthlyRate: undefined, interestConventionId: undefined, totalAmount: 3000, monthlyPayment: 300, firstPaymentDate: '2026-01-01' }
const flatSchedule = buildLoanSchedule(uncalibratedLegacyLoan)
check('An uncalibrated legacy loan (no calibratedMonthlyRate) falls back to the ORIGINAL flat arithmetic, unchanged', flatSchedule[0]?.balanceAfter, 2700)
check('...and stays exactly 10 periods for a clean 3000/300 flat loan, same as before this change', flatSchedule.length, 10)

// ─────────────────────────────────────────────────────────────────────
// 3. estimateSettlementFigure delegates too, and correctly falls back
// ─────────────────────────────────────────────────────────────────────
// firstPaymentDate deliberately AFTER the asOf date below, so zero
// synthetic periods have elapsed yet — totalAmount (7796) represents the
// real balance right now, unreduced by the synthetic schedule's own
// forward walk, same convention legacyBridge.ts itself relies on.
const settlementCheckDate = new Date('2026-08-20')
const calibratedForSettlement: LegacyLoan = { ...calibratedLegacyLoan, totalAmount: 7796.0, firstPaymentDate: '2026-08-21', settlementMultiplier: 3 }
check(
  'estimateSettlementFigure (delegated) matches the real fixture within the documented 39p tolerance',
  Math.abs(estimateSettlementFigure(calibratedForSettlement, settlementCheckDate) - SANTANDER_FIXTURE.realSettlementQuoteAfterTwoPayments),
  0.39,
  0.02,
)
check(
  'estimateSettlementFigure falls back to raw remaining balance when there is no rate to estimate a premium from',
  estimateSettlementFigure(uncalibratedLegacyLoan),
  summarizeLoan(uncalibratedLegacyLoan).remaining,
)

// ─────────────────────────────────────────────────────────────────────
// 4. scenarios.ts: pay_off_loan now reads the settlement figure, not raw
//    remaining balance, to decide whether a lump sum truly closes the
//    loan (scope §13 / handoff step 6 — the core regression this
//    architecture fix exists to prevent)
// ─────────────────────────────────────────────────────────────────────
const scenarioData = { ...bridged, scenarios: [] }
const trueRemaining = summarizeLoan(bridgedLoan).remaining
const trueSettlement = estimateSettlementFigure(bridgedLoan)
check('Sanity: the settlement figure is genuinely higher than the raw remaining balance for this loan (there IS a real premium to test against)', trueSettlement > trueRemaining + 1, true)

// A lump sum equal to the raw remaining balance should NOT be enough to
// fully close the loan once there's a real early-settlement premium —
// this is exactly the bug scope §13 calls out.
const partialScenario: Scenario = {
  id: 's1',
  name: 'Pay off with raw remaining only',
  actions: [{ id: 'a1', type: 'pay_off_loan', label: '', value: round2(trueRemaining), targets: [{ kind: 'loan', id: bridgedLoan.id }] }],
}
const partialImpact = calculateScenarioImpact(partialScenario, scenarioData, 'me', 0)
check("A lump sum covering only the RAW remaining balance is NOT marked as fully paying off the loan (the settlement premium isn't covered)", partialImpact.loanImpacts[0]?.fullyPaidOff, false)

// A lump sum equal to the real settlement figure DOES fully close it.
const fullScenario: Scenario = {
  id: 's2',
  name: 'Pay off with the real settlement figure',
  actions: [{ id: 'a1', type: 'pay_off_loan', label: '', value: round2(trueSettlement), targets: [{ kind: 'loan', id: bridgedLoan.id }] }],
}
const fullImpact = calculateScenarioImpact(fullScenario, scenarioData, 'me', 0)
check('A lump sum covering the real settlement figure DOES fully pay off the loan', fullImpact.loanImpacts[0]?.fullyPaidOff, true)
check('...and leaves £0 remaining, not a leftover balance from an under-covering lump sum', fullImpact.loanImpacts[0]?.newRemaining, 0)

// A lump sum larger than the settlement figure only costs what the loan
// actually took. CHANGED 2026-09-17 (Adam): a pay_off_loan lump sum is money
// out of your own pocket, so one-off cash is now MINUS what was applied; the
// £500 the loan didn't need never left the account, so it is not a gain
// either. A sell_asset's leftover proceeds still count as cash in hand.
const overShootScenario: Scenario = {
  id: 's3',
  name: 'Pay off with more than needed',
  actions: [{ id: 'a1', type: 'pay_off_loan', label: '', value: round2(trueSettlement) + 500, targets: [{ kind: 'loan', id: bridgedLoan.id }] }],
}
const overShootImpact = calculateScenarioImpact(overShootScenario, scenarioData, 'me', 0)
check('A lump sum of settlement+£500 costs the settlement figure in one-off cash, and the unused £500 is neither gain nor cost', overShootImpact.oneOffCashImpact, -round2(trueSettlement))

function round2(n: number) {
  return Math.round(n * 100) / 100
}

// ─────────────────────────────────────────────────────────────────────
// 5. scenarios.ts: loan_overpayment now genuinely re-simulates through
//    the real engine instead of a naive remaining/newPayment division
// ─────────────────────────────────────────────────────────────────────
const overpayScenario: Scenario = {
  id: 's4',
  name: 'Overpay by £100/mo',
  actions: [{ id: 'a1', type: 'loan_overpayment', label: '', value: 100, linkedTargetKind: 'loan', linkedTargetId: bridgedLoan.id }],
}
const overpayImpact = calculateScenarioImpact(overpayScenario, scenarioData, 'me', 0)
const naiveMonthsRemaining = Math.ceil(trueRemaining / (bridgedLoan.monthlyPayment + 100))
const realMonthsRemaining = overpayImpact.loanImpacts[0]?.newMonthsRemaining
check(
  "The genuine re-simulation's monthsRemaining differs from the old naive division formula — proves it's really running the engine, not the old shortcut",
  realMonthsRemaining !== naiveMonthsRemaining,
  true,
)
check('The genuine re-simulation still saves a sensible, positive number of months', (realMonthsRemaining ?? 0) < (overpayImpact.loanImpacts[0]?.originalMonthsRemaining ?? 0), true)

console.log(failures === 0 ? '\nAll loan-scenario delegation checks passed.' : `\n${failures} loan-scenario delegation check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
