// PROMPT-08c Part D — generates ELLA-PAY-TABLE-FY2026-27-to-FY2027-28.md, the
// period-by-period pay table Adam asked for to check the 5-week P13:
//
//   "create a payment table in a md file in this directory up to and
//   including fiscal year 2027-28, so I can check that the P13 W5 pay is
//   correct using Ella's salary from my backup file"
//
// Every figure comes from the app's own functions: the fiscal calendar
// (fiscalPeriodsFor), the pay dates as the app generates them
// (scheduledPaydaysBetween), the period length (payPeriodWeeks) and the tax
// engine (calculateNetSalary). Each net figure is cross-checked against
// computeNetPayForPeriod — the function the ledger itself uses — and the
// script refuses to write the table if any disagree.
//
// Not a verify-* script (it writes a file), so the sweep doesn't run it.
//   TZ=Europe/London npx tsx scripts/generate-ella-pay-table.ts [output.md]

import { readFileSync, writeFileSync } from 'node:fs'
import { fiscalPeriodsFor } from '../src/lib/fiscalCalendar'
import { payPeriodWeeks, scheduledPaydaysBetween } from '../src/lib/payCycle'
import { computeNetPayForPeriod } from '../src/lib/salaryLedger'
import { calculateNetSalary, periodThresholdsFor as thresholdsFor, STUDENT_LOAN_THRESHOLDS_2026_27 } from '../src/lib/tax'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { toLocalIsoDate as iso } from '../src/lib/date'
import type { AppDataV2, PayCycleConfig, Person } from '../src/types/ledger'

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger'
// The table, its two source spreadsheets and its screenshots live together in
// one folder (2026-09-23). The screenshot links written at the foot of the
// table are RELATIVE to the table, so `screenshots/` must stay a subfolder of
// OUT's directory — moving the table without its screenshots breaks them.
const ELLA_DIR = `${DIR}/ella-pay-cycle`
const OUT = process.argv[2] ?? `${ELLA_DIR}/ELLA-PAY-TABLE-FY2026-27-to-FY2027-28.md`
const raw = JSON.parse(readFileSync(`${DIR}/fixtures/finance-ledger-backup-2026-09-15.json`, 'utf8'))
const adam: AppDataV2 = migrateLedgerData(raw.data ?? raw)
const ella0 = adam.people.find((p) => p.name === 'Ella')!
const snapshot = { ...ella0.salaryHistory[0], payFrequency: 'four_weekly_fiscal' as const }
const ella: Person = { ...ella0, salaryHistory: [snapshot] }
// Next pay date 8 Oct 2026 (2026/27 P7), as set in-app. Only the Thursday matters to the fiscal calendar.
const pc: PayCycleConfig = { ...adam.payCycles.find((c) => c.personId === ella.id)!, paySchedule: { kind: 'four_weekly_fiscal', anchorPayDate: '2026-10-08' } }
const THURSDAY = 4

const money = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const r2 = (n: number) => Math.round(n * 100) / 100
const day = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

interface Row {
  fy: string
  period: number
  weeks: number
  start: Date
  end: Date
  payDate: Date
  moved: boolean
  real: boolean
  gross: number
  sacrifice: number
  tax: number
  ni: number
  studentLoan: number
  after: number
  net: number
}
const rows: Row[] = []
const problems: string[] = []
for (const endYear of [2027, 2028]) {
  for (const p of fiscalPeriodsFor(endYear, THURSDAY)) {
    const [payDate] = scheduledPaydaysBetween({ ...pc, paySchedule: pc.paySchedule! }, new Date(p.end.getTime() - 10 * 86400000), p.end)
    const weeks = payPeriodWeeks(pc, iso(payDate))!
    const b = calculateNetSalary({
      grossAnnual: snapshot.grossAnnual,
      taxCode: snapshot.taxCode,
      studentLoanPlan: snapshot.studentLoanPlan,
      payFrequency: snapshot.payFrequency,
      periodWeeks: weeks,
      deductions: snapshot.deductions,
    })
    const real = iso(payDate) >= snapshot.effectiveFrom
    const appNet = computeNetPayForPeriod(ella, iso(payDate), pc)
    if (real && appNet !== r2(b.netPerPeriod)) problems.push(`${p.fiscalYear} P${p.period}: table ${r2(b.netPerPeriod)} vs app ${appNet}`)
    if (weeks !== p.weeks) problems.push(`${p.fiscalYear} P${p.period}: weeks ${weeks} vs calendar ${p.weeks}`)
    rows.push({
      fy: p.fiscalYear,
      period: p.period,
      weeks,
      start: p.start,
      end: p.end,
      payDate,
      moved: iso(payDate) !== iso(p.end),
      real,
      gross: r2(b.grossPerPeriod),
      sacrifice: r2(b.preTaxDeductions.reduce((s, d) => s + d.amountPerPeriod, 0)),
      tax: r2(b.incomeTaxPerPeriod),
      ni: r2(b.nationalInsurancePerPeriod),
      studentLoan: r2(b.studentLoanPerPeriod),
      after: r2(b.postTaxDeductions.reduce((s, d) => s + d.amountPerPeriod, 0)),
      net: r2(b.netPerPeriod),
    })
  }
}
if (problems.length) {
  console.error('Refusing to write the table — it disagrees with the app:\n' + problems.join('\n'))
  process.exit(1)
}

