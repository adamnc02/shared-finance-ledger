// A recurring card expense rounds up exactly as a one-off one does.
//
// A £7.50 monthly card expense is shown, stored and cleared as £8.00 with 50p
// into the owner's Coin Jar, ahead of its date, while the owner's switch is on
// for that payment's date. "Not this one" is remembered on the template, either
// for every payment from a chosen one onward (effective-dated, like an amount
// change) or for a single payment (an occurrence override).
//
// THE TRAPS this guards:
// 1. The reconciler repaints a materialised row's amount from the template's
//    PRICE. Assigning the price would reset a rounded £8.00 row to £7.50 and
//    strand its roundedFrom; comparing the price against `amount` instead sees
//    a change on every load and rewrites every rounded row each time — a write
//    the sync app uploads, per row, per device, per load. It must compare
//    against the row's own price and leave a settled row untouched.
// 2. Counting a payment's 50p twice in the jar: once as a generated preview and
//    again once it is stored. The generated credit dedupes against stored rows.
// 3. Rounding history after the fact: a recurring card payment that cleared
//    before this existed must stay as it cleared (APP-KNOWLEDGE §1.19d, B3).
// 4. Dropping the choice: three places rebuild occurrence overrides field by
//    field (pausing, an amount change, a schedule change). An override holding
//    only `roundUpSkipped` must survive each of them.
//
// WHAT FAILS AGAINST THE PRE-FIX CODE: every check except the controls, which
// pass either way — income, bank transfer, an exact pound, and the switch off.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { computeProjection } from '../src/lib/projection'
import { computePotProjection } from '../src/lib/potLedger'
import { applyRoundUpChange, findCoinJar } from '../src/lib/roundUp'
import {
  applyTemplateAmountChange,
  applyTemplateRoundUpChange,
  applyTemplateScheduleChange,
  applyTemplateSingleOccurrenceRoundUpChange,
  setPausedTemplateOccurrences,
} from '../src/lib/schedule'
import { fromRows, toRows } from '../src/lib/powersync/mapping'
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
const asOf = new Date(2026, 9, 5, 12)

const sub: RecurringTemplate = {
  id: 'RU-SUB', name: 'Streaming', amount: 7.5, categoryId: base.categories[0].id, paymentMethod: 'card', frequency: 'monthly', anchorDate: '2026-10-20',
  location: 'personal', ownerId: OWNER, payee: '', payeeSharePercent: 100, active: true, kind: 'transaction', recurringTransactionType: 'expense',
}
const withTemplate = (t: Partial<RecurringTemplate>, data: AppDataV2 = base): AppDataV2 => ({ ...data, recurringTemplates: [...data.recurringTemplates, { ...sub, ...t }] })
const rows = (data: AppDataV2) => computeProjection(data, OWNER, data.payCycles.find((p) => p.personId === OWNER)!, 'three_cycles', asOf).transactions.filter((t) => t.sourceId === 'RU-SUB')
const projected = (data: AppDataV2) => computeProjection(data, OWNER, data.payCycles.find((p) => p.personId === OWNER)!, 'three_cycles', asOf).projectedBalance
const jarProjected = (data: AppDataV2) => computePotProjection(data, data.pots.find((p) => p.id === jar.id)!, 'three_cycles', asOf).projectedBalance
const shape = (list: Pick<Transaction, 'amount' | 'roundedFrom' | 'roundingPotId'>[]) => list.map((t) => [t.amount, t.roundedFrom ?? null, t.roundingPotId ? 'jar' : null])

console.log('\n── The real file carries a Coin Jar with the switch on ──')
check('the PROD file has a Coin Jar for the primary person', !!jar, true)

console.log('\n── Ahead of time ──')
const on = withTemplate({})
const n = rows(on).length
check('three cycles from 5 Oct hold four payments (20 Oct to 20 Jan)', n, 4)
check('every payment is shown as £8.00 from £7.50, into the jar', shape(rows(on)), Array(n).fill([8, 7.5, 'jar']))
const skippedAll = withTemplate({ roundUpSkipped: true })
check('"Not this one" on the template: none rounded', shape(rows(skippedAll)), Array(n).fill([7.5, null, null]))
check('the current account pays the uplift ONCE per payment (not twice)', Math.round((projected(skippedAll) - projected(on)) * 100) / 100, 0.5 * n)
check('the jar projects 50p per payment', Math.round((jarProjected(on) - jarProjected(skippedAll)) * 100) / 100, 0.5 * n)

console.log('\n── One payment, and every payment from a chosen one ──')
const slots = rows(on).map((t) => t.occurrenceOriginalDate!)
const single = withTemplate({ ...applyTemplateSingleOccurrenceRoundUpChange({ ...sub }, true, slots[1]) })
check('just the second payment opts out', shape(rows(single)).map((r) => r[0]), [8, 7.5, 8, 8])
check('…and the jar loses only that 50p', Math.round((jarProjected(on) - jarProjected(single)) * 100) / 100, 0.5)
const fromSecond = withTemplate({ ...applyTemplateRoundUpChange({ ...sub }, true, slots[1]) })
check('from the second payment on: first rounded, the rest not', shape(rows(fromSecond)).map((r) => r[0]), [8, 7.5, 7.5, 7.5])
const backOn = { ...sub, ...applyTemplateRoundUpChange({ ...sub }, true, slots[1]) }
const backOnSingle = withTemplate({ ...backOn, ...applyTemplateSingleOccurrenceRoundUpChange(backOn, false, slots[2]) })
check('a single payment can opt back in under a standing "off"', shape(rows(backOnSingle)).map((r) => r[0]), [8, 7.5, 8, 7.5])
const superseded = { ...sub, ...applyTemplateSingleOccurrenceRoundUpChange({ ...sub }, true, slots[2]) }
check('a later "every payment from" change clears a single choice it now owns', withTemplate({ ...superseded, ...applyTemplateRoundUpChange(superseded, false, slots[1]) }).recurringTemplates.at(-1)!.occurrenceOverrides, [])

