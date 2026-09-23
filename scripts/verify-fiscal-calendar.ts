// PROMPT-08c Part D — Ella's fiscal calendar: 4-weekly, with a 5-week P13
// in 53-week years, computed indefinitely and checked against the
// spreadsheets.
//
// Adam, 2026-09-19: "Ella gets paid every 4 weeks, but every 6 years, her
// final pay period of the year is a 5 week pay … take the current dates in
// the excel sheets, and then extrapolate using the same structure
// indefinitely … build a function that can automatically determine … when
// that extra week gets added, beyond the limits in the files we have."
// And: "Ella gets paid on the last day of each period (Thursday - always)".
//
// THE ORACLE is scripts/fixtures/fiscal-calendar-2005-2030.json: every
// period start date in both of Adam's spreadsheets (25 fiscal years), plus
// DateTables' own P13W5 rows. The rule in lib/fiscalCalendar.ts must
// reproduce all of it.
//
// WHAT FAILS AGAINST THE PRE-FIX CODE: the whole script, at import (no
// fiscal calendar existed). The checks that catch a plausible WRONG
// implementation: a fixed "every 6 years" cycle (wrong for 2032/33, and
// already wrong between 2010/11 and 2015/16); a 5th week added to every
// P13; a 5-week period paid as 4 weeks, or taxed on unscaled thresholds;
// and plain 4-weekly (Part C) picking up a 5th week it must never have.

import { readFileSync } from 'node:fs'
import { addDays, differenceInCalendarDays } from 'date-fns'
import { fiscalPeriodsFor, fiscalYearEnd, isFiftyThreeWeekYear, fiscalYearLabel, fiscalPeriodEndingOn } from '../src/lib/fiscalCalendar'
import { payPeriodWeeks, nominalPaydaysBetween } from '../src/lib/payCycle'
import { upcomingPaydays, paydaysForMonth, generateSalaryTransactions, computeNetPayForPeriod } from '../src/lib/salaryLedger'
import { calculateNetSalary } from '../src/lib/tax'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { toLocalIsoDate as iso } from '../src/lib/date'
import type { AppDataV2, PayCycleConfig, Person } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}
const THURSDAY = 4

console.log('\n── The spreadsheets: every period of 25 fiscal years ──')
const oracle = JSON.parse(readFileSync(new URL('./fixtures/fiscal-calendar-2005-2030.json', import.meta.url), 'utf8')) as {
  years: Record<string, { periodStarts: string[] }>
  dateTablesP13W5Days: string[]
}
const labels = Object.keys(oracle.years).sort()
check('25 years, 2005/06 to 2029/30', [labels.length, labels[0], labels[labels.length - 1]], [25, '2005/06', '2029/30'])
let mismatches: string[] = []
for (const label of labels) {
  const endYear = Number(label.slice(0, 4)) + 1
  const starts = fiscalPeriodsFor(endYear, THURSDAY).map((p) => iso(p.start))
  if (JSON.stringify(starts) !== JSON.stringify(oracle.years[label].periodStarts)) mismatches.push(label)
}
check('every period start matches the rule (P1–P13, all 25 years)', mismatches, [])
// Period ENDS: the day before the next period starts, across year boundaries too.
mismatches = []
for (let i = 0; i < labels.length - 1; i++) {
  const endYear = Number(labels[i].slice(0, 4)) + 1
  const starts = [...oracle.years[labels[i]].periodStarts, oracle.years[labels[i + 1]].periodStarts[0]]
  const ends = fiscalPeriodsFor(endYear, THURSDAY).map((p) => iso(p.end))
  const expected = starts.slice(1).map((s) => iso(addDays(new Date(`${s}T00:00:00`), -1)))
  if (JSON.stringify(ends) !== JSON.stringify(expected)) mismatches.push(labels[i])
}
check('every period end (pay date) matches, 24 year boundaries', mismatches, [])
const fiveWeek = labels.filter((l) => isFiftyThreeWeekYear(Number(l.slice(0, 4)) + 1, THURSDAY))
check('53-week years in the files', fiveWeek, ['2010/11', '2015/16', '2021/22', '2027/28'])
const p13_2122 = fiscalPeriodsFor(2022, THURSDAY)[12]
check("DateTables' own P13W5 rows are the 5th week of 2021/22's P13", oracle.dateTablesP13W5Days, Array.from({ length: 7 }, (_, i) => iso(addDays(p13_2122.end, i - 6))))

