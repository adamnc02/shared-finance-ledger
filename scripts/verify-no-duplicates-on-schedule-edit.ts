// 2026-09-16 (Adam: "I need to know that this bug is eradicated everywhere")
// — every place a recurring schedule's DATE can be edited, checked for the
// duplicate-payment bug first reported on a bill (verify-template-schedule-
// change.ts).
//
// Audit before fixing, each against real data where it exists:
//   bill / recurring transaction / transfer, single payment moved (incl.
//   twice)                                       ✓ already fine (PROMPT-02)
//   bill / recurring transaction / transfer,
//   all future, date or frequency                ✗ fixed in lib/schedule.ts
//   loan first payment date     (mum: Home Improvements, Car Finance) ✗
//   recurring overpayment start date   (Adam: Tesco)                  ✗
//   credit card payment day     (mum: Natwest, Santander)             ✗
//   salary payday               (Adam's backup: Ella, 10th)           ✗
//   pension date / frequency    (synthetic; neither backup has one)   ✗
//   savings pot opening date    (Rebalance accounts)                  ✗
// Every ✗ duplicated the payment it moved; a frequency change also invented
// past payments. Fixed via lib/scheduleChange.ts (interest: a period claim
// in generateSavingsInterestTransactions).
//
// Found on the way, and WORSE because it needs no edit at all: a
// follows-payday / follows-cycle-start recurring transfer duplicated on
// every load after its first payday — the reconciler moved the stored row
// back to its unadjusted slot, and the generator re-created it on the
// payday. Adam's three deposits would have started on 1 Oct 2026. Toggling
// "Follow payday" also silently re-dated every past transfer.
//
// For each surface this asserts, using the SAME function the UI calls:
//   1. the old behaviour (overwrite the field) duplicates, for the record;
//   2. no stored payment is duplicated or invented;
//   3. the picked payment moved to the new date, earlier ones untouched;
//   4. auto-clear is stable afterwards;
//   5. the projected ledger (what Home shows) has no near-duplicate pair.

