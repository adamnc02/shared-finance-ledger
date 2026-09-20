// PROMPT-13 Part B2 — the acceptance gate for the DERIVED Coin Jar
// credit, and for the one thing that must never happen because of it.
//
// A £7.50 shop reads −£8.00 in the personal ledger and +£0.50 in Coin
// Jar. £7.50 leaves net worth; 50p moves.
//
// WHAT FAILS AGAINST THE PRE-CHANGE CODE: `src/lib/roundUp.ts` did not
// exist and `coinJarCreditRows` was not exported from potLedger.ts, so
// this script dies on the import against PROMPT-12's tree (proven by
// running it against a read-only export of `main`).
//
// 🚨 THE CHECK THIS SCRIPT EXISTS FOR: THE UPLIFT MUST NOT REACH THE
// PERSONAL CASH BALANCE TWICE. `computeProjectionToDate` sums
// `signedAmount(t)` over personal rows, and `amount` is ALREADY £8.00 —
// so the correct implementation is the one that changes NOTHING in that
// path. The plausible wrong implementation is a well-meaning addition:
// somebody wires the uplift into the personal ledger "so it balances",
// and a £7.50 shop takes £8.50 out of personal cash. Asserted directly,
// against a control with rounding off, so the figure cannot drift.
//
// The other wrong implementations caught here:
//  - Storing a second transaction for the credit (Adam chose the DERIVED
//    option) — deleting the expense would then leave the 50p behind
//    forever. The delete case proves it does not.
//  - Crediting the jar with `amount` (£8.00) instead of the uplift
//    (£0.50), which is the single easiest slip in the whole of Part B.
//  - Ignoring the jar's `openingDate`, so a rounded expense from before
//    the jar existed silently counts.
//  - Letting an edit leave a stale `roundedFrom` behind.

import { coinJarCreditRows, potBalanceAsOf, computePotProjection, buildPotScheduleRows } from '../src/lib/potLedger'
import { roundUpFields, storedUplift, unroundedAmount, findCoinJar } from '../src/lib/roundUp'
import { computeProjection } from '../src/lib/projection'
import type { AppDataV2, PayCycleConfig, Pot, Transaction } from '../src/types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100
let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const PERSON = 'p1'
const JAR = 'jar1'
const TODAY = new Date(2026, 8, 20) // 2026-09-20

const payCycle: PayCycleConfig = {
  personId: PERSON,
  openingBalance: 1000,
  openingBalanceDate: '2026-09-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: false,
  cycleStartDayOfMonth: 1,
  roundUpEnabled: true,
  roundUpEffectiveFrom: '2026-09-01',
}

const jar: Pot = {
  id: JAR,
  personId: PERSON,
  name: 'Coin Jar',
  openingBalance: 0,
  openingDate: '2026-09-01',
  active: true,
  color: '#f5a524',
  isCoinJar: true,
}

/** A £7.50 personal card expense, put through the real round-up path. */
function shop(id: string, price: number, date = '2026-09-10', status: Transaction['status'] = 'cleared'): Transaction {
  const draft = { type: 'expense' as const, paymentMethod: 'card' as const, location: 'personal' as const, date, amount: price, creditCardId: undefined }
  const fields = roundUpFields(draft, payCycle, JAR)
  return {
    id,
    date,
    direction: 'out',
    categoryId: 'cat1',
    paymentMethod: 'card',
    status,
    type: 'expense',
    location: 'personal',
    ownerId: PERSON,
    note: `Shop ${id}`,
    ...fields,
  }
}

function makeData(transactions: Transaction[], pots: Pot[] = [jar]): AppDataV2 {
  return {
    people: [{ id: PERSON, name: 'Adam', salaryHistory: [], color: '#fff' } as never],
    categories: [{ id: 'cat1', name: 'Food', icon: 'shopping-cart', color: '#fff' } as never],
    recurringTemplates: [],
    loans: [],
    creditCards: [],
    pensions: [],
    savingsPots: [],
    pots,
    transactions,
    payCycles: [payCycle],
    salarySorts: [],
    scenarios: [],
    primaryPersonId: PERSON,
    jointAccount: null,
  }
}