console.log('\n── Extrapolated beyond the files ──')
const y53 = [] as string[]
for (let y = 2001; y <= 2061; y++) if (isFiftyThreeWeekYear(y, THURSDAY)) y53.push(fiscalYearLabel(y))
check('53-week years 2000–2061', y53, ['2004/05', '2010/11', '2015/16', '2021/22', '2027/28', '2032/33', '2038/39', '2043/44', '2049/50', '2055/56', '2060/61'])
const gaps = y53.slice(1).map((l, i) => Number(l.slice(0, 4)) - Number(y53[i].slice(0, 4)))
check('the gap is 5 OR 6 years, so a fixed 6-year cycle would be wrong', [...new Set(gaps)].sort(), [5, 6])
let tiling = true
let lengths = true
for (let y = 2001; y <= 2061; y++) {
  const ps = fiscalPeriodsFor(y, THURSDAY)
  ps.forEach((p, i) => {
    const days = differenceInCalendarDays(p.end, p.start) + 1
    if (days !== (i === 12 && isFiftyThreeWeekYear(y, THURSDAY) ? 35 : 28)) lengths = false
    if (p.end.getDay() !== THURSDAY || p.start.getDay() !== 5) lengths = false
    const next = i < 12 ? ps[i + 1].start : fiscalPeriodsFor(y + 1, THURSDAY)[0].start
    if (differenceInCalendarDays(next, p.end) !== 1) tiling = false
  })
}
check('2001–2061: periods tile with no gaps or overlaps', tiling, true)
check('2001–2061: every period Fri → Thu, 28 days, P13 35 in a 53-week year', lengths, true)
let taxYearsOk = true
for (let ty = 2026; ty <= 2059; ty++) {
  const n = nominalPaydaysBetween({ kind: 'four_weekly_fiscal', anchorPayDate: '2026-10-08' }, new Date(ty, 3, 6), new Date(ty + 1, 3, 5)).length
  if (n !== 13) taxYearsOk = false
}
check('every UK tax year 2026/27–2059/60 holds exactly 13 of her paydays (no HMRC "week 53" case)', taxYearsOk, true)
const ends = [] as number[]
for (let y = 2027; y <= 2060; y++) ends.push(fiscalYearEnd(y, THURSDAY).getDate())
check('…because every year ends between 25 and 31 March, before 6 April', [Math.min(...ends), Math.max(...ends)], [25, 31])

console.log("\n── Ella's pay dates on the fiscal frequency ──")
const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures'
const raw = JSON.parse(readFileSync(`${DIR}/finance-ledger-backup-2026-09-15.json`, 'utf8'))
const adam: AppDataV2 = migrateLedgerData(raw.data ?? raw)
const ella0 = adam.people.find((p) => p.name === 'Ella')!
const ella: Person = { ...ella0, salaryHistory: ella0.salaryHistory.map((s) => ({ ...s, payFrequency: 'four_weekly_fiscal' })) }
const pc: PayCycleConfig = { ...adam.payCycles.find((c) => c.personId === ella.id)!, paySchedule: { kind: 'four_weekly_fiscal', anchorPayDate: '2026-10-08' } }
check('from 19 Sep 2026: 8 Oct (P7), 5 Nov, 3 Dec, 31 Dec', upcomingPaydays(pc, new Date(2026, 8, 19), 4).map(iso), ['2026-10-08', '2026-11-05', '2026-12-03', '2026-12-31'])
check('2027/28 P12 → P13 → 2028/29 P1: 24 Feb, 30 Mar (5 weeks), 27 Apr 2028', upcomingPaydays(pc, new Date(2028, 1, 1), 3).map(iso), ['2028-02-24', '2028-03-30', '2028-04-27'])
check('…where plain 4-weekly would pay 23 Mar and 20 Apr', upcomingPaydays({ ...pc, paySchedule: { kind: 'four_weekly', anchorPayDate: '2026-10-08' } }, new Date(2028, 1, 1), 3).map(iso), ['2028-02-24', '2028-03-23', '2028-04-20'])
check('March 2028 holds only the 5-week P13 payday', paydaysForMonth(pc, 2028, 2).map(iso), ['2028-03-30'])
check('payPeriodWeeks: 30 Mar 2028 = 5, 24 Feb 2028 = 4, 25 Mar 2027 (52-week year) = 4', ['2028-03-30', '2028-02-24', '2027-03-25'].map((d) => payPeriodWeeks(pc, d)), [5, 4, 4])
// A payday pulled back for a weekend/bank holiday lands up to 10 days before
// its period ends; payPeriodWeeks must still find the period it pays for.
check('payPeriodWeeks finds the period from a landing date up to 10 days early (29 Mar 2028 → 5)', payPeriodWeeks({ ...pc, paydayAdjustForNonWorkingDay: true }, '2028-03-29'), 5)
check('fiscalPeriodEndingOn(30 Mar 2028) is 2027/28 P13', (({ fiscalYear, period, weeks }) => ({ fiscalYear, period, weeks }))(fiscalPeriodEndingOn(new Date(2028, 2, 30), THURSDAY)!), { fiscalYear: '2027/28', period: 13, weeks: 5 })