import { readFileSync } from 'node:fs'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { computeProjection } from '../src/lib/projection'
import { applyPensionScheduleChange, generatePensionTransactions } from '../src/lib/pensionLedger'
import { applyLoanStartDateChange, applyRecurringOverpaymentStartDateChange, buildLoanSchedule, recentAndUpcomingLoanRecurringOverpaymentDates } from '../src/lib/ledgerLoans'
import { applyCardPaymentDayChange, recentAndUpcomingCardPaymentDates } from '../src/lib/creditCards'
import { applyPaydayChange, paydaysForMonth, recentAndUpcomingPaydayDates } from '../src/lib/salaryLedger'
import { applyTemplateScheduleChange, applyTemplateSingleOccurrenceDateChange, recentAndUpcomingOccurrences } from '../src/lib/schedule'
import { newSavingsPot } from '../src/lib/savingsPotLedger'
import { parseLocalDate } from '../src/lib/date'
import type { AppDataV2, Pension, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const TODAY = '2026-09-16'
const asOf = parseLocalDate(TODAY)
const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/'
const load = (file: string) => autoClearDuePayments(parseLedgerBackupJson(readFileSync(DIR + file, 'utf8')), asOf)
const mum = load('finance-ledger-backup-2026-09-15-mum.json')
const adamBackup = load('finance-ledger-backup-2026-09-15.json')
const adam = adamBackup
const shiftDay = (iso: string, by: number) => `${iso.slice(0, 8)}${String(Number(iso.slice(8)) + by).padStart(2, '0')}`

/** Runs one surface through old vs new behaviour. `minGapDays`: two stream rows closer than this in the projected ledger are a duplicate. */
function surface(
  label: string,
  data: AppDataV2,
  personId: string,
  belongs: (t: Transaction) => boolean,
  oldBehaviour: (d: AppDataV2) => AppDataV2,
  fixed: (d: AppDataV2) => AppDataV2 | null,
  pickedDate: string,
  expectedNewDate: string,
  minGapDays = 7,
  /** Payments that legitimately exist only on the new schedule (a frequency increase), dated after the moved one. */
  expectedNewPayments: string[] = [],
) {
  const before = data.transactions.filter(belongs)
  check(`[${label}] fixture has stored payments, including the picked ${pickedDate}`, before.some((t) => t.date === pickedDate), true)

  const old = autoClearDuePayments(oldBehaviour(data), asOf).transactions.filter(belongs)
  check(`[${label}] old behaviour duplicated (for the record)`, old.length > before.length, true)

  const changed = fixed(data)
  check(`[${label}] the change applies`, changed !== null, true)
  if (!changed) return
  const after = autoClearDuePayments(changed, asOf)
  const rows = after.transactions.filter(belongs)
  check(`[${label}] no payment duplicated or invented`, rows.filter((t) => !before.some((b) => b.id === t.id)).map((t) => t.date).sort(), expectedNewPayments)
  check(`[${label}] no stored payment lost`, before.every((b) => rows.some((t) => t.id === b.id)), true)
  const moved = rows.find((t) => before.find((b) => b.date === pickedDate)?.id === t.id)
  check(`[${label}] the picked payment moved ${pickedDate} → ${expectedNewDate}`, moved?.date, expectedNewDate)
  const earlier = (ts: Transaction[]) => ts.filter((t) => t.date < pickedDate && t.id !== moved?.id).map((t) => `${t.id}:${t.date}:${t.amount}:${t.status}`).sort()
  check(`[${label}] every earlier payment untouched`, earlier(rows), earlier(before))
  check(`[${label}] auto-clear is stable afterwards`, JSON.stringify(autoClearDuePayments(after, asOf).transactions), JSON.stringify(after.transactions))

  const payCycle = after.payCycles.find((pc) => pc.personId === personId)!
  const ledger = computeProjection(after, personId, payCycle, 'three_cycles', asOf).transactions.filter(belongs).map((t) => t.date).sort()
  const dayNumber = (iso: string) => parseLocalDate(iso).getTime() / 86400000
  const tooClose = ledger.filter((d, i) => i > 0 && dayNumber(d) - dayNumber(ledger[i - 1]) < minGapDays)
  check(`[${label}] projected ledger has no near-duplicate pair`, tooClose, [])
}

// ── Bills / recurring transactions / transfers: single-payment moves ──
{
  const agria = mum.recurringTemplates.find((t) => t.name === 'Agria Pet Insurance - Pippa')!
  const move = (d: AppDataV2, newDate: string) => autoClearDuePayments({ ...d, recurringTemplates: d.recurringTemplates.map((t) => (t.id === agria.id ? { ...t, ...applyTemplateSingleOccurrenceDateChange(t, newDate, '2026-09-15') } : t)) }, asOf)
  const rows = (d: AppDataV2) => d.transactions.filter((t) => t.sourceId === agria.id).map((t) => `${t.date}:${t.status}`)
  check('[bill, single payment] 15 → 17 Sep moves it, no duplicate', rows(move(mum, '2026-09-17')), ['2026-09-17:pending'])
  check('[bill, single payment] moved twice (→17 →13) still one payment', rows(move(move(mum, '2026-09-17'), '2026-09-13')), ['2026-09-13:cleared'])
  const shopping = mum.recurringTemplates.find((t) => t.name === 'Weekly shopping')!
  const movedShopping = autoClearDuePayments({ ...mum, recurringTemplates: mum.recurringTemplates.map((t) => (t.id === shopping.id ? { ...t, ...applyTemplateSingleOccurrenceDateChange(t, '2026-09-14', '2026-09-12') } : t)) }, asOf)
  check('[recurring transaction, single payment] 12 → 14 Sep, no duplicate', movedShopping.transactions.filter((t) => t.sourceId === shopping.id).map((t) => t.date).sort(), ['2026-09-05', '2026-09-14'])
}

// ── Loans: first payment date ──
for (const loan of mum.loans) {
  const picked = mum.transactions.filter((t) => t.sourceType === 'loan' && t.sourceId === loan.id).map((t) => t.date).sort().at(-1)!
  const newStart = shiftDay(loan.startDate, Number(loan.startDate.slice(8)) >= 27 ? -2 : 2)
  const expected = shiftDay(picked, Number(loan.startDate.slice(8)) >= 27 ? -2 : 2)
  surface(
    `loan first payment date: ${loan.name}`,
    mum,
    loan.ownerId,
    (t) => t.sourceType === 'loan' && t.sourceId === loan.id,
    (d) => ({ ...d, loans: d.loans.map((l) => (l.id === loan.id ? { ...l, startDate: newStart } : l)) }),
    (d) => {
      const r = applyLoanStartDateChange(loan, d.transactions, newStart, picked, TODAY)
      return r && { ...d, transactions: r.transactions, loans: d.loans.map((l) => (l.id === loan.id ? { ...l, ...r.patch } : l)) }
    },
    picked,
    expected,
  )
}

// ── Recurring overpayment: start date (Adam's Tesco loan, 12th → 14th) ──
{
  const tesco = adam.loans.find((l) => l.name === 'Tesco')!
  const picked = recentAndUpcomingLoanRecurringOverpaymentDates(tesco, asOf).find((o) => o.isPast)!.date
  surface(
    'recurring overpayment start date: Tesco',
    adam,
    tesco.ownerId,
    (t) => t.sourceType === 'loan_recurring_overpayment' && t.sourceId === tesco.id,
    (d) => ({ ...d, loans: d.loans.map((l) => (l.id === tesco.id ? { ...l, recurringOverpayment: { ...l.recurringOverpayment!, startDate: '2026-09-14' } } : l)) }),
    (d) => {
      const r = applyRecurringOverpaymentStartDateChange(tesco, d.transactions, '2026-09-14', picked, TODAY)
      return r && { ...d, transactions: r.transactions, loans: d.loans.map((l) => (l.id === tesco.id ? { ...l, ...r.patch } : l)) }
    },
    picked,
    '2026-09-14',
  )
}

// ── Credit cards: payment day (mum's two cards, 14th → 16th) ──
for (const card of mum.creditCards) {
  const picked = recentAndUpcomingCardPaymentDates(card, asOf).find((o) => o.isPast)!.date
  surface(
    `credit card payment day: ${card.name}`,
    mum,
    card.ownerId,
    (t) => t.creditCardId === card.id && t.type === 'credit_card_payment' && !t.sourceType,
    (d) => ({ ...d, creditCards: d.creditCards.map((c) => (c.id === card.id ? { ...c, paymentDayOfMonth: 16 } : c)) }),
    (d) => {
      const r = applyCardPaymentDayChange(card, d.transactions, 16, picked, TODAY)
      return r && { ...d, transactions: r.transactions, creditCards: d.creditCards.map((c) => (c.id === card.id ? { ...c, ...r.patch } : c)) }
    },
    picked,
    '2026-09-16',
  )
}

// ── Salary payday (Ella in Adam's backup, 10th → 12th) ──
{
  // 2026-09-19 (PROMPT-08c Part C): this surface is a MONTHLY payday change.
  // Ella's real salary is 4-weekly, and it only used to be paid monthly on
  // the 10th because a 4-weekly salary's dates were never generated (the bug
  // 08c fixed). It now waits for a next pay date, so the fixture sets her
  // salary to monthly to keep testing what this section is about.
  const monthlyElla = (d: AppDataV2): AppDataV2 => ({
    ...d,
    people: d.people.map((p) => (p.name === 'Ella' ? { ...p, salaryHistory: p.salaryHistory.map((s) => ({ ...s, payFrequency: 'monthly' as const })) } : p)),
  })
  const adam = monthlyElla(adamBackup)
  const ella = adam.people.find((p) => p.name === 'Ella')!
  // The reverse direction across a month boundary: a new payday EARLIER
  // than the old one's month (2nd → 28th, from 2 Oct) must pay 2 Sep on the
  // old rule AND the moved October payday on 28 Sep — two in one month.
  const crossing = { ...adam.payCycles.find((pc) => pc.personId === ella.id)!, paydayDayOfMonth: 2, paydayAdjustForNonWorkingDay: false, paydayHistory: undefined }
  const crossed = applyPaydayChange(crossing, ella, [], null, { paydayDayOfMonth: 28, paydayAdjustForNonWorkingDay: false }, '2026-10-02', TODAY)!
  check('[salary payday 2nd → 28th from 2 Oct] Sep has 2 Sep (old rule) and 28 Sep (the moved Oct payday)', paydaysForMonth(crossed.payCycle, 2026, 8).map((d) => d.getDate()), [2, 28])
  check('[salary payday 2nd → 28th from 2 Oct] one payday per period after: Aug 2nd, Oct 28th (Nov\'s), Nov 28th', [7, 9, 10].map((m) => paydaysForMonth(crossed.payCycle, 2026, m).map((d) => d.getDate())), [[2], [28], [28]])
  const payCycle = adam.payCycles.find((pc) => pc.personId === ella.id)!
  const picked = recentAndUpcomingPaydayDates(payCycle, asOf).find((o) => o.isPast)!.date
  surface(
    'salary payday: Ella',
    adam,
    ella.id,
    (t) => t.type === 'salary' && t.personId === ella.id,
    (d) => ({ ...d, payCycles: d.payCycles.map((pc) => (pc.personId === ella.id ? { ...pc, paydayDayOfMonth: 12 } : pc)) }),
    (d) => {
      const r = applyPaydayChange(payCycle, ella, d.transactions, null, { paydayDayOfMonth: 12, paydayAdjustForNonWorkingDay: payCycle.paydayAdjustForNonWorkingDay }, picked, TODAY)
      return (
        r && {
          ...d,
          transactions: r.transactions,
          payCycles: d.payCycles.map((pc) => (pc.personId === ella.id ? r.payCycle : pc)),
          people: d.people.map((p) => (p.id === ella.id ? r.person : p)),
        }
      )
    },
    picked,
    '2026-09-11', // the 12th is a Saturday; Ella's payday moves to the last working day before it
  )
}

// ── Pensions: date and frequency (synthetic — neither backup has one) ──
{
  const personId = mum.people[0].id
  const pension: Pension = { id: 'pen', personId, name: 'State', amount: 500, frequency: 'monthly', anchorDate: '2026-06-25', active: true, adjustForNonWorkingDay: false, cycleStartFollowsPayday: false }
  const withPension = autoClearDuePayments({ ...mum, pensions: [pension] }, asOf)
  const belongs = (t: Transaction) => t.sourceType === 'pension' && t.sourceId === 'pen'
  const apply = (d: AppDataV2, next: Pick<Pension, 'frequency' | 'intervalWeeks' | 'anchorDate' | 'adjustForNonWorkingDay'>, picked: string) => {
    const r = applyPensionScheduleChange(pension, d.transactions, next, picked, TODAY)
    return r && { ...d, transactions: r.transactions, pensions: [{ ...pension, ...r.patch }] }
  }
  const dateChange = { frequency: 'monthly' as const, anchorDate: '2026-06-27', adjustForNonWorkingDay: false }
  surface('pension date 25th → 27th', withPension, personId, belongs, (d) => ({ ...d, pensions: [{ ...pension, ...dateChange }] }), (d) => apply(d, dateChange, '2026-08-25'), '2026-08-25', '2026-08-27')
  const weekly = { frequency: 'weekly' as const, anchorDate: '2026-06-25', adjustForNonWorkingDay: false }
  surface('pension monthly → weekly', withPension, personId, belongs, (d) => ({ ...d, pensions: [{ ...pension, ...weekly }] }), (d) => apply(d, weekly, '2026-08-25'), '2026-08-25', '2026-08-27', 6, ['2026-09-03', '2026-09-10'])
  const afterWeekly = autoClearDuePayments(apply(withPension, weekly, '2026-08-25')!, asOf)
  check('[pension monthly → weekly] continues weekly from the moved payment', generatePensionTransactions(afterWeekly.pensions[0], parseLocalDate('2026-08-20'), parseLocalDate('2026-09-20')).map((t) => t.date), ['2026-08-27', '2026-09-03', '2026-09-10', '2026-09-17'])
}

// ── Month-end fallback on the non-template generators (Adam, 2026-09-16) ──
{
  const loan = { ...mum.loans[0], startDate: '2027-01-31', scheduleFrom: undefined, overpayments: [] }
  check('[loan] first payment on the 31st: 31 Jan, 28 Feb, 31 Mar, 30 Apr', buildLoanSchedule(loan).slice(0, 4).map((e) => e.date), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'])
  const payCycle = { ...adam.payCycles[0], paydayDayOfMonth: 31, paydayAdjustForNonWorkingDay: false, paydayHistory: undefined }
  check('[salary] payday the 31st: 31 Jan, 28 Feb, 31 Mar, 30 Apr', [0, 1, 2, 3].map((m) => paydaysForMonth(payCycle, 2027, m).map((d) => d.getDate())[0]), [31, 28, 31, 30])
}

// ── Follows-payday transfers: no edit at all, just time passing ──
{
  const raw = parseLedgerBackupJson(readFileSync(DIR + 'finance-ledger-backup-2026-09-15.json', 'utf8'))
  const deposits = raw.recurringTemplates.filter((t) => t.kind === 'transfer' && t.followsPayday)
  check('[fixture] Adam has 3 follow-payday deposits', deposits.map((t) => t.name).sort(), ['Bills Deposit', 'Joint Account Deposit', 'Savings Deposit'])
  let d = raw
  const days = ['2026-09-16', '2026-10-01', '2026-10-02', '2026-10-15', '2026-11-02', '2026-11-03', '2026-12-01']
  for (const day of days) d = autoClearDuePayments(d, parseLocalDate(day))
  for (const t of deposits) {
    check(`[follows payday, day after day] ${t.name}: one transfer per payday, on the payday`, d.transactions.filter((x) => x.sourceId === t.id).map((x) => x.date).sort(), ['2026-09-30', '2026-10-30', '2026-11-30'])
  }

  // Turning "Follow payday" off from the October payment keeps September's
  // transfer on the day it went out.
  const bills = d.recurringTemplates.find((t) => t.name === 'Bills Deposit')!
  const dec = parseLocalDate('2026-12-01')
  const adamsPayCycle = d.payCycles.find((pc) => pc.personId === d.primaryPersonId)!
  check('[follows payday] the picker lists the real payday dates', recentAndUpcomingOccurrences(bills, dec, adamsPayCycle).map((o) => o.date).slice(0, 2), ['2026-11-30', '2026-12-31'])
  const { patch, transactions } = applyTemplateScheduleChange(bills, d.transactions, { frequency: bills.frequency, intervalWeeks: bills.intervalWeeks, anchorDate: bills.anchorDate, followsPayday: false, followsCycleStart: false }, '2026-10-30', '2026-12-01', adamsPayCycle)
  const off = autoClearDuePayments({ ...d, transactions, recurringTemplates: d.recurringTemplates.map((t) => (t.id === bills.id ? { ...t, ...patch } : t)) }, dec)
  check('[follow payday → off, from the 30 Oct transfer] Sep stays 30 Sep; Oct and Nov move to their own day (12th); nothing added', off.transactions.filter((x) => x.sourceId === bills.id).map((x) => x.date).sort(), ['2026-09-30', '2026-10-12', '2026-11-12'])
  check('[follow payday → off] stable', JSON.stringify(autoClearDuePayments(off, dec).transactions), JSON.stringify(off.transactions))
}

// ── Savings pot opening date (Rebalance accounts can change it) ──
{
  const personId = mum.people[0].id
  const pot = { ...newSavingsPot({ personId, name: 'ISA', openingBalance: 5000, openingDate: '2026-01-10', interestMethod: { type: 'aer_credited', aer: 4, creditingFrequency: 'monthly' } } as Parameters<typeof newSavingsPot>[0]), id: 'isa' }
  const base = autoClearDuePayments({ ...mum, savingsPots: [pot], payCycles: mum.payCycles.map((pc) => ({ ...pc, openingBalanceDate: '2026-01-01' })) }, asOf)
  const interest = (x: AppDataV2) => x.transactions.filter((t) => t.type === 'savings_interest' && t.sourceId === 'isa').map((t) => t.date).sort()
  const before = interest(base)
  check('[fixture] 8 monthly interest payments, 10 Feb → 10 Sep', [before.length, before[0], before.at(-1)], [8, '2026-02-10', '2026-09-10'])
  const moved = autoClearDuePayments({ ...base, savingsPots: base.savingsPots.map((p) => ({ ...p, openingDate: '2026-01-12' })) }, asOf)
  check('[savings opening date 10 → 12 Jan] no interest re-created on the 12th', interest(moved), before)
}

console.log(failures === 0 ? '\nAll schedule-edit duplicate checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)
