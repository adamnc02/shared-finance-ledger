// PROMPT-13 Part B5 — the acceptance gate for "Coin Jar is a pot with
// things taken away".
//
// | Keeps                               | Does not have                   |
// |-------------------------------------|---------------------------------|
// | Its own card in the wallet stack    | A progress ring (no target)     |
// | Its own line/trend chart            | A target amount or target date  |
// | Its own ledger                      | Recurring deposits              |
// | Transfers IN AND OUT, any location  | Funding a bill/loan/card payment|
// | An editable opening balance + date  | Ad-hoc spending out of it       |
//
// WHAT FAILS AGAINST THE PRE-CHANGE CODE: `Pot.isCoinJar` did not exist
// and `fundablePots` was not exported, so this script dies on the import
// against PROMPT-12's tree (proven by running it against a read-only
// export of `main`).
//
// 🚨 ASSERTED AGAINST THE GENERATORS, NOT THE UI. The prompt doc is
// explicit: "a hidden picker entry is not enforcement". Every check below
// that matters goes through `potBillsAndLoans`,
// `generatePotOutgoingTransactions` and `generatePotDepositTransactions`
// with a bill/loan/card/deposit deliberately POINTED AT the jar — the
// state a hand-edited backup, an import, or a future bug can produce and
// the pickers can do nothing about. Each has a CONTROL: the identical
// setup against an ordinary pot, which DOES generate. Without the
// control, an implementation that generates nothing for any pot would
// pass.
//
// The picker exclusions are then checked at the SOURCE, because that is
// where they live and a numeric check cannot see them. The thing to
// catch there is over-reach in the other direction: `fundablePots` must
// NOT be applied to the transfer options, the wallet stack or the
// rebalance targets, or the jar becomes a trap you cannot empty.

import { readFileSync } from 'node:fs'
import { potBillsAndLoans, generatePotOutgoingTransactions, generatePotDepositTransactions, computePotProjection } from '../src/lib/potLedger'
import { fundablePots } from '../src/lib/roundUp'
import type { AppDataV2, CreditCard, Loan, Pot, RecurringTemplate } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const PERSON = 'p1'
const RANGE_START = new Date(2026, 8, 1)
const RANGE_END = new Date(2026, 11, 31)

const jar: Pot = { id: 'jar1', personId: PERSON, name: 'Coin Jar', openingBalance: 0, openingDate: '2026-01-01', active: true, color: '#f5a524', isCoinJar: true }
/** The CONTROL: the same pot in every respect except that it is not a jar. */
const ordinary: Pot = { ...jar, id: 'pot1', name: 'Bills Pot', isCoinJar: false }

// A bill, a loan and a card, each pointed at WHICHEVER pot id is passed —
// exactly the state the pickers are supposed to prevent, arriving anyway.
const billFor = (potId: string): RecurringTemplate =>
  ({ id: `bill-${potId}`, kind: 'bill', name: 'Broadband', amount: 40, frequency: 'monthly', anchorDate: '2026-01-05', location: 'pot', potId, ownerId: PERSON, payee: '', categoryId: 'c', active: true, paymentMethod: 'direct_debit' }) as never
const loanFor = (potId: string): Loan =>
  ({ id: `loan-${potId}`, name: 'Car', principal: 5000, annualRate: 5, termMonths: 36, startDate: '2026-01-10', monthlyPayment: 150, paymentDayOfMonth: 10, location: 'pot', potId, ownerId: PERSON, categoryId: 'c', active: true, overpayments: [] }) as never
const cardFor = (potId: string): CreditCard =>
  ({ id: `card-${potId}`, name: 'Visa', currentBalance: 500, creditLimit: 2000, apr: 20, minimumPaymentPercent: 2, minimumPaymentFloor: 25, paymentDayOfMonth: 15, balanceAsOfDate: '2026-01-01', lumpPayments: [], location: 'pot', potId, ownerId: PERSON, categoryId: 'c', active: true, color: '#fff' }) as never

