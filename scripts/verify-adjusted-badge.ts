// PROMPT-08c Part A — the "· Adjusted" badge on every "Manage upcoming
// payments" row.
//
// Adam, 2026-09-19: "I do however like the adjusted badge on altered
// payments, we should add these everywhere else that uses manage upcoming
// payments … and add the adjusted flag for any payments that have been
// adjusted either on date or amount."
//
// Before this, the badge existed only on recurring transactions, and its
// rule was `occurrence.date !== occurrence.originalDate`: a moved date
// only. One rule (isOccurrenceAdjusted) and one wrapper per schedule now
// decide it, and every list renders the answer.
//
// WHAT FAILS AGAINST THE PRE-FIX CODE: the whole script, at import — none
// of the wrappers existed. The checks that discriminate against a plausible
// WRONG implementation, not merely a missing one:
//  - mum's 12 Sep (£150 → £80, same date) IS adjusted. The old date-only
//    rule says no, and that is asserted below.
//  - an override that sets the amount back to the standing figure is NOT
//    adjusted ("override exists" would say yes).
//  - a follows-payday transfer drifting to a Friday payday, and a pension
//    shifted off a Sunday, are NOT adjusted ("date differs from slot" would
//    say yes).
//  - a paused occurrence is NOT adjusted (it has its own badge).
//  - an amount-history change is NOT adjusted on the periods after it.

import { readFileSync } from 'node:fs'
import { templateOccurrenceAdjusted, templateOccurrencePreviews } from '../src/lib/schedule'
import { pensionOccurrenceAdjusted } from '../src/lib/pensionLedger'
import { potDepositOccurrenceAdjusted } from '../src/lib/potLedger'
import { savingsPotDepositOccurrenceAdjusted } from '../src/lib/savingsPotLedger'
import { recurringOverpaymentOccurrenceAdjusted } from '../src/lib/ledgerLoans'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import type { AppDataV2, LoanRecurringOverpayment, PayCycleConfig, Pension, Pot, RecurringTemplate, SavingsPot } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger'
function load(file: string): AppDataV2 {
  const raw = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'))
  return migrateLedgerData(raw.data ?? raw)
}

console.log('\n── Recurring transaction: mum\'s "Weekly shopping" (standing £150) ──')
const mum = load('finance-ledger-backup-2026-09-17-mum.json')
const shopping = mum.recurringTemplates.find((t) => t.id === 'QSF9e_W8')!
check('5 Sep, £75, same date → adjusted (amount)', templateOccurrenceAdjusted(shopping, '2026-09-05'), true)
check('12 Sep, £80, same date → adjusted (amount)', templateOccurrenceAdjusted(shopping, '2026-09-12'), true)
check('19 Sep → 18 Sep, £100 → adjusted (date and amount)', templateOccurrenceAdjusted(shopping, '2026-09-19'), true)
check('26 Sep, untouched → not adjusted', templateOccurrenceAdjusted(shopping, '2026-09-26'), false)
const old12 = templateOccurrencePreviews(shopping, new Date(2026, 8, 12), 1)[0]
check('…and the OLD date-only rule missed 12 Sep', old12.date !== old12.originalDate, false)

const noOp: RecurringTemplate = { ...shopping, occurrenceOverrides: [{ originalDate: '2026-10-03', amount: 150 }] }
check('an override back to the standing £150 → not adjusted', templateOccurrenceAdjusted(noOp, '2026-10-03'), false)
const paused: RecurringTemplate = { ...shopping, occurrenceOverrides: [{ originalDate: '2026-10-03', deleted: true, amount: 20 }] }
check('a paused occurrence → not adjusted (it shows Paused instead)', templateOccurrenceAdjusted(paused, '2026-10-03'), false)
const history: RecurringTemplate = { ...shopping, occurrenceOverrides: [], amount: 175, amountEffectiveFrom: '2026-10-01', amountHistory: [{ effectiveFrom: '2026-09-05', amount: 150 }] }
check('after a standing change to £175, 3 Oct at £175 → not adjusted', templateOccurrenceAdjusted(history, '2026-10-03'), false)
const historyOverride: RecurringTemplate = { ...history, occurrenceOverrides: [{ originalDate: '2026-10-03', amount: 150 }] }
check('…but 3 Oct overridden to the OLD £150 → adjusted', templateOccurrenceAdjusted(historyOverride, '2026-10-03'), true)

