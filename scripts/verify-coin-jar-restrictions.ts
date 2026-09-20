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
import { fundablePots, applyRoundUpChange, roundUpEnabledOn } from '../src/lib/roundUp'
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

// ── B4 (Adam, 2026-09-20) — WHERE the round-up toggle lives ───────────────
//
// It starts in the person's pay cycle settings, because the jar does not
// exist until the switch is first turned on and Adam did not want an
// always-visible jar for someone who has never used the feature: "this is a
// circular dependency". Once the jar is real the toggle MOVES to the jar's
// own expanded form. If the jar is ever deleted it moves BACK, and rounding
// switches off with it.
//
// 🚨 THE FAILURE THIS GUARDS AGAINST IS THE TOGGLE BECOMING UNREACHABLE.
// A Coin Jar is an ordinary Pot as far as SwipeToDelete is concerned — there
// is no isCoinJar special-case on deletion. If the toggle lived ONLY on the
// pot and the jar were deleted, there would be no way to turn rounding off
// or on again, and `roundUpEnabled` would sit at true while
// `coinJarForOwner` returned undefined and nothing rounded. Exactly one of
// the two homes must be showing it at any moment.
// ── B5, restriction 1 — the "What this pot pays" checklist ───────────────
//
// 🚨 REPORTED BY ADAM, 2026-09-20: the Coin Jar's expanded form was still
// showing this checklist, which is exactly what B5 says must be blocked.
//
// It was missed because it does NOT go through `fundablePots` like the
// other pickers — `potEligibleItems` builds its own list from the
// templates and loans directly. And it is the single most direct route in
// the app to pointing a bill or loan at a pot: one tap, no location flow.
//
// The generators would have refused to produce a payment anyway, so no
// money could ever have moved. That is arguably worse rather than better:
// the jar offered a checklist it would then silently ignore.
//
// Existing recurring transfers OUT of the jar still appear (locked,
// read-only) — B5 allows transfers "in and out, to any location", and
// those rows are not an assignment choice.
console.log('\n── B5: a Coin Jar offers nothing to tick ──')

const eligibleSrc = read('src/pages/Salary.tsx')
check('potEligibleItems offers no bills for a Coin Jar', eligibleSrc.includes('const eligibleTemplates = pot.isCoinJar'), true)
check('...and no loans either', eligibleSrc.includes('const eligibleLoans = pot.isCoinJar ? []'), true)
// The section itself is already gated on `items.length > 0`, so an empty
// list hides the whole "What this pot pays" block rather than showing an
// empty one. Pinned, because a future change to that gate would bring the
// heading back with nothing under it.
check('the checklist section is hidden entirely when there is nothing to list', eligibleSrc.includes('{items.length > 0 && ('), true)

console.log('\n── B4: the toggle has exactly one home, and it is never unreachable ──')

const salarySrc = read('src/pages/Salary.tsx')
const contextSrc = read('src/context/LedgerContext.tsx')

// Settings: shown only while there is NO jar.
check('the settings toggle is gated on the jar not existing', salarySrc.includes('{hasCoinJar ? ('), true)
check('...and hasCoinJar is computed from this person’s own pots', salarySrc.includes("data.pots.some((p) => p.isCoinJar && p.personId === person.id)"), true)
check('...with a pointer to where it went, rather than silence', salarySrc.includes('Round-ups are managed on the Coin Jar itself now'), true)

// Pot form: offered only for a Coin Jar.
check('the pot form’s toggle is offered only for a Coin Jar', salarySrc.includes('if (!pot.isCoinJar) return undefined'), true)
check('...and takes its effective-from through EffectiveDatedChangeFlow, like every other dated change', salarySrc.includes('onCommit={(effectiveFrom) => {\n          roundUp.onChange(choosingRoundUpFrom, effectiveFrom)'), true)
// The OWNER's switch and the OWNER's paydays — not the primary person's
// (§0b Q5). In a two-person household Ella's jar carries Ella's switch.
check('the pot form uses the JAR OWNER’s pay cycle, not the primary person’s', salarySrc.includes('data.payCycles.find((c) => c.personId === pot.personId)'), true)
check('...and the owner’s own paydays', salarySrc.includes('setRoundUp(pot.personId, enabled, effectiveFrom)'), true)

// Deleting the jar switches rounding off, so the reverted toggle tells the
// truth. Asserted in the context, which is where it has to happen.
check('deleting a Coin Jar switches that person’s round-ups off', contextSrc.includes("if (!pot?.isCoinJar) return next"), true)
check('...through applyRoundUpChange, so it is recorded like any other switch', /removePot[\s\S]{0,1400}applyRoundUpChange\(c, false, todayIso\(\)\)/.test(contextSrc), true)

console.log('\n── B4: deleting the jar, end to end ──')
// Behavioural, not just source: the pay cycle really does come back off,
// and the history records the window rather than losing it.
const jarOwnerCycle = {
  personId: PERSON, openingBalance: 0, openingBalanceDate: '2026-01-01', paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: false, cycleStartDayOfMonth: 1,
  roundUpEnabled: true, roundUpEffectiveFrom: '2026-03-01',
}
const afterDelete = { ...jarOwnerCycle, ...applyRoundUpChange(jarOwnerCycle, false, '2026-09-20') }
check('rounding is off after the jar is deleted', afterDelete.roundUpEnabled, false)
check('...so the toggle reverting to settings tells the truth', roundUpEnabledOn(afterDelete, '2026-09-21'), false)
// 🚨 B3 still holds: the window it WAS on for is preserved, so rows logged
// then still resolve as rounded and nothing stored is rewritten.
check('🚨 the window it was on for is preserved, not erased', roundUpEnabledOn(afterDelete, '2026-05-01'), true)
check('...and the history records that window with its start', afterDelete.roundUpHistory, [{ enabled: true, from: '2026-03-01', until: '2026-09-20', nextRuleFrom: '2026-09-20' }])

console.log(failures === 0 ? '\n✅ All Coin Jar restriction checks passed\n' : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
