// A recurring transfer with no Current Account leg stays off the Current Account.
//
// THE BUG: a Savings → Pot recurring transfer showed on the personal ledger as
// money coming IN, so the current account read higher than it was by every
// Savings → Pot payment in the horizon (£1,450 on the real 2026-10-05 file),
// while the savings pot and the pot read correctly.
//
// ROOT CAUSE: reconcilePersonReferences runs on every load and passed every
// recurring template through fallBackDanglingPot. A transfer template has no
// flat `potId` — its pot lives on transferFrom/transferTo — so every transfer
// with `location: 'pot'` looked like a bill pointing at a deleted pot and was
// rewritten to `location: 'personal'`. The generator gives a transfer
// `direction: 'in'` whenever personal is not its source, so the personal
// projection booked it as income. From its first payday it would have been
// auto-cleared as a permanent cleared row on the current account.
//
// THE SAME CLASS, ON EDIT: updateRecurringTemplate and updateTransaction merged
// new endpoints without re-deriving location/direction, so editing a transfer's
// From or To left it on the ledger of its old route.
//
// WHAT FAILS AGAINST THE PRE-FIX CODE: every check under "The real file" and
// "Synthetic", and the three source checks. The controls (a bill pointing at a
// deleted pot still falls back; a transfer to a deleted pot is still switched
// off) pass either way, which proves the fix did not just delete the fallback.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { computeHouseholdPersonProjection } from '../src/lib/householdLedger'
import { computePotProjection } from '../src/lib/potLedger'
import { retargetTransferRow } from '../src/lib/transferLedger'
import type { AppDataV2, RecurringTemplate, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const FILE = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-10-05-mum.json'
const raw = JSON.parse(readFileSync(FILE, 'utf8'))
const stored: AppDataV2 = raw.data ?? raw
const asOf = new Date(2026, 9, 5, 12)

console.log('\n── The real file ──')

const storedChristmas = stored.recurringTemplates.find((t) => t.id === 'jeGygw7h')!
check('the file really stores Savings → Christmas as personal (the damage)', storedChristmas.location, 'personal')
check('…and neither of its endpoints is the current account', [storedChristmas.transferFrom?.type, storedChristmas.transferTo?.type], ['savings', 'pot'])

const data = migrateLedgerData(stored)
const loc = (id: string) => data.recurringTemplates.find((t) => t.id === id)!.location
check('Savings → Birthdays loads as a pot transfer', loc('tCAhNm42'), 'pot')
check('Savings → Christmas loads as a pot transfer', loc('jeGygw7h'), 'pot')
check('Current Account → Savings is still personal', loc('7LFmfK7X'), 'personal')

const me = computeHouseholdPersonProjection(autoClearDuePayments(data, asOf), data.primaryPersonId, 'three_cycles', asOf)!
const noPersonalLeg = (t: Transaction) => t.type === 'transfer' && t.fromLocation?.type !== 'personal' && t.toLocation?.type !== 'personal'
check('no Savings → Pot row on the current account', me.transactions.filter(noPersonalLeg).length, 0)
check('the current account still pays into savings (150 + 550 + 750)', me.transactions.filter((t) => t.sourceId === '7LFmfK7X').map((t) => [t.direction, t.amount]), [['out', 150], ['out', 550], ['out', 750]])
check('projected current account, three cycles from 2026-10-05', me.projectedBalance, 28.4)

const christmas = data.pots.find((p) => p.id === '7KnJ9lk0')!
const pot = computePotProjection(data, christmas, 'three_cycles', asOf)
check('the Christmas pot still receives 150 / 550 / 750', pot.transactions.filter((t) => t.sourceId === 'jeGygw7h').map((t) => t.amount), [150, 550, 750])

// The payday it would have been written down for good.
const afterPayday = autoClearDuePayments(data, new Date(2026, 9, 15, 12))
const cleared = afterPayday.transactions.filter((t) => t.sourceId === 'jeGygw7h' && t.status === 'cleared')
check('on 15 Oct the Christmas payment is cleared once', cleared.length, 1)
check('…as a pot row, not a current-account row', cleared.map((t) => t.location), ['pot'])

console.log('\n── Synthetic: Pot → Pot, and the controls ──')

const base = migrateLedgerData(stored)
const potToPot: RecurringTemplate = { ...storedChristmas, id: 'P2P', transferFrom: { type: 'pot', potId: 'DyLHxIHj' }, transferTo: { type: 'pot', potId: 'lIFk8vVy' }, location: 'pot' }
const deadPotBill: RecurringTemplate = { ...base.recurringTemplates.find((t) => t.kind !== 'transfer')!, id: 'DEADBILL', location: 'pot', potId: 'NO-SUCH-POT' }
const deadPotTransfer: RecurringTemplate = { ...storedChristmas, id: 'DEADXFER', transferTo: { type: 'pot', potId: 'NO-SUCH-POT' }, location: 'pot' }
const synth = migrateLedgerData({ ...stored, recurringTemplates: [...stored.recurringTemplates, potToPot, deadPotBill, deadPotTransfer] })
const s = (id: string) => synth.recurringTemplates.find((t) => t.id === id)!
check('a Pot → Pot transfer keeps location pot', s('P2P').location, 'pot')
check('control: a bill paid from a deleted pot still falls back to personal', [s('DEADBILL').location, s('DEADBILL').potId], ['personal', undefined])
check('control: a transfer into a deleted pot is still switched off', [s('DEADXFER').active, s('DEADXFER').transferTo], [false, { type: 'personal' }])

console.log('\n── Editing the endpoints re-routes the row ──')

const oneOff: Transaction = { id: 'x', date: '2026-10-01', amount: 40, direction: 'out', categoryId: 'c', paymentMethod: 'bank_transfer', status: 'cleared', type: 'transfer', location: 'personal', ownerId: 'p', potId: 'lIFk8vVy', fromLocation: { type: 'personal' }, toLocation: { type: 'pot', potId: 'lIFk8vVy' } }
const moved = retargetTransferRow(oneOff, { type: 'savings', savingsPotId: 'qn8wAR8u' }, oneOff.toLocation)
check('Personal → Pot edited to Savings → Pot leaves the personal ledger', [moved.location, moved.direction, moved.savingsPotId, moved.potId], ['pot', 'in', 'qn8wAR8u', 'lIFk8vVy'])

const ctx = readFileSync(new URL('../src/context/LedgerContext.tsx', import.meta.url), 'utf8')
const body = (name: string) => ctx.slice(ctx.indexOf(`const ${name}:`), ctx.indexOf('\n  }\n', ctx.indexOf(`const ${name}:`)))
check('updateTransaction re-routes an endpoint edit', /retargetTransferRow\(/.test(body('updateTransaction')), true)
check('updateRecurringTemplate re-derives location on an endpoint edit', /locationTypeForTransfer\(merged\.transferFrom, merged\.transferTo\)/.test(body('updateRecurringTemplate')), true)
const household = readFileSync(new URL('../src/lib/household.ts', import.meta.url), 'utf8')
check('fallBackDanglingPot never touches a transfer', /function fallBackDanglingPot[^\n]*\n\s*if \(item\.kind === 'transfer'\) return item/.test(household), true)

console.log(failures === 0 ? '\nALL PASS' : `\nFAIL: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
