// Pay cycle math (doc Section 3.3): two deliberately independent dates.
//  - PAYDAY: the nominal day-of-month salary arrives, adjusted to the
//    last working day on or before it if that day falls on a weekend or
//    UK bank holiday.
//  - CYCLE BOUNDARY: the budgeting "month" (e.g. 14th–13th) used for
//    summary/projection scoping. Stays fixed even when the actual payday
//    drifts a day or two earlier for a weekend/holiday.
// Both live on PayCycleConfig (types/ledger.ts) as separate fields for
// exactly this reason — don't derive one from the other.

import { addDays, startOfDay } from 'date-fns'

// England & Wales bank holidays only — the app has no location setting,
// and this is the most common calendar for the UK finance use case this
// app was built around. Scotland/NI diverge (St Andrew's Day, different
// August holiday, etc.) — out of scope until that's actually requested.
//
// Computed rather than hard-coded per year so payday resolution keeps
// working correctly for any future year without a data update:
//  - Fixed-date holidays (New Year's Day, Christmas Day, Boxing Day) that
//    fall on a weekend move to the next available weekday — this is the
//    real UK "substitute day" rule, not a general weekend-skip.
//  - Good Friday / Easter Monday are moveable, computed from Easter
//    Sunday via the anonymous Gregorian algorithm (Meeus/Jones/Butcher).
//  - Early May, Spring, and Summer bank holidays are the 1st Monday of
//    May, last Monday of May, and last Monday of August respectively.

function easterSunday(year: number): Date {
  // Anonymous Gregorian algorithm.
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31) // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(year, month - 1, day)
}

function lastMondayOf(year: number, monthIndex0: number): Date {
  const lastDayOfMonth = new Date(year, monthIndex0 + 1, 0)
  const dayOfWeek = lastDayOfMonth.getDay() // 0 = Sunday
  const diffToMonday = (dayOfWeek + 6) % 7 // days to subtract to reach the preceding Monday
  return addDays(lastDayOfMonth, -diffToMonday)
}

function firstMondayOf(year: number, monthIndex0: number): Date {
  const firstDayOfMonth = new Date(year, monthIndex0, 1)
  const dayOfWeek = firstDayOfMonth.getDay()
  const diffToMonday = (8 - dayOfWeek) % 7
  return addDays(firstDayOfMonth, diffToMonday)
}

// If `date` falls on a Saturday or Sunday, returns the next Monday (or
// Tuesday, if Monday is also a fixed holiday that year — used for New
// Year's Day landing on a Saturday, which pushes Jan 1 substitute to the
// Monday, but if Jan 1 is a Sunday the substitute is just the Monday
// since Boxing Day/Christmas are a different month entirely). For this
// app's purposes (Jan 1, Dec 25, Dec 26 only) a single-step "move to next
// Monday" is sufficient — the compound Christmas/Boxing Day double-skip
// is handled explicitly in ukBankHolidays() below.
function substituteIfWeekend(date: Date): Date {
  const dow = date.getDay()
  if (dow === 6) return addDays(date, 2) // Saturday -> Monday
  if (dow === 0) return addDays(date, 1) // Sunday -> Monday
  return date
}

const dateKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/** All England & Wales bank holidays falling within the given calendar year. */
export function ukBankHolidays(year: number): Date[] {
  const easter = easterSunday(year)
  const goodFriday = addDays(easter, -2)
  const easterMonday = addDays(easter, 1)

  const newYearsDay = substituteIfWeekend(new Date(year, 0, 1))
  const earlyMay = firstMondayOf(year, 4)
  const springBankHoliday = lastMondayOf(year, 4)
  const summerBankHoliday = lastMondayOf(year, 7)

  // Christmas Day / Boxing Day: if Dec 25 is a Sat/Sun, both substitute
  // days shift so neither collides with the other's substitute.
  const christmasDayNominal = new Date(year, 11, 25)
  const boxingDayNominal = new Date(year, 11, 26)
  let christmasDay = christmasDayNominal
  let boxingDay = boxingDayNominal
  const christmasDow = christmasDayNominal.getDay()
  if (christmasDow === 6) {
    // Sat 25th / Sun 26th -> both move to Mon 27th / Tue 28th
    christmasDay = addDays(christmasDayNominal, 2)
    boxingDay = addDays(boxingDayNominal, 2)
  } else if (christmasDow === 0) {
    // Sun 25th -> substitute Tue 27th (Monday's taken by Boxing Day,
    // which is already a normal Monday and doesn't itself need moving).
    christmasDay = addDays(christmasDayNominal, 2)
  } else if (boxingDayNominal.getDay() === 6) {
    // Fri 25th (fine) / Sat 26th -> Boxing Day substitute = Mon 28th
    boxingDay = addDays(boxingDayNominal, 2)
  }
  // Any other weekday combination (25th Mon–Thu) needs no substitution.

  return [
    newYearsDay,
    goodFriday,
    easterMonday,
    earlyMay,
    springBankHoliday,
    summerBankHoliday,
    christmasDay,
    boxingDay,
  ]
}

