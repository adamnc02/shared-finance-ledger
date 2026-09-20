// PROMPT-13 Part B1 — the acceptance gate for WHAT GETS ROUNDED.
//
// The predicate, in full:
//
//     t.type === 'expense' && t.paymentMethod === 'card' && t.location === 'personal'
//     && !t.creditCardId && roundUpEnabledOn(payCycle, t.date) && uplift > 0
//
// WHAT FAILS AGAINST THE PRE-CHANGE CODE: `src/lib/roundUp.ts` did not
// exist, so this script dies on the import against PROMPT-12's tree
// (proven by running it against a read-only export of `main`).
//
// Every clause below is asserted INDEPENDENTLY, each against a CONTROL
// that differs from it in exactly that one field and DOES round. That
// pairing is the whole design of this script: an assertion that "a cash
// expense is not rounded" proves nothing on its own — an implementation
// that rounds nothing at all passes it. The control proves the clause is
// the reason.
//
// The wrong implementations this is built to catch:
//  - `paymentMethod === 'card'` WITHOUT `type === 'expense'`, which is
//    the exact fallthrough PROMPT-08a Part B already had to remove once:
//    it would round credit-card spends and card-paid bills.
//  - Rounding on `direction === 'out'`, which sweeps in bills, loan
//    payments and credit-card payments.
//  - Forgetting `location === 'personal'`, which rounds money spent from
//    a pot or the joint account into a personal jar.
//  - Rounding an exact pound and writing a £0.00 credit to the jar.
//  - Ignoring the effective date, which is the B3 violation — it would
//    reach back and round rows logged before the switch was ever on.