console.log('\n── Follows-payday transfer: payday drift is not an adjustment ──')
// Adam's real config: payday the 31st, working-day adjusted. A follows-payday
// transfer lands on the first payday AFTER its slot; 31 Oct 2026's own payday
// was pulled back to Fri 30 Oct, so the 31 Oct slot lands on Mon 30 Nov.
const adam = load('finance-ledger-backup-2026-09-15.json')
const adamPayCycle: PayCycleConfig = adam.payCycles.find((pc) => pc.personId === adam.primaryPersonId)!
const transfer: RecurringTemplate = {
  ...shopping, id: 'T-TEST', kind: 'transfer', name: 'Test transfer', frequency: 'monthly', anchorDate: '2026-10-31',
  followsPayday: true, transferFrom: { type: 'personal' }, transferTo: { type: 'joint' }, occurrenceOverrides: [{ originalDate: '2026-10-31', amount: 150 }],
}
check('the slot really drifts: 31 Oct slot is paid Mon 30 Nov', templateOccurrencePreviews(transfer, new Date(2026, 9, 1), 1, adamPayCycle).map((o) => [o.originalDate, o.date]), [['2026-10-31', '2026-11-30']])
check('a no-op override on a payday-drifted slot → not adjusted', templateOccurrenceAdjusted(transfer, '2026-10-31', adamPayCycle), false)
const movedTransfer: RecurringTemplate = { ...transfer, occurrenceOverrides: [{ originalDate: '2026-10-31', date: '2026-10-15' }] }
check('the same slot hand-moved to 15 Oct → adjusted', templateOccurrenceAdjusted(movedTransfer, '2026-10-31', adamPayCycle), true)

console.log('\n── Pension: a working-day shift is not an adjustment ──')
const pension: Pension = {
  id: 'P-TEST', personId: adam.primaryPersonId, name: 'Test Pension', amount: 500, frequency: 'monthly',
  anchorDate: '2026-11-01', active: true, adjustForNonWorkingDay: true, cycleStartFollowsPayday: false,
  occurrenceOverrides: [{ originalDate: '2026-11-01', amount: 500 }, { originalDate: '2026-12-01', amount: 450 }, { originalDate: '2027-01-01', date: '2027-01-05' }],
}
check('Sunday 1 Nov, paid Fri 30 Oct, no-op override → not adjusted', pensionOccurrenceAdjusted(pension, '2026-11-01'), false)
check('1 Dec at £450 → adjusted', pensionOccurrenceAdjusted(pension, '2026-12-01'), true)
check('1 Jan moved to 5 Jan → adjusted', pensionOccurrenceAdjusted(pension, '2027-01-01'), true)
check('1 Feb, no override → not adjusted', pensionOccurrenceAdjusted(pension, '2027-02-01'), false)

console.log('\n── Pots and savings pots ──')
const deposits = { recurringDepositAmount: 50, recurringDepositDayOfMonth: 20, recurringDepositStartDate: '2026-09-20', recurringDepositOverrides: [{ originalDate: '2026-10-20', amount: 60 }, { originalDate: '2026-11-20', amount: 50 }, { originalDate: '2026-12-20', deleted: true }] }
const pot: Pot = { ...adam.pots![0], ...deposits }
const savingsPot: SavingsPot = { ...adam.savingsPots![0], ...deposits }
check('pot: 20 Oct at £60 → adjusted', potDepositOccurrenceAdjusted(pot, '2026-10-20'), true)
check('pot: 20 Nov back to £50 → not adjusted', potDepositOccurrenceAdjusted(pot, '2026-11-20'), false)
check('pot: 20 Dec paused → not adjusted', potDepositOccurrenceAdjusted(pot, '2026-12-20'), false)
check('savings pot: 20 Oct at £60 → adjusted', savingsPotDepositOccurrenceAdjusted(savingsPot, '2026-10-20'), true)
check('savings pot: 20 Nov back to £50 → not adjusted', savingsPotDepositOccurrenceAdjusted(savingsPot, '2026-11-20'), false)

console.log('\n── Loan recurring overpayment ──')
const overpay: LoanRecurringOverpayment = {
  amount: { type: 'fixed', amount: 100 }, startDate: '2026-09-28',
  amountOverrides: [{ date: '2026-10-28', amount: { type: 'fixed', amount: 250 } }, { date: '2026-11-28', amount: { type: 'fixed', amount: 100 } }],
} as LoanRecurringOverpayment
check('28 Oct at £250 → adjusted', recurringOverpaymentOccurrenceAdjusted(overpay, '2026-10-28'), true)
check('28 Nov back to £100 → not adjusted', recurringOverpaymentOccurrenceAdjusted(overpay, '2026-11-28'), false)
check('28 Dec, no override → not adjusted', recurringOverpaymentOccurrenceAdjusted(overpay, '2026-12-28'), false)
const percent: LoanRecurringOverpayment = { ...overpay, amount: { type: 'percent_of_balance', percent: 2 }, amountOverrides: [{ date: '2026-10-28', amount: { type: 'fixed', amount: 100 } }] }
check('a % overpayment overridden to a fixed £100 → adjusted', recurringOverpaymentOccurrenceAdjusted(percent, '2026-10-28'), true)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
