// The What-if statement (lib/scenarioStatement.ts): the payment-by-payment
// view behind a loan or savings-pot card's "Statement" button.
//
// WHAT THIS PREVENTS.
//  1. The card and its statement disagreeing. Both must come from the same
//     engine run; the card's "Finishes" is the statement's last row.
//  2. The final month's extra being overstated. buildLoanSchedule records the
//     full overpayment in `overpaymentApplied` and then clamps the balance at
//     £0, so the backup's last month reads £450 where £396.69 cleared the loan.
//     Summing that field gives £7,300 of extras; £7,246.69 was paid.
//  3. A lump paid on its own day being folded into the payment row it was
//     filed with: £3,600 on 15 Feb is its own row, after the 14 Feb payment.
//
// The expected loan rows are an independent hand calculation (balance ×
// 0.486525%/month rounded to the penny, then £290.20, then any extra), done
// in Python with no app code.
//
// NOTE ON DATES: the clock is pinned to noon on the backup's day.

import { readFileSync } from 'node:fs'
import { addDays } from 'date-fns'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { buildLegacyAppData } from '../src/lib/legacyBridge'
import { calculateScenarioImpact, mergeScenarios, potWhatIfActivity, potWhatIfTemplates } from '../src/lib/scenarios'
import { buildLoanScenarioStatement, buildSavingsPotScenarioStatement } from '../src/lib/scenarioStatement'
import { simulateScenarioLoan } from '../src/lib/loans'
import { projectedBalanceAt, savingsPotBalanceAsOf } from '../src/lib/savingsPotLedger'
import { toLocalIsoDate, parseLocalDate } from '../src/lib/date'
import type { AppData, Scenario } from '../src/types/models'

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
const r2 = (n: number) => Math.round(n * 100) / 100

check('(control) the clock really is pinned', toLocalIsoDate(new Date()), '2026-11-08')

const FIXTURE = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-11-08-mum.json'
const data: AppData = buildLegacyAppData(parseLedgerBackupJson(readFileSync(FIXTURE, 'utf8')))
const me = data.primaryPersonId
const LOAN = 'NW_iSDAt'
const loan = data.loans.find((l) => l.id === LOAN)!

// ── The backup's Combined loan statement ──
const combined = calculateScenarioImpact(mergeScenarios(data.scenarios.filter((s) => s.includeInCumulative)), data, me, 0)
const di = combined.debtImpacts.find((d) => d.targetId === LOAN)!
const st = buildLoanScenarioStatement(loan, di.loanEvents)!

// [date, interest, payment, extra, balance]
const expected: [string, number, number, number, number][] = [
  ['2026-11-14', 50.62, 290.2, 0, 10165.36],
  ['2026-12-14', 49.46, 290.2, 0, 9924.62],
  ['2027-01-14', 48.29, 290.2, 0, 9682.71],
  ['2027-02-14', 47.11, 290.2, 0, 9439.62],
  ['2027-02-15', 0, 0, 3600, 5839.62],
  ['2027-03-14', 28.41, 290.2, 0, 5577.83],
  ['2027-04-14', 27.14, 290.2, 1000, 4314.77],
  ['2027-05-14', 20.99, 290.2, 450, 3595.56],
  ['2027-06-14', 17.49, 290.2, 450, 2872.85],
  ['2027-07-14', 13.98, 290.2, 450, 2146.63],
  ['2027-08-14', 10.44, 290.2, 450, 1416.87],
  ['2027-09-14', 6.89, 290.2, 450, 683.56],
  ['2027-10-14', 3.33, 290.2, 396.69, 0],
]
check('Combined: the rows of the hand calculation, exactly', st.rows.map((r) => [r.date, r.interest, r.payment, r.extra, r.balance]), expected)
check('15 Feb is its own row, not folded into 14 Feb', st.rows.filter((r) => r.date.startsWith('2027-02')).map((r) => r.kind), ['payment', 'extra'])
let prev = st.opening
let chain = true
for (const r of st.rows) {
  if (r2(prev + r.interest - r.payment - r.extra) !== r.balance) chain = false
  prev = r.balance
}
check('Every row: previous + interest − payment − extra = balance', chain, true)
check('Without the what-if: 14 Feb 2030, 40 payments, £1,057.13 interest', st.without, { finishDate: '2030-02-14', payments: 40, interest: 1057.13 })
check('With it: 14 Oct 2027, 12 payments, £324.15 interest', st.with, { finishDate: '2027-10-14', payments: 12, interest: 324.15 })
check('The last row is the card’s finish date', st.with.finishDate, di.finishDateAfterAll)
check('Extras actually paid: £7,246.69', st.extrasTotal, 7246.69)
const engineExtras = r2(simulateScenarioLoan(loan, di.loanEvents).schedule.reduce((s, e) => s + e.overpaymentApplied, 0))
check('(control) the engine’s overpaymentApplied sums to £7,300', engineExtras, 7300)

