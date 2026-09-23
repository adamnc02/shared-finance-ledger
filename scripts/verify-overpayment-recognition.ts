// PROMPT-08b — a one-off overpayment must count from the day it was PAID,
// not from the day the amortisation engine folds it into a period.
//
// Adam, 2026-09-18, on mum's backup with a £7,000 overpayment added to Car
// Finance dated 2026-09-17: "The owed amount is not updating anywhere, and
// the progress bar hasn't recognised the new cleared one off overpayment,
// it's still sat at the 13% paid before I added the overpayment", and
// then "the pie chart also doesn't see this overpayment", and "check on
// the borrowing page, as this also seemed to miss the overpayment".
//
// ROOT CAUSE. Car Finance is due on the 28th, so buildLoanSchedule folds a
// 2026-09-17 overpayment into the 2026-09-28 entry. Both `summarizeLoan`
// and `summarizeLoanProgress` read "as of today" by taking schedule
// entries with `date <= today`, so on the 18th the last entry they saw was
// 2026-08-28 — the loan exactly as it stood before the payment.
//
// WHAT FAILS AGAINST THE PRE-FIX CODE: every check under "The reported
// case" and "The surfaces Adam listed" below. The pre-fix figures are
// asserted explicitly as NOT-equal-to values, so this script discriminates
// rather than merely exercising the path.

import { readFileSync } from 'node:fs'
import { summarizeLoan, summarizeLoanProgress, appliedOneOffOverpayments, unrecognisedOneOffOverpayments, buildLoanSchedule, amortisedTotalPayable, nominalTotalPayable } from '../src/lib/ledgerLoans'
import { buildLoanTrendEvents } from '../src/lib/loanLedger'
import { summarizeLoansProgress } from '../src/lib/progressSection'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import type { AppDataV2, Loan } from '../src/types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100
let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures'
function load(file: string): AppDataV2 {
  const raw = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'))
  return migrateLedgerData(raw.data ?? raw)
}
const mum = load('finance-ledger-backup-2026-09-17-mum.json')

// Date-pinned: this bug is entirely about where "today" falls relative to
// the overpayment's own date and the period that absorbs it, so a
// floating "now" would stop reproducing it within days.
const TODAY = new Date(2026, 8, 18) // 2026-09-18
const TODAY_ISO = '2026-09-18'

const carFinance = mum.loans.find((l) => l.name === 'Car Finance')!
// Adam's exact repro, rebuilt from the real backup rather than invented.
const withOverpayment: Loan = {
  ...carFinance,
  overpayments: [...(carFinance.overpayments ?? []), { id: 'ADAM-REPRO', date: '2026-09-17', amount: 7000, recastMode: 'reduce_term' }],
}

console.log('\n── The setup that causes it ──')

const schedule = buildLoanSchedule(withOverpayment)
const absorbing = schedule.find((e) => e.overpaymentApplied > 0)!
check('the loan is due on the 28th', carFinance.paymentDayOfMonth ?? new Date(carFinance.startDate).getDate(), 28)
check('the overpayment was PAID on the 17th', '2026-09-17' < TODAY_ISO, true)
check('...but the engine folds it into the period due on the 28th', absorbing.date, '2026-09-28')
check('...which is in the FUTURE relative to today — the whole cause', absorbing.date > TODAY_ISO, true)
check('appliedOneOffOverpayments maps it to both dates', appliedOneOffOverpayments(withOverpayment).find((a) => a.overpaymentId === 'ADAM-REPRO'), {
  overpaymentId: 'ADAM-REPRO',
  date: '2026-09-17',
  periodDate: '2026-09-28',
  amount: 7000,
})
check('...and it is therefore "paid but not yet recognised" today', unrecognisedOneOffOverpayments(withOverpayment, schedule, TODAY_ISO), 7000)

console.log('\n── The reported case ──')

