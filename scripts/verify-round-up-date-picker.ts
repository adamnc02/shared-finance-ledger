// PROMPT-13a Part B — the round-up switch's effective-from is a plain
// CALENDAR DATE, not one of that person's paydays.
//
// Adam, 2026-09-22: *"The effective from for transactions is the pay cycle
// picker — likely inherited from when this toggle starts on the salary
// form — it should be a date picker. It did however block round ups until
// that date correctly, so we just need to give roundups on/off its own
// date picker effective from, which doesn't affect the salary."*
//
// So the RULES were already right and only the control was wrong. Nothing
// in `roundUpEnabledOn`, `applyRoundUpChange`, the history shape or any
// stored row changes — `verify-round-up-effective-dates.ts` still owns
// those and must stay green untouched. This script owns what the picker
// change makes newly REACHABLE.
//
// WHAT FAILS AGAINST THE PRE-CHANGE CODE: the two source checks in §3.
// `Salary.tsx` passed `occurrences={roundUp.occurrences}` /
// `occurrences={paydayOccurrences}` and guarded the flow on
// `paydayOccurrences.length > 0`; `EffectiveDatedChangeFlow` had no
// `datePicker` prop at all. §2's control reproduces that guard in full and
// shows it writing nothing.
//
// 🚨 THE TWO BUGS THIS SCRIPT EXISTS FOR — both worse than the wording,
// and both a consequence of borrowing the payday picker:
//
//  1. A person with NO SALARY CONFIGURED could not switch round-ups on
//     from the Coin Jar at all. `coinJarRoundUpProps` passed
//     `occurrences: []` when `hasSalaryConfigured` was false, and the date
//     step renders one button PER OCCURRENCE — a sheet with a
//     description, no options, and Cancel. A control that cannot do the
//     thing it offers.
//  2. From the pay cycle settings the same person's toggle SILENTLY DID
//     NOTHING: `if (roundUpChanged && paydayOccurrences.length > 0)` was
//     false, `onChangeRoundUp` was never called, and the draft died on
//     close — while the comment directly above it claimed "the switch
//     never commits without a date, so this step cannot be skipped".
//
// 🚨 WHAT MUST NOT CHANGE: a PAYDAY change keeps the occurrence picker. It
// re-dates stored salary, so it has to land on a payday a salary actually
// falls on. A round-up switch re-dates nothing (§1.19d B3), which is the
// whole reason any calendar date is legitimate for it. §3 pins both.

import { readFileSync } from 'node:fs'
import { applyRoundUpChange, roundUpEnabledOn, roundUpFields } from '../src/lib/roundUp'
import { recentAndUpcomingPaydayDates } from '../src/lib/salaryLedger'
import { hasSalaryConfigured } from '../src/lib/household'
import type { PayCycleConfig, Person, Transaction } from '../src/types/ledger'

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

const candidate = (date: string): Pick<Transaction, 'type' | 'paymentMethod' | 'location' | 'date' | 'creditCardId' | 'roundUpSkipped'> & { amount: number } => ({
  type: 'expense',
  paymentMethod: 'card',
  location: 'personal',
  date,
  creditCardId: undefined,
  roundUpSkipped: undefined,
  amount: 7.5,
})

// ── §1 — a non-payday date resolves exactly as a payday one ──────────────
//
// The point of the whole change: the 12th of the month is not a payday for
// anyone here, and the rules must not care. Asserted as an EQUALITY against
// the payday-dated switch rather than as a list of true/falses, so an
// implementation that quietly snapped the date to the nearest payday would
// fail rather than coincidentally agree.
console.log('\n── B: a switch on a NON-PAYDAY date behaves identically ──')

const onPayday = { ...base, ...applyRoundUpChange(base, true, '2026-03-28') }
const onAnyDay = { ...base, ...applyRoundUpChange(base, true, '2026-03-12') }

