// PROMPT-08a Part C — the acceptance gate for a loan's own hero card,
// ledger and trend chart, asserted against BOTH real backups.
//
// The fixtures are genuinely useful here, not synthetic:
//  - mum's 2026-09-17 backup has TWO active personal loans she owns
//    ("Home Improvements", with a logged ad-hoc overpayment, and
//    "Car Finance") — so both get a card, and one exercises the
//    overpayment x-axis point.
//  - Adam's 2026-09-15 backup has exactly one loan, "Tesco", owned by
//    ELLA (DfWvhQNX) while the primary person is Adam (GpD7EIbH) — a real
//    negative fixture for the ownership rule, not a made-up one. It also
//    carries a recurring overpayment.
//
// WHAT FAILS AGAINST THE PRE-CHANGE CODE: none of this module existed, so
// every check here is new behaviour. The checks that would fail against a
// WRONG implementation are called out individually below — in particular
// the window checks fail if the ledger is filtered to the household pay
// cycle instead of the loan's own due dates (the exact defect PROMPT-01
// Part B found on credit cards), and the sign checks fail if the loan
// ledger is fed `signedAmount` instead of `loanSignedAmount`.

import { readFileSync } from 'node:fs'
import { isLoanCardVisible, visibleLoanCards, loanCyclePeriods, loanPaymentTransactions, loanSignedAmount, buildLoanCycleSections, buildLoanTrendSeries, buildLoanTrendEvents, LOAN_PAYMENT_KIND_LABELS } from '../src/lib/loanLedger'
import { buildLoanSchedule, summarizeLoan, settleLoan } from '../src/lib/ledgerLoans'
import { pickNextSharedCardColor } from '../src/lib/creditCards'
import { SHARED_CARD_COLORS } from '../src/types/ledger'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { signedAmount } from '../src/lib/runningBalance'
import { toLocalIsoDate } from '../src/lib/date'
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
const adam = load('finance-ledger-backup-2026-09-15.json')

// Date-pinned. The SCHEDULES move as real time passes (a payment due next
// month materialises), so every windowed assertion below is taken as of a
// fixed date rather than "today", which is what makes this definitive
// whenever it runs. Same convention as verify-credit-card-mum-backup.ts.
const ASOF = new Date(2026, 8, 18) // 2026-09-18, local

console.log('\n── Ownership and visibility ──')

const mumCards = visibleLoanCards(mum, ASOF)
check('mum: both of her loans get a card', mumCards.map((l) => l.name).sort(), ['Car Finance', 'Home Improvements'])

// The real negative fixture: Adam's only loan belongs to Ella.
const adamCards = visibleLoanCards(adam, ASOF)
check("adam: Ella's loan gets NO card on Adam's deck", adamCards.length, 0)
const tesco = adam.loans.find((l) => l.name === 'Tesco')!
check("adam: that loan is owned by Ella, not the primary person", { owner: tesco.ownerId, primary: adam.primaryPersonId }, { owner: 'DfWvhQNX', primary: 'GpD7EIbH' })
check("adam: it WOULD get a card on Ella's own deck (ownership is the only thing stopping it)", isLoanCardVisible(tesco, 'DfWvhQNX', ASOF), true)

// Hidden once done — BOTH halves of the rule (Adam, 2026-09-18).
const homeImprovements = mum.loans.find((l) => l.name === 'Home Improvements')!
const settled = settleLoan(homeImprovements, 10643.36, '2026-09-18').updatedLoan
check('a SETTLED loan is hidden (settleLoan sets active: false)', isLoanCardVisible(settled, mum.primaryPersonId, ASOF), false)

// A loan that simply ran to the end of its schedule stays active: true —
// this is the half `active` alone does NOT cover, and the reason the
// balance check exists at all.
const finishedIso = summarizeLoan(homeImprovements).payoffDate!
const afterPayoff = new Date(2031, 0, 1) // comfortably past its 2030-02-14 payoff
check('a fully-repaid loan is still active: true (so `active` alone is not enough)', homeImprovements.active, true)
check(`a fully-repaid loan has no balance left after its payoff (${finishedIso})`, summarizeLoan(homeImprovements, afterPayoff).remainingBalance, 0)
check('...and is therefore hidden by the balance half of the rule', isLoanCardVisible(homeImprovements, mum.primaryPersonId, afterPayoff), false)
check('...while it is still visible today', isLoanCardVisible(homeImprovements, mum.primaryPersonId, ASOF), true)