let cachedYear: number | null = null
let cachedHolidaySet: Set<string> = new Set()

export function isUkBankHoliday(date: Date): boolean {
  const year = date.getFullYear()
  if (cachedYear !== year) {
    cachedYear = year
    cachedHolidaySet = new Set(ukBankHolidays(year).map(dateKey))
  }
  return cachedHolidaySet.has(dateKey(date))
}

export function isWeekend(date: Date): boolean {
  const dow = date.getDay()
  return dow === 0 || dow === 6
}

export function isWorkingDay(date: Date): boolean {
  return !isWeekend(date) && !isUkBankHoliday(date)
}

// ── Payday resolution ───────────────────────────────────────────────────

/**
 * The nominal payday for the given month, clamped to that month's real
 * last day if dayOfMonth overshoots (e.g. 31st in a 30-day month).
 */
export function nominalPayday(year: number, monthIndex0: number, dayOfMonth: number): Date {
  const daysInMonth = new Date(year, monthIndex0 + 1, 0).getDate()
  return new Date(year, monthIndex0, Math.min(dayOfMonth, daysInMonth))
}

/**
 * Walks backward from `date` until it lands on a working day — the core
 * step resolvePayday already did inline for a nominal day-of-month
 * payday. Pulled out as its own function so pensionLedger.ts can apply
 * the identical UK weekend/bank-holiday adjustment to a pension's own
 * (non-day-of-month, potentially weekly) schedule, rather than
 * duplicating this logic. Behaviour-preserving for resolvePayday itself
 * — same 10-day sanity guard, same backward-only direction.
 */
export function adjustToWorkingDay(date: Date): Date {
  if (isWorkingDay(date)) return date
  let candidate = date
  for (let i = 0; i < 10 && !isWorkingDay(candidate); i++) {
    candidate = addDays(candidate, -1)
  }
  return candidate
}

/**
 * Resolves the actual payday for a given month: the nominal day, or — if
 * adjustForNonWorkingDay is true and that day is a weekend/bank holiday —
 * the last working day on or before it.
 */
export function resolvePayday(
  year: number,
  monthIndex0: number,
  dayOfMonth: number,
  adjustForNonWorkingDay: boolean,
): Date {
  const nominal = nominalPayday(year, monthIndex0, dayOfMonth)
  return adjustForNonWorkingDay ? adjustToWorkingDay(nominal) : nominal
}

// ── Cycle boundary ──────────────────────────────────────────────────────

/**
 * Everything needed to place a cycle boundary. Passed instead of a bare
 * day-of-month wherever the caller has a real PayCycleConfig to hand, so
 * the `cycleStartFollowsPayday` override (types/ledger.ts) is honoured
 * automatically rather than needing every call site to remember to check
 * it. A PayCycleConfig is structurally assignable to this.
 *
 * The bare-number form of cycleBoundsForDate/cycleOffset is kept for the
 * fixed-day maths on its own (used directly by the verify scripts that
 * test that maths in isolation) — but note it can only ever produce
 * fixed-day boundaries, so anything holding a PayCycleConfig should pass
 * the config itself, NOT `config.cycleStartDayOfMonth`.
 */
export interface CycleBoundarySpec {
  cycleStartDayOfMonth: number
  paydayDayOfMonth: number
  paydayAdjustForNonWorkingDay: boolean
  cycleStartFollowsPayday?: boolean
}

/**
 * Cycle boundaries that follow the RESOLVED payday rather than a fixed
 * day of the month — the `cycleStartFollowsPayday` override.
 *
 * Deliberately built by collecting the resolved paydays of the months
 * AROUND the reference date and picking the last one on or before it,
 * rather than the "is ref past this month's boundary?" branch the
 * fixed-day path uses. That branch is only sound because a fixed-day
 * boundary always lands inside its own month; a resolved payday doesn't.
 * With payday on the 1st, a Sunday 1 November resolves back to Friday 30
 * October — so October genuinely contains two boundaries (1 Oct and 30
 * Oct) and November contains none. Asking "is ref >= October's boundary?"
 * would answer yes for 31 October and hand back a cycle that ended on 29
 * October, i.e. a window not containing the reference date at all.
 * Scanning the neighbouring months and picking the true predecessor has
 * no such blind spot.
 *
 * A ±3 month window is far more than enough: consecutive nominal paydays
 * are at least 28 days apart and resolution only ever walks BACKWARD, by
 * at most 10 days (resolvePayday's own guard), so the resolved sequence
 * stays strictly increasing and one month either side would already
 * suffice.
 */
