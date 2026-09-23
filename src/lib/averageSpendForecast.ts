// 2026-09-13 (dev.md follow-up, "average spend forecast" — see
// PROMPT-average-spend-forecast-toggle-2026-09-13.md), rewritten
// 2026-09-14 (see PROMPT-average-spend-forecast-current-cycle-2026-09-14.md)
// to a daily-rate methodology and extended into the current cycle. Both
// dates project a placeholder "average spend" amount, scoped to the
// Personal or Joint card, built from ad-hoc `type: 'expense'` transactions
// (never bills, loans, credit_card_spend, recurring templates, or ad-hoc
// income) — each cycle's own forecast is that scaled average REDUCED by
// whatever real ad-hoc spend already sits in that cycle.
//
// 2026-09-14 methodology change (Adam-confirmed, worked through several
// numeric examples live): the old flat "mean of the trailing 3 non-empty
// cycles" is replaced everywhere (not just for the current cycle) by a
// single daily rate — totalMatchingSpend over the window, divided by the
// window's own day count — scaled by each cycle's own actual length. Two
// deliberate corrections from the original dev-note wording:
//   1. The window's END is TODAY, not the latest matching transaction's
//      own date ("I probably don't spend every day, this helps balance
//      the average" — no-spend days between the last transaction and
//      today pull the daily rate DOWN, they aren't excluded).
//   2. The window's START stays the exact same boundary the trailing-3
//      lookback already used (`previousCycles(..., 3, asOfDate)`'s
//      earliest cycle's own start) — NOT the ledger's opening-balance/
//      rebalance date. Deliberately does NOT bound by either ledger's own
//      opening-balance date (`payCycle.openingBalanceDate` / `data.
//      jointAccount.openingBalanceDate`) the way `computeProjection`/
//      `computeJointAccountProjection` do — Adam's own words, carried
//      over from the 2026-09-13 build: "if we have older transactions
//      after the account was balanced, we should still use the full
//      available window."
//
// 2026-09-14 follow-up (Adam-reported, a real new-account backup) — the
// window's natural 3-cycles-back start ALSO isn't bounded by when the
// account's own history actually begins. For a genuinely new account (or
// one with only a few days of real ad-hoc spend), most of that window is
// just empty — dozens of days that predate the account entirely, not
// real no-spend days — and dividing by them produced an artificially
// tiny daily rate that a few real days of spending trivially exceeded, so
// the forecast silently clamped to £0 the moment any real spend existed.
// Fixed two ways:
//   1. The window's start is now clamped to the EARLIEST matching
//      transaction's own date whenever that's later than the natural
//      3-cycles-back start — so a new account's rate is built only from
//      days it actually has real history for, never diluted by days
//      before it existed. Still never bounded by openingBalanceDate/
//      rebalancing (point 2 above) — a rebalance doesn't erase real prior
//      spending history the way "account didn't exist yet" does.
//   2. A cycle is never forecast at all if it — not some earlier cycle —
//      is the very first one with any matching history: showing a
//      forecast there would be circular (built from that same cycle's
//      own partial data, reflected back onto its own remaining days).
//      Once at least one COMPLETED prior cycle has real history, this
//      stops applying, including to the current cycle.
//
// 2026-09-23 methodology change (Adam-confirmed live): once
// the week-aligned window spans MEDIAN_SPEND_HISTORY_DAYS (42 days = 6
// whole weeks), the pooled daily rate is replaced by the MEDIAN of the
// window's own per-week totals, scaled by cycleDays / 7. Below that bar
// — and whenever that median is genuinely £0 — everything behaves
// exactly as it did before. The mean's weakness is that one unusually
// large week (a gift, an appliance, a rare big shop) pulls every future
// cycle's forecast up until it ages out of the window; a median of
// several weeks' own totals ignores that week instead of being dragged
// by it, which is much closer to "what does a typical week actually
// look like". MIN_SPEND_HISTORY_DAYS (14) is untouched and remains the
// only gate on showing a forecast AT ALL — 42 decides only which method
// produces the number.
//   🚨 The two-threshold shape is the point, not an accident: two or
//   three weeks is not enough to HAVE a middle one — picking one of
//   three numbers is not materially different from the mean over the
//   same tiny sample, and arguably worse.

import { differenceInCalendarDays } from 'date-fns'
import { previousCycles } from './projection'
import type { AppDataV2, Transaction } from '../types/ledger'
import { toLocalIsoDate as toIso } from './date'