console.log('\n── Hero-card colours never repeat ──')

// 2026-09-18 (Adam-reported): every loan card rendered the same colour,
// because the hero keyed off the loan's CATEGORY and loans overwhelmingly
// share the one seeded "Loan" category. Loans now hold their own
// SHARED_CARD_COLORS entry, backfilled by migrateLedgerData, and join the
// same pool credit cards / pots / savings pots draw from — so no two hero
// cards in the deck can collide. Personal/Joint/Household have their own
// preset palette and are deliberately not in this pool.
for (const [who, data] of [['mum', mum], ['adam', adam]] as const) {
  const loanColors = data.loans.map((l) => l.color)
  check(`${who}: every loan has a colour after migration`, loanColors.every((c) => !!c), true)
  check(`${who}: no two loans share a colour`, loanColors.length, new Set(loanColors).size)
  const poolColors = [
    ...data.creditCards.map((c) => c.color),
    ...data.savingsPots.map((p) => p.color),
    ...(data.pots ?? []).map((p) => p.color),
    ...loanColors,
  ]
  check(`${who}: no loan collides with a card, pot or savings pot (${poolColors.length} entities)`, poolColors.length, new Set(poolColors).size)
  check(`${who}: every loan colour comes from the shared palette`, loanColors.every((c) => (SHARED_CARD_COLORS as readonly string[]).includes(c)), true)
}
// A NEW entity must not be handed a colour a loan is already showing —
// loans have to be in the picker's used-set, not just the backfill.
const nextForMum = pickNextSharedCardColor(mum)
check('the next shared colour avoids every loan colour already in use', mum.loans.some((l) => l.color === nextForMum), false)

console.log('\n── Cycle windows come from the LOAN\'s own due dates, not the pay cycle ──')

const carFinance = mum.loans.find((l) => l.name === 'Car Finance')!
const carSchedule = buildLoanSchedule(carFinance)
const carDueDates = carSchedule.map((e) => e.date)

const thisCycle = loanCyclePeriods(carFinance, ASOF, 1)
check('This cycle is exactly one period', thisCycle.length, 1)
// Car Finance is due on the 28th. The household pay cycle is nothing like
// this — that is the whole point of the check.
check('its due date is the loan\'s own next scheduled payment date', toLocalIsoDate(thisCycle[0].dueDate), carDueDates.find((d) => d >= '2026-09-18'))
check('its window ENDS on that due date (inclusive)', toLocalIsoDate(thisCycle[0].windowEnd), toLocalIsoDate(thisCycle[0].dueDate))
// windowStart is the day after the previous due date — so the two periods
// tile with no gap and no overlap, which is what stops a payment being
// counted twice or dropped between cycles.
const threeCycles = loanCyclePeriods(carFinance, ASOF, 4)
check('Next 3 cycles is 1 + 3 of the loan\'s own periods', threeCycles.length, 4)
check('each period starts the day after the previous one ends (no gap, no overlap)',
  threeCycles.slice(1).every((p, i) => {
    const prevEnd = new Date(threeCycles[i].windowEnd)
    prevEnd.setDate(prevEnd.getDate() + 1)
    return toLocalIsoDate(p.windowStart) === toLocalIsoDate(prevEnd)
  }), true)
check('every period boundary is one of the loan\'s own scheduled payment dates',
  threeCycles.every((p) => carDueDates.includes(toLocalIsoDate(p.dueDate))), true)

// A loan whose whole schedule is in the past still renders its last
// period rather than an empty card.
check('a loan past its payoff falls back to its final period, not []', loanCyclePeriods(carFinance, new Date(2031, 0, 1), 1).length, 1)

console.log('\n── Ledger rows are bounded by the window — including cleared ones ──')

