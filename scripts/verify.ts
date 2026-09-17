import { calculateNetSalary } from '../src/lib/tax'
import { buildLoanSchedule, summarizeLoan, currentLoanMonthlyCost } from '../src/lib/loans'
import { costForPerson, jointContributionForPerson, personalBillsTotal } from '../src/lib/bills'
import { calculateScenarioImpact, calculateHouseholdScenarioImpact, mergeScenarios } from '../src/lib/scenarios'
import { calculateFinanceAgreement } from '../src/lib/finance'
import type { AppData, Bill, Loan, Person, Scenario } from '../src/types/models'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok =
    typeof actual === 'number' && typeof expected === 'number'
      ? Math.abs(actual - expected) <= tolerance
      : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// ---- 1. Pay frequency: Ella-style 4-weekly should divide by 13, not 12 ----
const ellaSalary = {
  grossAnnual: 32000,
  taxCode: '1257L',
  studentLoanPlan: 'plan2' as const,
  payFrequency: 'four_weekly' as const,
  deductions: [{ id: 'p1', name: 'Pension', type: 'relief_at_source' as const, amountType: 'percent' as const, amount: 5 }],
}
const ellaBreakdown = calculateNetSalary(ellaSalary)
check('Ella periodsPerYear', ellaBreakdown.periodsPerYear, 13)
check('Ella netPerPeriod = netAnnual / 13', ellaBreakdown.netPerPeriod, ellaBreakdown.netAnnual / 13)
check('Ella netMonthly still = netAnnual / 12 (unaffected reference figure)', ellaBreakdown.netMonthly, ellaBreakdown.netAnnual / 12)

const adamSalary = { ...ellaSalary, payFrequency: 'monthly' as const, studentLoanPlan: 'none' as const }
const adamBreakdown = calculateNetSalary(adamSalary)
check('Adam (monthly) netPerPeriod === netMonthly (no regression)', adamBreakdown.netPerPeriod, adamBreakdown.netMonthly)

// ---- 1b. Deductions engine validated against Ella's real payslip screenshot ----
// Annual £32,857.50, 4-weekly (13 periods), Plan 1 student loan:
//   Holiday Purchase Scheme -£52.65 (salary sacrifice)
//   Pension 2.5% -£63.18 (salary sacrifice)
//   -> Gross Taxable £2411.67 -> Income Tax £288.80, NI £115.57, Student Loan £30.00
//   Work Charity Lottery -£4.00 (post-tax)
//   -> Net £1973.30
const ellaReal = calculateNetSalary({
  grossAnnual: 32857.5,
  taxCode: '1257L',
  studentLoanPlan: 'plan1',
  payFrequency: 'four_weekly',
  deductions: [
    { id: 'd1', name: 'Holiday Purchase Scheme', type: 'salary_sacrifice', amountType: 'fixed', amount: 52.65 },
    { id: 'd2', name: 'Pension', type: 'salary_sacrifice', amountType: 'percent', amount: 2.5 },
    { id: 'd3', name: 'Work Charity Lottery', type: 'post_tax', amountType: 'fixed', amount: 4.0 },
  ],
})
// Tolerances here are deliberately ZERO. They used to be £1, and that is
// precisely how three separate engine defects stayed hidden — the suite went
// green while the numbers were wrong. The engine calculates per period now and
// should reproduce a real payslip exactly; if it can't, that's a failure, not
// a rounding allowance. See scripts/verify-paye-engine.ts for the full set.
check('Real payslip: gross taxable exactly £2411.67', ellaReal.grossTaxablePerPeriod, 2411.67, 0)
check('Real payslip: income tax exactly £288.80', ellaReal.incomeTaxPerPeriod, 288.8, 0)
check('Real payslip: NI exactly £115.57', ellaReal.nationalInsurancePerPeriod, 115.57, 0)
check('Real payslip: student loan exactly £30.00', ellaReal.studentLoanPerPeriod, 30.0, 0)
check('Real payslip: net pay exactly £1973.30', ellaReal.netPerPeriod, 1973.3, 0)
check('Real payslip: preTaxDeductions recorded in order (Holiday first, Pension second)', ellaReal.preTaxDeductions.map((d) => d.name), ['Holiday Purchase Scheme', 'Pension'])
check('Real payslip: postTaxDeductions recorded', ellaReal.postTaxDeductions.map((d) => d.name), ['Work Charity Lottery'])

