// "Manage upcoming payments": the last payment on or before today, then the
// next 12 payments, on every list.
//
// Adam, 2026-09-19 (after PROMPT-08c): "in manage upcoming payments, I used
// to only see the most recent payment, and the next 12 upcoming … I can see
// 3 already cleared payments." Every list actually showed 2 months back to
// 12 months ahead; PROMPT-08c Part A moved recurring transactions (which
// had their own "Next 12 upcoming" list) onto that shared window. Adam
// chose one rule for all 7 call sites: last payment on or before today +
// the next 12 payments.
//
// WHAT FAILS AGAINST THE PRE-FIX CODE: the whole script, at import
// (manageUpcomingRange/trimToManageUpcoming did not exist), and the source
// checks at the bottom (every call site used addMonths(new Date(), -2) /
// the pot preview windows). The old window also fails the count checks: a
// monthly bill gave 15 rows (2-3 past), an annual one 1-2.

import { readFileSync } from 'node:fs'
import { manageUpcomingRange, trimToManageUpcoming, MANAGE_UPCOMING_NEXT_COUNT } from '../src/lib/occurrenceOverrides'
import { scheduledTemplateDates } from '../src/lib/schedule'
import { scheduledPensionDates } from '../src/lib/pensionLedger'
import { scheduledPotDepositDates } from '../src/lib/potLedger'
import { scheduledDepositDates } from '../src/lib/savingsPotLedger'
import { scheduledLoanRecurringOverpaymentRealDates } from '../src/lib/ledgerLoans'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import type { AppDataV2, Pension, Pot, RecurringTemplate, SavingsPot } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures'
function load(file: string): AppDataV2 {
  const raw = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'))
  return migrateLedgerData(raw.data ?? raw)
}

const TODAY = new Date(2026, 8, 19)
const TODAY_ISO = '2026-09-19'
const { start, end } = manageUpcomingRange(TODAY)

/** [past rows, upcoming rows, first date, last date] — the shape every list must have. */
function shape(dates: string[]) {
  return { past: dates.filter((d) => d <= TODAY_ISO).length, upcoming: dates.filter((d) => d > TODAY_ISO).length, first: dates[0], last: dates.at(-1) }
}
function templateWindow(t: RecurringTemplate) {
  return trimToManageUpcoming(scheduledTemplateDates(t, start, end), (d) => d.date, TODAY).map((d) => d.date)
}

console.log('\n── The rule itself ──')
check('12 upcoming', MANAGE_UPCOMING_NEXT_COUNT, 12)
const monthly14 = Array.from({ length: 14 }, (_, i) => `${2026 + Math.floor((i + 9) / 12)}-${String(((i + 9) % 12) + 1).padStart(2, '0')}-01`) // 1 Oct 2026 … 1 Nov 2027
check('unsorted input, several past → last past + next 12', shape(trimToManageUpcoming([...monthly14].reverse().concat(['2026-08-01', '2026-09-01']), (d) => d, TODAY)), { past: 1, upcoming: 12, first: '2026-09-01', last: '2027-09-01' })
check('nothing past yet → 12 upcoming only', shape(trimToManageUpcoming(['2026-09-20', '2026-09-27'], (d) => d, TODAY)), { past: 0, upcoming: 2, first: '2026-09-20', last: '2026-09-27' })

const adam = load('finance-ledger-backup-2026-09-15.json')
const mum = load('finance-ledger-backup-2026-09-17-mum.json')

console.log('\n── Bills (monthly) ──')
const windscribe = adam.recurringTemplates.find((t) => t.id === 'eFQqaDj8')!
check('Windscribe, due today (19th) → today is the last payment, not an upcoming one', shape(templateWindow(windscribe)), { past: 1, upcoming: 12, first: '2026-09-19', last: '2027-09-19' })
const gym = adam.recurringTemplates.find((t) => t.id === 'MyiDdhkv')!
check('Gym, first payment 1 Oct → no past row, 12 upcoming', shape(templateWindow(gym)), { past: 0, upcoming: 12, first: '2026-10-01', last: '2027-09-01' })
const sky = mum.recurringTemplates.find((t) => t.id === 'HDUztHoe')!
check("mum's Sky, 15th → 15 Sep then Oct … Sep", shape(templateWindow(sky)), { past: 1, upcoming: 12, first: '2026-09-15', last: '2027-09-15' })

console.log('\n── Recurring transaction (weekly, with a payment moved earlier) ──')
const shopping = mum.recurringTemplates.find((t) => t.id === 'QSF9e_W8')!
// 19 Sep slot is moved to 18 Sep: the last payment on or before today is the 18th.
check("mum's Weekly shopping → 18 Sep (moved from 19th), then 12 weekly", shape(templateWindow(shopping)), { past: 1, upcoming: 12, first: '2026-09-18', last: '2026-12-12' })

