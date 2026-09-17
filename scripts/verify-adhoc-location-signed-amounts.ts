// 2026-09-13 (dev.md item 5) — ad-hoc expense/income transactions can now
// carry location: 'joint' or 'pot' (previously always hardcoded to
// 'personal' by addAdHocTransaction), reusing the same location/potId
// fields a bill_payment/loan_payment already carries. jointAccountSignedAmount
// and potSignedAmount's fallback branches used to assume `-t.amount` for
// anything not explicitly matched, which was safe ONLY because every type
// that ever reached that fallback (bill_payment, loan_payment,
// pot_withdrawal) is always direction 'out'. An ad-hoc 'income' transaction
// tagged to Joint/Pot would have silently REDUCED that ledger's balance
// instead of increasing it, had these not been fixed with explicit
// 'income' branches.
//
// This script proves both signed-amount functions get the sign right for
// every real-world type that can now reach them, including the new
// income case, and that nothing pre-existing regressed.

import { jointAccountSignedAmount } from '../src/lib/jointAccountLedger'
import { potSignedAmount } from '../src/lib/potLedger'
import type { Transaction } from '../src/types/ledger'

let passed = 0
let failed = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  if (ok) {
    passed++
  } else {
    failed++
    console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  }
}

function txn(overrides: Partial<Transaction>): Pick<Transaction, 'type' | 'amount' | 'fromLocation' | 'toLocation'> {
  return { type: 'expense', amount: 100, ...overrides } as Pick<Transaction, 'type' | 'amount' | 'fromLocation' | 'toLocation'>
}

// ── jointAccountSignedAmount ──
check('an ad-hoc EXPENSE tagged location: joint reduces the joint balance', jointAccountSignedAmount(txn({ type: 'expense', amount: 50 })), -50)
check('an ad-hoc INCOME tagged location: joint increases the joint balance (the fix)', jointAccountSignedAmount(txn({ type: 'income', amount: 50 })), 50)
check('a bill_payment against the joint account still reduces it (pre-existing, unaffected)', jointAccountSignedAmount(txn({ type: 'bill_payment', amount: 30 })), -30)
check('a loan_payment against the joint account still reduces it (pre-existing, unaffected)', jointAccountSignedAmount(txn({ type: 'loan_payment', amount: 40 })), -40)
check('joint_deposit is unaffected by the fix', jointAccountSignedAmount(txn({ type: 'joint_deposit', amount: 20 })), 20)
check('joint_withdrawal is unaffected by the fix', jointAccountSignedAmount(txn({ type: 'joint_withdrawal', amount: 20 })), -20)

// ── potSignedAmount ──
check('an ad-hoc EXPENSE tagged location: pot reduces the pot balance', potSignedAmount(txn({ type: 'expense', amount: 25 })), -25)
check('an ad-hoc INCOME tagged location: pot increases the pot balance (the fix)', potSignedAmount(txn({ type: 'income', amount: 25 })), 25)
check('a bill_payment funded from a pot still reduces it (pre-existing, unaffected)', potSignedAmount(txn({ type: 'bill_payment', amount: 15 })), -15)
check('a loan_payment funded from a pot still reduces it (pre-existing, unaffected)', potSignedAmount(txn({ type: 'loan_payment', amount: 15 })), -15)
check('pot_deposit is unaffected by the fix', potSignedAmount(txn({ type: 'pot_deposit', amount: 10 })), 10)
check('pot_withdrawal is unaffected by the fix', potSignedAmount(txn({ type: 'pot_withdrawal', amount: 10 })), -10)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