function paydayCycleBounds(referenceDate: Date, spec: CycleBoundarySpec): { start: Date; end: Date } {
  const ref = startOfDay(referenceDate)

  const candidates: Date[] = []
  for (let offset = -3; offset <= 3; offset++) {
    const anchor = new Date(ref.getFullYear(), ref.getMonth() + offset, 1)
    candidates.push(resolvePayday(anchor.getFullYear(), anchor.getMonth(), spec.paydayDayOfMonth, spec.paydayAdjustForNonWorkingDay))
  }
  candidates.sort((a, b) => a.getTime() - b.getTime())

  let start = candidates[0]
  let next = candidates[candidates.length - 1]
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].getTime() <= ref.getTime()) {
      start = candidates[i]
      next = candidates[i + 1] ?? addDays(candidates[i], 28)
    }
  }

  return { start, end: addDays(next, -1) }
}

/**
 * The cycle-boundary day for a given month, clamped to that month's
 * actual length (e.g. day 31 clamps to day 30 in a 30-day month, day 28
 * in February). Pulled into its own function because it must be
 * recomputed FRESH for every month independently — see the comment on
 * cycleBoundsForDate below for why that matters.
 */
function clampedCycleStart(year: number, monthIndex0: number, cycleStartDayOfMonth: number): Date {
  const daysInMonth = new Date(year, monthIndex0 + 1, 0).getDate()
  return new Date(year, monthIndex0, Math.min(cycleStartDayOfMonth, daysInMonth))
}

/**
 * The pay-cycle window (start/end, inclusive) containing `referenceDate`,
 * for a fixed cycle-start day of month (e.g. 14 -> 14th–13th cycles).
 * Independent of the actual adjusted payday — see the file header.
 *
 * Both boundaries are computed by clamping cycleStartDayOfMonth fresh
 * against each relevant month's real length — NOT by adding a month to
 * an already-computed (possibly already-clamped) date. That distinction
 * matters: a short month (e.g. 30-day September, with
 * cycleStartDayOfMonth 31) clamps its own start down to day 30, but
 * `addMonths` on that already-clamped date would carry day 30 forward
 * into October too, even though October has 31 days and the boundary
 * should genuinely land on the 31st again there. Left unfixed, that
 * silently drifts the horizon end a day early every time a short month
 * is crossed — which cut a real payday out of the "next 3 cycles" view
 * whenever the cycle chain passed through September.
 */
export function cycleBoundsForDate(referenceDate: Date, cycle: number | CycleBoundarySpec): { start: Date; end: Date } {
  if (typeof cycle !== 'number' && cycle.cycleStartFollowsPayday) return paydayCycleBounds(referenceDate, cycle)

  const cycleStartDayOfMonth = typeof cycle === 'number' ? cycle : cycle.cycleStartDayOfMonth
  const ref = startOfDay(referenceDate)
  const thisMonthStart = clampedCycleStart(ref.getFullYear(), ref.getMonth(), cycleStartDayOfMonth)

  let start: Date
  if (ref >= thisMonthStart) {
    start = thisMonthStart
  } else {
    const prevMonthIndex0 = ref.getMonth() === 0 ? 11 : ref.getMonth() - 1
    const prevYear = ref.getMonth() === 0 ? ref.getFullYear() - 1 : ref.getFullYear()
    start = clampedCycleStart(prevYear, prevMonthIndex0, cycleStartDayOfMonth)
  }

  const nextMonthIndex0 = start.getMonth() === 11 ? 0 : start.getMonth() + 1
  const nextYear = start.getMonth() === 11 ? start.getFullYear() + 1 : start.getFullYear()
  const nextCycleStart = clampedCycleStart(nextYear, nextMonthIndex0, cycleStartDayOfMonth)
  const end = addDays(nextCycleStart, -1)

  return { start, end }
}

/**
 * The start date of the NEXT cycle strictly after the one containing
 * `date` — the cycle-boundary equivalent of salaryLedger.ts's
 * upcomingPaydays (which also only ever returns dates strictly after its
 * `fromDate`, never `fromDate` itself). Used by schedule.ts to resolve a
 * `followsCycleStart` transfer occurrence (Salary Sorter session,
 * 2026-09) the same way a `followsPayday` one resolves against
 * upcomingPaydays — see Transaction.followsCycleStart's own comment in
 * types/ledger.ts for why this exists as a sibling to followsPayday
 * rather than reusing it.
 */
export function nextCycleStartAfter(date: Date, cycle: number | CycleBoundarySpec): Date {
  const bounds = cycleBoundsForDate(date, cycle)
  return cycleBoundsForDate(addDays(bounds.end, 1), cycle).start
}

/** Convenience: which numbered cycle (relative to `start`) `date` falls into, 0 = the cycle containing start. */
export function cycleOffset(date: Date, start: Date, cycle: number | CycleBoundarySpec): number {
  let offset = 0
  let cursor = start
  while (true) {
    const bounds = cycleBoundsForDate(cursor, cycle)
    if (date >= bounds.start && date <= bounds.end) return offset
    if (date < bounds.start) {
      cursor = addDays(bounds.start, -1)
      offset--
    } else {
      cursor = addDays(bounds.end, 1)
      offset++
    }
  }
}