// ---- 2. Loan schedule + currentLoanMonthlyCost near payoff ----
const loan: Loan = {
  id: 'loan1',
  name: 'Car',
  firstPaymentDate: '2020-01-01',
  totalAmount: 1000,
  monthlyPayment: 300,
  location: 'personal',
  ownerId: 'adam',
  payee: '',
  payeeSharePercent: 100,
}
const schedule = buildLoanSchedule(loan)
check('Loan schedule length (1000/300 -> 4 payments)', schedule.length, 4)
check('Final payment absorbs rounding (1000 - 3*300 = 100)', schedule[3].amount, 100)
check('Balance hits exactly 0', schedule[3].balanceAfter, 0)

const asOfNearEnd = new Date('2020-03-15') // after 3 payments (Jan/Feb/Mar), before the 4th (Apr 1)
const summary = summarizeLoan(loan, asOfNearEnd)
check('summarizeLoan remaining after 3 payments', summary.remaining, 100)
check('currentLoanMonthlyCost uses reduced final payment, not flat monthlyPayment', currentLoanMonthlyCost(loan, asOfNearEnd), 100)

const asOfPaidOff = new Date('2021-01-01')
check('currentLoanMonthlyCost is 0 once fully paid off', currentLoanMonthlyCost(loan, asOfPaidOff), 0)

// ---- 3. Bill split percentages, both directions ----
const people: Person[] = [
  { id: 'adam', name: 'Adam', color: '#fff', salary: adamSalary },
  { id: 'ella', name: 'Ella', color: '#fff', salary: ellaSalary },
]
const splitBill: Bill = {
  id: 'b1',
  name: 'Netflix',
  cost: 100,
  dueDay: 1,
  location: 'joint',
  payee: 'adam',
  payeeSharePercent: 60,
  category: 'TV',
  ownerId: '',
  isStandingOrder: true,
}
check('costForPerson: payee gets their %', costForPerson(splitBill, 'adam', people), 60)
check('costForPerson: remainder goes to the other person', costForPerson(splitBill, 'ella', people), 40)
check('costForPerson: uninvolved third person gets nothing', costForPerson(splitBill, 'nobody', people), 0)

const fullBill: Bill = { ...splitBill, id: 'b2', payeeSharePercent: 100 }
check('100% split: payee pays it all', costForPerson(fullBill, 'adam', people), 100)
check('100% split: other person pays nothing', costForPerson(fullBill, 'ella', people), 0)

const bills = [splitBill]
check('jointContributionForPerson matches costForPerson sum', jointContributionForPerson(bills, 'adam', people), 60)
check('personalBillsTotal ignores joint bills', personalBillsTotal(bills, 'adam'), 0)

// ---- 4. Scenario: sell asset covering loan + overflow as one-off cash ----
const bigLoan: Loan = { ...loan, id: 'loan2', totalAmount: 6080, monthlyPayment: 411, firstPaymentDate: '2024-01-01' }
const scenarioData: AppData = {
  people,
  bills: [],
  loans: [bigLoan],
  scenarios: [],
  primaryPersonId: 'adam',
}
const sellScenario: Scenario = {
  id: 's1',
  name: 'Sell truck',
  includeInCumulative: true,
  actions: [{ id: 'a1', type: 'sell_asset', label: '', value: 10000, linkedLoanId: 'loan2' }],
}
const impact = calculateScenarioImpact(sellScenario, scenarioData, 'adam', 1000)
const remaining = summarizeLoan(bigLoan).remaining
check('Overflow beyond loan remaining becomes one-off cash (not swallowed)', impact.oneOffCashImpact, 10000 - remaining)
check('Loan impact shows fully paid off', impact.loanImpacts[0]?.fullyPaidOff, true)

// ---- 5. Cumulative merge: two scenarios targeting the same loan combine correctly ----
const loanForMerge: Loan = { ...loan, id: 'loan3', totalAmount: 1000, monthlyPayment: 100, firstPaymentDate: '2027-01-01' }
const mergeData: AppData = { ...scenarioData, loans: [loanForMerge] }
const s1: Scenario = { id: 's1', name: 'A', includeInCumulative: true, actions: [{ id: 'a1', type: 'pay_off_loan', label: '', value: 400, linkedLoanId: 'loan3' }] }
const s2: Scenario = { id: 's2', name: 'B', includeInCumulative: true, actions: [{ id: 'a2', type: 'pay_off_loan', label: '', value: 400, linkedLoanId: 'loan3' }] }
const merged = mergeScenarios([s1, s2])
const mergedImpact = calculateScenarioImpact(merged, mergeData, 'adam', 1000)
check('Merged lump sums combine (400+400=800) against real remaining, not double-counted incorrectly', mergedImpact.loanImpacts[0]?.newRemaining, 1000 - 800)