check('the chosen date is stored verbatim, not snapped to a payday', onAnyDay.roundUpEffectiveFrom, '2026-03-12')
check('the 12th itself is on (inclusive), like any effective-from', roundUpEnabledOn(onAnyDay, '2026-03-12'), true)
check('the day before is off', roundUpEnabledOn(onAnyDay, '2026-03-11'), false)
check('a row on the 12th rounds', roundUpFields(candidate('2026-03-12'), onAnyDay, 'jar1'), { amount: 8, roundedFrom: 7.5, roundingPotId: 'jar1' })
check('a row on the 11th does not', roundUpFields(candidate('2026-03-11'), onAnyDay, 'jar1'), { amount: 7.5, roundedFrom: undefined, roundingPotId: undefined })
// The two configs differ only in their date; every rule around them must
// be the same shape. A payday-dated switch writes no history on a first
// enable, so neither may a calendar-dated one.
check('the history shape is identical to a payday-dated switch', [onAnyDay.roundUpHistory, onPayday.roundUpHistory], [undefined, undefined])
check('...and so is every field except the date', { ...onAnyDay, roundUpEffectiveFrom: 'x' }, { ...onPayday, roundUpEffectiveFrom: 'x' })
// The mirror case: OFF on a non-payday, on top of an existing window.
const offMidMonth = { ...onAnyDay, ...applyRoundUpChange(onAnyDay, false, '2026-06-09') }
check('switching OFF mid-month records the window that really ran', offMidMonth.roundUpHistory, [{ enabled: true, from: '2026-03-12', until: '2026-06-09', nextRuleFrom: '2026-06-09' }])
check('the last day of the window still rounds', roundUpEnabledOn(offMidMonth, '2026-06-08'), true)
check('the off-date itself does not', roundUpEnabledOn(offMidMonth, '2026-06-09'), false)

// ── §2 — a person with NO SALARY can switch round-ups on ─────────────────
//
// The failing case, with the OLD gate reproduced beside it as the control.
console.log('\n── B3: a person with no salary configured ──')

const noSalary: Pick<Person, 'salaryHistory'> = { salaryHistory: [] }
const occurrences = hasSalaryConfigured(noSalary) ? recentAndUpcomingPaydayDates(base, new Date('2026-09-22')) : []
check('such a person has no paydays to offer', occurrences.length, 0)

// CONTROL — the pre-change code, in full: the flow only opened when there
// was at least one occurrence, so nothing was ever committed.
const oldFlowCommits = occurrences.length > 0
const oldResult = oldFlowCommits ? { ...base, ...applyRoundUpChange(base, true, '2026-09-22') } : base
check('CONTROL: the old guard never opened the flow', oldFlowCommits, false)
check('CONTROL: ...so the switch wrote nothing and silently reverted', oldResult.roundUpEffectiveFrom, undefined)
check('CONTROL: ...and rounding stayed off on every date', roundUpEnabledOn(oldResult, '2026-09-22'), false)

// The date step needs no occurrence, so the flow is entered unconditionally.
const newResult = { ...base, ...applyRoundUpChange(base, true, '2026-09-22') }
check('the switch now commits on the chosen date', newResult.roundUpEffectiveFrom, '2026-09-22')
check('...and rounding is genuinely on from it', roundUpEnabledOn(newResult, '2026-09-22'), true)
check('...with a real row rounding into the jar', roundUpFields(candidate('2026-09-22'), newResult, 'jar1'), { amount: 8, roundedFrom: 7.5, roundingPotId: 'jar1' })

// ── §3 — an OFF date at or before the current rule's start ───────────────
//
// `applyRoundUpChange` already handled this; it was simply unreachable
// while only paydays could be chosen, because turning the switch on and
// off again inside one payday gap was not expressible. Pinned here, since
// the calendar makes it a couple of taps away.
console.log('\n── B: off, dated at or before the rule it ends ──')

