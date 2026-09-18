// PROMPT-08b Part 1 — the acceptance gate for the progress section: its
// titles, when it renders at all, and the geometry of the progress bar
// that replaced the collapsed "Progress chart" header.
//
// WHAT FAILS AGAINST THE PRE-CHANGE CODE: `src/lib/progressSection.ts`
// did not exist, so this script does not even import against 08a's tree
// (proven by running it on the parent commit — it dies on the import).
// Beyond that bare existence, the checks that would fail against a WRONG
// implementation are called out individually below. In particular:
//
//  - the combined percentage must be summed CASH over summed BALANCE, not
//    a mean of the per-loan percentages. Mum's two loans are different
//    enough in size that the two answers differ by several points, so
//    `combined is not the mean` below genuinely discriminates.
//  - the faded projected segment must be the GAIN, not the cumulative
//    figure, or it would be drawn overlapping the solid fill (the exact
//    cumulative-segment rule ProgressRing.tsx already follows).
//  - the credit-card visibility rule must be an OR over both balances:
//    an implementation checking only today's balance hides a card that is
//    clear now but owes money by the horizon end.

import { readFileSync } from 'node:fs'
import {
  progressSectionTitle,
  isCreditCardProgressVisible,
  progressBarGeometry,
  progressTooltipLayout,
  summarizeLoansProgress,
  PROGRESS_BAR_MARKERS,
} from '../src/lib/progressSection'
import { summarizeLoanProgress } from '../src/lib/ledgerLoans'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import type { AppDataV2 } from '../src/types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100
let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger'
function load(file: string): AppDataV2 {
  const raw = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'))
  return migrateLedgerData(raw.data ?? raw)
}
const mum = load('finance-ledger-backup-2026-09-17-mum.json')
const adam = load('finance-ledger-backup-2026-09-15.json')

// `summarizeLoanProgress` reads "today" for the current figure, so the
// absolute cash amounts move as real time passes. Every assertion below
// is therefore a RELATION (combined vs the ring's own sums, projected vs
// current, combined vs the mean) rather than a hard-coded number — the
// same discrimination, without a check that rots next month. The horizon
// end is pinned because it is an input, not an observation.
const HORIZON_END = new Date(2026, 11, 18) // ~3 cycles on from 2026-09-18

console.log('\n── Section titles ──')

check('a loan hero card names the loan', progressSectionTitle('loan', 'Home Improvements'), 'Home Improvements loan progress')
check('Personal/Joint/Household are static', progressSectionTitle('combined_loans'), 'Combined loan progress')
check('...and ignore any name handed to them', progressSectionTitle('combined_loans', 'Joint'), 'Combined loan progress')
check('a credit card names the card', progressSectionTitle('credit_card', 'Santander'), 'Santander credit progress')
check('a savings pot names the pot', progressSectionTitle('savings_pot', 'Emergency Fund'), 'Emergency Fund savings progress')
// Every title ends in "progress" — the property that makes them read as
// one family rather than four unrelated headings.
check(
  'every title ends in "progress"',
  (['loan', 'combined_loans', 'credit_card', 'savings_pot'] as const).every((k) => progressSectionTitle(k, 'X').endsWith(' progress')),
  true,
)

console.log('\n── Credit card visibility (Adam: "only visible when there is balance on the card") ──')

check('nothing owed now, nothing owed by the horizon end → hidden', isCreditCardProgressVisible(0, 0), false)
check('owed today → visible', isCreditCardProgressVisible(412.5, 0), true)
// The discriminating case: a card cleared today that goes back into debt
// inside the horizon. An implementation testing only today's balance
// returns false here.
check('clear today but owing by the horizon end → visible', isCreditCardProgressVisible(0, 180), true)
check('both non-zero → visible', isCreditCardProgressVisible(412.5, 180), true)
// Overpaid: a credit balance is not "balance on the card" to pay off.
check('an overpaid (negative) card is still hidden', isCreditCardProgressVisible(-25, -25), false)

console.log('\n── Progress bar geometry ──')

check('markers are 25/50/75', [...PROGRESS_BAR_MARKERS], [25, 50, 75])

const plain = progressBarGeometry(42.7)
check('no projection: solid fill only', { fill: round2(plain.fillPercent), projected: plain.projectedPercent }, { fill: 42.7, projected: 0 })
check('the data label is a whole number, not a float', plain.labelPercent, 43)
check('no projection → no projected label', plain.projectedLabelPercent, undefined)