// ---- 6. change_bill honours location/split instead of always being the viewer's ----
const changeBillScenario: Scenario = {
  id: 's3',
  name: 'Finance',
  includeInCumulative: true,
  actions: [
    {
      id: 'a3',
      type: 'new_bill',
      label: '',
      value: 150,
      name: 'Furniture finance',
      location: 'joint',
      payee: 'adam',
      payeeSharePercent: 70,
    },
  ],
}
const changeBillData: AppData = { ...scenarioData, loans: [] }
const cbImpactAdam = calculateScenarioImpact(changeBillScenario, changeBillData, 'adam', 1000)
const cbImpactElla = calculateScenarioImpact(changeBillScenario, changeBillData, 'ella', 1000)
check('new_bill: Adam (70%) sees -105/mo', cbImpactAdam.monthlyImpact, -105)
check('new_bill: Ella (30%) sees -45/mo', cbImpactElla.monthlyImpact, -45)

// ---- 6b. Household view: per-person splits should sum back to the true full-value total ----
const cbImpactHousehold = calculateHouseholdScenarioImpact(changeBillScenario, changeBillData, 1000)
check("Household view: 70% + 30% reconstructs the full -£150/mo (not double- or under-counted)", cbImpactHousehold.monthlyImpact, -150)

// ---- 6c. Household view: a jointly-split loan being paid off should free up its FULL payment, not half ----
const jointLoan: Loan = {
  id: 'joint-loan',
  name: 'Joint loan',
  firstPaymentDate: '2027-01-01',
  totalAmount: 1200,
  monthlyPayment: 100,
  location: 'joint',
  ownerId: '',
  payee: 'adam',
  payeeSharePercent: 50,
}
const jointLoanData: AppData = { ...scenarioData, loans: [jointLoan] }
const jointLoanScenario: Scenario = {
  id: 'jl1',
  name: 'Clear joint loan',
  includeInCumulative: true,
  actions: [{ id: 'jla1', type: 'pay_off_loan', label: '', value: 1200, loanAllocations: [{ loanId: 'joint-loan' }] }],
}
const jlImpactAdam = calculateScenarioImpact(jointLoanScenario, jointLoanData, 'adam', 1000)
const jlImpactHousehold = calculateHouseholdScenarioImpact(jointLoanScenario, jointLoanData, 1000)
check("Household: Adam alone only sees his 50% share (£50/mo) freed up", jlImpactAdam.monthlyImpact, 50)
check("Household: combined view sees the FULL £100/mo freed up, not just one person's half", jlImpactHousehold.monthlyImpact, 100)
const zeroApr = calculateFinanceAgreement({ borrowAmount: 1000, aprPercent: 0, termMonths: 10 })
check('0% APR: monthly payment is a flat split', zeroApr.monthlyPayment, 100)
check('0% APR: total repayable = borrowed amount', zeroApr.totalRepayable, 1000)
check('0% APR: no interest', zeroApr.totalInterest, 0)

const withApr = calculateFinanceAgreement({ borrowAmount: 1000, aprPercent: 12, termMonths: 12 })
check('12% APR over 12mo: monthly payment ≈ £88.56 (standard amortisation, compound APR->monthly conversion — not the incorrect APR/12 shortcut this used to use)', withApr.monthlyPayment, 88.56, 0.1)
check('12% APR: total repayable > borrowed amount (interest applied)', withApr.totalRepayable > 1000, true)
check('12% APR: totalRepayable = monthlyPayment × term', withApr.totalRepayable, withApr.monthlyPayment * 12, 0.05)