const hiSections = buildLoanCycleSections(homeImprovements, mum.transactions, loanCyclePeriods(homeImprovements, ASOF, 4))
check('one section per period', hiSections.length, 4)
for (const s of hiSections) {
  check(`every row in the ${s.endIso} section is inside its own window`,
    s.rows.every((t) => t.date >= s.startIso && t.date <= s.endIso), true)
}
// The 2026-09-17 bug this must not reintroduce: cleared rows escaping the
// window when "show cleared" is on. Cleared rows are bounded by exactly
// the same window as pending ones — there is no separate path for them.
const allRows = hiSections.flatMap((s) => s.rows)
const clearedRows = allRows.filter((t) => t.status === 'cleared')
check('cleared rows are bounded by the window too (not exempt from it)',
  clearedRows.every((t) => t.date >= hiSections[0].startIso && t.date <= hiSections[hiSections.length - 1].endIso), true)
// Nothing from another loan can leak in.
check('every row belongs to THIS loan', allRows.every((t) => t.sourceId === homeImprovements.id), true)
check('every row is a loan_payment', allRows.every((t) => t.type === 'loan_payment'), true)

// One payment, once — a materialised row and its own projection must not
// both appear (they share a dedupeKey).
const keyed = allRows.map((t) => `${t.sourceType}:${t.date}`)
check('no payment appears twice (stored and generated deduped)', keyed.length, new Set(keyed).size)

console.log('\n── The mirrored sign ──')

const window = loanCyclePeriods(homeImprovements, ASOF, 4)
const rows = loanPaymentTransactions(homeImprovements, mum.transactions, window[0].windowStart, window[window.length - 1].windowEnd)
check('there are rows to check', rows.length > 0, true)
// The SAME row, two signs: negative where it was funded from, positive on
// the loan's own ledger. This is the whole double-entry decision in one
// assertion — see DECISION-2026-09-18-loan-ledger-double-entry.md.
check('every payment is negative on the funding ledger', rows.every((t) => signedAmount(t) < 0), true)
check('...and positive on the loan\'s own ledger', rows.every((t) => loanSignedAmount(t) > 0), true)
check('...and they are the same magnitude — one row, two presentations',
  rows.every((t) => Math.abs(signedAmount(t)) === loanSignedAmount(t)), true)
// The decision's own load-bearing claim: nothing is written.
check('no mirror row is stored in the data (the loan ledger is derived)',
  mum.transactions.filter((t) => t.sourceId === homeImprovements.id && t.direction === 'in').length, 0)

console.log('\n── Trend chart: balance, all time, x = payment dates + overpayments ──')

const hiTrend = buildLoanTrendSeries(homeImprovements, ASOF)
check('opens at the advance/start date with the full principal',
  { date: hiTrend.points[0].dateIso, balance: hiTrend.points[0].balance },
  { date: homeImprovements.advanceDate ?? homeImprovements.startDate, balance: homeImprovements.principal })
check('balance never increases along the series (a loan only pays down)',
  hiTrend.points.every((p, i) => i === 0 || p.balance <= hiTrend.points[i - 1].balance), true)
check('ends at zero — the series covers the loan\'s whole life, not a cycle',
  hiTrend.points[hiTrend.points.length - 1].balance, 0)
check('no duplicate x points (two events on one date collapse to one)',
  hiTrend.points.length, new Set(hiTrend.points.map((p) => p.dateIso)).size)
check('today\'s headline balance matches summarizeLoan', hiTrend.currentBalance, summarizeLoan(homeImprovements, ASOF).remainingBalance)

// The x axis is payment dates plus overpayment dates — every point after
// the opening one is a real dated event on this loan.
const hiScheduleDates = new Set(buildLoanSchedule(homeImprovements).map((e) => e.date))
const overpaymentDates = new Set((homeImprovements.overpayments ?? []).map((o) => o.date))
const unexplained = hiTrend.points.slice(1).filter((p) => !hiScheduleDates.has(p.dateIso) && !overpaymentDates.has(p.dateIso))
check('every x point is a scheduled payment date or an overpayment date', unexplained.map((p) => p.dateIso), [])
check('this loan really does have an ad-hoc overpayment to prove that with', (homeImprovements.overpayments ?? []).length, 1)

