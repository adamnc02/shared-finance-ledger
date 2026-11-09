// SYNC APP ONLY. The fields added with the 2026-11-09 migration
// (20261109120000) survive app → rows → app, each one checked by value.
//
// THE BUG IT PREVENTS. A field the mapping forgets is dropped on upload with
// no error, and the row that syncs back is a different row:
// - transferTo.personId lost → a person-to-person transfer comes back as the
//   sender's own Current Account: money out of one account, into nobody's;
// - a template's creditCardId / savingsPotId lost → a recurring payment onto
//   a card generates against nothing;
// - openingExcludesDate lost → the rebalance day's spending is counted twice
//   again after the next sync.
// verify-mapping-nulls.ts round-trips the real backups, but none of them holds
// these fields yet, so it would pass with every one of them dropped.
//
// Reads the real 2026-09-22 PROD backup (two people) by absolute path.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { fromRows, toRows } from '../src/lib/powersync/mapping'
import type { AppDataV2, RecurringTemplate, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-22-PROD.json', 'utf8'))
const base: AppDataV2 = migrateLedgerData(raw.data ?? raw)
const A = base.primaryPersonId
const B = base.people.find((p) => p.id !== A)!.id
// The PROD file has no card; a card id is a plain id in both directions, so any id tests the mapping.
const card = base.creditCards[0] ?? { id: 'CARD-SYNTHETIC' }
const sp = base.savingsPots[0]
check('fixture has two people, a savings pot, a pot and a joint account', [!!B, !!sp, base.pots.length > 0, !!base.jointAccount], [true, true, true, true])

const tplBase = { name: 'x', amount: 10, categoryId: base.categories[0].id, paymentMethod: 'bank_transfer', frequency: 'monthly', anchorDate: '2026-10-01', ownerId: A, payee: '', payeeSharePercent: 100, active: true } as const
const p2pTpl = { ...tplBase, id: 'S-P2P', location: 'personal', kind: 'transfer', transferFrom: { type: 'personal' }, transferTo: { type: 'personal', personId: B } } as RecurringTemplate
const cardTpl = { ...tplBase, id: 'S-CARD', location: 'credit_card', creditCardId: card.id, kind: 'transaction', recurringTransactionType: 'income', personId: A } as RecurringTemplate
const savTpl = { ...tplBase, id: 'S-SAV', location: 'savings', savingsPotId: sp.id, kind: 'transaction', recurringTransactionType: 'income', personId: A } as RecurringTemplate
const txBase = { date: '2026-10-01', amount: 10, categoryId: base.categories[0].id, paymentMethod: 'bank_transfer', status: 'pending', ownerId: A } as const
const p2pTx = { ...txBase, id: 'S-P2P-TX', type: 'transfer', direction: 'out', location: 'personal', fromLocation: { type: 'personal' }, toLocation: { type: 'personal', personId: B } } as Transaction
const cardTx = { ...txBase, id: 'S-CARD-TX', type: 'income', direction: 'in', location: 'credit_card', creditCardId: card.id, personId: A } as Transaction

const data: AppDataV2 = {
  ...base,
  recurringTemplates: [...base.recurringTemplates, p2pTpl, cardTpl, savTpl],
  transactions: [...base.transactions, p2pTx, cardTx],
  pots: base.pots.map((p, i) => (i === 0 ? { ...p, openingExcludesDate: true } : p)),
  savingsPots: base.savingsPots.map((p, i) => (i === 0 ? { ...p, openingExcludesDate: true } : p)),
  payCycles: base.payCycles.map((pc) => (pc.personId === A ? { ...pc, openingExcludesDate: true } : pc)),
  jointAccount: { ...base.jointAccount!, openingExcludesDate: true },
}
const rows = toRows(data, { householdId: 'h' })
const back = fromRows(rows)
const tplBack = (id: string) => back.recurringTemplates.find((t) => t.id === id)!
const txBack = (id: string) => back.transactions.find((t) => t.id === id)!

console.log('\n── Person-to-person transfers ──')
check('a recurring transfer\'s recipient round-trips', tplBack('S-P2P').transferTo?.personId === B, true)
check('...and goes up as transfer_to_person_id', rows.recurring_templates.find((r) => r.id === 'S-P2P')!.transfer_to_person_id === B, true)
check('a one-off transfer\'s recipient round-trips', txBack('S-P2P-TX').toLocation?.personId === B, true)
check('...and goes up as to_person_id', rows.transactions.find((r) => r.id === 'S-P2P-TX')!.to_person_id === B, true)
check('an ordinary transfer sends to_person_id NULL, never \'\'', rows.transactions.filter((r) => r.type === 'transfer' && r.id !== 'S-P2P-TX').every((r) => r.to_person_id === null), true)
check('CONTROL: an ordinary transfer comes back with no personId key', back.transactions.filter((t) => t.type === 'transfer' && t.id !== 'S-P2P-TX').every((t) => !('personId' in (t.toLocation ?? {}))), true)

console.log('\n── Money from outside ──')
check('a recurring income onto a card keeps its location and card', [tplBack('S-CARD').location, tplBack('S-CARD').creditCardId === card.id], ['credit_card', true])
check('a recurring income into savings keeps its location and pot', [tplBack('S-SAV').location, tplBack('S-SAV').savingsPotId === sp.id], ['savings', true])
check('a one-off income onto a card keeps its location and card', [txBack('S-CARD-TX').location, txBack('S-CARD-TX').creditCardId === card.id], ['credit_card', true])
check('an ordinary template sends savings_pot_id and credit_card_id NULL', rows.recurring_templates.filter((r) => !String(r.id).startsWith('S-')).every((r) => r.savings_pot_id === null && r.credit_card_id === null), true)

console.log('\n── Rebalance: end of the day ──')
check('pot, savings pot, pay cycle and joint keep openingExcludesDate', [back.pots[0].openingExcludesDate, back.savingsPots[0].openingExcludesDate, back.payCycles.find((p) => p.personId === A)!.openingExcludesDate, back.jointAccount!.openingExcludesDate], [true, true, true, true])
check('CONTROL: an account never rebalanced comes back without the key', back.payCycles.filter((p) => p.personId !== A).every((p) => !('openingExcludesDate' in p)), true)

console.log(failures === 0 ? '\nALL PASS' : `\nFAIL: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
