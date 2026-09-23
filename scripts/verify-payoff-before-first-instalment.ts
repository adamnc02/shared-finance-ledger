// 2026-09-23 — REGRESSION: a loan cleared BEFORE its first instalment falls due.
//
// Adam's live Monzo loan: £10,050 borrowed 2026-09-16, first payment not due
// until 2026-10-01. A What-if lump sum dated today got two things wrong:
//
//  1. BALANCE. scheduleEntryAsOf() finds the next entry at-or-AFTER the date,
//     so "what is owed on 23 September" returned the balance AFTER the
//     1 October payment — £9,906.51, exactly one instalment's capital light
//     (195 − 51.51 interest = 143.49). Every other page said £10,050.
//  2. FINISH DATE. The lump lands in the payment PERIOD it falls in, so a loan
//     cleared today reported "Finishes 2026-10-01" — the period's end, not the
//     day the money actually left.
//
// The fix is deliberately narrow: only dates BEFORE the first schedule entry
// change. An earlier attempt replaced the balance lookup wholesale and
// silently stopped seeing lump sums mid-schedule — verify-scenario-debt-sections
// caught it. Hence the mid-schedule control at the bottom, which must keep
// passing whatever happens to the pre-first-instalment window.
import type { AppData, Loan, Scenario } from '../src/types/models'
import { calculateScenarioImpact } from '../src/lib/scenarios'

let failures = 0
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const TODAY = new Date().toISOString().slice(0, 10)
const nextMonthIso = (() => { const d = new Date(); d.setMonth(d.getMonth() + 1); d.setDate(1); return d.toISOString().slice(0, 10) })()

const people = [{ id: 'me', name: 'Me', salary: 40000, payFrequency: 'monthly', payDayOfMonth: 25, sharePercent: 100 }]
// Mirrors the real loan AFTER the legacy bridge: balance as of today, and a
// first payment that has not fallen due yet.
const loan = {
  id: 'monzo', name: 'Monzo', firstPaymentDate: nextMonthIso, totalAmount: 10050,
  monthlyPayment: 195, location: 'personal', ownerId: 'me', payee: 'me',
  payeeSharePercent: 100, calibratedMonthlyRate: 0.005125641332341951,
} as unknown as Loan
const data = { people, loans: [loan], bills: [], creditCards: [], savingsPots: [], transactions: [] } as unknown as AppData
const clear = { id: 's', name: 'Clear it', includeInCumulative: true,
  actions: [{ id: 'a', type: 'pay_off_loan', label: '', value: 10050, targets: [{ kind: 'loan', id: 'monzo' }], date: TODAY }] } as unknown as Scenario

const r = calculateScenarioImpact(clear, data, 'me', 1000)
const d = r.debtImpacts?.[0]
const sec = d?.sections?.[0]

check('balance as of today is the full amount — no instalment has fallen due', d?.balanceNow, 10050)
check('the section "before" balance is the full amount too', sec?.balanceOnDateBefore, 10050)
check('cleared: nothing owing after', sec?.balanceOnDateAfter, 0)
check('cleared: reads as fully paid off', sec?.fullyPaidOff, true)
check('the monthly payment is freed in full', r.monthlyImpact, 195)
check('the one-off cash is the true settlement, not a reduced balance', r.oneOffCashImpact, -10050)
check('FINISHES the day the money left, not the end of the payment period', sec?.finishDateAfter, TODAY)
check('...and that is what the card reports overall', d?.finishDateAfterAll, TODAY)

// ---- CONTROL: a PARTIAL lump before the first instalment ----
const partial = { ...clear, actions: [{ ...(clear as unknown as { actions: Record<string, unknown>[] }).actions[0], value: 50 }] } as unknown as Scenario
const p = calculateScenarioImpact(partial, data, 'me', 1000)
const ps = p.debtImpacts?.[0]?.sections?.[0]
check('CONTROL partial lump: before is still the full balance', ps?.balanceOnDateBefore, 10050)
check('CONTROL partial lump: after drops by exactly the lump', ps?.balanceOnDateAfter, 10000)
check('CONTROL partial lump: not paid off, so the finish date is unchanged', ps?.fullyPaidOff, false)

// ---- CONTROL: a lump MID-SCHEDULE still behaves as it always did ----
// This is the case the narrow fix must not disturb. The loan is well into its
// term, so the balance lookup keeps its original next-entry semantics.
const running = { ...loan, firstPaymentDate: '2026-01-01' } as unknown as Loan
const runData = { ...data, loans: [running] } as unknown as AppData
const midDate = '2027-03-20'
const mid = { id: 's2', name: 'Mid lump', includeInCumulative: true,
  actions: [{ id: 'a2', type: 'pay_off_loan', label: '', value: 2000, targets: [{ kind: 'loan', id: 'monzo' }], date: midDate }] } as unknown as Scenario
const m = calculateScenarioImpact(mid, runData, 'me', 1000)
const ms = m.debtImpacts?.[0]?.sections?.[0]
// Not exactly £2,000: clearing capital early also changes that period's
// interest, so the drop is the lump plus a little. (verify-scenario-debt-sections
// asserts an exact figure because its fixture is a 0% loan.) What matters here
// is that the lump is SEEN at all — the earlier broken attempt gave a drop of 0.
const midDrop = Math.round(((ms?.balanceOnDateBefore ?? 0) - (ms?.balanceOnDateAfter ?? 0)) * 100) / 100
check('CONTROL mid-schedule: the lump is still seen — the drop is the lump plus that period\'s interest',
  midDrop >= 2000 && midDrop < 2000 + 195, true)
check('CONTROL mid-schedule: "before" is the scheduled balance on that date, below today\'s',
  (ms?.balanceOnDateBefore ?? 0) < (m.debtImpacts?.[0]?.balanceNow ?? 0), true)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