// ---- 10. Cascade fix: reproduces the exact reported bug ----
// Sell for £15,000 across two loans (Monzo needs £7696.19, Car needs
// £7453.78 — combined £15,149.97, MORE than the sale). Old behaviour
// double-counted: showed +£7303.81 "leftover" that was also being spent on
// the second loan. Correct behaviour: Car can't be fully cleared, and there
// is truly nothing left over.
const monzoLoan: Loan = { ...loan, id: 'monzo', totalAmount: 7696.19, monthlyPayment: 7696.19, firstPaymentDate: '2027-01-01' }
const carLoan: Loan = { ...loan, id: 'car', totalAmount: 7453.78, monthlyPayment: 7453.78, firstPaymentDate: '2027-01-01' }
const cascadeData: AppData = { ...scenarioData, loans: [monzoLoan, carLoan] }
const cascadeScenario: Scenario = {
  id: 'cascade',
  name: 'Sell car',
  includeInCumulative: true,
  actions: [{ id: 'ca1', type: 'sell_asset', label: '', value: 15000, linkedLoanIds: ['monzo', 'car'] }],
}
const cascadeImpact = calculateScenarioImpact(cascadeScenario, cascadeData, 'adam', 1000)
check('Cascade: Monzo (first target) fully paid off', cascadeImpact.loanImpacts.find((l) => l.loanId === 'monzo')?.fullyPaidOff, true)
check('Cascade: Car (second target) NOT fully paid off — not enough money left', cascadeImpact.loanImpacts.find((l) => l.loanId === 'car')?.fullyPaidOff, false)
check(
  "Cascade: Car's remaining after = 7453.78 - (15000-7696.19) = 149.97",
  cascadeImpact.loanImpacts.find((l) => l.loanId === 'car')?.newRemaining,
  149.97
)
check('Cascade: NO leftover one-off cash — every pound was spoken for', cascadeImpact.oneOffCashImpact, 0)

// ---- 11. Manual per-target amount override ----
// £15,000 sale, explicitly send only £5,000 to Monzo (not its full £7696.19
// need) and let Car auto-take the rest.
const overrideScenario: Scenario = {
  id: 'override',
  name: 'Sell car, manual split',
  includeInCumulative: true,
  actions: [
    {
      id: 'ov1',
      type: 'sell_asset',
      label: '',
      value: 15000,
      loanAllocations: [
        { loanId: 'monzo', amount: 5000 },
        { loanId: 'car' }, // auto — takes whatever's left
      ],
    },
  ],
}
const overrideImpact = calculateScenarioImpact(overrideScenario, cascadeData, 'adam', 1000)
check('Manual override: Monzo gets exactly the specified £5000, not its full need', overrideImpact.loanImpacts.find((l) => l.loanId === 'monzo')?.lumpSumApplied, 5000)
check('Manual override: Car auto-takes the remaining £10000 pool (capped to its own £7453.78 need)', overrideImpact.loanImpacts.find((l) => l.loanId === 'car')?.lumpSumApplied, 7453.78)
check('Manual override: Car fully paid off since 10000 pool exceeds its need', overrideImpact.loanImpacts.find((l) => l.loanId === 'car')?.fullyPaidOff, true)
check('Manual override: leftover cash = 15000 - 5000 - 7453.78', overrideImpact.oneOffCashImpact, 15000 - 5000 - 7453.78)

// ---- 12. Bug fix: switching a bill/loan from joint to personal must not orphan it ----
// (ownerId was previously left as '' — the empty string joint bills use — which
// never matches any real person's id, silently making the item invisible everywhere)
const wasJointNowPersonal: Bill = {
  id: 'switched',
  name: 'Switched bill',
  cost: 50,
  dueDay: 1,
  location: 'personal',
  ownerId: 'adam', // simulates the FIXED behaviour: ownerId gets set on switch
  payee: '',
  payeeSharePercent: 100,
  category: 'Test',
  isStandingOrder: true,
}
check(
  'Fixed: a bill switched to personal with an owner set is visible in that owner\'s personal total',
  personalBillsTotal([wasJointNowPersonal], 'adam'),
  50
)
const stillBrokenIfOwnerEmpty: Bill = { ...wasJointNowPersonal, ownerId: '' }
check(
  'Confirms the original bug mechanism: empty ownerId really does make a personal bill invisible (this is why the UI fix matters)',
  personalBillsTotal([stillBrokenIfOwnerEmpty], 'adam'),
  0
)

// ---- Summary ----
console.log('\n' + (failures === 0 ? `All checks passed.` : `${failures} check(s) FAILED.`))
process.exit(failures === 0 ? 0 : 1)
