// PROMPT-08c Part C — a 4-weekly salary is paid every 28 days from its next
// pay date, and a 4-weekly earner's budgeting cycle runs payday to payday.
//
// Adam, 2026-09-19: "Setting up Ella's 4 week salary, the pay dates are not
// generated correctly … this should be a date picker asking for next pay
// date. The salary/pay dates then need to be every 4 weeks from the next pay
// date … and ensure the rest of the app follows it's pay cycles correctly."
//
// ROOT CAUSE. PayFrequency 'four_weekly' only chose the tax thresholds.
// Every payday came from PayCycleConfig.paydayDayOfMonth, month by month,
// so a 4-weekly earner was paid 12 times a year on a day of the month, on
// 13-a-year tax thresholds.
//
// MONTHLY MUST NOT CHANGE BY A DATE OR A PENNY. Section 1 compares today's
// monthly behaviour on both real backups (every payday 2026–2028, the
// budgeting cycle for every day, upcoming/closed lists, generated salary,
// and a full auto-clear of mum's data) against a fingerprint taken from the
// pre-08c code (test app 97158877), stored in
// scripts/fixtures/monthly-pay-baseline-2026-09-19.json. Regenerate it only
// from pre-change code: `npx tsx scripts/verify-four-weekly-pay.ts --write-baseline`.
//
// WHAT FAILS AGAINST THE PRE-FIX CODE: every check from section 2 on. The
// ones that catch a plausible WRONG fix: 13 or 14 paydays in a calendar
// year (not 12), the bank-holiday payday moving back while the NEXT payday
// stays on the 28-day grid, the cycle running payday to payday and not on
// the old day-of-month, Joint/Household keeping Adam's monthly cycle, and a
// 4-weekly salary with no pay date generating nothing rather than a guess.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { addDays } from 'date-fns'
import * as salaryLedger from '../src/lib/salaryLedger'
import { cycleBoundsForDate } from '../src/lib/payCycle'
import { resolveCycleBounds } from '../src/lib/pensionLedger'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { toLocalIsoDate as iso } from '../src/lib/date'
import type { AppDataV2, PayCycleConfig, Person } from '../src/types/ledger'