const p13 = rows.find((r) => r.fy === '2027/28' && r.period === 13)!
const normal = rows.find((r) => r.fy === '2027/28' && r.period === 12)!
const t4 = thresholdsFor('four_weekly_fiscal')
const t5 = thresholdsFor('four_weekly_fiscal', 5)
const allowance = calculateNetSalary({ grossAnnual: snapshot.grossAnnual, taxCode: snapshot.taxCode, studentLoanPlan: snapshot.studentLoanPlan, payFrequency: snapshot.payFrequency, deductions: snapshot.deductions }).personalAllowance
const slThreshold = snapshot.studentLoanPlan === 'none' ? 0 : STUDENT_LOAN_THRESHOLDS_2026_27[snapshot.studentLoanPlan].threshold
const table = (fy: string) => {
  const rs = rows.filter((r) => r.fy === fy)
  const sum = (k: keyof Row) => money(r2(rs.reduce((s, r) => s + (r[k] as number), 0)))
  return [
    `### Fiscal year ${fy}${rs.some((r) => r.weeks === 5) ? ' — a 53-week year' : ''}`,
    '',
    '| Period | Weeks | Period runs | Pay date | Gross | Salary sacrifice | Income tax | NI | Student loan | After-tax deductions | **Net** |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ...rs.map(
      (r) =>
        `| P${r.period}${r.real ? '' : ' †'} | ${r.weeks === 5 ? '**5**' : r.weeks} | ${day(r.start)} – ${day(r.end)} | ${day(r.payDate)}${r.moved ? ' ‡' : ''} | ${money(r.gross)} | ${money(r.sacrifice)} | ${money(r.tax)}${r.weeks === 5 ? ' *' : ''} | ${money(r.ni)}${r.weeks === 5 ? ' *' : ''} | ${money(r.studentLoan)} | ${money(r.after)} | **${money(r.net)}** |`,
    ),
    `| **Total** | ${rs.reduce((s, r) => s + r.weeks, 0)} | | | **${sum('gross')}** | ${sum('sacrifice')} | ${sum('tax')} | ${sum('ni')} | ${sum('studentLoan')} | ${sum('after')} | **${sum('net')}** |`,
  ].join('\n')
}