// ── Every scenario on its own: card and statement agree ──
for (const sc of data.scenarios) {
  const one = calculateScenarioImpact(sc, data, me, 0).debtImpacts.find((d) => d.targetId === LOAN)!
  const s = buildLoanScenarioStatement(loan, one.loanEvents)!
  check(`"${sc.name}" (${sc.actions[0].date}): statement ends on the card's finish date`, s.with.finishDate, one.finishDateAfterAll)
  for (const sec of one.sections) {
    const onDay = s.rows.filter((r) => r.date <= sec.date).at(-1)
    check(`"${sc.name}": statement balance on ${sec.date} = the card's`, onDay?.balance, sec.balanceOnDateAfter)
  }
}

// ── Order of actions does not change the events (or the card) ──
const reversed = calculateScenarioImpact(mergeScenarios(data.scenarios.filter((s) => s.includeInCumulative).slice().reverse()), data, me, 0)
check('Reversed scenarios: identical loan events (count, and every event equal)', [reversed.debtImpacts[0].loanEvents.length, JSON.stringify(reversed.debtImpacts[0].loanEvents) === JSON.stringify(di.loanEvents)], [di.loanEvents.length, true])

// ── Savings pot: the backup's Easy access saver (pays in on payday, credits interest on the 4th) ──
const POT = 'sMtJBP3O'
const potScenario = {
  id: 'pot',
  name: 'Pot',
  includeInCumulative: true,
  actions: [
    { id: 'l', type: 'savings_pot_lump_sum', label: '', value: 500, date: '2027-01-20', savingsPotId: POT },
    { id: 'w', type: 'savings_pot_withdrawal', label: '', value: 200, date: '2027-03-10', savingsPotId: POT },
    { id: 'r', type: 'savings_pot_recurring_deposit_change', label: '', value: 400, date: '2027-04-04', savingsPotId: POT },
  ],
} as Scenario
const si = calculateScenarioImpact(potScenario, data, me, 0).savingsPotImpacts[0]
const ps = buildSavingsPotScenarioStatement(si, data, new Date())
check('Pot: runs from today to the last change + 12 months', [ps.startDate, ps.endDate], ['2026-11-08', '2028-04-04'])
check('Pot: the opening is the balance at the end of yesterday', ps.opening, savingsPotBalanceAsOf(data.savingsPots.find((p) => p.id === POT)!, data.transactions, addDays(new Date(), -1)))
check('Pot: the lump and the withdrawal are flagged as the what-if', ps.rows.filter((r) => r.whatIf).map((r) => [r.date, r.amount]), [['2027-01-20', 500], ['2027-03-10', -200]])
for (const sec of si.sections) {
  const onDay = ps.rows.filter((r) => r.date <= sec.date).at(-1)
  check(`Pot: statement balance on ${sec.date} = the card's`, onDay?.balance, sec.balanceOnDateAfter)
}
const pot = data.savingsPots.find((p) => p.id === POT)!
const payCycle = data.payCycles.find((c) => c.personId === pot.personId)
const projected = r2(projectedBalanceAt(pot, si.balanceNow, potWhatIfActivity(pot, si.whatIfPlan, data), new Date(), parseLocalDate(ps.endDate), potWhatIfTemplates(pot, si.whatIfPlan, data), payCycle))
check('Pot: the last row is the projected balance on the end date', ps.with.endBalance, projected)
check('Pot: the statement is not the pot unchanged', ps.with.endBalance !== ps.without.endBalance, true)

console.log(failures === 0 ? '\nAll What-if statement checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
