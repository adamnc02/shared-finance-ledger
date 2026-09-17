import { newPot, potBalanceAsOf, generatePotDepositTransactions, generatePotOutgoingTransactions, potDepositOccurrencePreviews, setPausedPotDeposits, scheduledPotDepositDates, potBillsAndLoans } from '../src/lib/potLedger'
import { reassignTransactionsForLocationChange } from '../src/lib/locationChange'
import { generateLoanPaymentTransactions, applyLoanOverpayment, settleLoan } from '../src/lib/ledgerLoans'
import { generateTransactionsForTemplate } from '../src/lib/schedule'
import { computeProjection } from '../src/lib/projection'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { defaultPayCycleConfig } from '../src/lib/ledgerStorage'
import { reconcilePersonReferences } from '../src/lib/household'
import type { AppDataV2, Loan, Person, Pot, RecurringTemplate, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const pot: Pot = { ...newPot({ personId: 'me', name: 'Bills', openingBalance: 500, openingDate: '2026-01-01' }), id: 'pot-1' }

// ---- 1. Balance derivation — deposits add, withdrawals AND pot-funded bill/loan payments subtract, pre-openingDate ignored ----
const activity: Transaction[] = [
  { id: 't0', date: '2025-12-01', amount: 9999, direction: 'out', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'pot_deposit', location: 'personal', ownerId: 'me', potId: 'pot-1' },
  { id: 't1', date: '2026-01-05', amount: 300, direction: 'out', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'pot_deposit', location: 'personal', ownerId: 'me', potId: 'pot-1' },
  { id: 't2', date: '2026-01-10', amount: 100, direction: 'out', categoryId: 'category-bills', paymentMethod: 'direct_debit', status: 'cleared', type: 'bill_payment', location: 'pot', ownerId: 'me', potId: 'pot-1', sourceType: 'recurring_template', sourceId: 'bill-1' },
  { id: 't3', date: '2026-01-12', amount: 50, direction: 'in', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'pot_withdrawal', location: 'personal', ownerId: 'me', potId: 'pot-1' },
]
check('A transaction dated BEFORE openingDate is ignored entirely', potBalanceAsOf(pot, [activity[0]], new Date('2026-01-01')), 500)
check('Opening balance + one deposit', potBalanceAsOf(pot, activity, new Date('2026-01-05')), 800)
check('...- a pot-funded bill payment (purely internal, still reduces the pot)', potBalanceAsOf(pot, activity, new Date('2026-01-10')), 700)
check('...- a withdrawal too', potBalanceAsOf(pot, activity, new Date('2026-01-12')), 650)

// ---- 2. Recurring deposits — monthly walker, pause/unpause (same mechanism as SavingsPot) ----
const depositPot: Pot = { ...pot, id: 'pot-dep', recurringDepositAmount: 150, recurringDepositDayOfMonth: 15, recurringDepositStartDate: '2026-01-15' }
const previews = potDepositOccurrencePreviews(depositPot, new Date('2026-01-01'), 3)
check('Next 3 recurring deposits land on the 15th of each month', previews.map((p) => p.date), ['2026-01-15', '2026-02-15', '2026-03-15'])

const window = scheduledPotDepositDates(depositPot, new Date('2026-01-01'), new Date('2026-06-01'))
const paused = { ...depositPot, ...setPausedPotDeposits(depositPot, window, ['2026-03-15', '2026-04-15']) }
check('Pausing March+April skips exactly those two', generatePotDepositTransactions(paused, new Date('2026-01-01'), new Date('2026-06-01')).map((t) => t.date), [
  '2026-01-15',
  '2026-02-15',
  '2026-05-15',
])
check('Every generated deposit is tagged pot_deposit, personal, with potId', generatePotDepositTransactions(depositPot, new Date('2026-01-01'), new Date('2026-02-01')).every((t) => t.type === 'pot_deposit' && t.location === 'personal' && t.potId === 'pot-dep'), true)

// ---- 3. Bill folding — a pot-located bill generates via the SAME schedule.ts generator, just routed by location ----
const potBill: RecurringTemplate = {
  id: 'bill-pot',
  name: 'Council Tax',
  amount: 120,
  categoryId: 'category-bills',
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-01-01',
  location: 'pot',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  potId: 'pot-1',
  active: true,
}
const billOccs = generateTransactionsForTemplate(potBill, new Date('2026-01-01'), new Date('2026-03-01'))
check('A pot-located bill still generates bill_payment occurrences via schedule.ts', billOccs.length, 3)
check('...tagged location: pot + potId, not personal', billOccs.every((t) => t.location === 'pot' && t.potId === 'pot-1'), true)

const dataWithPotBill: AppDataV2 = {
  primaryPersonId: 'me',
  people: [{ id: 'me', name: 'Me', color: '#fff', salaryHistory: [], salaryOverrides: [] } as unknown as Person],
  categories: [],
  recurringTemplates: [potBill],
  loans: [],
  creditCards: [],
  pensions: [],
  savingsPots: [],
  pots: [pot],
  transactions: [],
  payCycles: [defaultPayCycleConfig('me')],
  scenarios: [],
  jointAccount: null,
}
check('potBillsAndLoans derives membership from the bill\'s own potId (not stored on the Pot)', potBillsAndLoans(dataWithPotBill, 'pot-1').templates.map((t) => t.id), ['bill-pot'])
const outgoing = generatePotOutgoingTransactions(dataWithPotBill, pot, new Date('2026-01-01'), new Date('2026-03-01'))
check('generatePotOutgoingTransactions returns exactly the pot-located bill\'s occurrences', outgoing.length, 3)

// ---- 4. Loan folding — regular payment vs recurring overpayment can independently resolve to different locations ----
const baseLoan: Loan = {
  id: 'loan-1',
  name: 'Car finance',
  monthlyPayment: 200,
  termMonths: 36,
  startDate: '2026-01-01',
  categoryId: 'category-bills',
  location: 'pot',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  potId: 'pot-1',
  overpayments: [],
  principal: 7200,
  active: true,
}
const loanOccs = generateLoanPaymentTransactions(baseLoan, new Date('2026-01-01'), new Date('2026-02-01'))
check('A pot-located loan\'s regular payment carries location: pot + the loan\'s own potId', loanOccs.every((t) => t.location === 'pot' && t.potId === 'pot-1'), true)

// A personal loan whose RECURRING OVERPAYMENT is independently pot-funded.
const overpaidLoan: Loan = {
  ...baseLoan,
  id: 'loan-2',
  location: 'personal',
  potId: undefined,
  recurringOverpayment: { startDate: '2026-01-01', amount: { type: 'fixed', amount: 50 }, location: 'pot', potId: 'pot-1' },
}
const overpaidOccs = generateLoanPaymentTransactions(overpaidLoan, new Date('2026-01-01'), new Date('2026-02-15'))
const regularRow = overpaidOccs.find((t) => t.sourceType === 'loan')
const overpaymentRow = overpaidOccs.find((t) => t.sourceType === 'loan_recurring_overpayment')
check('The loan\'s own regular payment stays personal (its own location is unchanged)', regularRow?.location, 'personal')
check('...but its recurring overpayment independently resolves to the pot it was configured against', overpaymentRow?.location, 'pot')
check('...and carries that pot\'s id', overpaymentRow?.potId, 'pot-1')

const dataWithOverpaidLoan: AppDataV2 = { ...dataWithPotBill, recurringTemplates: [], loans: [overpaidLoan] }
const potOutgoingForOverpayment = generatePotOutgoingTransactions(dataWithOverpaidLoan, pot, new Date('2026-01-01'), new Date('2026-02-15'))
check('generatePotOutgoingTransactions picks up a pot-funded recurring overpayment even though the LOAN itself is personal-located', potOutgoingForOverpayment.some((t) => t.sourceType === 'loan_recurring_overpayment'), true)
check('...and does NOT pick up the loan\'s own regular (personal) payment', potOutgoingForOverpayment.some((t) => t.sourceType === 'loan'), false)

// ---- 5. Lump sums and settlements are NEVER pot-funded, even when the loan's own location is 'pot' ----
const { transaction: overpaymentTxn } = applyLoanOverpayment(baseLoan, 500, '2026-01-20')
check('A one-off lump overpayment on a pot-located loan falls back to personal, never pot', overpaymentTxn.location, 'personal')
check('...and carries no potId', overpaymentTxn.potId, undefined)

const { transaction: settlementTxn } = settleLoan(baseLoan, 4000, '2026-01-20')
check('A settlement on a pot-located loan also falls back to personal', settlementTxn.location, 'personal')

// A JOINT loan's recurring overpayment ignores an explicit pot override entirely — never split-corrupting.
const jointLoan: Loan = { ...baseLoan, id: 'loan-joint', location: 'joint', potId: undefined, payee: 'them', payeeSharePercent: 50, recurringOverpayment: { startDate: '2026-01-01', amount: { type: 'fixed', amount: 50 }, location: 'pot', potId: 'pot-1' } }
const jointOccs = generateLoanPaymentTransactions(jointLoan, new Date('2026-01-01'), new Date('2026-02-15'))
check('A JOINT loan\'s recurring overpayment always follows the loan (stays joint), ignoring its own pot override', jointOccs.every((t) => t.location === 'joint'), true)

// ---- 6. computeProjection — pot deposits touch personal cash, pot-funded bill/loan payments never do ----
const payCycle = { ...defaultPayCycleConfig('me'), openingBalanceDate: '2026-01-01', openingBalance: 0 }
const projData: AppDataV2 = {
  ...dataWithPotBill,
  recurringTemplates: [potBill],
  loans: [baseLoan],
  pots: [{ ...pot, recurringDepositAmount: 400, recurringDepositDayOfMonth: 5, recurringDepositStartDate: '2026-01-05' }],
  payCycles: [payCycle],
}
const projection = computeProjection(projData, 'me', payCycle, 'three_cycles', new Date('2026-01-01'))
check('A pot deposit appears in the personal projection (it\'s a real cash-out event)', projection.transactions.some((t) => t.type === 'pot_deposit'), true)
check('A pot-funded bill payment does NOT appear in the personal projection (purely internal to the pot)', projection.transactions.some((t) => t.type === 'bill_payment' && t.location === 'pot'), false)
check('A pot-funded loan payment does NOT appear in the personal projection either', projection.transactions.some((t) => t.type === 'loan_payment' && t.location === 'pot'), false)

// ---- 7. autoClearDuePayments — materializes BOTH a due pot deposit AND a due pot-funded bill payment, independently of the personal per-person pass ----
const clearData: AppDataV2 = { ...projData }
const settled = autoClearDuePayments(clearData, new Date('2026-01-10'))
check('The due pot deposit (5 Jan) is materialized as a real, cleared transaction', settled.transactions.some((t) => t.type === 'pot_deposit' && t.status === 'cleared' && t.date === '2026-01-05'), true)
check('The due pot-funded bill payment (1 Jan) is also materialized and cleared', settled.transactions.some((t) => t.type === 'bill_payment' && t.location === 'pot' && t.status === 'cleared' && t.date === '2026-01-01'), true)
check('Re-settling the same date is idempotent (no duplicate rows)', settled.transactions.filter((t) => t.type === 'bill_payment' && t.date === '2026-01-01').length, 1)
const resettled2 = autoClearDuePayments(settled, new Date('2026-01-10'))
check('...and produces the SAME data reference (a true no-op)', resettled2 === settled, true)

// ---- 8. Location change — retroactive rewrite, including cleared rows, respects the effective-date boundary ----
const preExisting: Transaction[] = [
  { id: 'x1', date: '2025-12-01', amount: 120, direction: 'out', categoryId: 'category-bills', paymentMethod: 'direct_debit', status: 'cleared', type: 'bill_payment', location: 'personal', ownerId: 'me', sourceType: 'recurring_template', sourceId: 'bill-x' },
  { id: 'x2', date: '2026-01-01', amount: 120, direction: 'out', categoryId: 'category-bills', paymentMethod: 'direct_debit', status: 'cleared', type: 'bill_payment', location: 'personal', ownerId: 'me', sourceType: 'recurring_template', sourceId: 'bill-x' },
  { id: 'x3', date: '2026-02-01', amount: 120, direction: 'out', categoryId: 'category-bills', paymentMethod: 'direct_debit', status: 'pending', type: 'bill_payment', location: 'personal', ownerId: 'me', sourceType: 'recurring_template', sourceId: 'bill-x' },
  { id: 'x4', date: '2026-01-15', amount: 30, direction: 'out', categoryId: 'category-misc', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'me' }, // unrelated row, must be untouched
]
const rewritten = reassignTransactionsForLocationChange(preExisting, 'recurring_template', 'bill-x', '2026-01-01', 'pot', 'pot-1')
check('A transaction dated BEFORE the effective date is untouched', rewritten.find((t) => t.id === 'x1')?.location, 'personal')
check('A CLEARED transaction dated on/after the effective date IS retroactively reassigned (per Adam\'s spec)', rewritten.find((t) => t.id === 'x2')?.location, 'pot')
check('...and picks up the new potId', rewritten.find((t) => t.id === 'x2')?.potId, 'pot-1')
check('A PENDING transaction on/after the effective date is reassigned too', rewritten.find((t) => t.id === 'x3')?.location, 'pot')
check('An unrelated transaction (different sourceId) is never touched', rewritten.find((t) => t.id === 'x4')?.location, 'personal')

// ---- 9. Person deletion self-heals a dangling potId (household.ts's reconcilePersonReferences) ----
const orphanBill: RecurringTemplate = { ...potBill, id: 'bill-orphan', ownerId: 'ghost' }
const dataWithGhostOwner: AppDataV2 = {
  ...dataWithPotBill,
  people: [{ id: 'me', name: 'Me', color: '#fff', salaryHistory: [], salaryOverrides: [] } as unknown as Person],
  recurringTemplates: [orphanBill],
  pots: [], // the pot itself no longer exists either — simulates a pot that was deleted without going through removePot
  primaryPersonId: 'me',
}
const reconciled = reconcilePersonReferences(dataWithGhostOwner)
check('A bill pointing at a pot that no longer exists falls back to personal (not left dangling)', reconciled.recurringTemplates[0].location, 'personal')
check('...and its potId is cleared', reconciled.recurringTemplates[0].potId, undefined)
check('...its ownerId is also reassigned to a valid person (existing reconciliation, unaffected by this change)', reconciled.recurringTemplates[0].ownerId, 'me')

console.log(failures === 0 ? '\nAll Pots checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