const md = `# Ella's pay, FY 2026/27 to FY 2027/28 — checking the 5-week P13

Generated ${iso(new Date())} by \`finance-ledger-test/scripts/generate-ella-pay-table.ts\` (PROMPT-08c Part D), from Ella's salary in
\`finance-ledger-backup-2026-09-15.json\`: **${money(snapshot.grossAnnual)} a year**, tax code ${snapshot.taxCode}, student loan ${snapshot.studentLoanPlan},
deductions: ${snapshot.deductions.map((d) => `${d.name} (${d.type.replace(/_/g, ' ')}, ${d.amountType === 'percent' ? `${d.amount}%` : money(d.amount)})`).join(', ')}.

Every figure comes from the app's own functions, not a separate spreadsheet: the fiscal calendar, the pay dates the app
generates, and the tax engine. Each net figure dated on or after her salary's start was checked against the function the
ledger uses (\`computeNetPayForPeriod\`), and the script refuses to write this file if any disagree.

**How to read it**

- **Frequency:** "Every 4 weeks, 5-week P13 in 53-week years", with next pay date **Thu 8 Oct 2026** (2026/27 P7).
- **Periods run Friday → Thursday**, and Ella is paid on the Thursday that ends each one. The period dates match
  \`Copy of Fiscal Calendar.xlsx\` and \`DateTables.xlsx\` exactly.
- **†** Her salary snapshot starts **${snapshot.effectiveFrom}**, so the app has no salary for periods paid before then. Those
  rows are worked out as if her current salary had applied throughout, which is the comparison you asked for.
- **‡** The pay date moved earlier for a weekend or UK bank holiday. There are none in these two years.
- **\\*** Tax and NI on the 5-week period are an **estimate**: the 4-weekly thresholds pro-rated ×5/4 (your call). Real
  payroll uses HMRC's cumulative tables, so expect pennies to a few pounds of difference on that one payslip.
- 2027/28 uses the app's **2026/27 tax rates and thresholds**. They're the only ones it has.

${table('2026/27')}

${table('2027/28')}

## The row you're checking: 2027/28 P13, paid ${day(p13.payDate)}

| | Normal period (P12) | 5-week P13 |
|---|---:|---:|
| Weekly rate (annual ÷ 52) | ${money(r2(snapshot.grossAnnual / 52))} | ${money(r2(snapshot.grossAnnual / 52))} |
| Weeks | 4 | 5 |
| **Gross** | **${money(normal.gross)}** | **${money(p13.gross)}** |
| Salary sacrifice | ${money(normal.sacrifice)} | ${money(p13.sacrifice)} |
| Income tax | ${money(normal.tax)} | ${money(p13.tax)} |
| National Insurance | ${money(normal.ni)} | ${money(p13.ni)} |
| Student loan | ${money(normal.studentLoan)} | ${money(p13.studentLoan)} |
| After-tax deductions | ${money(normal.after)} | ${money(p13.after)} |
| **Net** | **${money(normal.net)}** | **${money(p13.net)}** |

- **Gross** is an extra week on top: ${money(snapshot.grossAnnual)} ÷ 52 × 5 = ${money(p13.gross)} (the weekly rate is £${(snapshot.grossAnnual / 52).toFixed(3)}), so 2027/28 pays
  53/52 of the annual salary (${money(r2(rows.filter((r) => r.fy === '2027/28').reduce((s, r) => s + r.gross, 0)))} instead of ${money(snapshot.grossAnnual)}).
- **Thresholds for that period, ×5/4:** personal allowance per period (code ${snapshot.taxCode}, ${money(allowance)} a year) ${money(r2(allowance / t4.periodsPerYear))} → ${money(r2(allowance / t5.periodsPerYear))};
  NI primary threshold ${money(t4.niPrimaryThreshold)} → ${money(r2(t5.niPrimaryThreshold))}; student loan threshold per period
  ${money(r2(slThreshold / t4.periodsPerYear))} → ${money(r2(slThreshold / t5.periodsPerYear))}.
- **Deductions:** the ${snapshot.deductions.filter((d) => d.amountType === 'percent').map((d) => `${d.amount}% ${d.name}`).join(', ')} follows the gross.
  The fixed ones (${snapshot.deductions.filter((d) => d.amountType !== 'percent').map((d) => `${d.name} ${money(d.amount)}`).join(', ')}) stay the same per period.
  If any of those is really charged per week, the 5-week payslip will take 5/4 of it; tell me and I'll change it.
- **Tax years:** her last payday of every fiscal year falls between 25 and 31 March, before 6 April, so every UK tax year
  holds exactly 13 of her paydays. HMRC's "week 53" rules never apply to her. This is checked for every year to 2060.

## In the app

- Wallet → Ella, upcoming pay with "today" moved to 3 Feb 2028:
  \`screenshots/2026-09-19-partD-ella-upcoming-salary-5-week-P13.png\`
- Home → Personal (Ella) → Next 3 cycles, every cycle expanded, bills hidden:
  \`screenshots/2026-09-19-partD-ella-home-next-3-cycles.png\`
- The "Set next pay date" card her existing salary now shows: \`screenshots/2026-09-19-partC-ella-set-next-pay-date.png\`
`
writeFileSync(OUT, md)
console.log(`wrote ${OUT}`)
console.log(`2027/28 P13: gross ${p13.gross}, net ${p13.net}; P12 net ${normal.net}`)
