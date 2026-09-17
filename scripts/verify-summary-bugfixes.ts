// Verifies the four Bugs-section fixes tackled without needing
// screenshots (App_Dev.md "Bugs" 3, 4, 6, 7 — 2026-09 session). Bugs 3
// and 4 are pure JSX restructuring (stacked buttons → FormButtonRow,
// tap-to-edit instead of a text Edit link, deleting a duplicate ledger
// block) with no new logic to script-verify — confirmed by direct code
// review + a clean `tsc -b` instead. What IS logic, and covered here:
//   - Bug 6 (Savings pot detail never showed a rolling balance) — the
//     "anchor on savingsPotBalanceAsOf the day BEFORE the window, then
//     fold forward through the visible rows" approach Home.tsx's
//     SavingsPotDetail now uses, checked against the trusted ground
//     truth (savingsPotBalanceAsOf computed directly at the end date)
//     for a pot with only real, already-cleared activity.
//   - Bug 7 (Joint's new pulldown breakdown) — computeJointSummary's
//     perPerson shares reconciling to its own total (jointSharesReconcile,
//     pre-existing, exported for exactly this kind of check) — the exact
//     figures the new JointBreakdownCard now surfaces.

import { defaultLedgerData } from '../src/lib/ledgerStorage'
import { savingsPotBalanceAsOf } from '../src/lib/savingsPotLedger'
import { newPot } from '../src/lib/potLedger'
import { computeJointSummary, jointSharesReconcile } from '../src/lib/jointLedger'
import type { AppDataV2, RecurringTemplate, SavingsPot, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// ---- Bug 6: rolling balance fold matches ground truth ----
const base = defaultLedgerData()
const meId = base.primaryPersonId
const pot: SavingsPot = {
  personId: meId,
  name: 'Rainy day',
  openingBalance: 1000,
  openingDate: '2026-01-01',
  active: true,
  interestMethod: { type: 'aer_credited', aer: 3, creditingFrequency: 'monthly' },
  id: 'pot-1',
}
const deposit: Transaction = {
  id: 'txn-dep', date: '2026-01-05', amount: 200, direction: 'in', categoryId: 'category-savings', paymentMethod: 'bank_transfer',
  status: 'cleared', type: 'savings_deposit', location: 'personal', ownerId: meId, savingsPotId: pot.id,
}
const withdrawal: Transaction = {
  id: 'txn-wd', date: '2026-01-10', amount: 50, direction: 'out', categoryId: 'category-savings', paymentMethod: 'bank_transfer',
  status: 'cleared', type: 'savings_withdrawal', location: 'personal', ownerId: meId, savingsPotId: pot.id,
}
const transactions = [deposit, withdrawal]

// The fold approach: anchor the day BEFORE the window (here, the pot's
// own opening date, so the anchor is just openingBalance), then walk
// forward summing by type — same as SavingsPotDetail's activityWithRunning.
const opening = savingsPotBalanceAsOf(pot, transactions, new Date('2025-12-31'))
let running = opening
for (const t of [deposit, withdrawal].sort((a, b) => a.date.localeCompare(b.date))) {
  running += t.type === 'savings_withdrawal' ? -t.amount : t.amount
}
const groundTruth = savingsPotBalanceAsOf(pot, transactions, new Date('2026-01-31'))
check('Rolling-balance fold (anchor + walk forward) matches savingsPotBalanceAsOf computed directly at the end date', running, groundTruth)
check('Ground truth is the expected 1000 + 200 - 50', groundTruth, 1150)

// ---- Bug 7: per-person joint shares reconcile to the total ----
const ellaId = 'ella-1'
const jointBill: RecurringTemplate = {
  id: 'rt-1', name: 'Netflix', amount: 20, categoryId: 'category-seed-streaming', paymentMethod: 'direct_debit',
  frequency: 'monthly', anchorDate: '2026-01-16', location: 'joint', ownerId: '', payee: meId, payeeSharePercent: 70, active: true,
}
const dataWithJoint: AppDataV2 = {
  ...base,
  people: [...base.people, { id: ellaId, name: 'Ella', color: '#7c6fe0', salaryHistory: [], salaryOverrides: [] }],
  recurringTemplates: [jointBill],
  jointAccount: { openingBalance: 100, openingBalanceDate: '2026-01-01' },
}
const summary = computeJointSummary(dataWithJoint, new Date('2026-01-01'), new Date('2026-01-31'))
check('computeJointSummary total outgoings picks up the one Netflix occurrence', summary.totalOutgoings, 20)
check('computeJointSummary perPerson shares reconcile to the total (70/30 split)', jointSharesReconcile(summary), true)
const mePerson = summary.perPerson.find((p) => p.personId === meId)
check("Payee's own share matches their payeeSharePercent (70% of £20)", mePerson?.amount, 14)

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
