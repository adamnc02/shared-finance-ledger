// PROMPT-13 Part A1 — the acceptance gate for the loan pie chart's three
// RAG segments (green paid / amber projected / red remaining).
//
// WHAT FAILS AGAINST THE PRE-CHANGE CODE: `ragProgress`,
// `loansRagProgress` and `loanEntryRagProgress` did not exist in
// `src/lib/progressSection.ts`, so this script dies on the import against
// PROMPT-12's tree. That bare existence is the weakest check here; the
// ones below are chosen to discriminate against a plausible WRONG
// implementation, which is the point:
//
//  - AMBER IS THE INCREMENT, NEVER THE CUMULATIVE FIGURE. The single
//    likeliest bug is `projected.percent = projectedPaid / total`, i.e.
//    55% rather than the 15% gain, which draws the amber arc straight
//    over the green one. Today's two-segment `ProgressRing` already takes
//    the cumulative `projectedPercent` and converts it internally, so a
//    port that forwards the same number is exactly the mistake to expect.
//    Checked directly, and again via the sum below.
//  - THE THREE SEGMENTS SUM TO EXACTLY 100. A cumulative amber makes them
//    sum to 140 on Adam's own worked example, so this is a second,
//    independent trap for the same bug.
//  - AMBER IS ABSENT FOR `current_cycle` AND PRESENT FOR `three_cycles`.
//    A2 and A1 both hang off `showProjection`, and an implementation that
//    always emits three segments would look right on the home page's
//    default horizon and wrong nowhere until you switched it.
//  - THE SEGMENTS ARE NOT THE LEGEND'S `%` COLUMN (§0 Q1). The legend
//    reads 40/55/45; the segments read 40/15/45. An implementation that
//    reuses one for the other passes any check that only looks at green.
//  - CONTROL — today's two-segment output. Green is byte-for-byte the
//    `percentPaid` the pre-change ring drew, and green+amber is
//    byte-for-byte its cumulative `projectedPercent`. The RAG rewrite is
//    a re-expression of the same two numbers plus a derived third, and if
//    either control drifts the ring has silently changed meaning.
//  - Run against BOTH real backups' loans as well as the synthetic case,
//    because mum's Home Improvements carries a real overpayment (so the
//    amortised and contractual denominators genuinely differ) and Adam's
//    file has none.

