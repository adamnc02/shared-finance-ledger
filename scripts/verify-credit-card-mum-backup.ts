// PROMPT-01 — the acceptance gate for the "stranded residual balance" fix
// (mechanism 6 in APP-KNOWLEDGE.md §2), asserted against Adam's mum's REAL
// backup file with both cards COMPLETELY UNTOUCHED — no statement window
// added, her manual override left in place. That is the whole point: the
// root fix works on her data exactly as it stands, so nothing had to be
// stripped, rebuilt or doctored.
//
// THE SYMPTOM. Her Santander showed only a past payment row: £91.24 she
// genuinely owes (confirmed with her directly, 2026-09-16) had no future
// due row, so it could never be seen or cleared. Her Natwest failed more
// quietly — it lost exactly one £200 instalment, ending its schedule still
// owing £200 with no row to pay it. Same bug, two presentations.
//
// THE PRIMARY ASSERTION IS RECONCILIATION, NOT "DOES A ROW APPEAR".
// `sum(pending charges) === balance owed` catches every variant of this
// bug including the quiet Natwest one, which looked plausible enough to
// pass two rounds of review. It is a reusable helper here deliberately —
// it is the check that should have existed all along.
//
// DATE-PINNED at asOf = 15 September 2026. The BALANCES are date-stable
// (her latest transaction is 2026-09-15, so nothing moves after it); the
// SCHEDULES are not — run this in November and the 14 Oct charge will have
// materialised and the rows will have shifted. Pinning asOf is what makes
// this definitive whenever it runs.
import { readFileSync } from 'node:fs'
import { cardBalanceAsOf, withLiveBalance, buildCreditCardMinimumChargeRows, buildCreditCardDueOverviewRows } from '../src/lib/creditCards'
import type { CreditCard, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

/**
 * THE reusable invariant. Every pending minimum charge the card will ever
 * generate must, summed, come to exactly what is owed today — no more (the
 * balance was double-counted somewhere) and no less (a residual is
 * stranded with no row to pay it). Independent of dates, card shape,
 * minimum type, window and override, which is why it catches variants that
 * a "is there a row on 14 Oct" assertion sails straight past.
 */
function checkReconciles(label: string, card: CreditCard, transactions: Transaction[], asOf: Date) {
  const live = cardBalanceAsOf(card, transactions, asOf)
  const pending = buildCreditCardMinimumChargeRows(card, transactions, asOf).filter((r) => r.status === 'pending')
  const sum = Math.round(pending.reduce((s, r) => s + r.amount, 0) * 100) / 100
  const ok = Math.abs(sum - live) < 0.005
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — sum(pending) === live balance: £${sum.toFixed(2)} vs £${live.toFixed(2)}`)
  if (!ok) failures++
  return { live, pending, sum }
}

const BACKUP = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-15-mum.json'
const raw = JSON.parse(readFileSync(BACKUP, 'utf8'))
const txns: Transaction[] = raw.transactions
// `lumpPayments` is absent on both of her cards — it predates the field.
// The app's own restore path normalises this; do the same here so the
// fixture matches what the running app actually holds.
const cardOf = (id: string): CreditCard => {
  const c = (raw.creditCards as CreditCard[]).find((x) => x.id === id)
  if (!c) throw new Error(`card ${id} missing from backup`)
  return { ...c, lumpPayments: c.lumpPayments ?? [] }
}
const asOf = new Date(2026, 8, 15)

// ---------------------------------------------------------------------
// SANTANDER — anchor £0 @ 2026-08-17, minimum 100% of balance, APR 0%,
// payDay 14, NO statement window, override [{2026-09-14, £228.07}],
// 12 spend rows totalling £319.31, one cleared payment 2026-09-14 £228.07.
//
// Both Part A triggers at once: no window AND a manual override dated at
// rangeStart. Before the fix this produced the 14 Sept cleared row and
// NOTHING ELSE.
// ---------------------------------------------------------------------
console.log('\n--- Santander (lhF0fbR8) — no window + manual override ---')
const santander = cardOf('lhF0fbR8')
check('cardBalanceAsOf is the £91.24 genuinely owed', cardBalanceAsOf(santander, txns, asOf), 91.24)
check('withLiveBalance.currentBalance agrees', withLiveBalance(santander, txns, asOf).currentBalance, 91.24)
const sRows = buildCreditCardMinimumChargeRows(santander, txns, asOf)
const sPending = sRows.filter((r) => r.status === 'pending')
check('exactly one pending charge', sPending.length, 1)
check('that charge is dated 2026-10-14', sPending[0]?.date, '2026-10-14')
check('that charge is £91.24', sPending[0]?.amount, 91.24)
// projectedBalanceDue is the balance BEFORE this cycle's own deduction, so
// a 100% minimum of £91.24 against £91.24 leaves exactly £0.00 after it.
check('balance after it is £0.00', Math.round((sPending[0]!.projectedBalanceDue - sPending[0]!.amount) * 100) / 100, 0)
// A2 — her override applied only to the cycle it was created for. That
// cycle now has a real cleared payment, so the override is abandoned, not
// re-applied; what actually happened is simply the payment, treated as an
// ordinary partial overpayment, with the residue carrying forward.
check('A2: the £228.07 override is NOT re-applied as a second charge', sRows.filter((r) => r.amount === 228.07 && r.status === 'pending').length, 0)
check('the 14 Sept payment stays in the ledger as cleared history', sRows.filter((r) => r.date === '2026-09-14' && r.status === 'cleared').length, 1)
checkReconciles('Santander', santander, txns, asOf)

// ---------------------------------------------------------------------
// NATWEST — anchor £1600 @ 2026-08-23, minimum FIXED £200, APR 0%,
// payDay 14, no window, no override, 0 spend rows, one cleared payment
// 2026-09-14 £200. Before the fix: 6 pending (£1200) ending 2027-03-14
// still reading projectedBalanceDue = 200, with no row to pay it.
// ---------------------------------------------------------------------
console.log('\n--- Natwest (M2Ak3QNc) — no window, fixed minimum ---')
const natwest = cardOf('M2Ak3QNc')
check('cardBalanceAsOf is £1400', cardBalanceAsOf(natwest, txns, asOf), 1400)
const nPending = buildCreditCardMinimumChargeRows(natwest, txns, asOf).filter((r) => r.status === 'pending')
check('exactly 7 pending charges (was 6 — the bug)', nPending.length, 7)
check('the schedule runs Oct 2026 → Apr 2027', nPending.map((r) => r.date), [
  '2026-10-14', '2026-11-14', '2026-12-14', '2027-01-14', '2027-02-14', '2027-03-14', '2027-04-14',
])
check('every charge is £200', [...new Set(nPending.map((r) => r.amount))], [200])
check('the final charge leaves £0.00', Math.round((nPending[6]!.projectedBalanceDue - nPending[6]!.amount) * 100) / 100, 0)
checkReconciles('Natwest', natwest, txns, asOf)

// ---------------------------------------------------------------------
// THE WINDOW × OVERRIDE MATRIX — the four shapes from PROMPT-01. £150 of
// spend, only £100 paid on the 14th, so £50 must carry forward. Three of
// these four stranded it before the fix; the windowed/no-override cell was
// the one already-correct reference. All four must now agree with it.
// ---------------------------------------------------------------------
console.log('\n--- window × override matrix (£150 spend, £100 paid, £50 must carry) ---')
const baseCard = {
  id: 'c1', name: 'Matrix', categoryId: 'category-credit-card', color: '#000000',
  interestRatePercent: 0, currentBalance: 0, balanceAsOfDate: '2026-08-01',
  minimumPayment: { type: 'percent_of_balance', percent: 100 },
  paymentDayOfMonth: 14, ownerId: 'p1', active: true, lumpPayments: [],
} as unknown as CreditCard
const matrixTxns: Transaction[] = [
  { id: 't1', date: '2026-09-10', amount: 150, direction: 'out', categoryId: 'category-credit-card', paymentMethod: 'card', status: 'cleared', type: 'credit_card_spend', location: 'personal', ownerId: 'p1', creditCardId: 'c1' } as Transaction,
  { id: 't2', date: '2026-09-14', amount: 100, direction: 'out', categoryId: 'category-credit-card', paymentMethod: 'direct_debit', status: 'cleared', type: 'credit_card_payment', location: 'personal', ownerId: 'p1', creditCardId: 'c1' } as Transaction,
]
for (const win of [false, true]) {
  for (const ovr of [false, true]) {
    const card = {
      ...baseCard,
      ...(win ? { statementStartDay: 19, statementEndDay: 18 } : {}),
      ...(ovr ? { minimumPaymentOverrides: [{ date: '2026-09-14', amount: 100 }] } : {}),
    } as CreditCard
    const label = `window=${win ? '19→18' : 'none'} override=${ovr ? 'yes' : 'no'}`
    const { pending } = checkReconciles(label, card, matrixTxns, asOf)
    check(`  ${label}: the £50 carries to 2026-10-14`, pending.map((r) => `${r.date}/${r.amount}`), ['2026-10-14/50'])
  }
}

// ---------------------------------------------------------------------
// THE PERCENT-CARD UNDERSTATEMENT. A 5% card with £150 of spend and a £5
// payment truly owes £145. Before the fix a no-window card quoted the next
// charge off a balance with the £5 counted twice (£6.89); the correct
// figure, which a windowed card already produced, is £7.25.
// ---------------------------------------------------------------------
console.log('\n--- 5% card: the understated next charge ---')
const pctTxns: Transaction[] = [
  { id: 'p1', date: '2026-09-10', amount: 150, direction: 'out', categoryId: 'category-credit-card', paymentMethod: 'card', status: 'cleared', type: 'credit_card_spend', location: 'personal', ownerId: 'p1', creditCardId: 'c1' } as Transaction,
  { id: 'p2', date: '2026-09-14', amount: 5, direction: 'out', categoryId: 'category-credit-card', paymentMethod: 'direct_debit', status: 'cleared', type: 'credit_card_payment', location: 'personal', ownerId: 'p1', creditCardId: 'c1' } as Transaction,
]
for (const win of [false, true]) {
  const card = { ...baseCard, minimumPayment: { type: 'percent_of_balance', percent: 5 }, ...(win ? { statementStartDay: 19, statementEndDay: 18 } : {}) } as CreditCard
  const next = buildCreditCardMinimumChargeRows(card, pctTxns, asOf).filter((r) => r.status === 'pending')[0]
  check(`${win ? 'windowed' : 'no-window'} 5% card: next charge is the correct £7.25, not £6.89`, next?.amount, 7.25)
}

// ---------------------------------------------------------------------
// SEASON INDEPENDENCE. The defect hid behind an accidental one-hour BST
// offset and would have surfaced unaided at the 25 October GMT changeover.
// The same scenario dated in December (GMT) must behave identically to the
// September (BST) run — if this fails, a date boundary is being compared
// as a wall-clock instant somewhere rather than as an ISO date.
// ---------------------------------------------------------------------
console.log('\n--- season independence (BST vs GMT) ---')
const decTxns: Transaction[] = [
  { id: 'd1', date: '2026-12-10', amount: 150, direction: 'out', categoryId: 'category-credit-card', paymentMethod: 'card', status: 'cleared', type: 'credit_card_spend', location: 'personal', ownerId: 'p1', creditCardId: 'c1' } as Transaction,
  { id: 'd2', date: '2026-12-14', amount: 100, direction: 'out', categoryId: 'category-credit-card', paymentMethod: 'direct_debit', status: 'cleared', type: 'credit_card_payment', location: 'personal', ownerId: 'p1', creditCardId: 'c1' } as Transaction,
]
const decCard = { ...baseCard, balanceAsOfDate: '2026-11-01' } as CreditCard
const decPending = buildCreditCardMinimumChargeRows(decCard, decTxns, new Date(2026, 11, 15)).filter((r) => r.status === 'pending')
check('December (GMT) behaves exactly as September (BST)', decPending.map((r) => `${r.date}/${r.amount}`), ['2027-01-14/50'])

// ---------------------------------------------------------------------
// EVERY ROW ANSWERS ONE QUESTION: what was owed GOING INTO this due date.
// Found in UAT 2026-09-16 — a materialized row used to report
// cardBalanceAsOf (the balance AFTER its own payment) while generated rows
// report the balance BEFORE theirs, so Natwest showed "£1,400 balance due"
// against BOTH 14 Sept and 14 Oct, the same number meaning two different
// things, hiding the £1,600 genuinely owed on 14 Sept.
// ---------------------------------------------------------------------
console.log('\n--- one convention: what was owed going into each due date ---')
const nDue = buildCreditCardDueOverviewRows(natwest, txns, asOf)
check('Natwest reads as a clean descending schedule, 14 Sept included', nDue.slice(0, 5).map((r) => r.balanceDue), [1600, 1400, 1200, 1000, 800])
check('the 14 Sept row is £1600 owed going in, NOT the £1400 left after', nDue[0]?.balanceDue, 1600)
check('...and it is flagged past, so it carries no Clear button', nDue[0]?.isPast, true)
const sDue = buildCreditCardDueOverviewRows(santander, txns, asOf)
check('Santander 14 Sept is the £319.31 owed before her £228.07 payment', sDue[0]?.balanceDue, 319.31)
check('...leaving the £91.24 that carries to 14 Oct', sDue[1]?.balanceDue, 91.24)
check('319.31 − 228.07 === 91.24 — the rows reconcile against the real payment', Math.round((sDue[0]!.balanceDue - 228.07) * 100) / 100, sDue[1]?.balanceDue)

console.log(`\n${failures === 0 ? '✓ ALL CHECKS PASSED' : `✗ ${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
