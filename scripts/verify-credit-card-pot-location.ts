// 2026-09-16 (Adam-reported, urgent) — two credit card bugs, on mum's real backup.
//
// Bug 3: Santander's £91.24 minimum payment due 14 Oct never appeared on her
// Personal ledger (Borrowing showed it). PROMPT-01's mechanism-6 fix lived in
// buildCreditCardMinimumChargeRows only. projection.ts starts generation at the
// current cycle's start, 14 Sep, the same day her £228.07 payment cleared, so
// the simulation deducted that payment twice and a 100% card reached £0.
// Section 1 fails against the pre-fix code.
//
// Bug 2: a card's minimum payment couldn't be paid from a Pot. CreditCard now
// has location/potId, moved from a chosen payment like a loan. Sections 2–6
// check every consumer: Personal and pot ledgers, auto-clear, the card's own
// rows, the pot-delete guard, the load-time backstop and Salary Sort.
//
// Run under TZ=Europe/London AND TZ=UTC (APP-KNOWLEDGE §2).

import { readFileSync } from 'node:fs'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { computeProjection } from '../src/lib/projection'
import { computePotProjection } from '../src/lib/potLedger'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { buildCreditCardMinimumChargeRows, nextMinimumChargeAmount } from '../src/lib/creditCards'
import { applyCreditCardLocationChange } from '../src/lib/locationChange'
import { blockerTargetOptions, findDeleteBlockers, removePotFromData, resolveBlockersAndDelete } from '../src/lib/deleteReassign'
import { reconcilePersonReferences } from '../src/lib/household'
import { dueAmountForLocation } from '../src/lib/salarySortLedger'
import type { AppDataV2, Pot, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const MUM = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15-mum.json'
const base = parseLedgerBackupJson(readFileSync(MUM, 'utf8'))
const PID = base.primaryPersonId!
const PAY = base.payCycles.find((p) => p.personId === PID)!
const SANTANDER = 'lhF0fbR8'
const NATWEST = 'M2Ak3QNc'
const ASOF = new Date('2026-09-16T12:00:00')

const cardRows = (txs: Transaction[], cardId: string) =>
  txs.filter((t) => t.creditCardId === cardId && t.type === 'credit_card_payment').map((t) => `${t.date} ${t.amount} ${t.status}`)
const personal = (data: AppDataV2, asOf = ASOF) => computeProjection(data, PID, PAY, 'three_cycles', asOf)

console.log(`TZ=${process.env.TZ ?? '(system)'}`)

// ── 1. Bug 3: the Personal ledger generates the £91.24 ─────────────────
console.log('\n1. Personal ledger includes Santander 14 Oct')
{
  const p = personal(base)
  check('Santander rows on Personal, next 3 cycles', cardRows(p.transactions, SANTANDER), ['2026-09-14 228.07 cleared', '2026-10-14 91.24 pending'])
  check('Natwest rows unchanged', cardRows(p.transactions, NATWEST), ['2026-09-14 200 cleared', '2026-10-14 200 pending', '2026-11-14 200 pending', '2026-12-14 200 pending'])
  check('Projected balance includes the £91.24 (was 2586.07)', p.projectedBalance, 2494.83)
  check('Cleared balance unchanged', p.clearedBalance, 1482.47)
  // Times either side of midnight, where a UTC/local slip moves a date.
  for (const t of ['2026-09-14T00:30:00', '2026-09-14T23:30:00', '2026-09-15T00:05:00', '2026-10-13T23:59:00']) {
    check(`Santander 14 Oct present at asOf ${t}`, personal(base, new Date(t)).transactions.some((x) => x.creditCardId === SANTANDER && x.date === '2026-10-14' && x.amount === 91.24), true)
  }
  const santander = base.creditCards.find((c) => c.id === SANTANDER)!
  check('nextMinimumChargeAmount on the payment day itself (stored payment that day)', nextMinimumChargeAmount(santander, base.transactions, new Date('2026-09-14T12:00:00')), 91.24)
  check(
    'Borrowing rows unchanged by moving the guard into the generator',
    buildCreditCardMinimumChargeRows(santander, base.transactions, ASOF).map((r) => `${r.date} ${r.amount}`),
    ['2026-09-14 228.07', '2026-10-14 91.24'],
  )
  const cleared = autoClearDuePayments(base, new Date('2026-10-14T09:00:00'))
  check('Auto-clear on 14 Oct materialises the £91.24 once, on Personal', cleared.transactions.filter((t) => t.creditCardId === SANTANDER && t.date === '2026-10-14').map((t) => `${t.amount} ${t.status} ${t.location}`), ['91.24 cleared personal'])
  const again = autoClearDuePayments(cleared, new Date('2026-10-14T18:00:00'))
  check('Auto-clear again the same day adds nothing', again.transactions.length, cleared.transactions.length)
}

// ── 2. Bug 2: move Santander's minimum payment to a pot, from 14 Oct ───
const POT: Pot = { id: 'pot-test', personId: PID, name: 'Test pot', openingBalance: 0, openingDate: '2026-09-01', color: '#000' } as Pot
const withPot: AppDataV2 = { ...base, pots: [POT] }
const potProj = (data: AppDataV2) => computePotProjection(data, POT, 'three_cycles', ASOF)

console.log('\n2. Moved from an upcoming payment (14 Oct)')
const fromOct = applyCreditCardLocationChange(withPot, SANTANDER, 'pot', '2026-10-14', POT.id)
{
  const card = fromOct.creditCards.find((c) => c.id === SANTANDER)!
  check('Card location recorded', [card.location, card.potId, card.locationEffectiveFrom], ['pot', POT.id, '2026-10-14'])
  check('Previous location kept in history', card.locationHistory, [{ effectiveFrom: '2026-08-17', location: 'personal' }])
  check('14 Sep cleared payment stays on Personal', fromOct.transactions.filter((t) => t.creditCardId === SANTANDER && t.date === '2026-09-14').map((t) => t.location), ['personal'])
  const p = personal(fromOct)
  check('Personal no longer has the 14 Oct payment', cardRows(p.transactions, SANTANDER), ['2026-09-14 228.07 cleared'])
  check('Personal projected goes back up by £91.24', p.projectedBalance, 2586.07)
  check('Natwest untouched on Personal', cardRows(p.transactions, NATWEST).length, 4)
  const pp = potProj(fromOct)
  check('Pot ledger has the 14 Oct payment', cardRows(pp.transactions, SANTANDER), ['2026-10-14 91.24 pending'])
  check('Pot projected balance', pp.projectedBalance, -91.24)
  check('Pot cleared balance', pp.clearedBalance, 0)
  check(
    "Card's own rows don't change with where it's paid from",
    buildCreditCardMinimumChargeRows(fromOct.creditCards.find((c) => c.id === SANTANDER)!, fromOct.transactions, ASOF).map((r) => `${r.date} ${r.amount}`),
    ['2026-09-14 228.07', '2026-10-14 91.24'],
  )
  check('Nothing counted twice: Personal + pot projected = unmoved Personal projected', Math.round((p.projectedBalance + pp.projectedBalance) * 100) / 100, 2494.83)
}

// ── 3. Moved from an already-cleared payment (14 Sep) ──────────────────
console.log('\n3. Moved from a cleared payment (14 Sep)')
{
  const fromSep = applyCreditCardLocationChange(withPot, SANTANDER, 'pot', '2026-09-14', POT.id)
  check('14 Sep cleared payment moves to the pot', fromSep.transactions.filter((t) => t.creditCardId === SANTANDER && t.date === '2026-09-14').map((t) => `${t.location} ${t.potId}`), [`pot ${POT.id}`])
  check('Natwest 14 Sep untouched', fromSep.transactions.filter((t) => t.creditCardId === NATWEST && t.date === '2026-09-14').map((t) => t.location), ['personal'])
  check('Personal cleared balance gains £228.07', personal(fromSep).clearedBalance, 1710.54)
  check('Pot cleared balance loses £228.07', potProj(fromSep).clearedBalance, -228.07)
  const back = applyCreditCardLocationChange(fromSep, SANTANDER, 'personal', '2026-09-14')
  check('Moving back restores Personal exactly', [personal(back).clearedBalance, personal(back).projectedBalance], [1482.47, 2494.83])
  check('History records both moves', back.creditCards.find((c) => c.id === SANTANDER)!.locationHistory?.map((h) => `${h.effectiveFrom} ${h.location}`), ['2026-08-17 personal', '2026-09-14 pot'])
}

// ── 4. Auto-clear settles a pot-funded minimum payment in the pot ──────
console.log('\n4. Auto-clear')
{
  const cleared = autoClearDuePayments(fromOct, new Date('2026-10-14T09:00:00'))
  check('Materialised once, into the pot', cleared.transactions.filter((t) => t.creditCardId === SANTANDER && t.date === '2026-10-14').map((t) => `${t.amount} ${t.status} ${t.location} ${t.potId}`), [`91.24 cleared pot ${POT.id}`])
  const again = autoClearDuePayments(cleared, new Date('2026-10-15T09:00:00'))
  check('No duplicate the next day', again.transactions.filter((t) => t.creditCardId === SANTANDER && t.date === '2026-10-14').length, 1)
  check('Natwest 14 Oct still clears on Personal', cleared.transactions.filter((t) => t.creditCardId === NATWEST && t.date === '2026-10-14').map((t) => t.location), ['personal'])
}

// ── 5. Deleting the pot ────────────────────────────────────────────────
console.log('\n5. Pot delete guard and backstop')
{
  const blockers = findDeleteBlockers(fromOct, { type: 'pot', id: POT.id })
  const cardBlocker = blockers.find((b) => b.entity === 'creditCard')
  check('The card blocks the pot delete', cardBlocker ? [cardBlocker.id, cardBlocker.name] : null, [SANTANDER, 'Santander'])
  check('Can move to Personal', blockerTargetOptions(fromOct, { type: 'pot', id: POT.id }, cardBlocker!).map((o) => o.label), ['Personal'])
  const personalOption = blockerTargetOptions(fromOct, { type: 'pot', id: POT.id }, cardBlocker!)[0]
  const deleted = resolveBlockersAndDelete(fromOct, { type: 'pot', id: POT.id }, [[cardBlocker!.key, { type: 'reassign', target: personalOption.target }]], '2026-09-16')
  check('Pot deleted after moving the card', deleted.pots.length, 0)
  check('Card back on Personal', [deleted.creditCards.find((c) => c.id === SANTANDER)!.location, deleted.creditCards.find((c) => c.id === SANTANDER)!.potId], ['personal', undefined])
  check('Personal projection restored', personal(deleted).projectedBalance, 2494.83)
  const removed = removePotFromData(fromOct, POT.id, '2026-09-16')
  check('removePotFromData falls the card back to Personal', removed.creditCards.find((c) => c.id === SANTANDER)!.location, 'personal')
  const imported = reconcilePersonReferences({ ...fromOct, pots: [] })
  check('Load-time backstop: a card pointing at a missing pot pays from Personal', [imported.creditCards.find((c) => c.id === SANTANDER)!.location, imported.creditCards.find((c) => c.id === SANTANDER)!.potId], ['personal', undefined])
}

// ── 6. Salary Sort counts the pot's card payment ───────────────────────
console.log('\n6. Salary Sort')
{
  const window = { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31) }
  check("October's amount due into the pot includes the card payment", dueAmountForLocation(fromOct, { type: 'pot', potId: POT.id }, window), 91.24)
  check('Nothing due into the pot before the move', dueAmountForLocation(withPot, { type: 'pot', potId: POT.id }, window), 0)
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
if (failures > 0) process.exit(1)