import { readFileSync } from 'node:fs'
import { ragProgress, loansRagProgress, loanEntryRagProgress, summarizeLoansProgress } from '../src/lib/progressSection'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import type { AppDataV2 } from '../src/types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100
let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}
function checkTrue(label: string, actual: boolean) {
  console.log(`  ${actual ? '✓' : '✗'} ${label}`)
  if (!actual) failures++
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger'
function load(file: string): AppDataV2 {
  const raw = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'))
  return migrateLedgerData(raw.data ?? raw)
}
const mum = load('finance-ledger-backup-2026-09-17-mum.json')
const adam = load('finance-ledger-backup-2026-09-15.json')
const HORIZON_END = new Date(2026, 11, 18) // ~3 cycles on from 2026-09-18

const seg = (r: ReturnType<typeof ragProgress>, kind: 'paid' | 'projected' | 'remaining') => r.segments.find((s) => s.kind === kind)

// ── Adam's own worked example (PROMPT-13 A2) ────────────────────────────
// £10,000 loan, £4,000 paid, £500/month over the next 3 cycles.
console.log('\n── A1: Adam’s worked example, next 3 cycles ──')
const worked = ragProgress({ total: 10000, paid: 4000, projectedPaid: 5500, showProjection: true })

check('green is the paid share', round2(seg(worked, 'paid')!.percent), 40)
// THE discriminating check: 15, not 55. See the header.
check('amber is the INCREMENT, not the cumulative figure', round2(seg(worked, 'projected')!.percent), 15)
check('red is what is left after the horizon', round2(seg(worked, 'remaining')!.percent), 45)
check('three segments, in ring order', worked.segments.map((s) => s.kind), ['paid', 'projected', 'remaining'])
check('the segments sum to exactly 100', round2(worked.segments.reduce((s, x) => s + x.percent, 0)), 100)

console.log('\n── A1: the same loan, this cycle ──')
const thisCycle = ragProgress({ total: 10000, paid: 4000, projectedPaid: 5500, showProjection: false })
check('two segments only', thisCycle.segments.map((s) => s.kind), ['paid', 'remaining'])
check('no amber segment at all', seg(thisCycle, 'projected'), undefined)
check('green is unchanged by dropping the horizon', round2(seg(thisCycle, 'paid')!.percent), 40)
// Red absorbs the amber: 45 + 15. An implementation that forgot to
// recompute red would leave 45 here and a ring summing to 85.
check('red absorbs what amber would have been', round2(seg(thisCycle, 'remaining')!.percent), 60)
check('the two segments still sum to exactly 100', round2(thisCycle.segments.reduce((s, x) => s + x.percent, 0)), 100)

console.log('\n── A1: showProjection gates amber, and nothing else does ──')
// `showProjection = horizon === 'three_cycles'` already exists (Home.tsx
// 404). Asserted rather than reimplemented, per the prompt doc.
const noProjectedFigure = ragProgress({ total: 10000, paid: 4000, showProjection: true })
check('showProjection with no projected figure yields no amber', seg(noProjectedFigure, 'projected'), undefined)
const projectedEqualsPaid = ragProgress({ total: 10000, paid: 4000, projectedPaid: 4000, showProjection: true })
check('a zero-gain projection yields no amber', seg(projectedEqualsPaid, 'projected'), undefined)
// A projection that somehow came back LOWER than today's paid figure must
// clamp to zero gain, never a negative arc (which SVG draws as a gap).
const projectedBelowPaid = ragProgress({ total: 10000, paid: 4000, projectedPaid: 3000, showProjection: true })
check('a backwards projection never yields a negative amber', seg(projectedBelowPaid, 'projected'), undefined)
check('...and red is unaffected by it', round2(seg(projectedBelowPaid, 'remaining')!.percent), 60)

console.log('\n── A1: edge cases the ring has to survive ──')
const zero = ragProgress({ total: 10000, paid: 0, showProjection: false })
check('a 0%-paid loan is all red', [round2(seg(zero, 'paid')!.percent), round2(seg(zero, 'remaining')!.percent)], [0, 100])
const settled = ragProgress({ total: 10000, paid: 10000, showProjection: false })
check('a settled loan is all green', [round2(seg(settled, 'paid')!.percent), round2(seg(settled, 'remaining')!.percent)], [100, 0])
const overpaidPastTotal = ragProgress({ total: 10000, paid: 10500, showProjection: false })
check('paid beyond the total clamps at 100/0, never a negative red', [round2(seg(overpaidPastTotal, 'paid')!.percent), round2(seg(overpaidPastTotal, 'remaining')!.percent)], [100, 0])
const projectedPastTotal = ragProgress({ total: 10000, paid: 9000, projectedPaid: 12000, showProjection: true })
check('a projection past the total clamps amber so the ring still sums to 100', round2(projectedPastTotal.segments.reduce((s, x) => s + x.percent, 0)), 100)
check('...and red is exactly zero, not negative', round2(seg(projectedPastTotal, 'remaining')!.percent), 0)
const noTotal = ragProgress({ total: 0, paid: 0, showProjection: false })
check('a zero-total loan does not divide by zero', [round2(seg(noTotal, 'paid')!.percent), round2(seg(noTotal, 'remaining')!.percent)], [0, 100])

// ── The real backups ────────────────────────────────────────────────────
console.log('\n── A1: against the real backups’ loans ──')
for (const [name, data] of [['mum', mum], ['adam', adam]] as const) {
  const loans = data.loans.filter((l) => l.active !== false)
  if (loans.length === 0) {
    console.log(`  · ${name}: no active loans, skipped`)
    continue
  }
  const summary = summarizeLoansProgress(loans, HORIZON_END)
  const combined = loansRagProgress(summary, true)
  checkTrue(`${name}: combined segments sum to 100`, Math.abs(combined.segments.reduce((s, x) => s + x.percent, 0) - 100) < 0.001)

  // CONTROL — the pre-change ring's own two numbers, unchanged.
  checkTrue(`${name}: CONTROL green === the old ring's percentPaid`, Math.abs(seg(combined, 'paid')!.percent - summary.percentPaid) < 0.001)
  const amber = seg(combined, 'projected')?.percent ?? 0
  checkTrue(
    `${name}: CONTROL green+amber === the old ring's cumulative projectedPercent`,
    Math.abs(seg(combined, 'paid')!.percent + amber - (summary.projectedPercentPaid ?? summary.percentPaid)) < 0.001,
  )
  // The same trap as the worked example, now on real data with a real
  // overpayment in mum's file: amber must be the gain.
  checkTrue(`${name}: amber is smaller than the cumulative projected figure`, amber < (summary.projectedPercentPaid ?? 0) || amber === 0)

  const currentOnly = loansRagProgress(summary, false)
  check(`${name}: this cycle drops amber`, currentOnly.segments.map((s) => s.kind), ['paid', 'remaining'])
  checkTrue(`${name}: this cycle still sums to 100`, Math.abs(currentOnly.segments.reduce((s, x) => s + x.percent, 0) - 100) < 0.001)
  checkTrue(`${name}: green is identical with and without the horizon`, Math.abs(seg(currentOnly, 'paid')!.percent - seg(combined, 'paid')!.percent) < 0.001)

  for (const entry of summary.perLoan) {
    const perLoan = loanEntryRagProgress(entry, true)
    checkTrue(`${name}: "${entry.loan.name}" segments sum to 100`, Math.abs(perLoan.segments.reduce((s, x) => s + x.percent, 0) - 100) < 0.001)
    checkTrue(`${name}: "${entry.loan.name}" CONTROL green === that loan's own percentPaid`, Math.abs(seg(perLoan, 'paid')!.percent - entry.percentPaid) < 0.001)
    const perAmber = seg(perLoan, 'projected')?.percent ?? 0
    checkTrue(
      `${name}: "${entry.loan.name}" CONTROL green+amber === its cumulative projected percent`,
      Math.abs(seg(perLoan, 'paid')!.percent + perAmber - (entry.projectedPercentPaid ?? entry.percentPaid)) < 0.001,
    )
  }
}

// ── The segments are NOT the legend's % column ──────────────────────────
// §0 Q1 settled the legend on "% matches its own balance", which is a
// DIFFERENT set of numbers from the arc sizes. An implementation that
// computes one and reuses it for the other passes every check above.
console.log('\n── A1/A2: the segments and the legend’s % column are different numbers ──')
const both = ragProgress({ total: 10000, paid: 4000, projectedPaid: 5500, showProjection: true })
check('segments read 40 / 15 / 45', both.segments.map((s) => round2(s.percent)), [40, 15, 45])
check('the legend reads 40 / 55 / 45', both.rows.map((r) => round2(r.percent)), [40, 55, 45])
checkTrue('the two genuinely differ on the projected row', round2(seg(both, 'projected')!.percent) !== round2(both.rows[1].percent))

console.log(failures === 0 ? '\n✅ All RAG segment checks passed\n' : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
