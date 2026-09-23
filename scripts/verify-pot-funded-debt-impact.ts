// 2026-09-23 — A pot-funded loan: £0 in the BASELINE, its full payment in the IMPACT.
//
// These two must disagree, and getting that wrong costs real money either way:
//
//  BASELINE ("Available now (per month)"). A pot is funded by a monthly
//  transfer, and that transfer is itself a personal bill. The items the pot
//  then pays must add NOTHING on top, or the same money is counted twice.
//  Adam's Bills pot takes £256.03/month and pays exactly £256.03 of items
//  (Gym 37 + GiffGaff 10 + Monzo Perks 7 + Windscribe 7.03 + Monzo loan 195).
//
//  IMPACT ("Impact on available cash"). Clearing a £195 pot-funded loan frees
//  £195 of the pot's capacity, which becomes personal cash by reducing the
//  deposit. So the impact IS £195, not £0.
//
// Both bugs happened on 2026-09-23. costForPerson() knows only 'personal' and
// the joint split, so a 'pot' location fell into the joint branch and yielded
// £0 -- the impact showed blank. The first fix rewrote 'pot' in the BRIDGE,
// which fixed the impact and broke the baseline by £256.03. The mapping
// belongs in scenarios.ts's virtualLoanBill() and nowhere else.
import type { AppData, Loan, Scenario, Bill } from '../src/types/models'
import { calculateScenarioImpact } from '../src/lib/scenarios'
import { personalBillsTotal } from '../src/lib/bills'

let failures = 0
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const TODAY = new Date().toISOString().slice(0, 10)
const people = [{ id: 'me', name: 'Me', salary: 40000, payFrequency: 'monthly', payDayOfMonth: 25, sharePercent: 100 }]

// A pot funded by a £256.03 transfer, paying a £195 loan and £61.03 of bills.
const deposit = { id: 'dep', name: 'Bills Monthly Deposit', cost: 256.03, dueDay: 20, location: 'personal', ownerId: 'me', payee: '', payeeSharePercent: 100, category: 'Savings', isStandingOrder: true } as unknown as Bill
const potBills = [
  { id: 'gym', name: 'Gym', cost: 37, dueDay: 1, location: 'pot', ownerId: 'me', payee: '', payeeSharePercent: 100, category: 'Fitness', isStandingOrder: true },
  { id: 'gg', name: 'GiffGaff', cost: 10, dueDay: 7, location: 'pot', ownerId: 'me', payee: '', payeeSharePercent: 100, category: 'Phone', isStandingOrder: true },
  { id: 'mp', name: 'Monzo Perks', cost: 7, dueDay: 16, location: 'pot', ownerId: 'me', payee: '', payeeSharePercent: 100, category: 'Banking', isStandingOrder: true },
  { id: 'ws', name: 'Windscribe', cost: 7.03, dueDay: 19, location: 'pot', ownerId: 'me', payee: '', payeeSharePercent: 100, category: 'Internet', isStandingOrder: true },
] as unknown as Bill[]
const potLoan = { id: 'monzo', name: 'Monzo', firstPaymentDate: '2027-01-01', totalAmount: 10050, monthlyPayment: 195, location: 'pot', ownerId: 'me', payee: '', payeeSharePercent: 100, calibratedMonthlyRate: 0.005125641332341951 } as unknown as Loan

// ---- THE BASELINE: the deposit and nothing else ----
check(
  'BASELINE: personal bills are the pot DEPOSIT only — the items it pays add nothing on top',
  personalBillsTotal([deposit, ...potBills] as never, 'me'),
  256.03,
)
check(
  'BASELINE: adding four more pot-funded bills does not move it (no double count)',
  personalBillsTotal([deposit, ...potBills, ...potBills] as never, 'me'),
  256.03,
)

// ---- THE IMPACT: clearing the pot-funded loan frees its payment ----
const data = { people, loans: [potLoan], bills: [deposit, ...potBills], creditCards: [], savingsPots: [], transactions: [] } as unknown as AppData
const clear = { id: 's', name: 'Clear it', includeInCumulative: true,
  actions: [{ id: 'a', type: 'pay_off_loan', label: '', value: 10050, targets: [{ kind: 'loan', id: 'monzo' }], date: TODAY }] } as unknown as Scenario
const r = calculateScenarioImpact(clear, data, 'me', 1000)
check('IMPACT: clearing a pot-funded loan frees its FULL monthly payment', r.monthlyImpact, 195)
check('IMPACT: ...and the baseline handed in is untouched by it', r.monthlyAvailableBefore, 1000)
check('IMPACT: available after is the baseline plus the freed payment', r.monthlyAvailableAfter, 1195)

// ---- CONTROL: a PERSONAL loan is unaffected by any of this ----
const personalLoan = { ...potLoan, id: 'p', location: 'personal' } as unknown as Loan
const pr = calculateScenarioImpact(
  { ...clear, actions: [{ ...(clear as unknown as { actions: Record<string, unknown>[] }).actions[0], targets: [{ kind: 'loan', id: 'p' }] }] } as unknown as Scenario,
  { ...data, loans: [personalLoan] } as unknown as AppData, 'me', 1000)
check('CONTROL: a personal loan still frees its full payment', pr.monthlyImpact, 195)

// ---- CONTROL: a JOINT loan still splits, and is not swept into "personal" ----
const jointLoan = { ...potLoan, id: 'j', location: 'joint', ownerId: '', payee: 'me', payeeSharePercent: 50 } as unknown as Loan
const jr = calculateScenarioImpact(
  { ...clear, actions: [{ ...(clear as unknown as { actions: Record<string, unknown>[] }).actions[0], targets: [{ kind: 'loan', id: 'j' }] }] } as unknown as Scenario,
  { ...data, loans: [jointLoan], people: [...people, { id: 'them', name: 'Them', salary: 30000, payFrequency: 'monthly', payDayOfMonth: 25, sharePercent: 100 }] } as unknown as AppData, 'me', 1000)
check('CONTROL: a joint loan still frees only the payer\'s share', jr.monthlyImpact, 97.5)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
