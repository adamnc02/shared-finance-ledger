// 2026-09-23 (Adam-reported during the PROMPT-17 UAT, root-caused the same
// session) — the per-cycle closing-balance chain for Home's cycle-grouped
// ledger, extracted out of Home.tsx so a verify script can assert it. The
// fold used to live inline in `CycleGroupedList`, where nothing could reach
// it (`cycleSummary.ts` sits in lib for exactly this reason).
//
// 🚨 THE BUG THIS EXISTS TO PREVENT. The average spend forecast row reduces
// its own cycle's closing balance, and that reduction is supposed to carry
// forward into every later cycle's opening point — Home's own hero caption
// depends on it, and says so: the "projected" figure is
// `projectedBalance - forecastTotal`, summing EVERY cycle's forecast, and it
// is meant to equal the last cycle section's own closing balance.
//
// It did not. The old fold read:
//
//     const realClosing = upToEnd.length > 0 ? upToEnd[upToEnd.length - 1].running : carried
//     const closing = forecast ? round2(realClosing - forecast.forecastAmount) : realClosing
//     carried = closing
//
// `carried` held the adjusted figure, but it was only ever REACHED when there
// was no real transaction at all dated on or before that cycle's end. Once any
// history existed anywhere earlier — which on a real ledger is always, since
// the projection generates future bills and salary — `upToEnd` was non-empty,
// so every cycle re-based on the raw running balance and subtracted only its
// OWN forecast. Each cycle's closing was therefore overstated by the sum of
// all EARLIER cycles' forecasts, and the error grew with every cycle.
//
// Measured on a real `personal-ledger` backup (2026-09-20) before the fix:
// the hero said -£866.80 and the final cycle section said +£2,275.97 — a
// £3,142.77 gap, and the opposite sign. Nothing on screen looked wrong,
// because a real ledger's own bills and salary move each cycle's balance
// enough that a plausible-looking number is all anyone checks.
//
// 🚨 The row-level running balances are offset too, not just the closings.
// Offsetting only the closing would make a cycle's own arithmetic stop
// working: its last row would no longer be its closing minus its forecast
// row, which is precisely the sum a person does by eye to check the app.
//
// 🚨 `carried` is ALREADY fully adjusted, so the no-rows branch must NOT have
// `priorForecasts` taken off it a second time. That double-subtraction is the
// obvious-looking "fix" and it is wrong.

const round2 = (n: number) => Math.round(n * 100) / 100

/** One cycle's resolved balances. `rowRunning` is the row-level running balance already offset by every EARLIER cycle's forecast; `closing` is that cycle's own closing, after its own forecast. */
export type CycleChainLink = {
  /** The cycle's closing balance before its own forecast row, but after every earlier cycle's. */
  realClosing: number
  /** The closing balance actually shown against "Balance at <date>". */
  closing: number
  /** What to subtract from a raw running balance to display it inside this cycle — the total of every EARLIER cycle's forecast. */
  priorForecasts: number
}

/**
 * The balance chain for one horizon's worth of cycles.
 *
 * `runningByDate` is the global fold of real + projected ledger rows (date
 * ascending, salary-first), exactly as `CycleGroupedList` already computes it.
 * `forecastAmountFor` returns a cycle's forecast row amount, or 0.
 */
export function buildCycleForecastChain(
  runningByDate: { date: string; running: number }[],
  cycles: { endIso: string; startIso: string }[],
  forecastAmountFor: (startIso: string) => number,
  openingRunningBalance: number,
): CycleChainLink[] {
  let carried = openingRunningBalance
  let priorForecasts = 0
  return cycles.map(({ startIso, endIso }) => {
    const upToEnd = runningByDate.filter((r) => r.date <= endIso)
    // The raw running balance at this cycle's end, less every EARLIER
    // cycle's forecast. When there is no real row at all yet, `carried` is
    // the previous cycle's own closing and is already fully adjusted.
    const realClosing = upToEnd.length > 0 ? round2(upToEnd[upToEnd.length - 1].running - priorForecasts) : carried
    const forecastAmount = forecastAmountFor(startIso)
    const closing = forecastAmount > 0 ? round2(realClosing - forecastAmount) : realClosing
    const link: CycleChainLink = { realClosing, closing, priorForecasts }
    carried = closing
    priorForecasts = round2(priorForecasts + forecastAmount)
    return link
  })
}