const round2 = (n: number) => Math.round(n * 100) / 100

/** Which ledger's ad-hoc expense history this forecast is scoped to — Personal (a specific owner) or Joint (no owner check, either person can log a joint ad-hoc expense). Never Savings Pot/Pot/Household/Credit Card. */
export type SpendScope = { location: 'personal'; ownerId: string } | { location: 'joint' }

function matchesSpendScope(t: Pick<Transaction, 'type' | 'location' | 'ownerId'>, scope: SpendScope): boolean {
  if (t.type !== 'expense') return false
  return scope.location === 'personal' ? t.location === 'personal' && t.ownerId === scope.ownerId : t.location === 'joint'
}

function inCycle(t: Pick<Transaction, 'date'>, cycle: { start: Date; end: Date }): boolean {
  return t.date >= toIso(cycle.start) && t.date <= toIso(cycle.end)
}

/** Inclusive day count spanning both endpoints — a 1st-31st cycle is 31 days, a window from a cycle's start to that same day is 1 day, never 0. */
function daysInclusive(start: Date, end: Date): number {
  return differenceInCalendarDays(end, start) + 1
}

/** The earliest date among transactions matching `scope`, as an ISO string — undefined when there's no matching history at all. String comparison, not Date parsing, since every stored date is already a local YYYY-MM-DD (see date.ts's own file header on why `new Date(isoString)` is never safe here). */
function earliestMatchingSpendDateIso(data: AppDataV2, scope: SpendScope): string | undefined {
  let earliest: string | undefined
  for (const t of data.transactions) {
    if (!matchesSpendScope(t, scope)) continue
    if (earliest === undefined || t.date < earliest) earliest = t.date
  }
  return earliest
}

/**
 * Whether ANY matching ad-hoc expense has ever been logged — "genuinely
 * no history at all" is a different message than "some history, just
 * not the 2-week minimum yet" (see `daysOfSpendHistory`'s own comment),
 * and `daysOfSpendHistory` alone can't tell them apart: with zero
 * matching transactions, `rawWindowStart` falls back to the natural
 * ~90-day 3-cycles-back start (nothing to clamp to), so the raw day
 * count would read as "plenty of history" even though none of it is
 * real spend.
 */
export function hasAnyMatchingSpend(data: AppDataV2, scope: SpendScope): boolean {
  return earliestMatchingSpendDateIso(data, scope) !== undefined
}

/** `earliestMatchingSpendDateIso`, parsed into a local Date the same "split YYYY-MM-DD into three numbers" way every other local-date construction in this app uses — never `new Date(isoString)` directly (parses as UTC midnight, not local). */
function isoToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * The start of the lookback window: the START of the pay cycle 3 cycles
 * back from `asOfDate`'s own cycle — same boundary `previousCycles`
 * already resolves, pure calendar/payday arithmetic, never bound by an
 * opening-balance/rebalance date. Clamped forward to the earliest
 * matching transaction's own date whenever that's LATER than this
 * natural start (a new account, or one with only recent matching
 * history) — see this file's own header comment on why.
 */
function rawWindowStart(data: AppDataV2, scope: SpendScope, personId: string, asOfDate: Date): Date {
  const cycles = previousCycles(data, personId, 3, asOfDate)
  const naturalStart = cycles[cycles.length - 1].start
  const earliestIso = earliestMatchingSpendDateIso(data, scope)
  if (earliestIso === undefined || earliestIso <= toIso(naturalStart)) return naturalStart
  return isoToLocalDate(earliestIso)
}

/**
 * Minimum span the lookback window must actually cover before a forecast
 * is shown at all — 2 weeks. 2026-09-15 (Adam-reported, a real joint-
 * account backup): the window used to be gated only on "does at least one
 * matching transaction exist," which let a household that shops in a
 * weekly burst (e.g. one big Saturday supermarket run) show a forecast
 * built from as little as a single day's spend the moment that one shop
 * happened — extrapolating a single weekend's total across a whole
 * month. Two full weeks guarantees at least one complete weekly cycle
 * (so a weekly shopper's actual rhythm is represented at all) is in the
 * sample before any number is shown.
 */
export const MIN_SPEND_HISTORY_DAYS = 14

/**
 * How many days the lookback window would actually span right now (from
 * `rawWindowStart` through `asOfDate`) — exposed so the UI can tell "no
 * history at all" apart from "some history, just not 2 weeks of it yet"
 * (two different messages for why the toggle is greyed out).
 */