console.log('\n── Recurring transfer (monthly) ──')
const bills = adam.recurringTemplates.find((t) => t.id === 'vK9Z5XOy')!
check('Bills Deposit, 12th', shape(templateWindow(bills)), { past: 1, upcoming: 12, first: '2026-09-12', last: '2027-09-12' })

console.log('\n── Annual and quarterly: the range is wide enough ──')
const annual: RecurringTemplate = { ...gym, frequency: 'annual', anchorDate: '2025-11-01', anchorDayOfMonth: undefined, occurrenceOverrides: [], amountHistory: undefined }
check('annual from 1 Nov 2025 → 1 Nov 2025 + 12 years ahead', shape(templateWindow(annual)), { past: 1, upcoming: 12, first: '2025-11-01', last: '2037-11-01' })
const quarterly: RecurringTemplate = { ...annual, frequency: 'quarterly', anchorDate: '2026-07-20' }
check('quarterly from 20 Jul → 20 Jul + 12 quarters', shape(templateWindow(quarterly)), { past: 1, upcoming: 12, first: '2026-07-20', last: '2029-07-20' })

console.log('\n── Pension ──')
const pension = { anchorDate: '2026-06-28', frequency: 'monthly' } as Pension
check('monthly pension, 28th', shape(trimToManageUpcoming(scheduledPensionDates(pension, start, end), (d) => d, TODAY)), { past: 1, upcoming: 12, first: '2026-08-28', last: '2027-08-28' })

console.log('\n── Pots and savings pots (monthly, no history before opening) ──')
const pot = { openingDate: '2026-09-01', recurringDepositAmount: 50, recurringDepositStartDate: '2026-09-05', recurringDepositDayOfMonth: 5 } as Pot
check('pot, 5th → 5 Sep + 12', shape(trimToManageUpcoming(scheduledPotDepositDates(pot, start, end), (d) => d, TODAY)), { past: 1, upcoming: 12, first: '2026-09-05', last: '2027-09-05' })
const newPot = { ...pot, openingDate: '2026-09-19', recurringDepositStartDate: '2026-10-05' } as Pot
check('pot opened today, first deposit 5 Oct → nothing fabricated before it', shape(trimToManageUpcoming(scheduledPotDepositDates(newPot, start, end), (d) => d, TODAY)), { past: 0, upcoming: 12, first: '2026-10-05', last: '2027-09-05' })
const savings = { openingDate: '2025-01-01', recurringDepositAmount: 100, recurringDepositStartDate: '2025-01-25', recurringDepositDayOfMonth: 25 } as SavingsPot
check('savings pot, 25th → 25 Aug + 12', shape(trimToManageUpcoming(scheduledDepositDates(savings, start, end), (d) => d, TODAY)), { past: 1, upcoming: 12, first: '2026-08-25', last: '2027-08-25' })

console.log('\n── Loan recurring overpayment ──')
const tesco = adam.loans.find((l) => l.id === '3s08nRFO')!
const loanRows = trimToManageUpcoming(scheduledLoanRecurringOverpaymentRealDates(tesco, start, end), (e) => e.date, TODAY).map((e) => e.date)
const loanAll = scheduledLoanRecurringOverpaymentRealDates(tesco, start, end).filter((e) => e.date > TODAY_ISO).length
check('Tesco → at most 1 past, then 12 (or fewer if the loan ends first)', { past: shape(loanRows).past <= 1, upcoming: shape(loanRows).upcoming }, { past: true, upcoming: Math.min(12, loanAll) })

console.log('\n── Every call site uses the shared window (source) ──')
const src = (f: string) => readFileSync(new URL(`../src/pages/${f}`, import.meta.url), 'utf8')
const pages = { Bills: src('Bills.tsx'), Salary: src('Salary.tsx'), Expenses: src('Expenses.tsx') }
const controls = Object.values(pages).reduce((n, s) => n + (s.match(/<PausedOccurrencesControl\b/g) ?? []).length, 0)
const trims = Object.values(pages).reduce((n, s) => n + (s.match(/trimToManageUpcoming\(/g) ?? []).length, 0)
check('7 Manage upcoming payments lists', controls, 7)
check('7 trimToManageUpcoming calls, one per list', trims, 7)
check('no page still uses the old 2-months-back window', Object.values(pages).some((s) => s.includes('addMonths(new Date(), -2)')), false)
check('no list uses the pot preview windows', /schedule(Pot)?PreviewWindow\(/.test(pages.Expenses), false)

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
