// Verifies the 2026-09-20 fix for "a recurring transfer shows up in Bills".
//
// RecurringTemplate is one table holding three different things, told
// apart by `kind` (absent/'bill' | 'transaction' | 'transfer'). Bills.tsx
// read data.recurringTemplates with no `kind` filter at all, so every
// kind rendered on the Bills page.
//
// What made a TRANSFER specifically show up there is by-design behaviour
// elsewhere: a kind: 'transfer' template is deliberately saved with
// location: 'personal' and ownerId = the primary person, purely so the
// projection/auto-clear engines pick it up via their shared
// `location === 'personal' && ownerId === personId` filter (see
// types/ledger.ts's own comment on `kind`). That is correct for
// forecasting — the money really does leave the current account — but it
// left the transfer indistinguishable from a personal bill to any caller
// that only looks at location/ownerId.
//
// lib/bills.ts's isBillTemplate is the shared predicate that fixes it.
// The `?? 'bill'` default is the load-bearing part: testing
// `kind === 'bill'` alone would hide every template persisted before the
// field existed, which is all of Adam's real bills.
//
// Reproduces Adam's finance-ledger-backup-2026-09-20.json: five real
// bills with no `kind` at all, plus the "Bills Monthly Deposit" transfer
// (personal current account -> the Bills pot) that was wrongly listed.

import { isBillTemplate } from '../src/lib/bills'
import type { RecurringTemplate } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const ADAM = 'YyioVn9i'
const BILLS_POT = 'Q1Q89pU0'

const billBase = {
  amount: 10,
  categoryId: 'category-seed-phone',
  paymentMethod: 'standing_order' as const,
  frequency: 'monthly' as const,
  payee: '',
  payeeSharePercent: 100,
  active: true,
}

// The five real bills from the backup — note NOT ONE of them carries a
// `kind`, which is exactly why the default matters.
const templates: RecurringTemplate[] = [
  { ...billBase, id: 'ykYtXHlP', name: 'AA', anchorDate: '2026-09-21', location: 'joint', ownerId: '', payee: ADAM, payeeSharePercent: 50 },
  { ...billBase, id: '1p2gA-nv', name: 'Gym', anchorDate: '2026-10-01', location: 'pot', ownerId: ADAM, potId: BILLS_POT },
  { ...billBase, id: 'JoFHIv67', name: 'GiffGaff', anchorDate: '2026-10-07', location: 'pot', ownerId: ADAM, potId: BILLS_POT },
  { ...billBase, id: 'jnC3vFPd', name: 'Monzo Perks', anchorDate: '2026-10-16', location: 'pot', ownerId: ADAM, potId: BILLS_POT },
  { ...billBase, id: 'ZeyQ4VMc', name: 'Windscribe', anchorDate: '2026-10-19', location: 'pot', ownerId: ADAM, potId: BILLS_POT },
  // The reported bug: a recurring transfer, current account -> Bills pot.
  {
    ...billBase,
    id: 'ZAo0nKDf',
    name: 'Bills Monthly Deposit',
    amount: 256.03,
    categoryId: 'category-savings',
    paymentMethod: 'bank_transfer',
    anchorDate: '2026-09-20',
    location: 'personal',
    ownerId: ADAM,
    kind: 'transfer',
    transferFrom: { type: 'personal' },
    transferTo: { type: 'pot', potId: BILLS_POT },
    followsPayday: true,
  },
  // Not in the backup, but the same leak: a recurring ad-hoc expense.
  { ...billBase, id: 'rec-txn-1', name: 'Weekly coffee', anchorDate: '2026-10-01', location: 'personal', ownerId: ADAM, kind: 'transaction', recurringTransactionType: 'expense' },
]

// ---- 1. The predicate itself, kind by kind ----
check('Absent kind counts as a bill (every pre-`kind` template)', isBillTemplate(templates[0]), true)
check("Explicit kind: 'bill' counts as a bill", isBillTemplate({ ...templates[0], kind: 'bill' }), true)
check("kind: 'transfer' is NOT a bill", isBillTemplate(templates[5]), false)
check("kind: 'transaction' is NOT a bill", isBillTemplate(templates[6]), false)

// ---- 2. Adam's real backup: what the Bills page now lists ----
const onBillsPage = templates.filter(isBillTemplate).map((t) => t.name)
check('Bills page lists exactly the five real bills', onBillsPage, ['AA', 'Gym', 'GiffGaff', 'Monzo Perks', 'Windscribe'])
check('"Bills Monthly Deposit" no longer appears on the Bills page', onBillsPage.includes('Bills Monthly Deposit'), false)

// ---- 3. Mirror image: the Transfer pill still gets it ----
// Expenses.tsx's recurringTransfers filter, unchanged by this fix — the
// transfer must land SOMEWHERE, not just vanish from Bills.
const onTransferPill = templates.filter((t) => t.kind === 'transfer').map((t) => t.name)
check('The transfer is still listed under the Transactions page Transfer pill', onTransferPill, ['Bills Monthly Deposit'])

// ---- 4. The location filter chips ----
// Bills.tsx offers a 'personal' chip unconditionally, but 'joint'/'pot'
// only when a BILL uses them. The transfer is location: 'personal', so
// it never drove a chip — but the chips must still be computed off the
// filtered list, or a transfer-only pot/joint template would add a chip
// that then shows an empty list.
const billTemplates = templates.filter(isBillTemplate)
check('Joint chip offered (the AA bill is joint)', billTemplates.some((t) => t.location === 'joint'), true)
check('Pot chip offered (four bills are pot-located)', billTemplates.some((t) => t.location === 'pot'), true)

const transferOnly: RecurringTemplate[] = [{ ...templates[5], location: 'pot', potId: BILLS_POT }]
check('A pot-located TRANSFER alone does not conjure a Pot chip on an otherwise empty Bills page', transferOnly.filter(isBillTemplate).some((t) => t.location === 'pot'), false)

// ---- 5. The restore-confirmation count (Salary.tsx's BackupSection) ----
// Same leak, different symptom: the dialog said "7 bills" for a ledger
// holding five bills, a transfer and a recurring expense.
check('Restore dialog counts bills only', templates.filter(isBillTemplate).length, 5)

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
