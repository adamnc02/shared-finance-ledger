// Verifies the Picker-First Flows session (App_Dev.md, 2026-09). Most of
// this session's actual work is React component state machines (the two-
// step Owner→Location picker flow in Bills.tsx/Loans.tsx, the amount→
// location→recast wizard in Loans.tsx's RecurringOverpaymentEditor, and
// the "Whose income" removal in Expenses.tsx) rather than pure ledger
// functions — there's genuinely little of that kind of logic to
// script-verify this session, unlike a Pots/Salary-Sorter-style data
// layer. What IS covered here:
//   1. The one real shared predicate extracted from the duplicated
//      inline boolean logic (lib/pickerFirst.ts's shouldOfferLocationPicker).
//   2. End-to-end confirmation that the recurring-overpayment location
//      wizard's new "pick a pot" branch produces a Loan shape
//      (recurringOverpayment.location/potId) that the PRE-EXISTING pot
//      engine (potLedger.ts's generatePotOutgoingTransactions, unchanged
//      by this session) correctly picks up — since that's the one place
//      a UI mistake in the new wizard could silently produce a
//      transaction that never appears anywhere.
// The "Whose income" removal and the Owner/Location picker skip-flow
// itself were verified by direct code review + `tsc -b` (every prop this
// session removed/added is exercised at the type level by every existing
// call site) rather than here — there's no pure function to call.

import { defaultLedgerData } from '../src/lib/ledgerStorage'
import { newPot } from '../src/lib/potLedger'
import { generatePotOutgoingTransactions } from '../src/lib/potLedger'
import { shouldOfferLocationPicker } from '../src/lib/pickerFirst'
import type { AppDataV2, Loan, Pot } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// ---- 1. shouldOfferLocationPicker — the skip rule itself ----
check('Neither joint nor a pot available → skip the step', shouldOfferLocationPicker(false, false), false)
check('Joint available, no pot → still offer it', shouldOfferLocationPicker(true, false), true)
check('Pot available, no joint → still offer it', shouldOfferLocationPicker(false, true), true)
check('Both available → offer it', shouldOfferLocationPicker(true, true), true)

// ---- 2. Recurring-overpayment wizard's "pick a pot" branch — real engine round-trip ----
const base = defaultLedgerData()
const meId = base.primaryPersonId

const billsPot: Pot = { ...newPot({ personId: meId, name: 'Bills', openingBalance: 0, openingDate: '2026-01-01' }), id: 'pot-bills' }

// A loan whose REGULAR payment is personal, but whose recurring
// overpayment was routed to the pot via the new picker-first step — the
// exact shape LocationPickerCard-adjacent "commit({ location: 'pot',
// potId })" call in RecurringOverpaymentEditor now produces.
const loan: Loan = {
  id: 'loan-1',
  name: 'Car',
  principal: 10000,
  monthlyPayment: 300,
  termMonths: 36,
  startDate: '2026-01-01',
  categoryId: 'category-seed-loan',
  location: 'personal',
  ownerId: meId,
  payee: '',
  payeeSharePercent: 100,
  active: true,
  overpayments: [],
  recurringOverpayment: {
    startDate: '2026-01-01',
    amount: { type: 'fixed', amount: 100 },
    location: 'pot',
    potId: billsPot.id,
  },
}

const data: AppDataV2 = { ...base, pots: [billsPot], loans: [loan] }

const potOutgoing = generatePotOutgoingTransactions(data, billsPot, new Date('2026-01-01'), new Date('2026-03-31'))
const overpaymentRows = potOutgoing.filter((t) => t.type === 'loan_payment')
check('Pot-routed recurring overpayment produces real outgoing rows against the pot (3 months)', overpaymentRows.length, 3)
check('Each row is the fixed £100 overpayment amount, not the £300 regular payment (that stays personal)', overpaymentRows.every((t) => t.amount === 100), true)

// ---- 3. The "Follows the loan" choice (location left undefined) — no pot-only row, and no double count when the loan's OWN location is personal ----
const loanFollowing: Loan = { ...loan, id: 'loan-2', recurringOverpayment: { startDate: '2026-01-01', amount: { type: 'fixed', amount: 100 } } }
const dataFollowing: AppDataV2 = { ...base, pots: [billsPot], loans: [loanFollowing] }
const potOutgoingFollowing = generatePotOutgoingTransactions(dataFollowing, billsPot, new Date('2026-01-01'), new Date('2026-03-31'))
check('"Follows the loan" (undefined location) with a PERSONAL loan never lands on the pot\'s own ledger', potOutgoingFollowing.length, 0)

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