// ── The x axis is real dates, and every point knows its own kind ──────
// Adam's exact 2026-09-18 report: a £3,000 one-off overpayment logged on
// 22 Oct drew its dip on 14 OCT, labelled £290 — the monthly payment.
// Cause: buildLoanSchedule aggregates an overpayment into whichever
// period shares its MONTH, and buildLoanLedgerRows then dated the row at
// the PERIOD's date. These checks fail against that.
const withOverpayment: Loan = {
  ...homeImprovements,
  overpayments: [...homeImprovements.overpayments, { id: 'op-uat', date: '2026-10-22', amount: 3000, recastMode: 'reduce_term' }],
}
const opEvents = buildLoanTrendEvents(withOverpayment)
const theOverpayment = opEvents.find((e) => e.kind === 'one_off_overpayment' && e.amount === 3000)
check('a one-off overpayment is dated on the day it was actually made, not the loan payment date', theOverpayment?.dateIso, '2026-10-22')
check('...and carries its own amount, not the monthly payment', theOverpayment?.amount, 3000)
check('the monthly payment that shares its month is still its own separate event on the 14th',
  opEvents.some((e) => e.kind === 'monthly' && e.dateIso === '2026-10-14'), true)
const opPoints = buildLoanTrendSeries(withOverpayment, ASOF).points
check('the balance dip lands on the overpayment\'s own date', opPoints.some((p) => p.dateIso === '2026-10-22'), true)
const before = opPoints.find((p) => p.dateIso === '2026-10-14')!
const after = opPoints.find((p) => p.dateIso === '2026-10-22')!
check('...and is the size of the overpayment', round2(before.balance - after.balance), 3000)

// Every event kind is represented and labelled — the chart's tooltip
// names the kind because a loan's category icon is identical on every
// point and so says nothing (Adam, 2026-09-18).
check('every event kind has a label for the tooltip chip',
  [...new Set(buildLoanTrendEvents(tesco).map((e) => e.kind))].every((k) => !!LOAN_PAYMENT_KIND_LABELS[k]), true)
check("Ella's loan produces both monthly and recurring-overpayment events",
  [...new Set(buildLoanTrendEvents(tesco).map((e) => e.kind))].sort(), ['monthly', 'recurring_overpayment'])
// The tooltip reads IN, not OUT: every event is money arriving at the
// loan, so the figure the tooltip sums must be positive.
check('every trend event amount is positive (the tooltip reads IN, not OUT)',
  buildLoanTrendEvents(withOverpayment).every((e) => e.amount > 0), true)

// Ella's loan carries a RECURRING overpayment, whose real date can fall on
// a different day of the month from the loan's own payment date — the
// x axis has to follow the real date, not the period date.
const tescoTrend = buildLoanTrendSeries(tesco, ASOF)
check("Ella's loan trend also runs to zero", tescoTrend.points[tescoTrend.points.length - 1].balance, 0)
// THE REGRESSION THIS PINS (2026-09-18, found against this real loan).
// Its recurring overpayment falls on the 12th while the loan is due on
// the 1st, so the overpayment row is re-dated BEFORE the payment it is
// aggregated into. Reading each row's own `balanceAfter` — which assumes
// the within-period order — made the series read 374.55 → 0 → 14.55: back
// UP, and never reaching zero. Walking capital down in date order instead
// is what makes this monotonic. This check fails against that earlier
// implementation.
check("...and never increases along the way, even with its overpayment re-dated before the payment it belongs to",
  tescoTrend.points.every((p, i) => i === 0 || p.balance <= tescoTrend.points[i - 1].balance), true)
check('it has a recurring overpayment configured', !!tesco.recurringOverpayment, true)
const tescoScheduleDates = new Set(buildLoanSchedule(tesco).map((e) => e.date))
const offScheduleDates = tescoTrend.points.slice(1).filter((p) => !tescoScheduleDates.has(p.dateIso))
check('its recurring overpayment contributes x points on its OWN real dates, off the loan\'s schedule', offScheduleDates.length > 0, true)