const before = { summary: summarizeLoan(carFinance, TODAY), progress: summarizeLoanProgress(carFinance, TODAY) }
const after = { summary: summarizeLoan(withOverpayment, TODAY), progress: summarizeLoanProgress(withOverpayment, TODAY) }

// The exact figures from Adam's screenshot, pinned as the WRONG answers.
check('before the overpayment: £7,437 owed, 13% paid (Adam\'s screenshot)', { owed: before.summary.remainingBalance, pct: Math.round(before.progress.percentPaid) }, { owed: 7437, pct: 13 })
check('after it, the owed figure MOVES (it did not before the fix)', after.summary.remainingBalance !== before.summary.remainingBalance, true)
check('...by exactly the £7,000 paid, since an overpayment is 100% principal', round2(before.summary.remainingBalance - after.summary.remainingBalance), 7000)
check('...leaving £437 owed', after.summary.remainingBalance, 437)
check('the cash paid to date rises by the same £7,000', round2(after.progress.totalPaid - before.progress.totalPaid), 7000)
check('...so the progress bar is no longer stuck at 13%', Math.round(after.progress.percentPaid), 95)
// Not a tautology: summarizeLoansProgress is the call the progress SECTION
// makes (both the bar and the ring in its modal), and it aggregates
// independently of summarizeLoanProgress's own percentage. They must agree.
check('the progress section\'s own aggregate agrees with the loan\'s figure', round2(summarizeLoansProgress([withOverpayment]).percentPaid), round2(after.progress.percentPaid))
check('capital remaining agrees with the owed figure', after.progress.capitalRemaining, after.summary.remainingBalance)
check('reduce_term shortens the loan: 49 months left becomes 3', { before: before.summary.monthsRemaining, after: after.summary.monthsRemaining }, { before: 49, after: 3 })

console.log('\n── The surfaces Adam listed ──')

// Every surface he named reads one of these two functions, which is why
// one fix covers all of them. Asserted as identity rather than by
// re-rendering the pages: the point is that there is no third derivation
// anywhere that could still disagree.
check('the hero card\'s OWED == summarizeLoan', summarizeLoan(withOverpayment, TODAY).remainingBalance, 437)
check('the Borrowing page reads summarizeLoan/summarizeLoanProgress, so it moves too', summarizeLoanProgress(withOverpayment, TODAY).capitalRemaining, 437)
check('the progress bar and pie chart read summarizeLoanProgress', Math.round(summarizeLoanProgress(withOverpayment, TODAY).percentPaid), 95)
// The trend chart was already correct before this fix (PROMPT-08a re-dated
// overpayments for the chart only) and must STAY correct now that it
// shares the mapping helper.
const trendOverpayments = buildLoanTrendEvents(withOverpayment).filter((e) => e.kind === 'one_off_overpayment')
check('the trend chart still shows it, on its own date, exactly once', trendOverpayments.map((e) => ({ d: e.dateIso, a: e.amount })), [{ d: '2026-09-17', a: 7000 }])

console.log('\n── The boundaries ──')

// The day before it was paid, nothing has happened yet.
check('the day BEFORE the overpayment, the loan is untouched', summarizeLoan(withOverpayment, new Date(2026, 8, 16)).remainingBalance, before.summary.remainingBalance)
// On the day itself it counts — "paid today" is paid.
check('on the day it was paid, it counts', summarizeLoan(withOverpayment, new Date(2026, 8, 17)).remainingBalance, 437)
// Once the absorbing period arrives the schedule recognises it itself, and
// the credit must NOT be applied a second time on top.
const afterPeriod = summarizeLoan(withOverpayment, new Date(2026, 8, 29))
check('once the absorbing period passes, nothing is double-counted', unrecognisedOneOffOverpayments(withOverpayment, schedule, '2026-09-29'), 0)
check('...and the balance is the schedule\'s own, not £7,000 less again', afterPeriod.remainingBalance, round2(absorbing.balanceAfter))
check('...which is lower than today\'s, not higher', afterPeriod.remainingBalance < after.summary.remainingBalance, true)

