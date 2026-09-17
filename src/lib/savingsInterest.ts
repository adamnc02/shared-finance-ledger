// Savings interest engine (backlog item a, step 3). Sibling to
// interestConventions.ts (loans) but for the saver's side — a deposit
// EARNING interest rather than a balance being charged it. Two
// conventions built this session, per Adam's confirmed choice:
//
//  1. aer_credited — the bank quotes an AER and a crediting frequency
//     (usually monthly). Interest for a period is calculated against the
//     balance AS AT THE START of that period and credited/compounded at
//     the end of it. Cheap to compute (only needs the opening balance at
//     each crediting date, not a full daily ledger) but slightly wrong
//     for a pot with mid-period deposits/withdrawals — a deposit on the
//     15th of the month earns nothing until the FOLLOWING crediting
//     date, even though a real bank using this same quoted convention
//     would usually start accruing from the day the money landed. This
//     is the trade-off, not a bug — see method 2 for the realistic one.
//
//  2. daily_accrual_monthly_credited — the realistic convention most
//     easy-access accounts actually use: a daily rate (derived from AER)
//     accrues against the ACTUAL balance on each individual day —
//     replaying every deposit/withdrawal — and is only actually credited
//     into the balance (and starts compounding) once a month. This
//     genuinely needs the pot's full transaction history to compute, not
//     just an opening figure.
//
// A third convention — fixed-term/bond-style (rate locked for a term, no
// further deposits, interest paid annually or at maturity) — is
// deliberately NOT built yet. See SavingsInterestMethod's own comment in
// types/ledger.ts and the migration doc's item a addendum: flagged as
// near-term future work for ISA/bond-style products, not guessed at now.

import { formatCurrency } from './format'
import { addMonths, addQuarters, addYears, differenceInCalendarDays } from 'date-fns'
import { toLocalIsoDate as toIso, parseLocalDate } from './date'
import type { SavingsInterestMethod } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Periodic rate that compounds to the given AER over `periodsPerYear`
 * periods — the same "true compounding rate, not a naive division"
 * reasoning as interestConventions.ts's aprToMonthlyRate, just phrased
 * for a saver's AER rather than a borrower's APR (the maths is
 * identical either direction — see that file's own comment for why
 * dividing by 12 is wrong).
 */
export function aerToPeriodicRate(aerPercent: number, periodsPerYear: number): number {
  return Math.pow(1 + aerPercent / 100, 1 / periodsPerYear) - 1
}

/** AER-equivalent daily rate — periodsPerYear = 365, used by both conventions for day-count math. */
export function aerToDailyRate(aerPercent: number): number {
  return aerToPeriodicRate(aerPercent, 365)
}

function creditingPeriodsPerYear(frequency: 'monthly' | 'quarterly' | 'annual'): number {
  return frequency === 'monthly' ? 12 : frequency === 'quarterly' ? 4 : 1
}

// The k-th crediting date, always counted from the opening date rather than
// stepped from the previous one. Stepping drifted: a pot opened on the 31st
// credited 28 Feb and then the 28th forever (2026-09-16). date-fns clamps
// to the month's last day, so the 31st is 28 Feb but 31 Mar again.
function nthCreditingDate(opening: Date, frequency: 'monthly' | 'quarterly' | 'annual', k: number): Date {
  return frequency === 'monthly' ? addMonths(opening, k) : frequency === 'quarterly' ? addQuarters(opening, k) : addYears(opening, k)
}

export interface CreditingDate {
  date: string // when this interest payment lands
  periodStart: string // start of the period it covers, inclusive
  periodEnd: string // end of the period it covers, exclusive (== date)
}

/** Every crediting date for method 1 (aer_credited) between openingDate and rangeEnd, inclusive of rangeEnd. */
export function walkCreditingDates(openingDate: string, creditingFrequency: 'monthly' | 'quarterly' | 'annual', rangeEnd: Date): CreditingDate[] {
  const results: CreditingDate[] = []
  const opening = parseLocalDate(openingDate)
  let periodStart = opening
  let k = 1
  let cursor = nthCreditingDate(opening, creditingFrequency, k)
  while (cursor <= rangeEnd && k <= 2000) {
    results.push({ date: toIso(cursor), periodStart: toIso(periodStart), periodEnd: toIso(cursor) })
    periodStart = cursor
    cursor = nthCreditingDate(opening, creditingFrequency, ++k)
  }
  return results
}

/**
 * Method 1 (aer_credited): interest for one crediting period, against the
 * balance AS AT periodStart — the caller (savingsPotLedger.ts) supplies
 * that balance since it's the one replaying the transaction history.
 */
export function aerCreditedInterest(balanceAtPeriodStart: number, method: Extract<SavingsInterestMethod, { type: 'aer_credited' }>): number {
  if (balanceAtPeriodStart <= 0) return 0
  const rate = aerToPeriodicRate(method.aer, creditingPeriodsPerYear(method.creditingFrequency))
  return round2(balanceAtPeriodStart * rate)
}

/**
 * Method 2 (daily_accrual_monthly_credited): interest for one calendar
 * month, given the ACTUAL daily balances across it. `dailyBalances` is a
 * sorted array of {date, balance} — the balance that applied FROM that
 * date until the next entry (or periodEnd) — which the caller builds by
 * replaying every deposit/withdrawal against the pot. Always credited
 * monthly (see SavingsInterestMethod's own comment for why this
 * convention doesn't offer a frequency choice the way method 1 does).
 */