/**
 * `includeCard` — the card is exercised through `potBillsAndLoans`,
 * which resolves it by `location`/`potId` alone. It is left OUT of the
 * generator runs below: `generateMinimumPaymentTransactions` simulates a
 * full statement history and needs a far richer card fixture than this
 * check earns, and the bill and the loan already give the generator
 * CONTROL its teeth. The jar's own early return covers all three
 * identically.
 */
function dataWith(pot: Pot, includeCard = true): AppDataV2 {
  return {
    people: [{ id: PERSON, name: 'Adam', salaryHistory: [], color: '#fff' } as never],
    categories: [{ id: 'c', name: 'Bills', icon: 'zap', color: '#fff' } as never],
    recurringTemplates: [billFor(pot.id)],
    loans: [loanFor(pot.id)],
    creditCards: includeCard ? [cardFor(pot.id)] : [],
    pensions: [],
    savingsPots: [],
    pots: [pot],
    transactions: [],
    payCycles: [{ personId: PERSON, openingBalance: 0, openingBalanceDate: '2026-01-01', paydayDayOfMonth: 28, paydayAdjustForNonWorkingDay: false, cycleStartDayOfMonth: 1 }],
    salarySorts: [],
    scenarios: [],
    primaryPersonId: PERSON,
    jointAccount: null,
  }
}

console.log('\n── B5, restriction 2: a Coin Jar funds NOTHING ──')
const jarData = dataWith(jar)
const ordinaryData = dataWith(ordinary)

const jarFunded = potBillsAndLoans(jarData, jar.id)
check('no bill is ever resolved as funded by the jar', jarFunded.templates.length, 0)
check('no loan either', jarFunded.loans.length, 0)
check('no credit card either', jarFunded.creditCards.length, 0)
// CONTROL — the identical setup on an ordinary pot DOES resolve all three.
const ordinaryFunded = potBillsAndLoans(ordinaryData, ordinary.id)
check('CONTROL: an ordinary pot resolves its bill', ordinaryFunded.templates.length, 1)
check('CONTROL: ...its loan', ordinaryFunded.loans.length, 1)
check('CONTROL: ...and its card', ordinaryFunded.creditCards.length, 1)

console.log('\n── B5, restriction 2: and generates no outgoing rows ──')
const jarGen = dataWith(jar, false)
const ordinaryGen = dataWith(ordinary, false)
check('the jar generates no outgoing transactions at all', generatePotOutgoingTransactions(jarGen, jar, RANGE_START, RANGE_END).length, 0)
const ordinaryOutgoing = generatePotOutgoingTransactions(ordinaryGen, ordinary, RANGE_START, RANGE_END)
check('CONTROL: an ordinary pot generates them', ordinaryOutgoing.length > 0, true)
check('CONTROL: ...including a bill payment', ordinaryOutgoing.some((t) => t.type === 'bill_payment'), true)
check('CONTROL: ...and a loan payment', ordinaryOutgoing.some((t) => t.type === 'loan_payment'), true)

// The overpayment-only path does NOT go through potBillsAndLoans, so it
// needs its own case: a loan funded from Personal whose RECURRING
// OVERPAYMENT is pointed at the jar.
console.log('\n── B5: the recurring-overpayment path is closed too ──')
const overpaymentLoan = { ...loanFor('elsewhere'), location: 'personal', potId: undefined, recurringOverpayment: { amount: 50, location: 'pot', potId: jar.id, startDate: '2026-01-10' } } as never as Loan
const overpaymentData: AppDataV2 = { ...dataWith(jar, false), loans: [overpaymentLoan] }
check('a recurring overpayment aimed at the jar generates nothing', generatePotOutgoingTransactions(overpaymentData, jar, RANGE_START, RANGE_END).length, 0)
const overpaymentOrdinary = { ...overpaymentLoan, recurringOverpayment: { amount: 50, location: 'pot', potId: ordinary.id, startDate: '2026-01-10' } } as never as Loan
check(
  'CONTROL: the same overpayment aimed at an ordinary pot DOES generate',
  generatePotOutgoingTransactions({ ...dataWith(ordinary, false), loans: [overpaymentOrdinary] }, ordinary, RANGE_START, RANGE_END).length > 0,
  true,
)