export function daysOfSpendHistory(data: AppDataV2, scope: SpendScope, personId: string, asOfDate: Date): number {
  return daysInclusive(rawWindowStart(data, scope, personId, asOfDate), asOfDate)
}

/**
 * `rawWindowStart`, trimmed forward to the nearest date that makes the
 * window an exact whole number of 7-day weeks (dropping only the
 * OLDEST, partial leftover days — the end nearest `asOfDate` is never
 * touched). A window that happens to end mid-week over- or under-
 * represents whichever days-of-week it cuts off; anchoring to whole
 * weeks means every day-of-week is covered the same number of times, so
 * a weekly shopping pattern isn't systematically over- or under-counted
 * depending on which day the window happens to start on. Only called
 * once `hasSpendHistory` has already confirmed at least
 * MIN_SPEND_HISTORY_DAYS (14) of raw span, so this never trims below a
 * full 2 weeks.
 */
export function weekAlignedWindowStart(rawStart: Date, asOfDate: Date): Date {
  const totalDays = daysInclusive(rawStart, asOfDate)
  // Nothing meaningful to trim below a single week — guards against a
  // caller passing a sub-week span (nothing in normal use does, since
  // this is only ever called after hasSpendHistory's 14-day gate, but a
  // remainder trim on a <7-day span would push the "start" past
  // `asOfDate` entirely).
  if (totalDays < 7) return rawStart
  const remainder = totalDays % 7
  if (remainder === 0) return rawStart
  const trimmed = new Date(rawStart)
  trimmed.setDate(trimmed.getDate() + remainder)
  return trimmed
}

/**
 * True when `cycle` is — not some earlier cycle — the very first one
 * with any matching history at all (ignoring rebalancing, same as the
 * window itself). Showing a forecast for this cycle would be circular:
 * the "average" would be built entirely from this cycle's OWN partial
 * data and reflected back onto its own remaining days. Adam-confirmed
 * (2026-09-14, a real new-account report): block it outright rather than
 * let the window-clamping above produce a number here at all.
 */
function isFirstLoggedCycle(data: AppDataV2, scope: SpendScope, cycle: { start: Date }): boolean {
  const earliestIso = earliestMatchingSpendDateIso(data, scope)
  if (earliestIso === undefined) return true
  return earliestIso >= toIso(cycle.start)
}

/**
 * Whether there is enough real history to show a forecast at all — two
 * conditions, both required: (1) at least one matching ad-hoc expense
 * anywhere in the lookback window, and (2) that window spans at least
 * MIN_SPEND_HISTORY_DAYS (2 weeks). Adam-confirmed: "Only allow the
 * ability to display a forecast if there is at least one transaction to
 * create a history from" — (1) is distinct from `dailySpendRate`
 * returning 0, which can also mean "history exists but happens to be
 * exactly £0." (2) is the 2026-09-15 addition — see
 * MIN_SPEND_HISTORY_DAYS's own comment for why a single transaction
 * alone isn't enough for a weekly-shopping household.
 */
export function hasSpendHistory(data: AppDataV2, scope: SpendScope, personId: string, asOfDate: Date): boolean {
  if (daysOfSpendHistory(data, scope, personId, asOfDate) < MIN_SPEND_HISTORY_DAYS) return false
  const start = toIso(rawWindowStart(data, scope, personId, asOfDate))
  const end = toIso(asOfDate)
  return data.transactions.some((t) => matchesSpendScope(t, scope) && t.date >= start && t.date <= end)
}

/**
 * The single daily ad-hoc-expense rate the whole forecast is built from:
 * total matching spend from the WEEK-ALIGNED lookback window's start
 * (see `weekAlignedWindowStart`) through `asOfDate` (today), divided by
 * that window's own inclusive day count. Returns 0 when there's no
 * matching spend in the window at all. Callers are expected to have
 * already checked `hasSpendHistory` — this doesn't re-check the 2-week
 * minimum itself, it just always operates on a whole-week window once
 * there's enough raw history for one to exist.
 */
export function dailySpendRate(data: AppDataV2, scope: SpendScope, personId: string, asOfDate: Date): number {
  const start = weekAlignedWindowStart(rawWindowStart(data, scope, personId, asOfDate), asOfDate)
  const startIso = toIso(start)
  const endIso = toIso(asOfDate)
  const total = data.transactions.filter((t) => matchesSpendScope(t, scope) && t.date >= startIso && t.date <= endIso).reduce((sum, t) => sum + t.amount, 0)
  if (total <= 0) return 0
  return total / daysInclusive(start, asOfDate)
}