const sameDayOff = { ...onAnyDay, ...applyRoundUpChange(onAnyDay, false, '2026-03-12') }
check('no zero-width history entry is written', sameDayOff.roundUpHistory, undefined)
check('the rule is REPLACED, not layered on', sameDayOff.roundUpEffectiveFrom, '2026-03-12')
check('...so nothing ever rounded in that window', [roundUpEnabledOn(sameDayOff, '2026-03-12'), roundUpEnabledOn(sameDayOff, '2026-04-01')], [false, false])

const earlierOff = { ...onAnyDay, ...applyRoundUpChange(onAnyDay, false, '2026-03-01') }
check('an off-date BEFORE the on-date replaces it too', earlierOff.roundUpHistory, undefined)
check('...and leaves rounding off on the old on-date', roundUpEnabledOn(earlierOff, '2026-03-12'), false)

// ── §4 — the source: which flow gets which picker ────────────────────────
console.log('\n── B: the date picker is wired to round-ups, and ONLY to round-ups ──')

const read = (p: string) => readFileSync(`${process.cwd()}/${p}`, 'utf8')
const flow = read('src/components/EffectiveDatedChangeFlow.tsx')
const salary = read('src/pages/Salary.tsx')

check('the shared flow has a calendar mode', flow.includes('datePicker?: { label: string; defaultDate: string }'), true)
check('...rendered through EditField, the app’s date idiom', /step === 'date' && datePicker[\s\S]{0,1400}type="date"/.test(flow), true)
check('...with its own Continue, since a calendar advances nothing by itself', flow.includes('commitLabel="Continue"'), true)
check('...disabled while the field is empty', flow.includes('commitDisabled={!pickedDate}'), true)
check('...and the occurrence list untouched for every other caller', flow.includes('{occurrences.map((o) => ('), true)

// Both homes of the toggle (§1.19e-2) — fixing only the one that was
// tested is exactly the "same fix applied to a similar component" trap.
check('BOTH round-up flows pass a datePicker', salary.split("datePicker={{ label: 'Effective from', defaultDate: todayIso() }}").length - 1, 2)
check('neither round-up flow passes paydays any more', /roundUp\.occurrences|occurrences: cycle && owner/.test(salary), false)
check('the settings flow is no longer gated on having paydays', salary.includes('if (roundUpChanged && paydayOccurrences.length > 0)'), false)
check('...it opens whenever the switch moved', salary.includes('if (roundUpChanged) {\n      setChoosingRoundUpFrom(true)'), true)

// The same silent-skip shape, one layer down: setRoundUp used to bail with
// `if (!payCycle) return prev` for a person with no PayCycleConfig row.
// addPerson always writes one, but migrateLedgerData does not backfill,
// so a restored backup can reach it without one — and the switch would
// again do nothing, quietly.
const context = read('src/context/LedgerContext.tsx')
// Matched as CODE, not as text: the comment above the fix quotes the old
// guard verbatim, on purpose, so a bare `includes` would find it.
check('setRoundUp no longer bails silently on a missing pay cycle', /\n\s*if \(!payCycle\) return prev/.test(context), false)
check('...it creates the default config instead, like updatePayCycle', /setRoundUp[\s\S]{0,1600}\?\? defaultPayCycleConfig\(personId\)/.test(context), true)
check('...and migrateLedgerData still does not backfill, which is why', read('src/lib/ledgerStorage.ts').includes('payCycles: data.payCycles ?? []'), true)

// 🚨 The payday change KEEPS its occurrence picker.
check('a PAYDAY change still picks a real payday', salary.includes('occurrences={paydayOccurrences}'), true)
check('...and is still gated on there being one to pick', salary.includes('if (paydayChanged && paydayOccurrences.length > 0)'), true)
// The other occurrence-driven callers, untouched by this change.
check('bills still pick an occurrence', read('src/pages/Bills.tsx').includes('occurrences={'), true)
check('loans still pick an occurrence', read('src/pages/Loans.tsx').includes('occurrences={'), true)

console.log(failures === 0 ? '\n✅ All round-up date-picker checks passed\n' : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