import { shouldRoundUp, roundUpTarget, roundUpUplift, roundUpFields, roundUpEnabledOn, roundUpAvailable } from '../src/lib/roundUp'
import type { PayCycleConfig, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

// Rounding on since well before every date used below.
const ON: PayCycleConfig = {
  personId: 'p1',
  openingBalance: 0,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: false,
  cycleStartDayOfMonth: 1,
  roundUpEnabled: true,
  roundUpEffectiveFrom: '2026-01-01',
}

type Candidate = Parameters<typeof shouldRoundUp>[0]
/** The CONTROL: a personal, card-paid, ad-hoc expense of £7.50. This rounds. */
const base: Candidate = { type: 'expense', paymentMethod: 'card', location: 'personal', date: '2026-09-20', amount: 7.5, creditCardId: undefined }

console.log('\n── B1: the control rounds ──')
check('a personal card expense of £7.50 rounds', shouldRoundUp(base, ON), true)
check('...to £8.00', roundUpTarget(7.5), 8)
check('...contributing a 50p uplift', roundUpUplift(7.5), 0.5)

console.log('\n── B1: clause 1 — type === "expense" ──')
// Each of these differs from the control in `type` ALONE.
for (const type of ['bill_payment', 'loan_payment', 'credit_card_payment', 'credit_card_spend', 'transfer', 'salary', 'income', 'bonus', 'pension_income', 'pot_deposit', 'pot_withdrawal', 'savings_deposit'] as const) {
  check(`a "${type}" is NOT rounded`, shouldRoundUp({ ...base, type: type as Transaction['type'] }, ON), false)
}
// The control, restated immediately after, so a blanket-false
// implementation cannot pass the block above.
check('CONTROL: "expense" still rounds', shouldRoundUp(base, ON), true)

console.log('\n── B1: clause 2 — paymentMethod === "card" ──')
for (const pm of ['cash', 'bank_transfer', 'direct_debit', 'standing_order'] as const) {
  check(`a card-less "${pm}" expense is NOT rounded`, shouldRoundUp({ ...base, paymentMethod: pm }, ON), false)
}
check('CONTROL: "card" still rounds', shouldRoundUp({ ...base, paymentMethod: 'card' }, ON), true)

console.log('\n── B1: clause 3 — location === "personal" ──')
for (const loc of ['pot', 'joint', 'savings'] as const) {
  check(`an expense located in "${loc}" is NOT rounded`, shouldRoundUp({ ...base, location: loc as Transaction['location'] }, ON), false)
}
check('CONTROL: "personal" still rounds', shouldRoundUp({ ...base, location: 'personal' }, ON), true)

console.log('\n── B1: clause 4 — no creditCardId (prompt doc §0c assumption 1) ──')
// A charge to a credit card is `credit_card_spend`, so this should be
// unreachable for a correctly-created row — but the edit path can attach
// a card id, and a credit-card charge is not money leaving the current
// account, so rounding it would credit the jar against cash that never
// moved.
check('an expense carrying a creditCardId is NOT rounded', shouldRoundUp({ ...base, creditCardId: 'cc1' }, ON), false)
check('CONTROL: the same row without one still rounds', shouldRoundUp({ ...base, creditCardId: undefined }, ON), true)

console.log('\n── B1: an exact pound is not rounded (Adam: "correct, exact £ transactions do not get rounded") ──')
check('£8.00 is NOT rounded', shouldRoundUp({ ...base, amount: 8 }, ON), false)
check('...and yields a zero uplift, not a £0.00 credit row', roundUpUplift(8), 0)
check('£0.00 is NOT rounded', shouldRoundUp({ ...base, amount: 0 }, ON), false)
check('CONTROL: £8.01 IS rounded', shouldRoundUp({ ...base, amount: 8.01 }, ON), true)
check('...to £9.00, a 99p uplift', [roundUpTarget(8.01), roundUpUplift(8.01)], [9, 0.99])
check('a penny under the pound rounds to the pound, a 1p uplift', [roundUpTarget(7.99), roundUpUplift(7.99)], [8, 0.01])
// Float noise must not round £7.50 up to £9.
check('float noise does not gain a whole pound', roundUpTarget(7.500000000000001), 8)

console.log('\n── B1: the switch has to be on, on that row’s own date ──')
check('rounding off → not rounded', shouldRoundUp(base, { ...ON, roundUpEnabled: false }), false)
check('no pay cycle at all → not rounded', shouldRoundUp(base, undefined), false)
// An enabled switch with no effective-from is malformed data (B4 makes
// the date required); the safe reading is "do not round".
check('enabled but with no effective-from → not rounded', shouldRoundUp(base, { ...ON, roundUpEffectiveFrom: undefined }), false)
check('a row dated BEFORE the effective-from → not rounded', shouldRoundUp({ ...base, date: '2025-12-31' }, ON), false)
check('a row dated ON the effective-from → rounded (inclusive)', shouldRoundUp({ ...base, date: '2026-01-01' }, ON), true)

console.log('\n── B1: roundUpFields writes the right three values ──')
check('a rounding row stores the rounded amount and what it came from', roundUpFields(base, ON, 'jar1'), { amount: 8, roundedFrom: 7.5, roundingPotId: 'jar1' })
// The explicit undefineds matter: an edit that stops qualifying must
// CLEAR a previously-set pair, not leave it crediting a jar forever.
check('a non-qualifying row clears both fields explicitly', roundUpFields({ ...base, paymentMethod: 'cash' }, ON, 'jar1'), { amount: 7.5, roundedFrom: undefined, roundingPotId: undefined })
check('an exact pound stores no roundedFrom', roundUpFields({ ...base, amount: 8 }, ON, 'jar1'), { amount: 8, roundedFrom: undefined, roundingPotId: undefined })
// No jar (the person has never switched rounding on) — nothing rounds,
// and nothing points at a pot that does not exist.
check('no Coin Jar → nothing is rounded', roundUpFields(base, ON, undefined), { amount: 7.5, roundedFrom: undefined, roundingPotId: undefined })

console.log('\n── B1: roundUpEnabledOn is date-resolved, not a bare flag ──')
check('a bare disabled config is off on any date', roundUpEnabledOn({ ...ON, roundUpEnabled: false }, '2026-09-20'), false)
check('undefined config is off', roundUpEnabledOn(undefined, '2026-09-20'), false)

// ── B1a (Adam, 2026-09-20) — the per-transaction opt-out ─────────────────
//
// "the per transaction level ability to ignore rounding ONLY if the coin
// jar exists. By default, the value should be set to round up if the toggle
// is on. But I can turn it off per transaction."
//
// 🚨 WHY IT IS A STORED FIELD AND NOT A UI-ONLY CHOICE. On a saved row,
// "was not rounded" and "was DELIBERATELY not rounded" are indistinguishable
// — both simply lack `roundedFrom`. `roundUpFields` recomputes from the
// rules every time a row is saved, so without a stored flag, editing the
// note on an excluded row would silently round it after all. That is the
// failure this section exists to pin.
console.log('\n── B1a: the per-transaction opt-out ──')

check('the control row still rounds by DEFAULT — no decision needed', shouldRoundUp(base, ON), true)
check('...and an undefined flag is the same as rounding', shouldRoundUp({ ...base, roundUpSkipped: undefined }, ON), true)
check('...and an explicit false is too', shouldRoundUp({ ...base, roundUpSkipped: false }, ON), true)
check('a skipped row does NOT round', shouldRoundUp({ ...base, roundUpSkipped: true }, ON), false)
check('...and stores no roundedFrom or pot id', roundUpFields({ ...base, roundUpSkipped: true }, ON, 'jar1'), { amount: 7.5, roundedFrom: undefined, roundingPotId: undefined })
// 🚨 The re-round trap: saving an excluded row again must leave it alone.
check('🚨 re-saving a skipped row does not round it after all', roundUpFields({ ...base, roundUpSkipped: true, amount: 7.5 }, ON, 'jar1').roundedFrom, undefined)
check('...and clearing the flag rounds it again', roundUpFields({ ...base, roundUpSkipped: false }, ON, 'jar1'), { amount: 8, roundedFrom: 7.5, roundingPotId: 'jar1' })

console.log('\n── B1a: when the control is OFFERED (roundUpAvailable) ──')
// Adam's three conditions, plus the jar, plus the switch. Each is checked
// against the control, which IS offered.
check('CONTROL: a personal card expense with a jar offers it', roundUpAvailable(base, ON, 'jar1'), true)
check('🚨 no Coin Jar → never offered ("ONLY if the coin jar exists")', roundUpAvailable(base, ON, undefined), false)
check('rounding switched off → not offered (it would decide nothing)', roundUpAvailable(base, { ...ON, roundUpEnabled: false }, 'jar1'), false)
check('a date outside the enabled window → not offered', roundUpAvailable({ ...base, date: '2025-12-31' }, ON, 'jar1'), false)
check('not an expense → not offered', roundUpAvailable({ ...base, type: 'income' }, ON, 'jar1'), false)
check('not card → not offered', roundUpAvailable({ ...base, paymentMethod: 'cash' }, ON, 'jar1'), false)
check('not personal → not offered', roundUpAvailable({ ...base, location: 'joint' }, ON, 'jar1'), false)
check('a credit-card charge → not offered', roundUpAvailable({ ...base, creditCardId: 'cc1' }, ON, 'jar1'), false)

// Deliberately NOT gated on the amount: an exact pound still OFFERS the
// control, so it does not blink in and out as a figure is typed in the edit
// form. The wizard checks the uplift itself, because it has nothing to ask
// when there is nothing to round.
check('an exact pound still OFFERS the control (visibility follows shape, not amount)', roundUpAvailable({ ...base, amount: 8 }, ON, 'jar1'), true)
check('...though there is nothing for it to do', roundUpUplift(8), 0)
// And a row that already opted out must still offer it, or there would be
// no way back in.
check('🚨 an already-skipped row STILL offers the control, or you could never opt back in', roundUpAvailable({ ...base, roundUpSkipped: true } as never, ON, 'jar1'), true)

console.log(failures === 0 ? '\n✅ All round-up predicate checks passed\n' : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