/**
 * The second, HIGHER bar the median method must clear before it takes
 * over from the pooled mean — 6 whole weeks. MIN_SPEND_HISTORY_DAYS (14)
 * is unchanged and still the ONLY gate on showing a forecast at all; this
 * is a separate, stricter threshold that only decides WHICH method
 * produces the number.
 *
 * 2026-09-23 (Adam-confirmed, chosen over 28/35/56 with the reasoning
 * given live): a median needs enough independent weeks to have a genuine
 * middle one. At 4 buckets the median is the mean of weeks 2 and 3 — a
 * single outlier week is a quarter of the sample and still drags the
 * middle pair, which is barely different from the mean it replaces. At 6
 * buckets the median is the mean of weeks 3 and 4 with two ordinary
 * weeks either side, so one unusually large week cannot reach the middle
 * at all — which is the entire point of the change. 8 weeks is more
 * robust still, but the window itself only ever spans ~3 pay cycles
 * (~90 days), so it would leave a narrow band in which the better method
 * ever engages.
 *
 * 🚨 Expressed against the WEEK-ALIGNED window, not the raw one. (They
 * agree — `weekAlignedWindowStart` trims `raw % 7` days, so aligned >= 42
 * exactly when raw >= 42 — but the aligned span is the one that becomes
 * buckets, and stating it that way is what stops a later reader "fixing"
 * this to read the raw span.)
 */
export const MEDIAN_SPEND_HISTORY_DAYS = 42

/**
 * The week-aligned lookback window split into whole 7-day buckets, each
 * bucket's own total matching ad-hoc spend, OLDEST FIRST. The window is
 * already an exact number of weeks (see `weekAlignedWindowStart`), so
 * every bucket is a full 7 days and the last one ends on `asOfDate` —
 * there is never a partial bucket to decide what to do with.
 *
 * 🚨 The unit is "one week's TOTAL spend", not "one transaction". A
 * median of individual transaction amounts answers a completely
 * different question (the typical size of a shop, not the typical weekly
 * outgoing) and would look entirely plausible while being wrong — it
 * would also ignore how MANY shops a week contains, which is most of the
 * signal. Weeks with no spend at all are real £0 buckets and are kept:
 * dropping them would reintroduce exactly the "extrapolate one big
 * Saturday across a month" bug MIN_SPEND_HISTORY_DAYS exists to block.
 */
export function weeklySpendTotals(data: AppDataV2, scope: SpendScope, personId: string, asOfDate: Date): number[] {
  const start = weekAlignedWindowStart(rawWindowStart(data, scope, personId, asOfDate), asOfDate)
  const totalDays = daysInclusive(start, asOfDate)
  if (totalDays < 7) return []
  const weeks = Math.floor(totalDays / 7)
  const buckets: number[] = []
  for (let w = 0; w < weeks; w++) {
    const bucketStart = new Date(start)
    bucketStart.setDate(bucketStart.getDate() + w * 7)
    const bucketEnd = new Date(bucketStart)
    bucketEnd.setDate(bucketEnd.getDate() + 6)
    const startIso = toIso(bucketStart)
    const endIso = toIso(bucketEnd)
    buckets.push(round2(data.transactions.filter((t) => matchesSpendScope(t, scope) && t.date >= startIso && t.date <= endIso).reduce((sum, t) => sum + t.amount, 0)))
  }
  return buckets
}

/** The middle value of an ascending copy — the mean of the two middle entries for an even count, which is the ordinary definition and keeps an even-bucket window from arbitrarily favouring the lower week. */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The typical week's total ad-hoc spend — the median of
 * `weeklySpendTotals` — or **0 when the median method does not apply**,
 * which is the single signal every caller uses to fall back to the mean.
 * Two distinct reasons it returns 0, deliberately collapsed into one
 * answer because both mean the same thing to a caller:
 *
 *   1. The window spans fewer than MEDIAN_SPEND_HISTORY_DAYS (42) days —
 *      not enough independent weeks to have a genuine middle one.
 *   2. The median of the buckets genuinely IS £0.
 *
 * 🚨 (2) is not hypothetical and is why the fallback exists (Adam-
 * confirmed 2026-09-23). Someone who does one big shop a month has four
 * £0 weeks out of six, so their middle week is £0 — and with no fallback
 * their forecast row would silently DISAPPEAR the day they crossed the
 * 42-day threshold, because `buildForecastByCycle` drops any cycle whose
 * average is <= 0. Removing a figure a user has been reading, with no
 * release to blame it on, is the exact failure this change is supposed
 * to avoid causing. So a £0 median hands back to the pooled mean, which
 * still has a real number for that account.
 */