// The faded segment is the GAIN (58.2 - 42.7), not the cumulative 58.2 —
// an implementation returning the cumulative figure draws the faded arc
// straight over the solid one.
const projecting = progressBarGeometry(42.7, 58.2)
check('projected segment is the gain, not the cumulative figure', round2(projecting.projectedPercent), 15.5)
check('...and the solid fill is untouched by it', round2(projecting.fillPercent), 42.7)
check('both labels are whole numbers', { now: projecting.labelPercent, projected: projecting.projectedLabelPercent }, { now: 43, projected: 58 })

check('a projection below the current figure collapses to zero width, never negative', progressBarGeometry(60, 55).projectedPercent, 0)
check('a projection that rounds to the same percent shows no arrow', progressBarGeometry(42.1, 42.4).projectedLabelPercent, undefined)
check('over 100% is clamped', progressBarGeometry(140, 180), { fillPercent: 100, projectedPercent: 0, labelPercent: 100, projectedLabelPercent: undefined })
check('below 0 is clamped', progressBarGeometry(-10).fillPercent, 0)

console.log('\n── The mini-tooltip above the bar (Adam: "the down arrow must exactly hit the end of the filled line") ──')

// THE anti-drift property, and the reason this layout is computed in
// percentages rather than pixels: the arrow's x IS the fill's x. An
// implementation that measured the box in pixels and offset from it would
// fail this at some widths and pass at others.
const single = progressTooltipLayout(progressBarGeometry(42.7))
check('this cycle: one arrow', single.arrowPercents.length, 1)
check('...and it sits exactly on the end of the fill', single.arrowPercents[0], progressBarGeometry(42.7).fillPercent)
check('...with the box centred on it', single.centerPercent, single.arrowPercents[0])
check('...and no span to stretch over', single.spanPercent, 0)

const dual = progressTooltipLayout(progressBarGeometry(25, 32))
check('next 3 cycles: two arrows', dual.arrowPercents.length, 2)
check('...the first on today\'s fill, the second on the end of the projection', dual.arrowPercents, [25, 32])
check('...the box centred BETWEEN them', dual.centerPercent, 28.5)
check('...and stretched to cover the gap', dual.spanPercent, 7)
// Equidistance is a consequence of those two, and is what Adam asked for
// ("The arrows always need to be the same distance from the end of the
// tooltip box"): centre − first must equal last − centre, at any values.
check(
  'each arrow is the same distance from the box centre, so the same distance from its end',
  round2(dual.centerPercent - dual.arrowPercents[0]) === round2(dual.arrowPercents[1] - dual.centerPercent),
  true,
)

// A projection too small to change the whole percent shows one arrow, not
// two stacked in the same place — the same rule that suppresses the
// "25-25% paid" label.
check('a projection that rounds to the same percent collapses to one arrow', progressTooltipLayout(progressBarGeometry(42.1, 42.4)).arrowPercents.length, 1)
check('a zero-width projection likewise', progressTooltipLayout(progressBarGeometry(60, 55)).arrowPercents.length, 1)

// The edge cases Adam called out: at 0% and 100% the BOX is clamped inside
// the bar's bounds, but the arrows never move off the fill's end — the
// layout keeps reporting the true x and the clamping happens in CSS.
check('at 0% the arrow is still at 0, not nudged inwards', progressTooltipLayout(progressBarGeometry(0)).arrowPercents, [0])
check('at 100% the arrow is still at 100', progressTooltipLayout(progressBarGeometry(100)).arrowPercents, [100])
check('a projection running to 100% still reports both true ends', progressTooltipLayout(progressBarGeometry(96, 100)).arrowPercents, [96, 100])
check('no arrow can ever fall outside the bar', [0, 12.5, 42.7, 99.9, 100, 140].every((p) => progressTooltipLayout(progressBarGeometry(p, p + 20)).arrowPercents.every((a) => a >= 0 && a <= 100)), true)

console.log('\n── Combined loan progress, against mum\'s real backup ──')

const mumLoans = mum.loans.filter((l) => l.location === 'personal' && l.ownerId === mum.primaryPersonId && l.active)
check('mum has two active personal loans to combine', mumLoans.map((l) => l.name).sort(), ['Car Finance', 'Home Improvements'])