// ── One-off overpayments reach the loan's OWN ledger ──────────────────
//
// BUGFIX (Adam-reported, 2026-09-18): "one off overpayments aren't
// included in the loans ledger, it comes out of my personal card ledger
// fine, but I don't see the same mirrored +amount in the loans ledger.
// Recurring payments are fine, just missing one off overpayments."
//
// Mum's backup carries the real fixture: a £40 overpayment on Home
// Improvements, dated 2025-02-22, stored with sourceType
// 'loan_overpayment' and sourceId 'diX5btfJ' — the OVERPAYMENT's id, not
// the loan's. Every check below fails against the pre-fix code, which
// filtered on `t.sourceId === loan.id` alone.
console.log('\n── One-off overpayments reach the loan\'s own ledger (2026-09-18 bugfix) ──')

const overpayment = homeImprovements.overpayments![0]
check('the fixture is real: a £40 one-off overpayment on Home Improvements', { date: overpayment.date, amount: overpayment.amount }, { date: '2025-02-22', amount: 40 })
const storedOverpaymentTx = mum.transactions.find((t) => t.sourceType === 'loan_overpayment' && t.sourceId === overpayment.id)!
check('...stored with the OVERPAYMENT\'s id as sourceId, not the loan\'s — the whole cause', { sourceId: storedOverpaymentTx.sourceId, loanId: homeImprovements.id }, { sourceId: 'diX5btfJ', loanId: 'jbgh-CKK' })

// A window wide enough to contain 2025-02-22.
const opStart = new Date(2025, 1, 1)
const opEnd = new Date(2025, 2, 31)
const opRows = loanPaymentTransactions(homeImprovements, mum.transactions, opStart, opEnd)
check('the overpayment now appears on the loan\'s own ledger', opRows.some((t) => t.sourceId === overpayment.id), true)
check('...exactly once, not duplicated by a generated counterpart', opRows.filter((t) => t.sourceId === overpayment.id).length, 1)
// Guarded rather than `!`-asserted: against the pre-fix code the row is
// absent, and a regression should report a failure here, not crash the
// sweep on an undefined.
const opRow = opRows.find((t) => t.sourceId === overpayment.id)
check('...reading POSITIVE, the mirrored +amount Adam expected', opRow ? loanSignedAmount(opRow) : 'row missing', 40)

// The other half of the fix: one loan must never absorb another's
// overpayment. Car Finance has none of its own, and its ledger must stay
// empty of Home Improvements'.
const carRows = loanPaymentTransactions(carFinance, mum.transactions, opStart, opEnd)
check('Car Finance has no overpayments of its own', (carFinance.overpayments ?? []).length, 0)
check('...and does NOT absorb Home Improvements\' one', carRows.some((t) => t.sourceId === overpayment.id), false)

// It must also reach the CYCLE SECTIONS, which is where the ledger's
// totals come from — appearing in the rows but not the total would be the
// same bug one layer up.
// 2025-02-25 sits inside the loan's own 2025-02-07..2025-03-14 period,
// which is the one containing the overpayment — the loan's due day is the
// 14th, so an "as of mid-March" window would already be the NEXT period.
const opSections = buildLoanCycleSections(homeImprovements, mum.transactions, loanCyclePeriods(homeImprovements, new Date(2025, 1, 25), 2))
const opSection = opSections.find((s) => s.rows.some((t) => t.sourceId === overpayment.id))
check('it lands in a cycle section too', !!opSection, true)
check('...inside that section\'s own window', !!opSection && opSection.startIso <= '2025-02-22' && opSection.endIso >= '2025-02-22', true)
check('...and is counted in that section\'s total', !!opSection && opSection.total >= 40, true)

// The reason it was invisible for so long: every OTHER surface reads
// loan.overpayments through buildLoanSchedule, so the loan looked right
// everywhere except the one place the payment should have been listed.
const opInTrend = buildLoanTrendEvents(homeImprovements).filter((e) => e.kind === 'one_off_overpayment')
check('the trend chart always had it (which is why only the ledger looked wrong)', opInTrend.length, 1)

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll loan-card checks passed.')
process.exitCode = failures ? 1 : 0