console.log('\n── B2: one £7.50 shop — −£8.00 personal, +£0.50 Coin Jar ──')
const one = shop('t1', 7.5)
check('the stored expense amount is the ROUNDED figure', one.amount, 8)
check('...and it remembers what it was rounded from', one.roundedFrom, 7.5)
check('...and which jar it feeds', one.roundingPotId, JAR)
check('the real price is still recoverable for the edit form', unroundedAmount(one), 7.5)
check('the uplift is 50p', storedUplift(one), 0.5)

const credits = coinJarCreditRows(jar, [one])
check('exactly one derived credit row', credits.length, 1)
check('...for the UPLIFT, not the amount', credits[0].amount, 0.5)
check('...dated on the expense', credits[0].date, '2026-09-10')
check('...labelled from the expense’s own note', credits[0].note, 'Shop t1')
check('...as a pot_deposit into this jar', [credits[0].type, credits[0].potId, credits[0].location], ['pot_deposit', JAR, 'pot'])
check('...mirroring the expense’s status (§0c assumption 2)', credits[0].status, 'cleared')
check('...and carrying no rounding fields of its own, so it can never be re-rounded', [credits[0].roundedFrom, credits[0].roundingPotId], [undefined, undefined])
check('the Coin Jar balance is 50p', potBalanceAsOf(jar, [one], TODAY), 0.5)

console.log('\n── B2 🚨: the uplift never reaches personal cash twice ──')
// The SAME shop, once with rounding on and once off. Personal cash must
// differ by exactly the 50p that the rounding added to `amount` — never
// by £1.00, which is what a double count looks like.
const rounded = computeProjection(makeData([one]), PERSON, payCycle, 'current_cycle', TODAY)
const unroundedTxn: Transaction = { ...one, amount: 7.5, roundedFrom: undefined, roundingPotId: undefined }
const plain = computeProjection(makeData([unroundedTxn], []), PERSON, payCycle, 'current_cycle', TODAY)
check('personal cash moves by exactly `amount` (£8.00), never amount + uplift', round2(plain.clearedBalance - rounded.clearedBalance), 0.5)
check('...i.e. the rounded run is £8.00 down from opening, not £8.50', round2(payCycle.openingBalance - rounded.clearedBalance), 8)
check('CONTROL: the unrounded run is £7.50 down from opening', round2(payCycle.openingBalance - plain.clearedBalance), 7.5)
// And the jar's own rows must not appear on the personal ledger at all.
check('no derived credit row appears in the personal projection', rounded.transactions.filter((t) => t.id.startsWith('roundup:')).length, 0)

console.log('\n── B2: several shops, and the pennies add up ──')
const many = [shop('t1', 7.5), shop('t2', 2.01, '2026-09-11'), shop('t3', 19.99, '2026-09-12'), shop('t4', 8, '2026-09-13')]
// £0.50 + £0.99 + £0.01 = £1.50. The £8.00 exact pound contributes nothing.
check('the exact-pound shop was never marked as rounded', many[3].roundedFrom, undefined)
check('three credits, not four', coinJarCreditRows(jar, many).length, 3)
check('the jar holds £1.50', potBalanceAsOf(jar, many, TODAY), 1.5)

console.log('\n── B2: delete the expense and the credit goes with it ──')
// The whole point of the derived model. No cleanup step, no orphan.
const afterDelete = many.filter((t) => t.id !== 't2')
check('deleting the 99p shop removes its credit', coinJarCreditRows(jar, afterDelete).length, 2)
check('...and the balance falls to £0.51', potBalanceAsOf(jar, afterDelete, TODAY), 0.51)

console.log('\n── B3: editing recomputes from the REAL price ──')
// Adam: "if I have to amend a transaction, it's because I got the price
// wrong, but my banking app would have handled it correctly."
// £7.50 → £9.20 becomes £10.00 with an 80p uplift.
const editedFields = roundUpFields({ ...one, amount: 9.2 }, payCycle, JAR)
const edited: Transaction = { ...one, ...editedFields }
check('£9.20 becomes £10.00', edited.amount, 10)
check('...rounded from £9.20, not from the old £7.50', edited.roundedFrom, 9.2)
check('...an 80p uplift', storedUplift(edited), 0.8)
check('the jar follows the edit with no separate step', potBalanceAsOf(jar, [edited], TODAY), 0.8)
// An edit to an exact pound must CLEAR the fields, not leave a stale pair.
const toExactPound: Transaction = { ...one, ...roundUpFields({ ...one, amount: 12 }, payCycle, JAR) }
check('editing to an exact pound clears roundedFrom', [toExactPound.amount, toExactPound.roundedFrom, toExactPound.roundingPotId], [12, undefined, undefined])
check('...and the jar empties', potBalanceAsOf(jar, [toExactPound], TODAY), 0)
// An edit that moves it out of scope entirely must also clear.
const toCash: Transaction = { ...one, paymentMethod: 'cash', ...roundUpFields({ ...one, paymentMethod: 'cash', amount: unroundedAmount(one) }, payCycle, JAR) }
check('switching to cash clears the rounding and restores the real price', [toCash.amount, toCash.roundedFrom], [7.5, undefined])