export function dailyAccrualInterest(dailyBalances: { date: string; balance: number }[], periodStart: Date, periodEnd: Date, method: Extract<SavingsInterestMethod, { type: 'daily_accrual_monthly_credited' }>): number {
  if (dailyBalances.length === 0) return 0
  const dailyRate = aerToDailyRate(method.aer)

  let total = 0
  for (let i = 0; i < dailyBalances.length; i++) {
    const segmentStart = new Date(Math.max(parseLocalDate(dailyBalances[i].date).getTime(), periodStart.getTime()))
    const segmentEndCandidate = i + 1 < dailyBalances.length ? parseLocalDate(dailyBalances[i + 1].date) : periodEnd
    const segmentEnd = new Date(Math.min(segmentEndCandidate.getTime(), periodEnd.getTime()))
    const days = differenceInCalendarDays(segmentEnd, segmentStart)
    if (days <= 0 || dailyBalances[i].balance <= 0) continue
    total += dailyBalances[i].balance * dailyRate * days
  }
  return round2(total)
}

/** Every monthly crediting window for method 2 between openingDate and rangeEnd — same shape as walkCreditingDates, kept separate since method 2 has no frequency choice. */
export function walkMonthlyCreditingDates(openingDate: string, rangeEnd: Date): CreditingDate[] {
  const results: CreditingDate[] = []
  const opening = parseLocalDate(openingDate)
  let periodStart = opening
  let k = 1
  let cursor = addMonths(opening, k) // counted from opening, see nthCreditingDate
  while (cursor <= rangeEnd && k <= 2000) {
    results.push({ date: toIso(cursor), periodStart: toIso(periodStart), periodEnd: toIso(cursor) })
    periodStart = cursor
    cursor = addMonths(opening, ++k)
  }
  return results
}

// ── Example ledger — for the "explanation on save" popup ─────────────
// A small, self-contained illustration of how a given method behaves,
// shown when a pot is created/its interest method changed — Adam's
// spec: "a clear explanation pop-up on save... with a possible example
// ledger to show when/how interest is paid." Deliberately uses a round
// £1,000 opening balance and, for method 2, one illustrative mid-period
// £200 deposit — real enough to show the mechanic (accrual from the
// deposit date, not from the start of the month) without needing the
// pot's real data, since this runs before the pot even exists yet.

export interface ExampleLedgerRow {
  date: string
  label: string
  amount: number
  balanceAfter: number
}

const EXAMPLE_OPENING_BALANCE = 1000
const EXAMPLE_MONTHS = 3

export function buildExampleLedger(method: SavingsInterestMethod): ExampleLedgerRow[] {
  const start = '2026-01-01'
  const rangeEnd = new Date(2026, 0 + EXAMPLE_MONTHS + 1, 1)
  const rows: ExampleLedgerRow[] = [{ date: start, label: 'Opening balance', amount: EXAMPLE_OPENING_BALANCE, balanceAfter: EXAMPLE_OPENING_BALANCE }]

  if (method.type === 'aer_credited') {
    let balance = EXAMPLE_OPENING_BALANCE
    // Walked far enough for three credits at ANY frequency (2026-09-16, PROMPT-04
    // Bug C) — the 3-month rangeEnd above showed one quarterly credit and no annual
    // one at all, invisible until the form actually saved a non-monthly choice.
    // Monthly still takes the first three, exactly as before.
    const creditRangeEnd = new Date(2029, 0, 1)
    for (const c of walkCreditingDates(start, method.creditingFrequency, creditRangeEnd).slice(0, 3)) {
      const interest = aerCreditedInterest(balance, method)
      balance = round2(balance + interest)
      // BUGFIX (Adam-reported, 2026-09-02): this used to interpolate the
      // raw `balance - interest` float directly into the label — e.g.
      // "on £1007.3599999999999 balance", a genuine JS floating-point
      // artifact (0.1 + 0.2 problem) leaking straight into the UI.
      // Rounded and comma-formatted through the same formatCurrency
      // every other £ figure in this app goes through, not a one-off fix.
      rows.push({ date: c.date, label: `Interest (${method.creditingFrequency}, on £${formatCurrency(round2(balance - interest))} balance)`, amount: interest, balanceAfter: balance })
    }
    return rows
  }

  // daily_accrual_monthly_credited — illustrate a mid-period deposit
  // earning from its own date, the exact behaviour method 1 can't show.
  const depositDate = '2026-01-15'
  rows.push({ date: depositDate, label: 'Example deposit', amount: 200, balanceAfter: EXAMPLE_OPENING_BALANCE + 200 })

  const dailyBalances = [
    { date: start, balance: EXAMPLE_OPENING_BALANCE },
    { date: depositDate, balance: EXAMPLE_OPENING_BALANCE + 200 },
  ]
  let balance = EXAMPLE_OPENING_BALANCE + 200
  for (const c of walkMonthlyCreditingDates(start, rangeEnd).slice(0, 3)) {
    const interest = dailyAccrualInterest(dailyBalances, parseLocalDate(c.periodStart), parseLocalDate(c.periodEnd), method)
    balance = round2(balance + interest)
    rows.push({ date: c.date, label: 'Interest (daily accrual, credited monthly)', amount: interest, balanceAfter: balance })
    dailyBalances.length = 0
    dailyBalances.push({ date: c.date, balance })
  }
  return rows
}
