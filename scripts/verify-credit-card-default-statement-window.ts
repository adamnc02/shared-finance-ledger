// PROMPT-01 A1 — the statement window OFFERED to a card that has none.
// Adam, 2026-09-15: "Prompt the user, but default to paymentDayOfMonth."
//
// The window closes ON the payment day, the next opens the day after: a
// card paying on the 14th is offered "opens 15th, closes 14th".
//
// WHY THIS IS A FREE CHOICE NOW. An earlier analysis proposed
// paymentDayOfMonth + 1, because a window closing on or before the payment
// day left the residual balance stranded. That was measuring the Part A
// double-count, not statement mechanics — the cleared cycle was being
// re-simulated and only a later close pushed spend clear of the damage.
// With the root cause fixed, EVERY closing day reconciles, which this file
// asserts directly against the real card: that is what makes the default
// free to be the one that is simplest to explain.
//
// It is OFFERED, never applied silently — adding a window to an existing
// card retroactively moves still-pending spend between cycles, so it must
// be the user's own action. That is a UI property (a button in the card
// edit form, pre-filled); what is asserted here is the figure it fills in.
import { readFileSync } from 'node:fs'
import { defaultStatementWindowForPaymentDay, cardBalanceAsOf, buildCreditCardMinimumChargeRows } from '../src/lib/creditCards'
import type { CreditCard, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

console.log('--- the default window ---')
check('payDay 14 → opens 15th, closes 14th', defaultStatementWindowForPaymentDay(14), { statementStartDay: 15, statementEndDay: 14 })
check('payDay 1 → opens 2nd, closes 1st', defaultStatementWindowForPaymentDay(1), { statementStartDay: 2, statementEndDay: 1 })
check('payDay 30 → opens 31st, closes 30th', defaultStatementWindowForPaymentDay(30), { statementStartDay: 31, statementEndDay: 30 })
check('payDay 31 wraps → opens 1st, closes 31st', defaultStatementWindowForPaymentDay(31), { statementStartDay: 1, statementEndDay: 31 })
check('out-of-range high is clamped', defaultStatementWindowForPaymentDay(99), { statementStartDay: 1, statementEndDay: 31 })
check('out-of-range low is clamped', defaultStatementWindowForPaymentDay(0), { statementStartDay: 2, statementEndDay: 1 })

// --- Applying the default to the real card must keep it reconciled ---
console.log('\n--- the offered default applied to mum\'s Santander ---')
const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15-mum.json', 'utf8'))
const txns: Transaction[] = raw.transactions
const stored = (raw.creditCards as CreditCard[]).find((c) => c.id === 'lhF0fbR8')!
const santander = { ...stored, lumpPayments: stored.lumpPayments ?? [] } as CreditCard
const asOf = new Date(2026, 8, 15)

const withDefault = { ...santander, ...defaultStatementWindowForPaymentDay(santander.paymentDayOfMonth) } as CreditCard
const live = cardBalanceAsOf(withDefault, txns, asOf)
const pending = buildCreditCardMinimumChargeRows(withDefault, txns, asOf).filter((r) => r.status === 'pending')
const sum = Math.round(pending.reduce((s, r) => s + r.amount, 0) * 100) / 100
check('her balance is unchanged by adding the window', live, 91.24)
check('it still reconciles: sum(pending) === live', sum, 91.24)
check('still exactly one pending charge, on 2026-10-14', pending.map((r) => r.date), ['2026-10-14'])

// --- The claim the default rests on: EVERY closing day now reconciles ---
// Before the Part A fix this failed for every endDay at or below the
// payment day (10, 12, 13, 14 stranded the balance; 15+ survived). If this
// ever regresses, the default is no longer a free choice.
console.log('\n--- every statement closing day reconciles (why the default is free) ---')
const broken: number[] = []
for (let endDay = 1; endDay <= 28; endDay++) {
  const card = { ...santander, statementEndDay: endDay, statementStartDay: endDay === 31 ? 1 : endDay + 1 } as CreditCard
  const l = cardBalanceAsOf(card, txns, asOf)
  const p = buildCreditCardMinimumChargeRows(card, txns, asOf).filter((r) => r.status === 'pending')
  const st = Math.round(p.reduce((a, r) => a + r.amount, 0) * 100) / 100
  if (Math.abs(st - l) >= 0.005) broken.push(endDay)
}
check('no closing day strands the balance (1–28)', broken, [])

console.log(`\n${failures === 0 ? '✓ ALL CHECKS PASSED' : `✗ ${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