export function medianWeeklySpend(data: AppDataV2, scope: SpendScope, personId: string, asOfDate: Date): number {
  const start = weekAlignedWindowStart(rawWindowStart(data, scope, personId, asOfDate), asOfDate)
  if (daysInclusive(start, asOfDate) < MEDIAN_SPEND_HISTORY_DAYS) return 0
  return median(weeklySpendTotals(data, scope, personId, asOfDate))
}

/** Which method actually produced the number for this scope right now. Exposed so the UI can say so (Adam's Q3, 2026-09-23) — a figure that changes method without saying so is exactly what gets reported as a bug later. `'median'` ONLY when the median path genuinely ran, so the caption never claims "typical week" over a mean-derived figure. */
export type SpendForecastMethod = 'mean' | 'median'
export function spendForecastMethod(data: AppDataV2, scope: SpendScope, personId: string, asOfDate: Date): SpendForecastMethod {
  return medianWeeklySpend(data, scope, personId, asOfDate) > 0 ? 'median' : 'mean'
}

/**
 * The average ad-hoc expense for ONE cycle (current or future), scaled by
 * that cycle's own actual length in days — never a fixed/typical
 * constant, since pay cycle length can vary cycle to cycle. 0 for a cycle
 * that's the very first one with any matching history at all (see
 * `isFirstLoggedCycle`) — nothing to genuinely average yet.
 *
 * 2026-09-23 — TWO methods now feed this one function, chosen
 * automatically, never a user-facing setting:
 *
 *   - **median** (preferred), once the week-aligned window spans
 *     MEDIAN_SPEND_HISTORY_DAYS (42): the median of the window's own
 *     per-week totals, scaled by `cycleDays / 7`. A mean is one unusually
 *     large week away from being skewed — a single big one-off pulls
 *     EVERY future cycle's forecast up until it ages out of the window.
 *     A median of several weeks' own totals ignores that week rather than
 *     being dragged by it.
 *   - **mean** (unchanged), below that bar, or whenever the median is £0
 *     (see `medianWeeklySpend`): the pooled daily rate scaled by the
 *     cycle's own day count, byte-for-byte the behaviour every account
 *     had before this change.
 *
 * 🚨 This is purely ADDITIVE for every account below the bar. Anything
 * that changes `dailySpendRate`'s own answer, or its signature, has
 * changed the number for accounts this work was never meant to touch.
 * 🚨 And note what is NOT forked: `forecastSpendForCycle`'s "average
 * minus real spend already logged, floored at 0" is identical whichever
 * method ran. It is handed a different `averageForThisCycle` and nothing
 * else — duplicating it per method is how the two paths would drift.
 */
export function averageAdHocSpendForCycle(data: AppDataV2, scope: SpendScope, personId: string, cycle: { start: Date; end: Date }, asOfDate: Date): number {
  if (isFirstLoggedCycle(data, scope, cycle)) return 0
  const cycleDays = daysInclusive(cycle.start, cycle.end)
  const typicalWeek = medianWeeklySpend(data, scope, personId, asOfDate)
  if (typicalWeek > 0) return round2(typicalWeek * (cycleDays / 7))
  const rate = dailySpendRate(data, scope, personId, asOfDate)
  if (rate <= 0) return 0
  return round2(rate * cycleDays)
}

/**
 * The forecast for ONE cycle (current or future): that cycle's own
 * average (see `averageAdHocSpendForCycle`) reduced by whatever real
 * ad-hoc spend (same scope) already sits in that cycle, clamped at 0
 * (never negative). `realSpend` is returned alongside so a caller can
 * show a "reduced from £X" caption when it's non-zero.
 */
export function forecastSpendForCycle(data: AppDataV2, scope: SpendScope, averageForThisCycle: number, cycle: { start: Date; end: Date }): { forecastAmount: number; realSpend: number } {
  const realSpend = round2(data.transactions.filter((t) => matchesSpendScope(t, scope) && inCycle(t, cycle)).reduce((sum, t) => sum + t.amount, 0))
  const forecastAmount = Math.max(0, round2(averageForThisCycle - realSpend))
  return { forecastAmount, realSpend }
}