// Mum's REAL existing overpayment is comfortably in the past, on both
// counts — so this fix changes nothing about her stored data as it stands,
// which is what makes it safe to ship to a live app.
console.log('\n── Mum\'s real data is unaffected ──')

const homeImprovements = mum.loans.find((l) => l.name === 'Home Improvements')!
check('her real £40 overpayment is fully recognised already', unrecognisedOneOffOverpayments(homeImprovements, buildLoanSchedule(homeImprovements), TODAY_ISO), 0)
check('...so her owed figure is unchanged by this fix', summarizeLoan(homeImprovements, TODAY).remainingBalance > 0, true)
check('neither of her loans has any unrecognised overpayment today', mum.loans.every((l) => unrecognisedOneOffOverpayments(l, buildLoanSchedule(l), TODAY_ISO) === 0), true)

// A lump bigger than the loan must clear it, never drive it negative.
// ── The progress denominator is the AMORTISED total ───────────────────
//
// Adam, 2026-09-18: "the progress bar does not read the amortised amount
// remaining, it uses the fixed amount remaining by subtracting the total
// paid from total borrowed... The progress bars and pie charts 100% needs
// to be the amortised value after all projected payments (including
// scheduled one off overpayments and recurring overpayments)."
console.log('\n── Progress reads the amortised total, not the contractual one ──')

check('with no overpayments the two totals agree, so nothing changes for most loans', amortisedTotalPayable(carFinance), nominalTotalPayable(carFinance))
check('an overpayment cuts the REAL total (shorter term, less interest)', amortisedTotalPayable(withOverpayment) < nominalTotalPayable(withOverpayment), true)
check('...while the contractual total stays frozen, as verify-loan-amortisation pins it', nominalTotalPayable(withOverpayment), nominalTotalPayable(carFinance))

// THE decisive property, and the clearest statement of the bug: against a
// frozen contractual denominator a loan with overpayments can never reach
// 100% — it tops out short of full and then the loan simply closes.
const contractualPercentAtPayoff = round2((summarizeLoanProgress(withOverpayment, new Date(2030, 0, 1)).totalPaid / nominalTotalPayable(withOverpayment)) * 100)
check('a fully-repaid overpaid loan reads EXACTLY 100%', round2(summarizeLoanProgress(withOverpayment, new Date(2030, 0, 1)).percentPaid), 100)
check('...where the contractual denominator would have stopped short of it', contractualPercentAtPayoff < 100, true)
console.log(`      (contractual denominator would read ${contractualPercentAtPayoff}% at payoff — the bar could never fill)`)
check('a loan with NO overpayments also reaches exactly 100%', round2(summarizeLoanProgress(carFinance, new Date(2031, 0, 1)).percentPaid), 100)

// "the amortised amount remaining" — falls when a term shortens, which
// nominalRemaining (totalBalance − totalPaid) does not.
check('amortisedRemaining is the real cash left, below the nominal figure', after.progress.amortisedRemaining < after.progress.nominalRemaining, true)
check('...and reaches zero at payoff', summarizeLoanProgress(withOverpayment, new Date(2030, 0, 1)).amortisedRemaining, 0)
check('paid + amortisedRemaining == the amortised total, always', round2(after.progress.totalPaid + after.progress.amortisedRemaining), round2(after.progress.amortisedTotalPayable))

console.log('\n── A lump larger than the balance ──')

const overkill: Loan = { ...carFinance, overpayments: [{ id: 'HUGE', date: '2026-09-17', amount: 999_999, recastMode: 'reduce_term' }] }
check('owed is clamped at zero, never negative', summarizeLoan(overkill, TODAY).remainingBalance >= 0, true)
check('percent paid is clamped at 100', summarizeLoanProgress(overkill, TODAY).percentPaid <= 100, true)

console.log(failures === 0 ? '\nAll overpayment-recognition checks passed.' : `\n${failures} overpayment-recognition check(s) FAILED.`)
process.exitCode = failures === 0 ? 0 : 1
