// The sync app stores a recurring card expense's round-up choice in four columns.
// Sync app only (DIVERGENCE.md): `personal-ledger` has no mapping to check.
//
// THE TRAP: a field the mapping forgets is silently dropped on the next sync —
// the choice reads correctly on the device that made it and is gone on the
// other device. `false` on a single payment is a real choice ("round this one,
// under a standing off") and must survive as false, not vanish as unset.
// verify-mapping-nulls.ts proves every column written exists in the schema;
// this proves these four are written at all.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { applyTemplateRoundUpChange } from '../src/lib/schedule'
import { fromRows, toRows } from '../src/lib/powersync/mapping'
import type { RecurringTemplate } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-22-PROD.json', 'utf8'))
const base = migrateLedgerData(raw.data ?? raw)
const sub: RecurringTemplate = {
  id: 'RU-SUB', name: 'Streaming', amount: 7.5, categoryId: base.categories[0].id, paymentMethod: 'card', frequency: 'monthly', anchorDate: '2026-10-20',
  location: 'personal', ownerId: base.primaryPersonId, payee: '', payeeSharePercent: 100, active: true, kind: 'transaction', recurringTransactionType: 'expense',
}
const slots = ['2026-10-20', '2026-11-20', '2026-12-20']

console.log('\n── Sync mapping ──')
const mapped = { ...sub, ...applyTemplateRoundUpChange({ ...sub }, true, slots[1]), ...{ occurrenceOverrides: [{ originalDate: slots[2], roundUpSkipped: false }] } }
const back = fromRows(toRows({ ...base, recurringTemplates: [mapped] }, { householdId: 'h' })).recurringTemplates[0]
check('the standing choice and its history round-trip', [back.roundUpSkipped, back.roundUpSkippedEffectiveFrom, back.roundUpSkippedHistory], [mapped.roundUpSkipped, mapped.roundUpSkippedEffectiveFrom, mapped.roundUpSkippedHistory])
check('a single payment\'s choice round-trips, false included', back.occurrenceOverrides, [{ originalDate: slots[2], roundUpSkipped: false }])

console.log(failures === 0 ? '\nALL PASS' : `\nFAIL: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
