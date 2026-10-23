// A recurring payment whose stored rounding is broken is repaired on the next load.
//
// A rounded recurring payment is stored as £7.00 with `roundedFrom: 6.99`. A
// device running a build from before recurring round-ups (2026-10-05) repaints
// that row from the template: its reconciler set `amount` to the price and left
// `roundedFrom` behind, so the row reads £6.99 "rounded from £6.99" and puts
// nothing in the Coin Jar. It syncs that row back to every other device.
//
// THE TRAP this guards: the current reconciler re-rounds a stored row only when
// its PRICE or its round-up choice changed (verify-round-up-recurring.ts, trap
// 1). A broken row has neither — its price still matches the template — so it
// was left broken on every load, forever. The only way out was toggling that
// payment's round-up off and on, which changes the choice twice and forces a
// recompute. The reconciler now also recomputes a row whose `amount` is not
// what its own `roundedFrom` rounds to (`roundUpBroken`, lib/roundUp.ts).
//
// WHAT IT CANNOT REPAIR, asserted below so nobody "fixes" it: a row an old
// build stored with no rounding at all. It is indistinguishable from a payment
// that cleared before recurring rounding existed, which must stay as it cleared
// (APP-KNOWLEDGE §1.19d, B3).
//
// WHAT FAILS AGAINST THE PRE-FIX CODE: "repaired on the next load". The opt-out
// case passes either way, because changing the choice already forces a recompute.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { findCoinJar, roundUpBroken } from '../src/lib/roundUp'
import { applyTemplateSingleOccurrenceRoundUpChange } from '../src/lib/schedule'
import type { AppDataV2, RecurringTemplate, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const FILE = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-22-PROD.json'
const raw = JSON.parse(readFileSync(FILE, 'utf8'))
const base = migrateLedgerData(raw.data ?? raw)
const OWNER = base.primaryPersonId
const jar = findCoinJar(base.pots, OWNER)!
const asOf = new Date(2026, 9, 23, 12)

const plex: RecurringTemplate = {
  id: 'RU-FIX', name: 'Plex Pass', amount: 6.99, categoryId: base.categories[0].id, paymentMethod: 'card', frequency: 'monthly', anchorDate: '2026-10-17',
  location: 'personal', ownerId: OWNER, payee: '', payeeSharePercent: 100, active: true, kind: 'transaction', recurringTransactionType: 'expense',
}
const withPlex: AppDataV2 = { ...base, recurringTemplates: [...base.recurringTemplates, plex] }
const ours = (d: AppDataV2) => d.transactions.filter((t) => t.sourceId === 'RU-FIX')
const shape = (list: Pick<Transaction, 'amount' | 'roundedFrom' | 'roundingPotId'>[]) => list.map((t) => [t.amount, t.roundedFrom ?? null, t.roundingPotId === jar.id ? 'jar' : (t.roundingPotId ?? null)])
const edit = (d: AppDataV2, patch: Partial<Transaction>): AppDataV2 => ({ ...d, transactions: d.transactions.map((t) => (t.sourceId === 'RU-FIX' ? { ...t, ...patch } : t)) })

console.log('\n── The starting point ──')
const healthy = autoClearDuePayments(withPlex, asOf)
check('the 17 Oct payment is stored rounded: £7.00 from £6.99, into the jar', shape(ours(healthy)), [[7, 6.99, 'jar']])
check('a healthy rounded row is not broken', roundUpBroken(ours(healthy)[0]), false)

console.log('\n── An old build repainted the amount and left roundedFrom behind ──')
const stranded = edit(healthy, { amount: 6.99 })
check('the stranded row is recognised as broken', roundUpBroken(ours(stranded)[0]), true)
const repaired = autoClearDuePayments(stranded, asOf)
check('repaired on the next load: £7.00 from £6.99, into the jar', shape(ours(repaired)), [[7, 6.99, 'jar']])
const again = autoClearDuePayments(repaired, asOf)
check('…and a further load leaves it alone (the same row object, nothing to upload)', ours(again)[0] === ours(repaired)[0], true)

console.log('\n── A broken row the person opted out of is cleared, not re-rounded ──')
const optedOut = { ...stranded, recurringTemplates: stranded.recurringTemplates.map((t) => (t.id === 'RU-FIX' ? { ...t, ...applyTemplateSingleOccurrenceRoundUpChange(t, true, '2026-10-17') } : t)) }
check('repaired to the plain price with no jar credit', shape(ours(autoClearDuePayments(optedOut, asOf))), [[6.99, null, null]])

console.log('\n── Limits, deliberately ──')
const neverRounded = edit(healthy, { amount: 6.99, roundedFrom: undefined, roundingPotId: undefined })
check('a row stored with no rounding at all is NOT rounded after the fact', shape(ours(autoClearDuePayments(neverRounded, asOf))), [[6.99, null, null]])
const bridge: Pick<Transaction, 'amount' | 'roundedFrom'> = { amount: 8, roundedFrom: 7.5 }
check('a correctly rounded row (a Listly shop, £7.50 kept as £8.00) is not broken', roundUpBroken(bridge), false)
check('an ordinary unrounded row is not broken', roundUpBroken({ amount: 6.99, roundedFrom: undefined }), false)
check('float noise is not breakage (7.000000000000001 from 6.99)', roundUpBroken({ amount: 7.000000000000001, roundedFrom: 6.99 }), false)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n✗ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