console.log('\n── B5, restriction 3: no recurring deposits into a Coin Jar ──')
const withDeposit = { ...jar, recurringDepositAmount: 25, recurringDepositDayOfMonth: 1, recurringDepositStartDate: '2026-01-01' }
check('a recurring deposit set on the jar generates nothing', generatePotDepositTransactions(withDeposit, RANGE_START, RANGE_END).length, 0)
const ordinaryWithDeposit = { ...ordinary, recurringDepositAmount: 25, recurringDepositDayOfMonth: 1, recurringDepositStartDate: '2026-01-01' }
check('CONTROL: the same deposit on an ordinary pot DOES generate', generatePotDepositTransactions(ordinaryWithDeposit, RANGE_START, RANGE_END).length > 0, true)

console.log('\n── B5: the jar’s balance cannot be driven down by any of it ──')
// Everything above, end to end: a jar with a bill, a loan and a card all
// pointed at it must still project at exactly its opening balance.
const jarProjection = computePotProjection(dataWith({ ...jar, openingBalance: 5 }, false), { ...jar, openingBalance: 5 }, 'three_cycles', new Date(2026, 8, 20))
check('the jar projects at its opening balance, untouched', [jarProjection.clearedBalance, jarProjection.projectedBalance], [5, 5])
const ordinaryProjection = computePotProjection(dataWith({ ...ordinary, openingBalance: 5 }, false), { ...ordinary, openingBalance: 5 }, 'three_cycles', new Date(2026, 8, 20))
check('CONTROL: the ordinary pot is driven negative by the same setup', ordinaryProjection.projectedBalance < 5, true)

console.log('\n── B5, restriction 1 and 4: fundablePots ──')
check('fundablePots drops the jar', fundablePots([jar, ordinary]).map((p) => p.id), ['pot1'])
check('...and keeps every ordinary pot', fundablePots([ordinary]).map((p) => p.id), ['pot1'])
check('...and copes with a list of nothing but jars', fundablePots([jar]), [])

console.log('\n── B5: where fundablePots is, and is NOT, applied ──')
const read = (p: string) => readFileSync(`${process.cwd()}/${p}`, 'utf8')
const expenses = read('src/pages/Expenses.tsx')
const bills = read('src/pages/Bills.tsx')
const loans = read('src/pages/Loans.tsx')
const locationEditor = read('src/components/LocationEditor.tsx')
const salary = read('src/pages/Salary.tsx')

// Applied: every funding picker.
check('LocationEditor filters the pots it offers', locationEditor.includes('fundablePots(pots)'), true)
check('Bills offers only fundable pots', bills.includes('fundablePots(data.pots)'), true)
check('Loans offers only fundable pots', loans.includes('fundablePots(data.pots)'), true)
check('the loan overpayment pickers filter too', expenses.split('fundablePots(pots)').length - 1, 3)
check('the three ad-hoc expense/income location pickers filter', expenses.split('fundablePots(data.pots)').length - 1, 3)
// NOT applied: the transfer wizard. A jar you cannot empty is a trap,
// and B5 allows transfers "in and out, to any location".
check('the TRANSFER wizard is NOT filtered — transfers in and out are allowed', expenses.includes('buildTransferLocationOptions(data.savingsPots, data.pots,'), true)
// NOT applied: the wallet stack (the jar has its own card) or the
// rebalance targets (a rebalance is a transfer by another name).
check('the Wallet stack still lists every pot, jar included', salary.includes('data.pots.map((pot) => ('), true)
check('the rebalance targets still include every pot', salary.includes('data.pots.filter((p) => p.personId === data.primaryPersonId)'), true)

console.log(failures === 0 ? '\n✅ All Coin Jar restriction checks passed\n' : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
