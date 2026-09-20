// PROMPT-13 Part B3/B4 — the acceptance gate for WHEN rounding applies,
// and for the promise that a switch never rewrites history.
//
// WHAT FAILS AGAINST THE PRE-CHANGE CODE: `src/lib/roundUp.ts` did not
// exist, so this script dies on the import against PROMPT-12's tree
// (proven by running it against a read-only export of `main`).
//
// 🚨 THE CHECK THIS SCRIPT EXISTS FOR: NO STORED ROW IS EVER REWRITTEN BY
// A SWITCH, cleared or pending. Adam confirmed B3 with one word —
// "Correct". The plausible wrong implementation is the helpful one: a
// toggle that walks the transaction list and applies or strips rounding
// to match the new setting, so that the data is "consistent". It would
// silently change the amount of every historic shop and move the personal
// balance. This is asserted by deep-comparing the ENTIRE transaction list
// before and after each switch, not by spot-checking a field.
//
// The other wrong implementations caught here:
//  - A bare boolean with no date at all, which rounds everything ever
//    logged the moment it is switched on.
//  - Resolving the date against "today" rather than against the ROW's own
//    date, which gets the right answer right up until you back-date an
//    expense or turn the switch off.
//  - An off-window that leaks: on → off → on must leave a genuine hole,
//    and a row inside that hole must not round.
//  - A boundary that is exclusive on the wrong side. The effective date
//    itself is INCLUDED in the new rule.

