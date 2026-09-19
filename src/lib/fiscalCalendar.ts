// A 4-4-4 fiscal calendar with a 53rd week (2026-09-19, PROMPT-08c Part D).
//
// Ella's employer pays 4-weekly on the last day of each period, 13 periods
// a year. 13 × 28 = 364 days, so every 5 or 6 years the final period (P13)
// is 5 weeks long to catch up the missing days.
//
// THE RULE, derived from Adam's two spreadsheets (`DateTables.xlsx`,
// `Copy of Fiscal Calendar.xlsx`) and checked against every year in them by
// scripts/verify-fiscal-calendar.ts: a fiscal year ENDS on the last pay
// weekday on or before 31 March (for Ella, the last Thursday), and starts
// the day after the previous one ended. A year is 53 weeks when those ends
// are 371 days apart, and P13 is then 5 weeks.
//
// The "every 6 years" rule of thumb is only approximate: leap days make the
// gap 5 or 6 years (…2021/22, 2027/28, 2032/33, 2038/39…). So every year is
// computed from the rule, never from a fixed cycle or a stored table, and
// it extends indefinitely.
//
// Everything here works on UNADJUSTED (nominal) pay dates. The weekend/
// bank-holiday adjustment is applied on top by payCycle.ts, and never moves
// a period's boundaries.

import { addDays, differenceInCalendarDays } from 'date-fns'

/** The fiscal year ends on the last pay weekday on or before this date (month index 2 = March). */
export const FISCAL_YEAR_END_MONTH0 = 2
export const FISCAL_YEAR_END_DAY = 31

export interface FiscalPeriod {
  /** e.g. "2026/27" — the fiscal year that ends in March of `endYear`. */
  fiscalYear: string
  endYear: number
  period: number // 1–13
  start: Date // the day after the previous period's pay date
  end: Date // the pay date (unadjusted), the last day of the period
  weeks: 4 | 5
}

/** The last day (a `payWeekday`, 0 = Sunday … 6 = Saturday) of the fiscal year ending in March of `endYear`. */
export function fiscalYearEnd(endYear: number, payWeekday: number): Date {
  const limit = new Date(endYear, FISCAL_YEAR_END_MONTH0, FISCAL_YEAR_END_DAY)
  return addDays(limit, -((limit.getDay() - payWeekday + 7) % 7))
}

export function isFiftyThreeWeekYear(endYear: number, payWeekday: number): boolean {
  return differenceInCalendarDays(fiscalYearEnd(endYear, payWeekday), fiscalYearEnd(endYear - 1, payWeekday)) === 371
}

export function fiscalYearLabel(endYear: number): string {
  return `${endYear - 1}/${String(endYear % 100).padStart(2, '0')}`
}

/** The 13 periods of the fiscal year ending in March of `endYear`. P1–P12 are 4 weeks; P13 is 4 or 5. */
export function fiscalPeriodsFor(endYear: number, payWeekday: number): FiscalPeriod[] {
  const previousEnd = fiscalYearEnd(endYear - 1, payWeekday)
  const yearEnd = fiscalYearEnd(endYear, payWeekday)
  const periods: FiscalPeriod[] = []
  for (let p = 1; p <= 13; p++) {
    const start = addDays(previousEnd, 28 * (p - 1) + 1)
    const end = p === 13 ? yearEnd : addDays(previousEnd, 28 * p)
    periods.push({ fiscalYear: fiscalYearLabel(endYear), endYear, period: p, start, end, weeks: differenceInCalendarDays(end, start) + 1 === 35 ? 5 : 4 })
  }
  return periods
}

/** The fiscal year (by its end year) containing `date`. */
export function fiscalEndYearFor(date: Date, payWeekday: number): number {
  const y = date.getFullYear()
  return date > fiscalYearEnd(y, payWeekday) ? y + 1 : y
}

/** Every period whose pay date (unadjusted) falls in [from, to], in order. */
export function fiscalPeriodsBetween(from: Date, to: Date, payWeekday: number): FiscalPeriod[] {
  const out: FiscalPeriod[] = []
  for (let y = fiscalEndYearFor(from, payWeekday); y <= fiscalEndYearFor(to, payWeekday); y++) {
    for (const p of fiscalPeriodsFor(y, payWeekday)) if (p.end >= from && p.end <= to) out.push(p)
  }
  return out
}

/** The period whose unadjusted pay date is exactly `payDate`, or null if `payDate` is not a period end. */
export function fiscalPeriodEndingOn(payDate: Date, payWeekday: number): FiscalPeriod | null {
  return fiscalPeriodsFor(fiscalEndYearFor(payDate, payWeekday), payWeekday).find((p) => differenceInCalendarDays(p.end, payDate) === 0) ?? null
}
