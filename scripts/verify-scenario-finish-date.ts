// What-if loan cards: the "Finishes" date and "Balance on <date>".
//
// THE BUG THIS PREVENTS. A loan with two lump sums and a recurring
// overpayment (the 2026-11-08 backup's Home Improvements loan: £3,600 on 15 Feb 2027, £1,000 on
// 14 Apr 2027, £450/month from 14 May 2027) read "Finishes 14 Apr 2027" in
// the Combined view, while the same card showed £3,595.56 still owed on
// 14 May 2027. The real last payment is 14 Oct 2027. The finish date was
// gated on simulateScenarioLoan's `fullyPaidOff`, which is anchored to the
// chronologically LAST event, and a recurring overpayment is 600
// materialised events (~50 years out), so the flag was always true and the
// last lump's date won.
//
// And: "Balance on 15 Feb 2027" read £9,195.35 → £5,577.83, the balances
// after the 14 MARCH payment (the first schedule entry at-or-after the date),
// so a month of payments that had not happened yet showed as already made.
// On 15 Feb itself it is £9,439.62 → £5,839.62.
//
// NOTE ON DATES: the bridge reads the loan as of today, so the clock is
// pinned to noon on the backup's own day.

import { readFileSync } from 'node:fs'
import { addMonths } from 'date-fns'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { buildLegacyAppData } from '../src/lib/legacyBridge'
import { calculateScenarioImpact, mergeScenarios } from '../src/lib/scenarios'
import { simulateScenarioLoan, loanBalanceOnDay, type ScenarioLoanEvent } from '../src/lib/loans'
import { toLocalIsoDate, parseLocalDate } from '../src/lib/date'
import type { AppData, Loan, Scenario } from '../src/types/models'

const PINNED_NOW = new Date(2026, 10, 8, 12).getTime()
const RealDate = Date
class PinnedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(PINNED_NOW)
    else super(...(args as [string | number | Date]))
  }
  static now() {
    return PINNED_NOW
  }
}
globalThis.Date = PinnedDate as unknown as DateConstructor

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.005) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

check('(control) the clock really is pinned', toLocalIsoDate(new Date()), '2026-11-08')

const FIXTURE = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-11-08-mum.json'
const data: AppData = buildLegacyAppData(parseLedgerBackupJson(readFileSync(FIXTURE, 'utf8')))
const me = data.primaryPersonId
const LOAN = 'NW_iSDAt'

// ── The backup's Combined: all three scenarios ticked ──
const combined = calculateScenarioImpact(mergeScenarios(data.scenarios.filter((s) => s.includeInCumulative)), data, me, 0)
const di = combined.debtImpacts.find((d) => d.targetId === LOAN)!
check('Combined: three sections', di.sections.map((s) => s.date), ['2027-02-15', '2027-04-14', '2027-05-14'])
check('Combined: finishes on the last real payment, 14 Oct 2027', di.finishDateAfterAll, '2027-10-14')
check('Combined: the 14 May section finishes 14 Oct 2027 too', di.sections[2].finishDateAfter, '2027-10-14')
check('Combined: 12 payments left', di.monthsRemainingAfterAll, 12)
check('15 Feb: the balance on that day, before and after the £3,600', [di.sections[0].balanceOnDateBefore, di.sections[0].balanceOnDateAfter], [9439.62, 5839.62])
check('15 Feb: before − after is exactly the lump', Math.round((di.sections[0].balanceOnDateBefore - di.sections[0].balanceOnDateAfter) * 100) / 100, 3600)
check('14 Apr: lump on the payment day', [di.sections[1].balanceOnDateBefore, di.sections[1].balanceOnDateAfter], [5314.77, 4314.77])
check('14 May: the first £450', [di.sections[2].balanceOnDateBefore, di.sections[2].balanceOnDateAfter], [4045.56, 3595.56])

// ── Each scenario on its own was already right, and must stay so ──
const alone = (name: string, date: string) => {
  const sc = data.scenarios.find((s) => s.actions[0]?.date === date) as Scenario
  return calculateScenarioImpact(sc, data, me, 0).debtImpacts.find((d) => d.targetId === LOAN)!.finishDateAfterAll
}
check('£3,600 alone finishes 14 Dec 2028', alone('lump 3600', '2027-02-15'), '2028-12-14')
check('£1,000 alone finishes 14 Oct 2029', alone('lump 1000', '2027-04-14'), '2029-10-14')
check('£450/month alone finishes 14 May 2028', alone('recurring 450', '2027-05-14'), '2028-05-14')