const combined = summarizeLoansProgress(mumLoans)
check('one entry per loan, in the order given', combined.perLoan.map((e) => e.loan.name), mumLoans.map((l) => l.name))

// The bar and the ring must read the same number. These are the exact
// sums LoanProgressRingsSection computes for its "Total Loans" ring.
const ringPaid = round2(mumLoans.reduce((s, l) => s + summarizeLoanProgress(l).totalPaid, 0))
const ringBalance = round2(mumLoans.reduce((s, l) => s + summarizeLoanProgress(l).totalBalance, 0))
check('combined totals match the ring\'s own sums', { paid: round2(combined.totalPaid), balance: round2(combined.totalBalance) }, { paid: ringPaid, balance: ringBalance })
check('combined percent is summed cash over summed balance', round2(combined.percentPaid), round2((ringPaid / ringBalance) * 100))

// The discriminator: the mean of the two per-loan percentages is a
// DIFFERENT number, and a plausible-but-wrong implementation returns it.
const mean = round2(combined.perLoan.reduce((s, e) => s + e.percentPaid, 0) / combined.perLoan.length)
check('combined is NOT the mean of the per-loan percentages', round2(combined.percentPaid) !== mean, true)
console.log(`      (combined ${round2(combined.percentPaid)}% vs the mean ${mean}% — the two answers genuinely differ)`)

check('no horizon end → no projected figures at all', { pct: combined.projectedPercentPaid, paid: combined.projectedPaid }, { pct: undefined, paid: undefined })

const combinedProjected = summarizeLoansProgress(mumLoans, HORIZON_END)
check('a horizon end produces a projected percent', typeof combinedProjected.projectedPercentPaid, 'number')
check('projection is forwards: more paid by the horizon end than today', (combinedProjected.projectedPaid ?? 0) > combinedProjected.totalPaid, true)
check('...and so the projected percent is higher', (combinedProjected.projectedPercentPaid ?? 0) > combinedProjected.percentPaid, true)
check('every per-loan entry gets its own projection too', combinedProjected.perLoan.every((e) => typeof e.projectedPercentPaid === 'number'), true)
check(
  'remaining goes DOWN over the horizon while paid goes up',
  (combinedProjected.projectedNominalRemaining ?? Infinity) < combinedProjected.totalNominalRemaining,
  true,
)

// Fed straight into the bar, mum's real combined figures produce a
// sensible two-segment bar rather than anything degenerate.
const mumBar = progressBarGeometry(combinedProjected.percentPaid, combinedProjected.projectedPercentPaid)
check('mum\'s combined bar has both segments, and they fit inside 100%', mumBar.fillPercent + mumBar.projectedPercent <= 100 && mumBar.projectedPercent > 0, true)
console.log(`      (mum's combined bar: ${mumBar.labelPercent}% paid → ${mumBar.projectedLabelPercent}% projected)`)

console.log('\n── The empty case (Adam: "the section is hidden if there is nothing to show") ──')

// Adam's own backup is the real negative fixture, as in
// verify-loan-cards.ts: his only loan belongs to Ella, so his Personal
// card has no loans of its own to combine.
const adamLoans = adam.loans.filter((l) => l.location === 'personal' && l.ownerId === adam.primaryPersonId && l.active)
check('adam has no personal loans of his own (Ella owns the only one)', adamLoans.length, 0)
const empty = summarizeLoansProgress(adamLoans)
check('no loans → no entries, and no divide-by-zero', { entries: empty.perLoan.length, pct: empty.percentPaid, balance: empty.totalBalance }, { entries: 0, pct: 0, balance: 0 })
check('...so the caller has an unambiguous "nothing to show" signal', empty.perLoan.length === 0, true)

// A single-loan card (a loan's own hero card, loans={[loan]}) — the
// combined figure IS that loan's figure, which is why the hero card shows
// exactly one bar rather than a total plus an identical per-loan bar.
const one = summarizeLoansProgress([mumLoans[0]], HORIZON_END)
check('a single-loan card\'s combined figure equals that loan\'s own', round2(one.percentPaid), round2(one.perLoan[0].percentPaid))
check('...including its projection', round2(one.projectedPercentPaid ?? -1), round2(one.perLoan[0].projectedPercentPaid ?? -2))

console.log(failures === 0 ? '\nAll progress-section checks passed.' : `\n${failures} progress-section check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
