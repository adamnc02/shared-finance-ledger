import { flatAddOnConvention, calibrateRateAndConvention, totalAbsoluteError } from '../src/lib/interestConventions'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

// ── Core formula: constant interest, driven by ORIGINAL principal, not the shrinking balance ──
const principal = 8396
const monthlyFlatRate = 0.0465 / 12 // the quoted flat rate, used consistently with the £32.53/month fixture below

check(
  'Interest is the same regardless of a much lower "current balance" passed in — this convention ignores balance entirely',
  flatAddOnConvention.interestForPeriod(1000, new Date('2026-01-01'), new Date('2026-02-01'), monthlyFlatRate, principal),
  flatAddOnConvention.interestForPeriod(8000, new Date('2026-01-01'), new Date('2026-02-01'), monthlyFlatRate, principal),
)
check(
  'The actual figure is originalPrincipal x monthlyRate',
  flatAddOnConvention.interestForPeriod(1000, new Date('2026-01-01'), new Date('2026-02-01'), monthlyFlatRate, principal),
  Math.round(principal * monthlyFlatRate * 100) / 100,
)
check(
  "Period dates don't matter either — no day-weighting, unlike daily_simple",
  flatAddOnConvention.interestForPeriod(1000, new Date('2026-01-01'), new Date('2026-01-05'), monthlyFlatRate, principal),
  flatAddOnConvention.interestForPeriod(1000, new Date('2026-01-01'), new Date('2026-03-15'), monthlyFlatRate, principal),
)

// ── fitRate: constant across periods -> the best fit is just the mean, divided by principal ──
const constantLines = [
  { date: '2026-03-01', capital: 139.4, interest: 32.53 },
  { date: '2026-04-01', capital: 139.4, interest: 32.53 },
  { date: '2026-05-01', capital: 139.4, interest: 32.53 },
]
const fittedRate = flatAddOnConvention.fitRate('2026-02-01', principal, constantLines)
check('fitRate recovers the rate exactly from perfectly constant real lines', Math.round(fittedRate * principal * 100) / 100, 32.53)

// ── The false-positive this convention exists to close: simulated early flat-rate lines used to confidently mis-match flat_monthly ──
const simulatedFlatRateLines = [
  { date: '2026-03-02', capital: 139.4, interest: 32.53 },
  { date: '2026-04-02', capital: 139.4, interest: 32.53 },
  { date: '2026-05-02', capital: 139.4, interest: 32.53 },
]
const ranked = calibrateRateAndConvention('2026-03-02', principal, simulatedFlatRateLines)
check('With flat_add_on available, it now correctly wins over flat_monthly for genuinely flat-rate data', ranked[0].convention.id, 'flat_add_on')
check('flat_add_on fits this data essentially exactly (near-zero error), unlike the false-positive flat_monthly match found earlier', ranked[0].error < 0.05, true)

// A reducing-balance loan (Santander's real shape) must NOT be pulled
// toward flat_add_on just because a third candidate now exists to compete
// with — it should still lose decisively against the correct convention.
const santanderLines = [
  { date: '2026-07-02', capital: 300.03, interest: 110.26 },
  { date: '2026-08-02', capital: 303.97, interest: 106.32 },
  { date: '2026-09-02', capital: 307.96, interest: 102.33 },
]
const santanderRanked = calibrateRateAndConvention('2026-05-11', 8400, santanderLines)
check('flat_add_on does not accidentally win for a genuinely reducing-balance loan', santanderRanked[0].convention.id, 'flat_monthly')
const flatAddOnResult = santanderRanked.find((r) => r.convention.id === 'flat_add_on')!
check("flat_add_on fits Santander's real (non-constant, clearly reducing) interest figures far worse than the winner", flatAddOnResult.error > santanderRanked[0].error * 5, true)

// Sanity: totalAbsoluteError threads the original principal through correctly end-to-end.
const err = totalAbsoluteError(flatAddOnConvention, monthlyFlatRate, '2026-02-01', principal, constantLines)
check('totalAbsoluteError works correctly for flat_add_on via the shared helper', err < 0.05, true)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll flat-add-on-convention checks passed.')
