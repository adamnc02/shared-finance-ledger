// 2026-09-16 (Adam-reported, a sibling of PROMPT-02 Task B) — changing a
// bill's due date "for every payment from then on", from a chosen payment,
// duplicated the payment instead of moving it. Mum's backup: "Agria Pet
// Insurance - Pippa" 15th -> 16th, from yesterday's (15 Sep) payment, left
// a cleared 15 Sep AND a cleared 16 Sep.
//
// Root cause: the "all future" branch just overwrote `anchorDate` and
// ignored the chosen payment. A materialised occurrence is identified by
// its slot (APP-KNOWLEDGE §1.5a); with a new anchor, no existing row's slot
// is produced any more, so the generator materialised every occurrence
// since the anchor again on the new day. 21 of mum's 29 bills showed it. A
// frequency change had the same cause, and recurring transactions/transfers
// saved date and frequency changes immediately with no "from which payment"
// step at all.
//
// Fixed by applyTemplateScheduleChange (lib/schedule.ts). Section 1 fails
// against the old `{ anchorDate: draft.anchorDate }` behaviour, emulated by
// `oldBehaviour` below.

import { readFileSync } from 'node:fs'
import { defaultLedgerData, defaultPayCycleConfig, parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { applyTemplateAmountChange, applyTemplateScheduleChange, generateTransactionsForTemplate, recentAndUpcomingOccurrences, scheduledTemplateDates, type TemplateSchedule } from '../src/lib/schedule'
import { parseLocalDate } from '../src/lib/date'
import type { AppDataV2, RecurringTemplate, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const TODAY = '2026-09-16'
const asOf = parseLocalDate(TODAY)

function change(data: AppDataV2, templateId: string, next: TemplateSchedule, fromDate: string): AppDataV2 {
  const template = data.recurringTemplates.find((t) => t.id === templateId)!
  const { patch, transactions } = applyTemplateScheduleChange(template, data.transactions, next, fromDate, TODAY)
  return autoClearDuePayments({ ...data, transactions, recurringTemplates: data.recurringTemplates.map((t) => (t.id === templateId ? { ...t, ...patch } : t)) }, asOf)
}
function oldBehaviour(data: AppDataV2, templateId: string, next: TemplateSchedule): AppDataV2 {
  return autoClearDuePayments({ ...data, recurringTemplates: data.recurringTemplates.map((t) => (t.id === templateId ? { ...t, ...next } : t)) }, asOf)
}
const rowsOf = (data: AppDataV2, id: string): Transaction[] =>
  data.transactions.filter((t) => t.sourceType === 'recurring_template' && t.sourceId === id).sort((a, b) => a.date.localeCompare(b.date))
const dates = (rows: Transaction[]) => rows.map((t) => `${t.date}:${t.status}`)

// A bill with 20 months of cleared history.
const base = defaultLedgerData()
const ME = base.primaryPersonId
const bill: RecurringTemplate = {
  id: 'bill',
  name: 'Insurance',
  amount: 68.58,
  categoryId: 'category-bills',
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2025-01-15',
  location: 'personal',
  ownerId: ME,
  payee: '',
  payeeSharePercent: 100,
  active: true,
}
const longHistory = autoClearDuePayments(
  { ...base, recurringTemplates: [bill], payCycles: [{ ...defaultPayCycleConfig(ME), openingBalance: 1000, openingBalanceDate: '2025-01-01' }] },
  asOf,
)
const history = rowsOf(longHistory, 'bill')
check('[fixture] 21 cleared monthly payments, 15 Jan 2025 → 15 Sep 2026', [history.length, history[0].date, history.at(-1)!.date], [21, '2025-01-15', '2026-09-15'])
const on16th: TemplateSchedule = { frequency: 'monthly', anchorDate: '2025-01-16' }

// ─────────────────────────────────────────────────────────────────────
// 1. The reported bug: 15th → 16th, from yesterday's payment
// ─────────────────────────────────────────────────────────────────────
{
  const before = oldBehaviour(longHistory, 'bill', on16th)
  check('[old behaviour, for the record] the history was duplicated on the 16th', rowsOf(before, 'bill').length, 42)

  const after = change(longHistory, 'bill', on16th, '2026-09-15')
  const rows = rowsOf(after, 'bill')
  check('no payment is duplicated', rows.length, 21)
  check("yesterday's payment moved to the 16th rather than being duplicated", dates(rows.filter((t) => t.date >= '2026-09-01')), ['2026-09-16:cleared'])
  check('every payment before it keeps its old date and row', rows.slice(0, 20), history.slice(0, 20))
  check('the moved payment keeps its id and amount', [rows.at(-1)!.id, rows.at(-1)!.amount], [history.at(-1)!.id, history.at(-1)!.amount])
  check('its slot is the new one', rows.at(-1)!.occurrenceOriginalDate, '2026-09-16')
  check('the schedule continues on the 16th', recentAndUpcomingOccurrences(after.recurringTemplates[0], asOf).map((o) => o.date), ['2026-09-16', '2026-10-16', '2026-11-16', '2026-12-16'])
  check('stable: running auto-clear again changes nothing', JSON.stringify(autoClearDuePayments(after, asOf).transactions), JSON.stringify(after.transactions))
}

// ─────────────────────────────────────────────────────────────────────
// 2. Other directions and choices
// ─────────────────────────────────────────────────────────────────────
{
  const upcoming = change(longHistory, 'bill', on16th, '2026-10-15')
  check('from an UPCOMING payment: every cleared payment is untouched', rowsOf(upcoming, 'bill'), history)
  check('...and the next payment is 16 Oct', recentAndUpcomingOccurrences(upcoming.recurringTemplates[0], parseLocalDate('2026-09-17')).map((o) => o.date).slice(0, 2), ['2026-10-16', '2026-11-16'])

  const earlier = change(longHistory, 'bill', { frequency: 'monthly', anchorDate: '2025-01-10' }, '2026-09-15')
  check('moving EARLIER (15th → 10th): same count, 15 Sep becomes 10 Sep, no 10 Aug appears', [rowsOf(earlier, 'bill').length, dates(rowsOf(earlier, 'bill').slice(-2))], [21, ['2026-08-15:cleared', '2026-09-10:cleared']])

  const later = change(longHistory, 'bill', { frequency: 'monthly', anchorDate: '2025-01-20' }, '2026-09-15')
  check('moving LATER past today (15th → 20th): 15 Sep becomes a PENDING 20 Sep', dates(rowsOf(later, 'bill').slice(-2)), ['2026-08-15:cleared', '2026-09-20:pending'])

  const fromEarlierPayment = change(longHistory, 'bill', on16th, '2026-07-15')
  check('from a payment two months back: Jul, Aug, Sep all move, nothing duplicates', [rowsOf(fromEarlierPayment, 'bill').length, dates(rowsOf(fromEarlierPayment, 'bill').slice(-4))], [21, ['2026-06-15:cleared', '2026-07-16:cleared', '2026-08-16:cleared', '2026-09-16:cleared']])
}

// ─────────────────────────────────────────────────────────────────────
// 3. Frequency changes
// ─────────────────────────────────────────────────────────────────────
{
  const weekly = change(longHistory, 'bill', { frequency: 'weekly', anchorDate: '2025-01-15' }, '2026-09-15')
  const rows = rowsOf(weekly, 'bill')
  check('monthly → weekly: no phantom weekly payments in the past history', rows.filter((t) => t.date < '2026-09-01'), history.slice(0, 20))
  const september = rows.filter((t) => t.date >= '2026-09-01')
  // Only the frequency changed, so the chosen payment starts the weekly run.
  check('monthly → weekly from 15 Sep: that payment stays on 15 Sep and starts the weekly run, nothing duplicated', dates(september), ['2026-09-15:cleared'])
  check('...next weekly payments 22 Sep, 29 Sep', generateTransactionsForTemplate(weekly.recurringTemplates[0], parseLocalDate('2026-09-16'), parseLocalDate('2026-09-30')).map((o) => o.date), ['2026-09-22', '2026-09-29'])
  check('...and it is the SAME row, re-slotted', september[0].id, history.at(-1)!.id)

  const weeklyBill: RecurringTemplate = { ...bill, id: 'weekly', frequency: 'weekly', anchorDate: '2026-06-02' }
  const weeklyData = autoClearDuePayments({ ...longHistory, recurringTemplates: [weeklyBill], transactions: [] }, asOf)
  const weeklyRows = rowsOf(weeklyData, 'weekly')
  const toMonthly = change(weeklyData, 'weekly', { frequency: 'monthly', anchorDate: '2026-06-02' }, '2026-09-15')
  const monthlyRows = rowsOf(toMonthly, 'weekly')
  check('weekly → monthly from 15 Sep: earlier weekly payments untouched', monthlyRows.filter((t) => t.date < '2026-09-15'), weeklyRows.filter((t) => t.date < '2026-09-15'))
  check('weekly → monthly from 15 Sep: that payment is the first monthly one, no duplicate', dates(monthlyRows.filter((t) => t.date >= '2026-09-15')), ['2026-09-15:cleared'])
  check('...then 15 Oct, 15 Nov', generateTransactionsForTemplate(toMonthly.recurringTemplates[0], parseLocalDate('2026-09-16'), parseLocalDate('2026-11-30')).map((o) => o.date), ['2026-10-15', '2026-11-15'])
}

// ─────────────────────────────────────────────────────────────────────
// 4. Per-payment overrides follow their payment
// ─────────────────────────────────────────────────────────────────────
{
  const withOverrides: AppDataV2 = {
    ...longHistory,
    recurringTemplates: [
      {
        ...bill,
        occurrenceOverrides: [
          { originalDate: '2026-09-15', amount: 70, date: '2026-09-15' }, // a single-payment amount edit also writes date = its own slot
          { originalDate: '2026-10-15', amount: 99 },
          { originalDate: '2026-11-15', deleted: true },
          { originalDate: '2026-12-15', date: '2026-12-20' }, // a genuine move
          { originalDate: '2026-06-15', amount: 60 }, // before the chosen payment: untouched
        ],
      },
    ],
  }
  const after = change(withOverrides, 'bill', on16th, '2026-09-15')
  const o = after.recurringTemplates[0].occurrenceOverrides!
  check('an amount edit on 15 Oct now applies to 16 Oct', o.find((x) => x.amount === 99)?.originalDate, '2026-10-16')
  check('a paused 15 Nov is now a paused 16 Nov', o.find((x) => x.deleted)?.originalDate, '2026-11-16')
  check('a genuine move keeps the date the user chose', o.find((x) => x.date === '2026-12-20')?.originalDate, '2026-12-16')
  check("an override whose date was just its own slot follows the new slot", o.find((x) => x.amount === 70), { originalDate: '2026-09-16', amount: 70, date: '2026-09-16' })
  check('an override before the chosen payment is untouched', o.find((x) => x.amount === 60)?.originalDate, '2026-06-15')
  check('the upcoming schedule honours them: 16 Oct £99, 16 Nov skipped, 20 Dec', recentAndUpcomingOccurrences(after.recurringTemplates[0], asOf).map((x) => x.date), ['2026-09-16', '2026-10-16', '2026-12-20', '2027-01-16'])
}

// ─────────────────────────────────────────────────────────────────────
// 4b. The 29th–31st (Adam, 2026-09-16): a day a month can't hold falls on
//     that month's last day, ONLY in that month. Found in review: choosing
//     the 31st from the 15 Sep payment anchored on 30 Sep, and every later
//     month stayed on the 30th. anchorDayOfMonth keeps the intended day.
// ─────────────────────────────────────────────────────────────────────
{
  const to31st = change(longHistory, 'bill', { frequency: 'monthly', anchorDate: '2025-01-31' }, '2026-09-15')
  const t = to31st.recurringTemplates[0]
  check('15th → 31st from 15 Sep: the Sep payment lands on 30 Sep (September has 30 days)', dates(rowsOf(to31st, 'bill').slice(-1)), ['2026-09-30:pending'])
  check('...stored as anchor 30 Sep, intended day 31', [t.anchorDate, t.anchorDayOfMonth], ['2026-09-30', 31])
  const expected = ['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']
  check('the ledger generator: back on the 31st whenever the month has one', generateTransactionsForTemplate(t, parseLocalDate('2026-09-01'), parseLocalDate('2027-04-30')).map((o) => o.date), expected)
  check('Manage upcoming payments shows the same dates', scheduledTemplateDates(t, parseLocalDate('2026-09-01'), parseLocalDate('2027-04-30')).map((o) => o.date), expected)
  check('a 29 Feb in a leap year is kept', generateTransactionsForTemplate({ ...t, anchorDate: '2027-11-30', anchorDayOfMonth: 29 }, parseLocalDate('2028-01-01'), parseLocalDate('2028-03-31')).map((o) => o.date), ['2028-01-29', '2028-02-29', '2028-03-29'])
  const quarterly = change({ ...longHistory, recurringTemplates: [{ ...bill, frequency: 'quarterly', anchorDate: '2026-03-15' }], transactions: [] }, 'bill', { frequency: 'quarterly', anchorDate: '2026-03-31' }, '2026-06-15')
  check('quarterly 15th → 31st: 30 Jun, 30 Sep, 31 Dec, 31 Mar', generateTransactionsForTemplate(quarterly.recurringTemplates[0], parseLocalDate('2026-06-01'), parseLocalDate('2027-03-31')).map((o) => o.date), ['2026-06-30', '2026-09-30', '2026-12-31', '2027-03-31'])
  check('changing only the frequency (→ quarterly from 30 Nov) keeps the intended 31st', generateTransactionsForTemplate(change(to31st, 'bill', { frequency: 'quarterly', anchorDate: t.anchorDate }, '2026-11-30').recurringTemplates[0], parseLocalDate('2026-11-01'), parseLocalDate('2027-08-31')).map((o) => o.date), ['2026-11-30', '2027-02-28', '2027-05-31', '2027-08-31'])
}

// ─────────────────────────────────────────────────────────────────────
// 4c. Amount AND date in one save (found in review, fixed 2026-09-16).
//     The amount change is recorded from the chosen payment's OLD date;
//     moving that payment earlier left it before the new amount started.
// ─────────────────────────────────────────────────────────────────────
{
  const withAmount: AppDataV2 = { ...longHistory, recurringTemplates: [{ ...bill, ...applyTemplateAmountChange(bill, 80, '2026-09-15') }] }
  const both = change(withAmount, 'bill', { frequency: 'monthly', anchorDate: '2025-01-10' }, '2026-09-15')
  const rows = rowsOf(both, 'bill')
  check('amount £80 + date 15th → 10th from 15 Sep: the moved Sep payment is £80', [rows.at(-1)!.date, rows.at(-1)!.amount], ['2026-09-10', 80])
  check('...Aug keeps the old amount', rows.at(-2)!.amount, 68.58)
  check('...the upcoming 10 Oct is £80', generateTransactionsForTemplate(both.recurringTemplates[0], parseLocalDate('2026-10-01'), parseLocalDate('2026-10-31')).map((o) => o.amount), [80])
  const later = change(withAmount, 'bill', { frequency: 'monthly', anchorDate: '2025-01-20' }, '2026-09-15')
  check('amount £80 + date 15th → 20th: the moved payment is £80 too', rowsOf(later, 'bill').at(-1)!.amount, 80)
  const futureAmount: AppDataV2 = { ...longHistory, recurringTemplates: [{ ...bill, ...applyTemplateAmountChange(bill, 90, '2026-11-15') }] }
  const shifted = change(futureAmount, 'bill', { frequency: 'monthly', anchorDate: '2025-01-10' }, '2026-09-15')
  check('an amount change already scheduled for 15 Nov now starts on 10 Nov, the same payment', shifted.recurringTemplates[0].amountEffectiveFrom, '2026-11-10')
}

// ─────────────────────────────────────────────────────────────────────
// 5. Mum's real backup — every template, day +1 from its most recent payment
// ─────────────────────────────────────────────────────────────────────
{
  const BACKUP = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-15-mum.json'
  const loaded = autoClearDuePayments(parseLedgerBackupJson(readFileSync(BACKUP, 'utf8')), asOf)
  const agria = loaded.recurringTemplates.find((t) => t.name === 'Agria Pet Insurance - Pippa')!
  const reported = change(loaded, agria.id, { frequency: 'monthly', anchorDate: '2026-09-16' }, '2026-09-15')
  check("[mum] Agria Pet Insurance - Pippa, 15th → 16th from 15 Sep: one payment, on the 16th", dates(rowsOf(reported, agria.id)), ['2026-09-16:cleared'])

  let exercised = 0
  for (const t of loaded.recurringTemplates) {
    const recent = recentAndUpcomingOccurrences(t, asOf)[0]
    if (!recent?.isPast) continue
    const day = Number(t.anchorDate.slice(8))
    const next: TemplateSchedule = { frequency: t.frequency, intervalWeeks: t.intervalWeeks, anchorDate: `${t.anchorDate.slice(0, 8)}${String(day >= 28 ? day - 1 : day + 1).padStart(2, '0')}` }
    const before = rowsOf(loaded, t.id)
    const after = rowsOf(change(loaded, t.id, next, recent.date), t.id)
    check(`[mum] ${t.name}: no duplicate after moving the date from ${recent.date}`, after.length, before.length)
    exercised++
  }
  check('[mum] templates exercised', exercised > 20, true)
}

console.log(failures === 0 ? '\nAll template schedule-change checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)