console.log('\n── Stored, and loaded again ──')
const clearDay = new Date(2026, 9, 21, 12)
const once = autoClearDuePayments(on, clearDay)
const stored = once.transactions.filter((t) => t.sourceId === 'RU-SUB')
check('the 20 Oct payment is materialised rounded, as the projection showed it', shape(stored), [[8, 7.5, 'jar']])
const twice = autoClearDuePayments(once, clearDay)
check('a second load leaves it at £8.00 (the reconciler compares the price)', shape(twice.transactions.filter((t) => t.sourceId === 'RU-SUB')), [[8, 7.5, 'jar']])
check('…and does not rewrite it (the same row object, so nothing to save or upload)', twice.transactions.find((t) => t.sourceId === 'RU-SUB') === once.transactions.find((t) => t.sourceId === 'RU-SUB'), true)
const jarCleared = (d: AppDataV2) => computePotProjection(d, d.pots.find((p) => p.id === jar.id)!, 'three_cycles', clearDay)
check('the jar counts the stored payment\'s 50p once, not again as a preview', Math.round((jarCleared(twice).projectedBalance - jarCleared(autoClearDuePayments(withTemplate({ roundUpSkipped: true }), clearDay)).projectedBalance) * 100) / 100, 0.5 * n)
const optedOutAfter = { ...twice, recurringTemplates: twice.recurringTemplates.map((t) => (t.id === 'RU-SUB' ? { ...t, ...applyTemplateSingleOccurrenceRoundUpChange(t, true, slots[0]) } : t)) }
check('opting that stored payment out repaints it at its price', shape(autoClearDuePayments(optedOutAfter, clearDay).transactions.filter((t) => t.sourceId === 'RU-SUB')), [[7.5, null, null]])

console.log('\n── Never after the fact ──')
const legacyRow: Transaction = { id: 'legacy', date: '2026-09-20', amount: 7.5, direction: 'out', categoryId: sub.categoryId, paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: OWNER, sourceType: 'recurring_template', sourceId: 'RU-SUB', occurrenceOriginalDate: '2026-09-20', note: 'Streaming' }
const legacy = withTemplate({ anchorDate: '2026-09-20' }, { ...base, transactions: [...base.transactions, legacyRow] })
check('a payment that cleared before recurring rounding existed stays £7.50', shape(autoClearDuePayments(legacy, asOf).transactions.filter((t) => t.id === 'legacy')), [[7.5, null, null]])

console.log('\n── Controls: what never rounds ──')
check('income', shape(rows(withTemplate({ recurringTransactionType: 'income' }))).every((r) => r[1] === null), true)
check('bank transfer', shape(rows(withTemplate({ paymentMethod: 'bank_transfer' }))).every((r) => r[1] === null), true)
check('an exact pound', shape(rows(withTemplate({ amount: 9 }))).every((r) => r[1] === null), true)
const off = { ...base, payCycles: base.payCycles.map((pc) => (pc.personId === OWNER ? { ...pc, ...applyRoundUpChange(pc, false, '2026-11-01') } : pc)) }
check('the switch off from 1 Nov: October rounds, later ones do not', shape(rows(withTemplate({}, off))).map((r) => r[0]), [8, 7.5, 7.5, 7.5])

console.log('\n── The choice survives every rewrite of the overrides ──')
const onlyChoice = { ...sub, ...applyTemplateSingleOccurrenceRoundUpChange({ ...sub }, true, slots[2]) }
const choice = (t: Partial<RecurringTemplate>) => t.occurrenceOverrides?.find((o) => o.originalDate === slots[2])?.roundUpSkipped
check('pausing a different payment', choice(setPausedTemplateOccurrences(onlyChoice, slots, [slots[0]])), true)
check('an amount change from before it', choice(applyTemplateAmountChange(onlyChoice, 9.5, slots[1])), true)
const moved = applyTemplateScheduleChange({ ...sub, ...applyTemplateRoundUpChange({ ...sub }, true, slots[1]) }, [], { frequency: 'monthly', anchorDate: '2026-11-25' }, slots[1], '2026-10-05')
check('a schedule change moves the "from" boundary with its payment', moved.patch.roundUpSkippedEffectiveFrom, '2026-11-25')

console.log('\n── Sync mapping ──')
const mapped = { ...sub, ...applyTemplateRoundUpChange({ ...sub }, true, slots[1]), ...{ occurrenceOverrides: [{ originalDate: slots[2], roundUpSkipped: false }] } }
const back = fromRows(toRows({ ...base, recurringTemplates: [mapped] }, { householdId: 'h' })).recurringTemplates[0]
check('the standing choice and its history round-trip', [back.roundUpSkipped, back.roundUpSkippedEffectiveFrom, back.roundUpSkippedHistory], [mapped.roundUpSkipped, mapped.roundUpSkippedEffectiveFrom, mapped.roundUpSkippedHistory])
check('a single payment\'s choice round-trips, false included', back.occurrenceOverrides, [{ originalDate: slots[2], roundUpSkipped: false }])

console.log(failures === 0 ? '\nALL PASS' : `\nFAIL: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
