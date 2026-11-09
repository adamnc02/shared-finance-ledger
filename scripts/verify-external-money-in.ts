// Money paid in from OUTSIDE the household straight onto a credit card or a
// savings pot (lib/outsideIncome.ts) — one-off and recurring.
//
// WHAT IT PREVENTS
// - A card payment by someone else being read as the MINIMUM payment made, or
//   sitting on the current account as money out. Both happen if it is stored
//   as a `credit_card_payment` with no sourceType (APP-KNOWLEDGE §1.15).
// - A recurring payment onto a card lowering the minimum only once each
//   occurrence has cleared: the minimum simulation sees future payments only
//   through card.lumpPayments / its `transactions`, so future occurrences must
//   be fed in (withCardCredits).
// - The same money counting on the current account as income.
//
// THE CONTROL that makes the card half meaningful: money from outside must
// give EXACTLY the minimums the same amount logged as a lump payment gives
// (it is an overpayment by someone else), and differ from no payment at all.
//
// Reads Adam's mum's real 2026-10-06 backup by absolute path (two cards, one
// with a statement window, one savings pot). Prints figures only, never a name.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { cardBalanceAsOf, generateMinimumPaymentTransactions, totalPaidForCard } from '../src/lib/creditCards'
import { savingsPotBalanceAsOf, generateSavingsDepositTransactions } from '../src/lib/savingsPotLedger'
import { computeProjection } from '../src/lib/projection'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { withCardCredits, isOutsideIncomeTemplate } from '../src/lib/outsideIncome'
import { removeCreditCardFromData, removeSavingsPotFromData } from '../src/lib/deleteReassign'
import { reconcilePersonReferences } from '../src/lib/household'
import type { AppDataV2, CreditCard, RecurringTemplate, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const round2 = (n: number) => Math.round(n * 100) / 100
const amounts = (rows: { amount: number }[]) => rows.map((r) => r.amount)

const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-10-06-mum.json', 'utf8'))
const base: AppDataV2 = migrateLedgerData(raw.data ?? raw)
const pid = base.primaryPersonId
const windowCard = base.creditCards.find((c) => c.statementEndDay != null)!
const plainCard: CreditCard = { ...base.creditCards.find((c) => c.statementEndDay == null)!, minimumPayment: { type: 'percent_of_balance', percent: 5 } }
const pot = base.savingsPots[0]
check('fixture: a statement-window card, a no-window card and a savings pot', [!!windowCard, !!plainCard, !!pot], [true, true, true])

const asOf = new Date(2026, 9, 6) // the backup's own day
const rangeStart = asOf
const rangeEnd = new Date(2027, 2, 31)

let seq = 0
const outside = (card: CreditCard, date: string, amount: number): Transaction =>
  ({ id: `oi-${++seq}`, date, amount, direction: 'in', categoryId: '', paymentMethod: 'bank_transfer', status: date <= '2026-10-06' ? 'cleared' : 'pending', type: 'income', location: 'credit_card', creditCardId: card.id, ownerId: pid, personId: pid, note: 'From Sis' }) as Transaction
const lumpOf = (card: CreditCard, date: string, amount: number): CreditCard => ({ ...card, lumpPayments: [...card.lumpPayments, { id: `lp-${++seq}`, date, amount }] })

for (const [label, card] of [['window card', windowCard], ['no-window 5% card', plainCard]] as const) {
  // ── 1. A FUTURE one-off: the simulation sees it exactly like a lump payment ──
  const D = '2026-11-03'
  const none = generateMinimumPaymentTransactions(card, rangeStart, rangeEnd, base.transactions)
  const viaLump = generateMinimumPaymentTransactions(lumpOf(card, D, 150), rangeStart, rangeEnd, base.transactions)
  const viaOutside = generateMinimumPaymentTransactions(card, rangeStart, rangeEnd, [...base.transactions, outside(card, D, 150)])
  check(`${label}: £150 from outside gives exactly the lump payment's minimums`, amounts(viaOutside), amounts(viaLump))
  check(`CONTROL ${label}: ...and those differ from no payment at all`, JSON.stringify(amounts(viaOutside)) !== JSON.stringify(amounts(none)), true)
  check(`${label}: no generated minimum is the outside money itself`, viaOutside.every((t) => t.type === 'credit_card_payment' && t.direction === 'out'), true)

  // ── 2. A PAST one: in the balance, and in "paid so far" ──
  const past = outside(card, '2026-10-01', 40)
  const withPast = [...base.transactions, past]
  // Compared with the same £40 logged as a lump payment, not with "£40 off":
  // a payment larger than the balance clamps it to zero on its own date, and
  // spend after that date adds back.
  const pastLumpRow = { ...past, type: 'credit_card_payment', direction: 'out', location: 'personal', sourceType: 'credit_card_lump_payment' } as Transaction
  check(`${label}: a past £40 from outside leaves the balance a £40 lump payment leaves`, cardBalanceAsOf(card, withPast, asOf), cardBalanceAsOf(card, [...base.transactions, pastLumpRow], asOf))
  check(`CONTROL ${label}: ...which is lower than with no payment`, cardBalanceAsOf(card, withPast, asOf) < cardBalanceAsOf(card, base.transactions, asOf), true)
  check(`${label}: ...and counts in total paid`, round2(totalPaidForCard(card.id, withPast, asOf) - totalPaidForCard(card.id, base.transactions, asOf)), 40)
}

// ── 3. Never on the current account ──
const pc = base.payCycles.find((p) => p.personId === pid)!
const personalOf = (txns: Transaction[]) => computeProjection({ ...base, transactions: txns }, pid, pc, 'current_cycle', asOf).clearedBalance
const onCard = outside(windowCard, '2026-10-02', 75)
check('Money from outside onto a card does not touch the current account', round2(personalOf([...base.transactions, onCard]) - personalOf(base.transactions)), 0)
check('CONTROL: the same income on the current account does', round2(personalOf([...base.transactions, { ...onCard, location: 'personal', creditCardId: undefined }]) - personalOf(base.transactions)), 75)

// ── 4. Recurring onto a card: future occurrences reach the simulation ──
const tpl: RecurringTemplate = {
  id: 'tpl-sis', name: 'Sis pays card', amount: 50, categoryId: base.categories[0].id, paymentMethod: 'bank_transfer', frequency: 'monthly',
  anchorDate: '2026-09-20', location: 'credit_card', creditCardId: plainCard.id, ownerId: pid, payee: '', payeeSharePercent: 100,
  active: true, kind: 'transaction', recurringTransactionType: 'income', personId: pid,
} as RecurringTemplate
check('the template is recognised as money from outside', isOutsideIncomeTemplate(tpl), true)
const fed = withCardCredits(base.transactions, [tpl], rangeEnd)
const occDates = fed.filter((t) => t.sourceId === 'tpl-sis').map((t) => t.date)
check('withCardCredits generates its monthly occurrences', occDates.slice(0, 3), ['2026-09-20', '2026-10-20', '2026-11-20'])
let lumped = plainCard
for (const d of occDates.filter((x) => x > '2026-10-06')) lumped = lumpOf(lumped, d, 50)
check('Recurring £50 from outside gives the minimums of the same monthly lump payments',
  amounts(generateMinimumPaymentTransactions(plainCard, rangeStart, rangeEnd, fed)),
  amounts(generateMinimumPaymentTransactions(lumped, rangeStart, rangeEnd, [...base.transactions, ...fed.filter((t) => t.sourceId === 'tpl-sis' && t.date <= '2026-10-06')])))
check('A stored occurrence is not generated a second time', withCardCredits([...base.transactions, { ...outside(plainCard, '2026-09-20', 50), sourceType: 'recurring_template', sourceId: 'tpl-sis' }], [tpl], rangeEnd).filter((t) => t.sourceId === 'tpl-sis' && t.date === '2026-09-20').length, 1)

// ── 5. autoClear materialises it, onto the card, never the current account ──
const withTpl: AppDataV2 = { ...base, creditCards: base.creditCards.map((c) => (c.id === plainCard.id ? plainCard : c)), recurringTemplates: [...base.recurringTemplates, tpl] }
const cleared = autoClearDuePayments(withTpl, asOf).transactions.filter((t) => t.sourceId === 'tpl-sis')
check('autoClear clears the due occurrence (20 Sept) and nothing future', cleared.map((t) => [t.date, t.status, t.location, t.creditCardId === plainCard.id]), [['2026-09-20', 'cleared', 'credit_card', true]])

// ── 6. Savings: one-off and recurring raise the pot, never the current account ──
const gift: Transaction = { ...onCard, id: 'gift', creditCardId: undefined, location: 'savings', savingsPotId: pot.id, date: '2026-10-05' } // the pot opened 4 Oct
check('CONTROL: dated before the pot opened, it is ignored like any row', round2(savingsPotBalanceAsOf(pot, [...base.transactions, { ...gift, date: '2026-10-03' }], asOf) - savingsPotBalanceAsOf(pot, base.transactions, asOf)), 0)
check('£75 from outside into a savings pot raises its balance by £75', round2(savingsPotBalanceAsOf(pot, [...base.transactions, gift], asOf) - savingsPotBalanceAsOf(pot, base.transactions, asOf)), 75)
check('...and does not touch the current account', round2(personalOf([...base.transactions, gift]) - personalOf(base.transactions)), 0)
const savTpl: RecurringTemplate = { ...tpl, id: 'tpl-gran', location: 'savings', creditCardId: undefined, savingsPotId: pot.id }
check('A recurring income into the pot is generated as its deposits', generateSavingsDepositTransactions(pot, new Date(2026, 10, 1), new Date(2026, 11, 31), [savTpl]).filter((t) => t.sourceId === 'tpl-gran').map((t) => [t.date, t.type, t.location]), [['2026-11-20', 'income', 'savings'], ['2026-12-20', 'income', 'savings']])
check('CONTROL: an expense template on the pot is not', generateSavingsDepositTransactions(pot, new Date(2026, 10, 1), new Date(2026, 11, 31), [{ ...savTpl, recurringTransactionType: 'expense' }]).filter((t) => t.sourceId === 'tpl-gran').length, 0)

// ── 7. Deleting the card / pot takes its recurring outside money with it ──
check('Deleting the card removes its recurring payment-in', removeCreditCardFromData(withTpl, plainCard.id).recurringTemplates.some((t) => t.id === 'tpl-sis'), false)
check('Deleting the savings pot removes its recurring payment-in', removeSavingsPotFromData({ ...base, recurringTemplates: [...base.recurringTemplates, savTpl] }, pot.id).recurringTemplates.some((t) => t.id === 'tpl-gran'), false)
check('Backstop: an imported template whose card is gone is dropped on load', reconcilePersonReferences({ ...base, recurringTemplates: [...base.recurringTemplates, { ...tpl, creditCardId: 'gone' }] }).recurringTemplates.some((t) => t.id === 'tpl-sis'), false)
check('CONTROL: one whose card exists survives the load', reconcilePersonReferences(withTpl).recurringTemplates.some((t) => t.id === 'tpl-sis'), true)

console.log(failures === 0 ? '\nAll outside-money checks passed.' : `\n${failures} outside-money check(s) failed.`)
if (failures > 0) process.exit(1)