// ── The control: the old rule, re-run inline, reproduces 14 Apr 2027 ──
const bridged = data.loans.find((l) => l.id === LOAN)!
const events: ScenarioLoanEvent[] = [
  { date: '2027-02-15', amount: 3600, recastMode: 'reduce_term' },
  { date: '2027-04-14', amount: 1000, recastMode: 'reduce_term' },
  ...Array.from({ length: 600 }, (_, i) => ({ date: toLocalIsoDate(addMonths(parseLocalDate('2027-05-14'), i)), amount: 450, recastMode: 'reduce_term' as const })),
]
const outcome = simulateScenarioLoan(bridged, events)
const clearingLump = '2027-04-14'
const oldFinish = outcome.fullyPaidOff && clearingLump < (outcome.finalPaymentDate ?? '') ? clearingLump : outcome.finalPaymentDate
check('(control) the tail-anchored flag is true with a recurring overpayment', outcome.fullyPaidOff, true)
check('(control) the old rule reads 14 Apr 2027', oldFinish, '2027-04-14')
check('(control) the schedule itself ends 14 Oct 2027', outcome.finalPaymentDate, '2027-10-14')

// ── Balance on the day: a lump before, on and after the payment day ──
// A synthetic loan: £6,000, £300 on the 14th, 0.5%/month flat.
const loan: Loan = { id: 'syn', name: 'Synthetic', firstPaymentDate: '2027-01-14', totalAmount: 6000, monthlyPayment: 300, location: 'personal', ownerId: me, payee: '', payeeSharePercent: 100, calibratedMonthlyRate: 0.005, interestConventionId: 'flat_monthly' }
// By hand: interest = balance × 0.5%, then the payment.
const jan = 6000 + 30 - 300 // 5730
const feb = Math.round((jan + jan * 0.005 - 300) * 100) / 100 // 5458.65
const lumpDays = (date: string) => simulateScenarioLoan(loan, [{ date, amount: 500, recastMode: 'reduce_term' }]).schedule
const ev = (date: string) => [{ date, amount: 500, recastMode: 'reduce_term' as const }]
const before = lumpDays('2027-03-03')
check('Lump on 3 Mar (before the 14 Mar payment): 2 Mar has nothing yet', loanBalanceOnDay(before, 6000, ev('2027-03-03'), '2027-03-02'), feb)
check('Lump on 3 Mar: on the day, the February balance less the lump', loanBalanceOnDay(before, 6000, ev('2027-03-03'), '2027-03-03'), feb - 500)
check('Lump on 3 Mar: on 14 Mar, the engine’s own entry', loanBalanceOnDay(before, 6000, ev('2027-03-03'), '2027-03-14'), before[2].balanceAfter)
const on = lumpDays('2027-02-14')
check('Lump on 14 Feb (the payment day): included that day', loanBalanceOnDay(on, 6000, ev('2027-02-14'), '2027-02-14'), feb - 500)
check('Lump on 14 Feb: not the day before', loanBalanceOnDay(on, 6000, ev('2027-02-14'), '2027-02-13'), jan)
const after = lumpDays('2027-02-20')
check('Lump on 20 Feb (after the payment): 14 Feb does not include it', loanBalanceOnDay(after, 6000, ev('2027-02-20'), '2027-02-14'), feb)
check('Lump on 20 Feb: on the day it does', loanBalanceOnDay(after, 6000, ev('2027-02-20'), '2027-02-20'), feb - 500)

// ── A lump that clears the loan finishes on its own day ──
const synData: AppData = { ...data, loans: [...data.loans, loan] }
const clear = (date: string) =>
  calculateScenarioImpact({ id: 'c', name: 'c', includeInCumulative: true, actions: [{ id: 'a', type: 'pay_off_loan', label: '', value: 100000, date, targets: [{ id: 'syn', kind: 'loan' }] }] } as Scenario, synData, me, 0).debtImpacts[0]
check('A clearing lump on 3 Mar finishes 3 Mar, not on the 14 Mar payment', clear('2027-03-03').finishDateAfterAll, '2027-03-03')
check('...and is paid off', clear('2027-03-03').fullyPaidOff, true)

console.log(failures === 0 ? '\nAll What-if finish-date checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