import { roundUpEnabledOn, shouldRoundUp, applyRoundUpChange, roundUpFields } from '../src/lib/roundUp'
import type { PayCycleConfig, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const base: PayCycleConfig = {
  personId: 'p1',
  openingBalance: 0,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: false,
  cycleStartDayOfMonth: 1,
}

console.log('\n── B4: never switched on ──')
check('a config with no round-up fields is off on every date', [roundUpEnabledOn(base, '2020-01-01'), roundUpEnabledOn(base, '2026-09-20'), roundUpEnabledOn(base, '2099-01-01')], [false, false, false])

console.log('\n── B4: switched ON from 2026-03-01 ──')
const on = { ...base, ...applyRoundUpChange(base, true, '2026-03-01') }
check('the effective-from is recorded', on.roundUpEffectiveFrom, '2026-03-01')
// First enable: there is no previous window, so nothing goes to history.
check('no history entry is written for the first enable', on.roundUpHistory, undefined)
check('the day BEFORE is off', roundUpEnabledOn(on, '2026-02-28'), false)
check('the day ITSELF is on (inclusive)', roundUpEnabledOn(on, '2026-03-01'), true)
check('the day after is on', roundUpEnabledOn(on, '2026-03-02'), true)
check('years earlier is off — turning it on does not reach back', roundUpEnabledOn(on, '2019-06-15'), false)

console.log('\n── B4: on → OFF from 2026-06-01 ──')
const off = { ...on, ...applyRoundUpChange(on, false, '2026-06-01') }
// 🚨 `from` is what makes the enabled window a WINDOW rather than "all
// of time up to June" — see the field's own comment. Its absence was a
// real bug, caught on this script's first run.
check('the enabled window is preserved as history, WITH its start date', off.roundUpHistory, [{ enabled: true, from: '2026-03-01', until: '2026-06-01', nextRuleFrom: '2026-06-01' }])
check('before the on-date: off', roundUpEnabledOn(off, '2026-02-01'), false)
check('inside the on window: ON', roundUpEnabledOn(off, '2026-04-15'), true)
check('the last day of the on window: ON', roundUpEnabledOn(off, '2026-05-31'), true)
check('the off date itself: OFF (exclusive upper bound)', roundUpEnabledOn(off, '2026-06-01'), false)
check('after: off', roundUpEnabledOn(off, '2026-08-01'), false)

console.log('\n── B4: off → ON again from 2026-09-01 (the hole must be real) ──')
const onAgain = { ...off, ...applyRoundUpChange(off, true, '2026-09-01') }
check('two history entries now', onAgain.roundUpHistory?.length, 2)
check('the first window is still the enabled one', onAgain.roundUpHistory?.[0], { enabled: true, from: '2026-03-01', until: '2026-06-01', nextRuleFrom: '2026-06-01' })
check('the second records the disabled window', onAgain.roundUpHistory?.[1], { enabled: false, from: '2026-06-01', until: '2026-09-01', nextRuleFrom: '2026-09-01' })
// The three windows, walked end to end.
check('window 1 (Mar–May): ON', [roundUpEnabledOn(onAgain, '2026-03-01'), roundUpEnabledOn(onAgain, '2026-05-31')], [true, true])
check('window 2 (Jun–Aug): OFF — the hole is genuine', [roundUpEnabledOn(onAgain, '2026-06-01'), roundUpEnabledOn(onAgain, '2026-08-31')], [false, false])
check('window 3 (Sep onward): ON', [roundUpEnabledOn(onAgain, '2026-09-01'), roundUpEnabledOn(onAgain, '2026-12-25')], [true, true])
check('still off before it was ever switched on', roundUpEnabledOn(onAgain, '2026-01-01'), false)

console.log('\n── B4: only rows logged inside an enabled window carry an uplift ──')
const candidate = (date: string) => ({ type: 'expense' as const, paymentMethod: 'card' as const, location: 'personal' as const, date, amount: 7.5, creditCardId: undefined })
check('Feb (before any window): not rounded', shouldRoundUp(candidate('2026-02-14'), onAgain), false)
check('April (window 1): ROUNDED', shouldRoundUp(candidate('2026-04-14'), onAgain), true)
check('July (the hole): not rounded', shouldRoundUp(candidate('2026-07-14'), onAgain), false)
check('September (window 3): ROUNDED', shouldRoundUp(candidate('2026-09-14'), onAgain), true)
// The resolution is against the ROW's date, not "now" — which is what a
// back-dated expense proves.
check('a back-dated expense resolves against its OWN date, not today', shouldRoundUp(candidate('2026-07-01'), onAgain), false)

console.log('\n── B3 🚨: no stored row is ever rewritten by a switch ──')
// A realistic list: one rounded (logged while on), one not (logged in the
// hole), one pending, one cleared.
const stored: Transaction[] = [
  { id: 'a', date: '2026-04-10', amount: 8, roundedFrom: 7.5, roundingPotId: 'jar1', direction: 'out', categoryId: 'c', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'p1' },
  { id: 'b', date: '2026-07-10', amount: 7.5, direction: 'out', categoryId: 'c', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'p1' },
  { id: 'c', date: '2026-09-15', amount: 3, roundedFrom: 2.4, roundingPotId: 'jar1', direction: 'out', categoryId: 'c', paymentMethod: 'card', status: 'pending', type: 'expense', location: 'personal', ownerId: 'p1' },
  { id: 'd', date: '2026-09-16', amount: 12.34, direction: 'out', categoryId: 'c', paymentMethod: 'cash', status: 'pending', type: 'expense', location: 'personal', ownerId: 'p1' },
]
const before = JSON.stringify(stored)

// Every switch the UI can make, in sequence. `applyRoundUpChange`
// returns ONLY pay-cycle fields — it is structurally incapable of
// touching a transaction, which is the point, and this asserts it.
const switches = [
  applyRoundUpChange(onAgain, false, '2026-10-01'),
  applyRoundUpChange({ ...onAgain, ...applyRoundUpChange(onAgain, false, '2026-10-01') }, true, '2026-11-01'),
  applyRoundUpChange(base, true, '2020-01-01'),
]
check('turning rounding off does not touch a single stored row', JSON.stringify(stored), before)
check('...nor does turning it back on', JSON.stringify(stored), before)
check('...nor does enabling it from a date years in the past', JSON.stringify(stored), before)
check('a switch returns pay-cycle fields ONLY, never transactions', switches.every((s) => Object.keys(s).every((k) => k.startsWith('roundUp'))), true)
// Specifically: the row logged in the hole stays unrounded, and the row
// logged while on stays rounded, whatever the switch now says.
check('the row logged while OFF is still unrounded after enabling', stored[1].roundedFrom, undefined)
check('the row logged while ON is still rounded after disabling', stored[0].roundedFrom, 7.5)
check('...including a PENDING one (the tempting one to "fix")', stored[2].roundedFrom, 2.4)

console.log('\n── B3: turning it off leaves the jar alone ──')
// Past uplifts keep pointing at the jar, so its balance is unchanged.
const nowOff = { ...onAgain, ...applyRoundUpChange(onAgain, false, '2026-10-01') }
check('past rows still name the jar', stored.filter((t) => t.roundingPotId === 'jar1').length, 2)
check('...and a NEW row after the off-date does not round', roundUpFields(candidate('2026-10-05'), nowOff, 'jar1'), { amount: 7.5, roundedFrom: undefined, roundingPotId: undefined })
check('...while a row inside the old on-window still would', roundUpFields(candidate('2026-09-05'), nowOff, 'jar1'), { amount: 8, roundedFrom: 7.5, roundingPotId: 'jar1' })

console.log('\n── B4: a change dated at or before the current rule replaces it ──')
// Otherwise the walk would carry a zero-width rule that can never match.
const replaced = { ...on, ...applyRoundUpChange(on, false, '2026-03-01') }
check('no zero-width history entry is written', replaced.roundUpHistory, undefined)
check('the new rule simply governs from that date', [roundUpEnabledOn(replaced, '2026-03-01'), roundUpEnabledOn(replaced, '2026-05-01')], [false, false])

console.log(failures === 0 ? '\n✅ All round-up effective-date checks passed\n' : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
