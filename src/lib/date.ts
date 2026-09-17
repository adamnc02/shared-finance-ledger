/**
 * Local-timezone-safe ISO date (YYYY-MM-DD) formatting.
 *
 * NEVER use `date.toISOString().slice(0, 10)` for this. `toISOString()`
 * converts to UTC first — for a local-midnight Date during any positive
 * UTC offset (British Summer Time included: UTC+1 for roughly seven
 * months of the year), that conversion rolls the calendar date back by
 * one full day. Every Date object in this app is built from local Y/M/D
 * components (`new Date(year, month, day)`, `resolvePayday`, `addMonths`,
 * etc.), so formatting has to round-trip through the same local getters,
 * not UTC ones, or dates silently drift a day early for any UK user
 * during BST.
 */
export function toLocalIsoDate(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function todayIso(): string {
  return toLocalIsoDate(new Date())
}

/**
 * The reverse direction of the same hazard `toLocalIsoDate` guards
 * against, and just as dangerous: `new Date(isoString)` on a bare
 * "YYYY-MM-DD" string parses per the ISO 8601 date-only rule as UTC
 * MIDNIGHT, not local midnight. During any positive UTC offset (British
 * Summer Time included: UTC+1 for roughly seven months of the year —
 * this app is built for the UK, and BST/GMT correctness is a hard
 * requirement, not an edge case), that's a real, distinct timestamp from
 * the local-midnight Date every OTHER date in this app is built from
 * (`new Date(year, month, day)`, `resolvePayday`, `addMonths`,
 * `addDays`, etc.) — `.getDate()`/`.getMonth()`/`.getFullYear()` still
 * read back the "right" calendar day either way (JS Date getters are
 * always local), so the bug stays invisible until two Dates built via
 * these two DIFFERENT methods are compared or diffed directly (`<`,
 * `<=`, `.getTime()`), at which point a UTC-parsed date can sort as
 * LATER than a local-midnight date for the exact same calendar day —
 * confirmed as a real, live bug (2026-09-16, Adam-reported): a recurring
 * transaction anchored exactly on a cycle's own last day silently
 * dropped out of "This cycle" (but not "Next 3 cycles", where the gap
 * was swamped by a much later range end) because `schedule.ts`'s walk
 * compared a UTC-parsed anchor against a local-midnight range end one
 * hour earlier on the same calendar day.
 *
 * Every stored date-only string in this app (`Transaction.date`,
 * `anchorDate`, `originalDate`, `openingDate`, `balanceAsOfDate`, etc.)
 * must be parsed back into a Date through THIS function, never
 * `new Date(isoString)` directly, so every Date in the app — regardless
 * of which direction it was built from — represents the exact same
 * local-midnight instant for a given calendar day and can be safely
 * compared against any other.
 */
export function parseLocalDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(year, month - 1, day)
}
