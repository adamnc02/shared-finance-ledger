// The edit window (lib/editWindow.ts): a payment that has already cleared
// stays correctable for 5 days, today included.
//
// The bug it prevents: a recurring card expense cleared on 9 Oct. On 10 Oct
// its payment was paused from "Manage upcoming payments" — the stored,
// cleared row stayed in the ledger, because the reconciler skipped any slot
// marked paused. Its recurring transaction was then deleted — the row still
// stayed, because the generator-delete sweep only removed cleared rows dated
// TODAY. The £75 expense and its Coin Jar round-up were left with nothing in
// the app able to reach them.
//
//  1. the window's boundary: 9 Oct is inside on 13 Oct and outside on 14 Oct;
//     `isSettled` (the fold) agrees with it;
//  2. "Manage upcoming payments" lists every payment inside the window (two
//     for a weekly payment), the last one before it when none is inside, and
//     still the next 12;
//  3. for each of the five pause mechanisms — recurring template, pension,
//     pot deposit, savings-pot deposit, loan recurring overpayment — run the
//     whole autoClearDuePayments pass: pausing a payment cleared 2 days ago
//     removes its row; the control, the same payment 6 days ago, keeps it;
//     unpausing brings the row back under the same id (§1.25).
//
//  4. deleting a loan's recurring overpayment on its own (not the whole loan)
//     sweeps by the same rule: deleteReassign.ts once kept an inline copy of
//     the old "dated today" predicate after the window replaced it.
//
// Fails on the old code: checks 1–2 (3-day fold; one past payment listed),
// every "removed" row in 3, and the yesterday row in 4.

import { readFileSync } from 'node:fs'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { isInEditWindow, EDIT_WINDOW_DAYS } from '../src/lib/editWindow'
import { isSettled } from '../src/lib/transferGroups'
import { trimToManageUpcoming, MANAGE_UPCOMING_NEXT_COUNT } from '../src/lib/occurrenceOverrides'
import { setPausedTemplateOccurrences } from '../src/lib/schedule'
import { newPension, setPausedPensionOccurrences } from '../src/lib/pensionLedger'
import { newPot, setPausedPotDeposits } from '../src/lib/potLedger'
import { newSavingsPot, setPausedDeposits } from '../src/lib/savingsPotLedger'
import { scheduledLoanRecurringOverpaymentRealDates, setPausedLoanRecurringOverpaymentDates } from '../src/lib/ledgerLoans'
import { removeLoanRecurringOverpaymentFromData } from '../src/lib/deleteReassign'
import type { AppDataV2, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', JSON.stringify(detail).slice(0, 800))
  }
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/'
const load = (file: string): AppDataV2 => parseLedgerBackupJson(readFileSync(DIR + file, 'utf8'))
const at = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

// ── 1. The boundary ──────────────────────────────────────────────────
console.log('\n1. The boundary')
check(`the window is ${EDIT_WINDOW_DAYS} days`, EDIT_WINDOW_DAYS === 5)
check('9 Oct is inside the window on 13 Oct', isInEditWindow('2026-10-09', at('2026-10-13')))
check('9 Oct is outside the window on 14 Oct', !isInEditWindow('2026-10-09', at('2026-10-14')))
check('a future date is inside the window', isInEditWindow('2026-10-20', at('2026-10-13')))
check('the fold agrees: a cleared 9 Oct payment is not folded on 13 Oct (was folded from 12 Oct)', !isSettled('2026-10-09', true, at('2026-10-13')))
check('the fold agrees: folded on 14 Oct', isSettled('2026-10-09', true, at('2026-10-14')))
check('a pending payment never folds', !isSettled('2026-09-01', false, at('2026-10-14')))