console.log('\n── B5: the opening balance and as-of date are honoured ──')
const seeded: Pot = { ...jar, openingBalance: 12.34 }
check('an opening balance is added to the derived credits', potBalanceAsOf(seeded, [one], TODAY), 12.84)
// Nothing before openingDate counts — the same rule every other pot has.
const laterOpening: Pot = { ...jar, openingDate: '2026-09-11' }
check('a shop dated before the as-of date is ignored', potBalanceAsOf(laterOpening, [one], TODAY), 0)
check('...and produces no credit row at all', coinJarCreditRows(laterOpening, [one]).length, 0)
const negativeOpening: Pot = { ...jar, openingBalance: -5 }
check('a negative opening balance is respected, not clamped', potBalanceAsOf(negativeOpening, [one], TODAY), -4.5)

console.log('\n── B2: the jar’s own ledger and projection see the credits ──')
// NOTE on the jar used here: `buildPotScheduleRows` windows its rows
// through `schedulePotPreviewWindow`, whose ramp-up starts at
// `asOf - min(2, whole months since openingDate)`. A pot opened THIS
// calendar month therefore has a window starting today, and shows no
// past rows at all — existing, shared behaviour for every pot ("don't
// fabricate history"), not something round-ups introduce. An older jar
// is used below so the assertion exercises the real path rather than
// the empty window. Flagged in the prompt doc: a Coin Jar created today
// shows its first credits in the BALANCE and the PROJECTION (checked
// above, and what the UI actually reads) but not yet in this preview.
const olderJar: Pot = { ...jar, openingDate: '2026-06-01' }
const data = makeData(many, [olderJar])
const rows = buildPotScheduleRows(data, olderJar, TODAY)
check('the jar’s ledger shows one row per rounded expense', rows.filter((r) => r.type === 'pot_deposit').length, 3)
check('...each for its own uplift', rows.filter((r) => r.type === 'pot_deposit').map((r) => r.amount).sort(), [0.01, 0.5, 0.99])
const projection = computePotProjection(data, jar, 'current_cycle', TODAY)
check('the jar’s projection clears at £1.50', projection.clearedBalance, 1.5)
// A pending shop gives a pending credit, which must land in the
// projected figure and not the cleared one.
const withPending = [...many, shop('t5', 3.4, '2026-09-25', 'pending')]
const pendingProjection = computePotProjection(makeData(withPending), jar, 'current_cycle', TODAY)
check('a pending shop’s 60p is pending, not cleared', pendingProjection.clearedBalance, 1.5)
check('...and shows in the projected balance', pendingProjection.projectedBalance, 2.1)

console.log('\n── B2: a credit only ever feeds the jar it names ──')
const otherJar: Pot = { ...jar, id: 'jar2', personId: 'p2' }
check('another person’s jar gets nothing from this row', coinJarCreditRows(otherJar, [one]).length, 0)
check('...and reads £0.00', potBalanceAsOf(otherJar, [one], TODAY), 0)
// An ordinary pot never derives credits, whatever a row claims.
const ordinaryPot: Pot = { ...jar, id: JAR, isCoinJar: false }
check('a pot that is not a Coin Jar derives no credits at all', coinJarCreditRows(ordinaryPot, [one]).length, 0)
check('findCoinJar finds this person’s jar', findCoinJar([jar, otherJar], PERSON)?.id, JAR)
check('...and nothing for a person without one', findCoinJar([jar], 'p3'), undefined)

console.log(failures === 0 ? '\n✅ All Coin Jar balance checks passed\n' : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