console.log('\n── Pay: an extra week on top, taxed on thresholds × 5/4 ──')
const annual = ella.salaryHistory[0].grossAnnual
check("Ella's salary from the backup", annual, 32857.5)
const input = { grossAnnual: annual, taxCode: ella.salaryHistory[0].taxCode, studentLoanPlan: ella.salaryHistory[0].studentLoanPlan, payFrequency: 'four_weekly_fiscal' as const, deductions: ella.salaryHistory[0].deductions }
const normal = calculateNetSalary(input)
const p13 = calculateNetSalary({ ...input, periodWeeks: 5 })
check('normal period gross = annual ÷ 52 × 4 = £2,527.50', Math.round(normal.grossPerPeriod * 100) / 100, 2527.5)
check('5-week P13 gross = annual ÷ 52 × 5 = £3,159.38', Math.round(p13.grossPerPeriod * 100) / 100, 3159.38)
check('the 5-week period pays more than a normal one', p13.netPerPeriod > normal.netPerPeriod, true)
const naive = calculateNetSalary({ ...input, grossAnnual: annual * (5 / 4) })
check('…and tax on the 5-week pay is lower than unscaled thresholds would give', p13.incomeTaxPerPeriod < naive.incomeTaxPerPeriod, true)
// With no deductions, pay and every threshold both scale ×5/4, so tax and NI
// do too, give or take the engine's whole-pound rounding of taxable pay.
const bare = { ...input, deductions: [] }
const bare4 = calculateNetSalary(bare)
const bare5 = calculateNetSalary({ ...bare, periodWeeks: 5 })
check('no deductions: 5-week tax = 4-week tax × 5/4 (within £1 rounding)', Math.abs(bare5.incomeTaxPerPeriod - bare4.incomeTaxPerPeriod * 1.25) <= 1, true)
check('no deductions: 5-week NI = 4-week NI × 5/4 (within 1p)', Math.abs(bare5.nationalInsurancePerPeriod - bare4.nationalInsurancePerPeriod * 1.25) <= 0.01, true)
check("Ella's fixed £52.65 per-period sacrifice stays £52.65; her 2.5% pension follows the gross", [p13.preTaxDeductions.map((d) => Math.round(d.amountPerPeriod * 100) / 100)], [[52.65, 78.98]])
const net = (d: string) => computeNetPayForPeriod(ella, d, pc)
check('the app pays the 5-week figure on 30 Mar 2028 and the normal one either side', [net('2028-02-24') === net('2028-04-27'), net('2028-03-30')! > net('2028-02-24')!], [true, true])
check('without the pay cycle it falls back to a normal period', computeNetPayForPeriod(ella, '2028-03-30'), net('2028-02-24'))
const gen = generateSalaryTransactions(ella, pc, new Date(2028, 1, 1), new Date(2028, 4, 1))
check('generated salary Feb–Apr 2028: the P13 row carries the 5-week pay', gen.map((t) => [t.date, t.amount]), [
  ['2028-02-24', net('2028-02-24')],
  ['2028-03-30', net('2028-03-30')],
  ['2028-04-27', net('2028-04-27')],
])
const fy = (endYear: number) => fiscalPeriodsFor(endYear, THURSDAY).map((p) => Math.round(calculateNetSalary({ ...input, periodWeeks: p.weeks }).grossPerPeriod * 100) / 100)
check('FY 2026/27 gross: 13 × £2,527.50', fy(2027), Array(13).fill(2527.5))
check('FY 2027/28 gross: 12 × £2,527.50 + £3,159.38', fy(2028), [...Array(12).fill(2527.5), 3159.38])

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