// ── 2. Manage upcoming payments ──────────────────────────────────────
console.log('\n2. Manage upcoming payments')
const weekly = ['2026-09-26', '2026-10-03', '2026-10-07', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31']
const listed = trimToManageUpcoming(weekly, (d) => d, at('2026-10-10'))
check('every payment inside the window is listed (7 and 10 Oct), not just the latest', listed.includes('2026-10-07') && listed.includes('2026-10-10'), listed)
check('a payment before the window is not listed while one is inside it', !listed.includes('2026-10-03'), listed)
const monthly = ['2026-08-15', '2026-09-15', '2026-10-15', '2026-11-15']
const listedMonthly = trimToManageUpcoming(monthly, (d) => d, at('2026-10-10'))
check('nothing inside the window: the last past payment is listed, as before', listedMonthly[0] === '2026-09-15' && listedMonthly.length === 3, listedMonthly)
const many = Array.from({ length: 20 }, (_, i) => `2027-${String((i % 12) + 1).padStart(2, '0')}-${String(Math.floor(i / 12) + 1).padStart(2, '0')}`)
check(`still at most the next ${MANAGE_UPCOMING_NEXT_COUNT} upcoming`, trimToManageUpcoming(many, (d) => d, at('2026-10-10')).length === MANAGE_UPCOMING_NEXT_COUNT)

// ── 3. Pausing a cleared payment, all five mechanisms ────────────────
console.log('\n3. Pausing a cleared payment')

type Mechanism = {
  name: string
  data: AppDataV2
  /** The cleared row for the payment dated `date`, after autoClear. */
  find: (d: AppDataV2, date: string) => Transaction | undefined
  pause: (d: AppDataV2, date: string, paused: boolean) => AppDataV2
}

function exercise(m: Mechanism, date: string, insideAsOf: string, outsideAsOf: string) {
  console.log(`\n  ${m.name} — payment dated ${date}`)
  const cleared = autoClearDuePayments(m.data, at(insideAsOf))
  const row = m.find(cleared, date)
  check(`the payment cleared (a real test, not an empty one)`, row?.status === 'cleared', row)
  if (!row) return

  const paused = autoClearDuePayments(m.pause(cleared, date, true), at(insideAsOf))
  check(`paused on ${insideAsOf}, inside the window: the row is removed`, !paused.transactions.some((t) => t.id === row.id))
  check('…and not re-materialised under another id', !m.find(paused, date))

  const unpaused = autoClearDuePayments(m.pause(paused, date, false), at(insideAsOf))
  check('unpaused: the row comes back under the same id', unpaused.transactions.some((t) => t.id === row.id && t.status === 'cleared'))

  // Control: the same payment, paused once it has left the window.
  const later = autoClearDuePayments(m.data, at(outsideAsOf))
  const laterRow = m.find(later, date)
  const pausedLate = autoClearDuePayments(m.pause(later, date, true), at(outsideAsOf))
  check(`control — paused on ${outsideAsOf}, outside the window: the row is kept as history`, !!laterRow && pausedLate.transactions.some((t) => t.id === laterRow.id))
}

// Recurring template — mum's real data: a monthly bill.
const mum = load('finance-ledger-backup-2026-10-06-mum.json')
{
  const probe = autoClearDuePayments(mum, at('2026-10-06'))
  const sample = probe.transactions
    .filter((t) => t.sourceType === 'recurring_template' && t.status === 'cleared' && t.date >= '2026-09-25' && t.date <= '2026-10-04')
    .sort((a, b) => b.date.localeCompare(a.date))[0]
  check('mum\'s data has a recurring payment cleared in early October to test with', !!sample, sample)
  if (sample) {
    const slotOf = (t: Transaction) => t.occurrenceOriginalDate ?? t.date
    exercise(
      {
        name: `Recurring template (mum's "${mum.recurringTemplates.find((t) => t.id === sample.sourceId)?.name}")`,
        data: mum,
        find: (d, date) => d.transactions.find((t) => t.sourceType === 'recurring_template' && t.sourceId === sample.sourceId && t.date === date),
        pause: (d, date, paused) => {
          const row = d.transactions.find((t) => t.sourceType === 'recurring_template' && t.sourceId === sample.sourceId && t.date === date)
          const slot = row ? slotOf(row) : date
          return { ...d, recurringTemplates: d.recurringTemplates.map((t) => (t.id === sample.sourceId ? { ...t, ...setPausedTemplateOccurrences(t, [slot], paused ? [slot] : []) } : t)) }
        },
      },
      sample.date,
      shift(sample.date, 2),
      shift(sample.date, 6),
    )
  }
}

function shift(iso: string, days: number): string {
  const d = at(iso)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Pension, pot deposit, savings-pot deposit — synthetic, on mum's person.
const me = mum.primaryPersonId!
const withPension: AppDataV2 = { ...mum, pensions: [...mum.pensions, { ...newPension({ personId: me, name: 'Test pension', amount: 321, frequency: 'monthly', anchorDate: '2026-09-18' }), id: 'ew-pension' }] }
exercise(
  {
    name: 'Pension',
    data: withPension,
    find: (d, date) => d.transactions.find((t) => t.type === 'pension_income' && t.sourceId === 'ew-pension' && t.date === date),
    pause: (d, date, paused) => ({ ...d, pensions: d.pensions.map((p) => (p.id === 'ew-pension' ? { ...p, ...setPausedPensionOccurrences(p, [date], paused ? [date] : []) } : p)) }),
  },
  '2026-10-18',
  '2026-10-20',
  '2026-10-24',
)

const pot = { ...newPot({ personId: me, name: 'Test pot', openingBalance: 0, openingDate: '2026-09-01', color: '#888' }), id: 'ew-pot', recurringDepositAmount: 45, recurringDepositDayOfMonth: 18, recurringDepositStartDate: '2026-09-18' }
exercise(
  {
    name: 'Pot deposit',
    data: { ...mum, pots: [...(mum.pots ?? []), pot] },
    find: (d, date) => d.transactions.find((t) => t.type === 'pot_deposit' && t.sourceId === 'ew-pot' && t.date === date),
    pause: (d, date, paused) => ({ ...d, pots: (d.pots ?? []).map((p) => (p.id === 'ew-pot' ? { ...p, ...setPausedPotDeposits(p, [date], paused ? [date] : []) } : p)) }),
  },
  '2026-10-18',
  '2026-10-20',
  '2026-10-24',
)

const savings = {
  ...newSavingsPot({ personId: me, name: 'Test savings', openingBalance: 0, openingDate: '2026-09-01', interestMethod: { type: 'aer_credited', aer: 0 }, color: '#888' }),
  id: 'ew-savings',
  recurringDepositAmount: 60,
  recurringDepositDayOfMonth: 18,
  recurringDepositStartDate: '2026-09-18',
}
exercise(
  {
    name: 'Savings-pot deposit',
    data: { ...mum, savingsPots: [...mum.savingsPots, savings] },
    find: (d, date) => d.transactions.find((t) => t.type === 'savings_deposit' && t.sourceId === 'ew-savings' && t.date === date),
    pause: (d, date, paused) => ({ ...d, savingsPots: d.savingsPots.map((p) => (p.id === 'ew-savings' ? { ...p, ...setPausedDeposits(p, [date], paused ? [date] : []) } : p)) }),
  },
  '2026-10-18',
  '2026-10-20',
  '2026-10-24',
)

// Loan recurring overpayment — Adam's real loan. 🚨 Paused by LOAN PERIOD, found by real date.
const adam = load('finance-ledger-backup-2026-09-15.json')
const loan = adam.loans.find((l) => l.recurringOverpayment)!
const periods = scheduledLoanRecurringOverpaymentRealDates(loan, at('2026-09-01'), at('2027-12-31'))
const target = periods.find((p) => p.date >= '2026-10-01')!
check(`Adam's loan has a recurring overpayment due in the autumn (real ${target?.date}, period ${target?.periodDate})`, !!target)
exercise(
  {
    name: 'Loan recurring overpayment',
    data: adam,
    find: (d, date) => d.transactions.find((t) => t.sourceType === 'loan_recurring_overpayment' && t.sourceId === loan.id && t.date === date),
    pause: (d, date, paused) => {
      const period = periods.find((p) => p.date === date)!.periodDate
      return { ...d, loans: d.loans.map((l) => (l.id === loan.id ? { ...l, recurringOverpayment: setPausedLoanRecurringOverpaymentDates(l, [period], paused ? [period] : []) } : l)) }
    },
  },
  target.date,
  shift(target.date, 2),
  shift(target.date, 6),
)

// ── 4. Deleting a loan's recurring overpayment on its own ────────────
console.log('\n4. Deleting a recurring overpayment on its own')
{
  const row = (id: string, date: string): Transaction => ({ id, date, amount: 100, direction: 'out', categoryId: 'c', paymentMethod: 'bank_transfer', status: 'cleared', type: 'loan_payment', location: 'personal', ownerId: 'me', sourceType: 'loan_recurring_overpayment', sourceId: loan.id })
  const data: AppDataV2 = { ...adam, transactions: [row('ro-yesterday', '2026-10-09'), row('ro-5-back', '2026-10-05')] }
  const after = removeLoanRecurringOverpaymentFromData(data, loan.id, '2026-10-10')
  check('cleared yesterday: removed with it', !after.transactions.some((t) => t.id === 'ro-yesterday'))
  check('control — cleared 5 days back: kept as history', after.transactions.some((t) => t.id === 'ro-5-back'))
  const src = readFileSync(new URL('../src/lib/deleteReassign.ts', import.meta.url), 'utf8')
  check('deleteReassign.ts has no inline "dated today" sweep of its own', !/date === asOfIso/.test(src))
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)
