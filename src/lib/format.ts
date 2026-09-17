/** £ amounts throughout the app — comma thousand separators, always 2 decimal places. Use as `£${formatCurrency(x)}`, not a leading £ built in, to match the existing inline-£ convention every call site already uses. */
export function formatCurrency(amount: number): string {
  return amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** "March 2028" from an ISO date — used wherever a loan payoff date is shown as a rough milestone rather than an exact day (e.g. an overpayment recast preview, the loan ledger modal's finish-date banner, scope §10). Parses the ISO string's own date components directly rather than `new Date(iso)` + local getters, so this can never day-shift across a timezone boundary the way constructing a Date from a bare date-only string can. */
export function formatMonthYear(iso: string): string {
  const [year, month] = iso.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}

/**
 * "29 August 2026" from an ISO date — the full-date counterpart to
 * formatMonthYear, for anywhere a specific day genuinely matters rather
 * than a rough month/year milestone. Bills.tsx's "apply this change
 * from…" picker is the motivating case: a bill that occurs more than
 * once a month (weekly/every-N-weeks) can offer several distinct
 * candidate dates that all fall in the same calendar month, and
 * month/year alone made those options visually indistinguishable —
 * confirmed as more than a cosmetic gap, since a person who can't tell
 * two buttons apart is liable to pick the wrong one, or the same
 * underlying date twice across two separate edits, either of which
 * quietly corrupts amountHistory (see resolveTemplateAmount's own
 * comment on the tie-break this can trigger). Same ISO-components-first
 * parsing as formatMonthYear, for the same reason: constructing straight
 * from `new Date(iso)` and reading local getters back off it can
 * day-shift across a timezone boundary for a bare date-only string.
 */
export function formatFullDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}