const { paydaysForMonth, upcomingPaydays, closedPaydays, generateSalaryTransactions } = salaryLedger

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}
function checkQuiet(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label}${pass ? '' : ` — first difference: ${firstDifference(actual, expected)}`}`)
  if (!pass) failures++
}
function firstDifference(a: unknown, b: unknown): string {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  let i = 0
  while (i < x.length && x[i] === y[i]) i++
  return `…${x.slice(Math.max(0, i - 60), i + 60)} vs …${y.slice(Math.max(0, i - 60), i + 60)}`
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures'
function load(file: string): AppDataV2 {
  const raw = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'))
  return migrateLedgerData(raw.data ?? raw)
}
const adam = load('finance-ledger-backup-2026-09-15.json')
const mum15 = load('finance-ledger-backup-2026-09-15-mum.json')
const mum17 = load('finance-ledger-backup-2026-09-17-mum.json')
const BASELINE = new URL('./fixtures/monthly-pay-baseline-2026-09-19.json', import.meta.url)

// ── 1. Monthly regression ────────────────────────────────────────────
function monthlyFingerprint() {
  const out: Record<string, unknown> = {}
  for (const [name, data] of [['adam', adam], ['mum15', mum15], ['mum17', mum17]] as const) {
    for (const pc of data.payCycles) {
      const person = data.people.find((p) => p.id === pc.personId)!
      const monthly = person.salaryHistory.every((s) => s.payFrequency === 'monthly')
      const key = `${name}:${person.name}`
      const paydays: string[] = []
      for (let y = 2026; y <= 2028; y++) for (let m = 0; m < 12; m++) paydays.push(...paydaysForMonth(pc, y, m).map(iso))
      const bounds: string[] = []
      for (let d = new Date(2026, 0, 1); d <= new Date(2028, 11, 31); d = addDays(d, 1)) {
        const b = cycleBoundsForDate(d, pc)
        bounds.push(`${iso(b.start)}>${iso(b.end)}`)
      }
      const resolved: string[] = []
      for (let d = new Date(2026, 6, 1); d <= new Date(2027, 6, 1); d = addDays(d, 3)) {
        const b = resolveCycleBounds(data, pc.personId, d)
        resolved.push(`${iso(b.start)}>${iso(b.end)}`)
      }
      out[key] = {
        paydays,
        bounds,
        resolved,
        upcoming: upcomingPaydays(pc, new Date(2026, 8, 19), 20).map(iso),
        closed: closedPaydays(pc, new Date(2026, 8, 19), 12).map(iso),
        // Salary only for monthly earners: a 4-weekly salary with no pay date now deliberately waits.
        salary: monthly ? generateSalaryTransactions(person, pc, new Date(2026, 0, 1), new Date(2028, 11, 31)).map((t) => `${t.date}:${t.amount}`) : 'n/a',
      }
    }
  }
  const strip = (d: AppDataV2) => d.transactions.map((t) => ({ ...t, id: undefined })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  out.mumAutoClear15 = strip(autoClearDuePayments(mum15, new Date(2027, 2, 31)))
  out.mumAutoClear17 = strip(autoClearDuePayments(mum17, new Date(2027, 2, 31)))
  return out
}

if (process.argv.includes('--write-baseline')) {
  mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true })
  writeFileSync(BASELINE, JSON.stringify(monthlyFingerprint()))
  console.log('baseline written')
  process.exit(0)
}

console.log('\n── 1. Monthly pay is unchanged (both backups, 2026–2028) ──')
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
const now = JSON.parse(JSON.stringify(monthlyFingerprint()))
for (const key of Object.keys(baseline)) {
  if (typeof baseline[key] === 'object' && !Array.isArray(baseline[key])) {
    for (const part of Object.keys(baseline[key])) checkQuiet(`${key} ${part}`, now[key]?.[part], baseline[key][part])
  } else checkQuiet(key, now[key], baseline[key])
}

// ── 2. Plain 4-weekly ─────────────────────────────────────────────────
console.log('\n── 2. Every 4 weeks from the next pay date ──')
const ella = adam.people.find((p) => p.name === 'Ella')!
const ellaPc = adam.payCycles.find((pc) => pc.personId === ella.id)!
const fourWeekly: PayCycleConfig = { ...ellaPc, paySchedule: { kind: 'four_weekly', anchorPayDate: '2026-10-08' } }
const ellaFourWeekly: Person = { ...ella, salaryHistory: ella.salaryHistory.map((s) => ({ ...s, payFrequency: 'four_weekly' })) }
const months = (pc: PayCycleConfig, y: number) => Array.from({ length: 12 }, (_, m) => paydaysForMonth(pc, y, m).map(iso)).flat()

check('upcoming from 19 Sep 2026: 28 days apart from 8 Oct', upcomingPaydays(fourWeekly, new Date(2026, 8, 19), 4).map(iso), ['2026-10-08', '2026-11-05', '2026-12-03', '2026-12-31'])
check('closed before 8 Oct: the grid runs backwards too (opening balance moved back to reach them)', closedPaydays({ ...fourWeekly, openingBalanceDate: '2026-07-01' }, new Date(2026, 9, 7), 3).map(iso), ['2026-07-16', '2026-08-13', '2026-09-10'])
check('…and never before the opening balance date (3 Sep)', closedPaydays(fourWeekly, new Date(2026, 9, 7), 3).map(iso), ['2026-09-10'])
check('2026 has 13 paydays (not 12)', months(fourWeekly, 2026).length, 13)
check('2027 has 13 paydays', months(fourWeekly, 2027).length, 13)
check('a month can hold two: December 2026', paydaysForMonth(fourWeekly, 2026, 11).map(iso), ['2026-12-03', '2026-12-31'])
check('every 2026 payday is exactly 28 days after the one before', months(fourWeekly, 2026).every((d, i, a) => i === 0 || (Date.parse(d) - Date.parse(a[i - 1])) / 86400000 === 28), true)

console.log('\n── 2b. Bank holiday: the payday moves back, the grid does not ──')
// Anchor so a payday lands on Friday 25 Dec 2026 (Christmas).
const xmas: PayCycleConfig = { ...ellaPc, paydayAdjustForNonWorkingDay: true, paySchedule: { kind: 'four_weekly', anchorPayDate: '2026-12-25' } }
check('25 Dec (bank holiday) is paid Thu 24 Dec, and the next is still 22 Jan', upcomingPaydays(xmas, new Date(2026, 11, 1), 2).map(iso), ['2026-12-24', '2027-01-22'])
const xmasNoAdjust: PayCycleConfig = { ...xmas, paydayAdjustForNonWorkingDay: false }
check('with the box unticked it is paid on the day', upcomingPaydays(xmasNoAdjust, new Date(2026, 11, 1), 1).map(iso), ['2026-12-25'])

console.log('\n── 2c. The budgeting cycle runs payday to payday ──')
const cycle = (pc: PayCycleConfig, d: Date) => {
  const b = cycleBoundsForDate(d, pc)
  return `${iso(b.start)} → ${iso(b.end)}`
}
check('19 Sep 2026: 10 Sep → 7 Oct', cycle(fourWeekly, new Date(2026, 8, 19)), '2026-09-10 → 2026-10-07')
check('on payday itself a new cycle starts', cycle(fourWeekly, new Date(2026, 9, 8)), '2026-10-08 → 2026-11-04')
check('follows-payday ticked: the Christmas cycle starts when the money lands', cycle({ ...xmas, cycleStartFollowsPayday: true }, new Date(2026, 11, 24)), '2026-12-24 → 2027-01-21')
check('unticked: the cycle stays on the period grid', cycle({ ...xmas, cycleStartFollowsPayday: false }, new Date(2026, 11, 24)), '2026-11-27 → 2026-12-24')
const withFourWeekly: AppDataV2 = { ...adam, people: adam.people.map((p) => (p.id === ella.id ? ellaFourWeekly : p)), payCycles: adam.payCycles.map((pc) => (pc.personId === ella.id ? fourWeekly : pc)) }
const adamPc = adam.payCycles.find((pc) => pc.personId === adam.primaryPersonId)!
const r = (d: AppDataV2, id: string, date: Date) => {
  const b = resolveCycleBounds(d, id, date)
  return `${iso(b.start)} → ${iso(b.end)}`
}
check('resolveCycleBounds (Home, pots, projections) uses it for Ella', r(withFourWeekly, ella.id, new Date(2026, 8, 19)), '2026-09-10 → 2026-10-07')
check("Adam's own (primary, monthly) cycle is untouched — Joint/Household follow it", r(withFourWeekly, adamPc.personId, new Date(2026, 8, 19)), r(adam, adamPc.personId, new Date(2026, 8, 19)))

console.log('\n── 2d. Salary is generated on the 4-weekly dates ──')
const gen = generateSalaryTransactions(ellaFourWeekly, fourWeekly, new Date(2026, 8, 3), new Date(2026, 11, 31))
check('Ella from her salary start: 10 Sep, 8 Oct, 5 Nov, 3 Dec, 31 Dec', gen.map((t) => t.date), ['2026-09-10', '2026-10-08', '2026-11-05', '2026-12-03', '2026-12-31'])
check('each at the same 4-weekly net pay', new Set(gen.map((t) => t.amount)).size, 1)

console.log('\n── 2e. A 4-weekly salary with no pay date waits ──')
check("Ella as in the backup (four_weekly, no schedule) needs a pay date", salaryLedger.salaryNeedsPayDate(ella, ellaPc), true)
check('…and generates no salary rather than a guessed monthly one', generateSalaryTransactions(ella, ellaPc, new Date(2026, 8, 3), new Date(2026, 11, 31)).length, 0)
check('once the schedule is set it no longer needs one', salaryLedger.salaryNeedsPayDate(ellaFourWeekly, fourWeekly), false)
check('a schedule of the wrong kind still needs one', salaryLedger.salaryNeedsPayDate({ ...ella, salaryHistory: ella.salaryHistory.map((s) => ({ ...s, payFrequency: 'four_weekly_fiscal' })) }, fourWeekly), true)
check("Adam (monthly) never needs one", salaryLedger.salaryNeedsPayDate(adam.people.find((p) => p.id === adam.primaryPersonId)!, adamPc), false)

console.log('\n── 2f. Switching Ella from the old monthly rule keeps past pay where it was ──')
const switched = salaryLedger.applyPaydayChange(ellaPc, ella, adam.transactions, null, { paydayDayOfMonth: ellaPc.paydayDayOfMonth, paydayAdjustForNonWorkingDay: true, paySchedule: { kind: 'four_weekly', anchorPayDate: '2026-10-08' } }, '2026-10-09', '2026-09-19')!
check('the new rule is the 4-weekly schedule', switched.payCycle.paySchedule, { kind: 'four_weekly', anchorPayDate: '2026-10-08' })
check('the old monthly rule is kept in history up to the switch', switched.payCycle.paydayHistory?.map((h) => [h.paydayDayOfMonth, h.paySchedule ?? 'monthly', h.until, h.nextRuleFrom]), [[10, 'monthly', '2026-10-09', '2026-10-08']])
check('paydays: 10 Sep (old rule) then 8 Oct, 5 Nov (new)', ['2026-08', '2026-09', '2026-10', '2026-11'].flatMap((ym) => paydaysForMonth(switched.payCycle, Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1).map(iso)), ['2026-08-10', '2026-09-10', '2026-10-08', '2026-11-05'])

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
