// Person-to-person transfers in a joint household (lib/personTransfer.ts):
// from one person's current account to the other's, one-off and recurring,
// stored as ONE row owned by the sender.
//
// WHAT IT PREVENTS
// - The recipient never seeing the money: every per-person ledger filter is
//   `location === 'personal' && ownerId === X`, which matches the SENDER only.
// - The household's money changing when it only moved: Household Combined must
//   be unchanged by a transfer between its own two people.
// - A transfer to someone who has left the household (or, after an owner is
//   reassigned, to its own owner) carrying on as money into nowhere.
//
// Reads the real 2026-09-22 PROD backup (two people) by absolute path; nothing
// from it is printed.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { computeProjection } from '../src/lib/projection'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { buildTransferTransaction, transferLocationKey, locationsEqual, transferLocationLabel, categoryForTransfer, TRANSFER_JOINT_CATEGORY_ID } from '../src/lib/transferLedger'
import { transferRecipientId, templateRecipientId, personTransferOptions } from '../src/lib/personTransfer'
import { groupTransfersByFrom } from '../src/lib/transferGroups'
import { reconcilePersonReferences } from '../src/lib/household'
import type { AppDataV2, RecurringTemplate, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const round2 = (n: number) => Math.round(n * 100) / 100

const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-22-PROD.json', 'utf8'))
const base: AppDataV2 = migrateLedgerData(raw.data ?? raw)
check('fixture has two people', base.people.length, 2)
const A = base.primaryPersonId
const B = base.people.find((p) => p.id !== A)!.id
const asOf = new Date(2026, 8, 22, 18, 0)
const D = '2026-09-22'

const pcOf = (data: AppDataV2, id: string) => data.payCycles.find((p) => p.personId === id)!
const cleared = (data: AppDataV2, id: string) => computeProjection(data, id, pcOf(data, id), 'current_cycle', asOf).clearedBalance
const projected = (data: AppDataV2, id: string) => computeProjection(data, id, pcOf(data, id), 'three_cycles', asOf).projectedBalance
check('both people have a pay cycle', [!!pcOf(base, A), !!pcOf(base, B)], [true, true])

// ── 1. One-off, A → B ──
const row = { ...buildTransferTransaction({ type: 'personal' }, { type: 'personal', personId: B }, 120, D, A, 'To Ella'), id: 'p2p-1' } as Transaction
check('the row is owned by the sender, on the personal ledger, money out', [row.ownerId === A, row.location, row.direction], [true, 'personal', 'out'])
check('its recipient is B', transferRecipientId(row) === B, true)
check('it takes the Joint (household) category', row.categoryId, TRANSFER_JOINT_CATEGORY_ID)
const withRow: AppDataV2 = { ...base, transactions: [...base.transactions, row] }
check('A (sender) is £120 down', round2(cleared(withRow, A) - cleared(base, A)), -120)
check('B (recipient) is £120 up — from the same one row', round2(cleared(withRow, B) - cleared(base, B)), 120)
check('Household (A + B) is unchanged: the money only moved', round2(cleared(withRow, A) + cleared(withRow, B) - cleared(base, A) - cleared(base, B)), 0)
check('B\'s copy keeps the stored row\'s id, so edit/delete reach the one row', computeProjection(withRow, B, pcOf(withRow, B), 'current_cycle', asOf).transactions.some((t) => t.id === 'p2p-1' && t.direction === 'in'), true)
check('the stored row itself is untouched (still out)', withRow.transactions.find((t) => t.id === 'p2p-1')!.direction, 'out')
// CONTROL: an ordinary transfer to A's OWN savings is not B's.
const own = { ...row, id: 'own-1', toLocation: { type: 'savings' as const, savingsPotId: 'x' } }
check('CONTROL: a transfer to A\'s own savings has no recipient', transferRecipientId(own), null)
check('CONTROL: ...and does not touch B', round2(cleared({ ...base, transactions: [...base.transactions, own] }, B) - cleared(base, B)), 0)

// ── 2. Recurring, A → B, monthly ──
const tpl: RecurringTemplate = {
  id: 'tpl-p2p', name: 'Housekeeping to Ella', amount: 200, categoryId: categoryForTransfer({ type: 'personal' }, { type: 'personal', personId: B }), paymentMethod: 'bank_transfer',
  frequency: 'monthly', anchorDate: '2026-10-01', location: 'personal', ownerId: A, payee: '', payeeSharePercent: 100, active: true,
  kind: 'transfer', transferFrom: { type: 'personal' }, transferTo: { type: 'personal', personId: B },
} as RecurringTemplate
check('the template\'s recipient is B', templateRecipientId(tpl) === B, true)
const withTpl: AppDataV2 = { ...base, recurringTemplates: [...base.recurringTemplates, tpl] }
const dA = round2(projected(withTpl, A) - projected(base, A))
const dB = round2(projected(withTpl, B) - projected(base, B))
check('A\'s projection carries the recurring transfer out', dA < 0, true)
check('B\'s projection carries exactly the same money in', dB, -dA)
const later = new Date(2026, 9, 2)
const materialised = autoClearDuePayments(withTpl, later).transactions.filter((t) => t.sourceId === 'tpl-p2p')
check('autoClear materialises ONE row per occurrence, owned by A', materialised.map((t) => [t.date, t.ownerId === A, t.direction, transferRecipientId(t) === B]), [['2026-10-01', true, 'out', true]])

// ── 3. Locations and options ──
check('key: another person\'s account is distinct from your own', [transferLocationKey({ type: 'personal' }), transferLocationKey({ type: 'personal', personId: B }) === `personal:${B}`], ['personal', true])
check('equality respects the person', [locationsEqual({ type: 'personal' }, { type: 'personal', personId: B }), locationsEqual({ type: 'personal', personId: B }, { type: 'personal', personId: B })], [false, true])
const bName = base.people.find((p) => p.id === B)!.name
check('label names the person', transferLocationLabel({ type: 'personal', personId: B }, [], [], base.people) === `${bName}'s Current Account`, true)
check('options: the OTHER person only', personTransferOptions(base.people, A).map((o) => o.location.personId === B), [true])
check('CONTROL: a one-person household gets none', personTransferOptions(base.people.slice(0, 1), A), [])

// ── 4. On B's device, A's transfer groups under A's name ──
const onB: AppDataV2 = { ...withRow, primaryPersonId: B }
const groups = groupTransfersByFrom([], [row], onB, asOf)
check('on the recipient\'s device it groups under the sender\'s account', groups.map((g) => g.key === `personal:${A}`), [true])
check('CONTROL: on the sender\'s device, under their own Current Account', groupTransfersByFrom([], [row], withRow, asOf).map((g) => g.key), ['personal'])

// ── 5. Someone leaving the household ──
const gone = reconcilePersonReferences({ ...withTpl, people: withTpl.people.filter((p) => p.id !== B) })
const after = gone.recurringTemplates.find((t) => t.id === 'tpl-p2p')!
check('a recurring transfer to a removed person is switched off', [after.active, after.transferTo?.personId], [false, undefined])
check('CONTROL: with both people present it stays on', reconcilePersonReferences(withTpl).recurringTemplates.find((t) => t.id === 'tpl-p2p')!.active, true)

console.log(failures === 0 ? '\nAll person-transfer checks passed.' : `\n${failures} person-transfer check(s) failed.`)
if (failures > 0) process.exit(1)
