// PROMPT-13 Part A2 — the acceptance gate for the legend table that sits
// above each RAG ring: its rows, its balances, its single delta and its
// `%` column.
//
// WHAT FAILS AGAINST THE PRE-CHANGE CODE: the legend did not exist in any
// form — `ragProgress`/`loansRagProgress`/`loanEntryRagProgress` are new
// in `src/lib/progressSection.ts` — so this script dies on the import
// against PROMPT-12's tree. The checks that discriminate against a
// plausible WRONG implementation:
//
//  - THE PROJECTED BALANCE IS CUMULATIVE (£5,500), NOT THE INCREMENT
//    (£1,500). This is the exact mirror of the segment trap in
//    verify-rag-progress-segments.ts, and an implementation that gets
//    the arc right by taking the increment will very plausibly carry the
//    same increment into the table. Adam's worked example pins it.
//  - THE `%` COLUMN IS EACH ROW'S OWN BALANCE OVER THE TOTAL, AND DOES
//    NOT SUM TO 100 (§0 Q1, answered 2026-09-20). It reads 40 / 55 / 45,
//    summing to 140 on purpose. The wrong implementation is the segment
//    sizes (40 / 15 / 45), which look more "correct" precisely because
//    they sum to 100 — so this is asserted both by value and by the sum.
//  - ONLY THE AMBER ROW CARRIES A DELTA (§0 Q2, answered 2026-09-20).
//    Adam chose the non-recommended option: green and red BOTH read `—`.
//    `−£1,500` on the red row is the plausible wrong implementation (it
//    is what this prompt doc's own first draft said), so red's delta
//    being absent is checked explicitly rather than incidentally.
//  - THE RED BALANCE IS REMAINING-AFTER-PROJECTION, NOT REMAINING-NOW.
//    £4,500 (10,000 − 5,500), not £6,000 (10,000 − 4,000). An
//    implementation reading `amortisedRemaining` straight off today's
//    summary gets £6,000 and still produces a plausible-looking table.
//  - THIS CYCLE DROPS THE PROJECTED ROW ENTIRELY and red reverts to
//    £6,000 / 60% — not a projected row showing `—`, and not a red row
//    stuck on the three-cycle figure.
//  - Run against BOTH real backups' loans as well as the synthetic case,
//    per the prompt doc, with every assertion there stated as a RELATION
//    (the table against the summary that fed it) rather than a hard-coded
//    number, so it does not rot as real time passes.

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
const HORIZON_END = new Date(2026, 11, 18)

const row = (r: ReturnType<typeof ragProgress>, kind: 'paid' | 'projected' | 'remaining') => r.rows.find((x) => x.kind === kind)

// ── Adam's worked example, verbatim from PROMPT-13 A2 ───────────────────
//
//   ■  Paid         £4,000        —        40%
//   ■  Projected    £5,500     +£1,500     55%
//   ■  Remaining    £4,500        —        45%
//
console.log('\n── A2: Adam’s worked example reproduces exactly (next 3 cycles) ──')
const worked = ragProgress({ total: 10000, paid: 4000, projectedPaid: 5500, showProjection: true })

check('three rows, top to bottom: Paid, Projected, Remaining', worked.rows.map((r) => r.kind), ['paid', 'projected', 'remaining'])
check('Paid balance', round2(row(worked, 'paid')!.balance), 4000)
// THE discriminating check: £5,500 cumulative, not the £1,500 increment
// the amber ARC is drawn from. See the header.
check('Projected balance is CUMULATIVE, not the increment', round2(row(worked, 'projected')!.balance), 5500)
// £4,500 = 10,000 − 5,500. £6,000 would mean red ignored the projection.
check('Remaining balance is what is left AFTER the projection', round2(row(worked, 'remaining')!.balance), 4500)

console.log('\n── A2: the delta column (§0 Q2 — only amber carries one) ──')
check('Paid has no delta', row(worked, 'paid')!.delta, undefined)
check('Projected delta is the increment', round2(row(worked, 'projected')!.delta!), 1500)
// Explicitly, not incidentally: −1500 here is the plausible wrong answer.
check('Remaining has no delta — NOT −£1,500', row(worked, 'remaining')!.delta, undefined)
check('exactly one row in the whole table carries a delta', worked.rows.filter((r) => r.delta !== undefined).length, 1)

console.log('\n── A2: the % column (§0 Q1 — each row’s own balance over the total) ──')
check('Paid %', round2(row(worked, 'paid')!.percent), 40)
// 55, not 15. The segment is 15; the table is not the segment sizes.
check('Projected % matches its own balance (55, not the 15 the arc draws)', round2(row(worked, 'projected')!.percent), 55)
check('Remaining %', round2(row(worked, 'remaining')!.percent), 45)
check('the column sums to 140, deliberately — it is NOT a share of the ring', round2(worked.rows.reduce((s, r) => s + r.percent, 0)), 140)
checkTrue('every row’s % is its own balance / total', worked.rows.every((r) => Math.abs(r.percent - (r.balance / 10000) * 100) < 0.001))

console.log('\n── A2: the this-cycle variant ──')
const thisCycle = ragProgress({ total: 10000, paid: 4000, projectedPaid: 5500, showProjection: false })
// Dropped entirely — not present-but-blank.
check('the Projected row is dropped entirely', thisCycle.rows.map((r) => r.kind), ['paid', 'remaining'])
check('Paid is unchanged: £4,000 / 40%', [round2(thisCycle.rows[0].balance), round2(thisCycle.rows[0].percent)], [4000, 40])
// £6,000 / 60%, not the £4,500 / 45% of the three-cycle view.
check('Remaining reverts to £6,000 / 60%', [round2(thisCycle.rows[1].balance), round2(thisCycle.rows[1].percent)], [6000, 60])
check('no deltas at all this cycle', thisCycle.rows.filter((r) => r.delta !== undefined).length, 0)
check('this cycle’s % column sums to 100 (only because there are two rows)', round2(thisCycle.rows.reduce((s, r) => s + r.percent, 0)), 100)

console.log('\n── A2: edge cases ──')
const zero = ragProgress({ total: 10000, paid: 0, showProjection: false })
check('a 0%-paid loan reads £0 / 0% and £10,000 / 100%', zero.rows.map((r) => [round2(r.balance), round2(r.percent)]), [[0, 0], [10000, 100]])
const settled = ragProgress({ total: 10000, paid: 10000, showProjection: false })
check('a settled loan reads £10,000 / 100% and £0 / 0%', settled.rows.map((r) => [round2(r.balance), round2(r.percent)]), [[10000, 100], [0, 0]])
const overpaid = ragProgress({ total: 10000, paid: 10500, showProjection: false })
check('paid beyond the total never shows a negative remaining balance', round2(row(overpaid, 'remaining')!.balance), 0)
const noTotal = ragProgress({ total: 0, paid: 0, showProjection: false })
check('a zero-total loan does not divide by zero in the % column', noTotal.rows.map((r) => round2(r.percent)), [0, 0])

// ── The real backups ────────────────────────────────────────────────────
console.log('\n── A2: against the real backups’ loans ──')
for (const [name, data] of [['mum', mum], ['adam', adam]] as const) {
  const loans = data.loans.filter((l) => l.active !== false)
  if (loans.length === 0) {
    console.log(`  · ${name}: no active loans, skipped`)
    continue
  }
  const summary = summarizeLoansProgress(loans, HORIZON_END)
  const combined = loansRagProgress(summary, true)
  const total = summary.totalAmortisedPayable

  // The table against the summary that fed it — relations, not literals.
  checkTrue(`${name}: Paid balance === summary.totalPaid`, Math.abs(row(combined, 'paid')!.balance - summary.totalPaid) < 0.01)
  checkTrue(`${name}: Projected balance === summary.projectedPaid (cumulative)`, Math.abs(row(combined, 'projected')!.balance - (summary.projectedPaid ?? 0)) < 0.01)
  checkTrue(`${name}: Remaining balance === total − projected paid`, Math.abs(row(combined, 'remaining')!.balance - Math.max(0, total - (summary.projectedPaid ?? 0))) < 0.01)
  checkTrue(`${name}: Paid + Remaining balances === the total, once projection is counted`, Math.abs(row(combined, 'projected')!.balance + row(combined, 'remaining')!.balance - total) < 0.01)
  checkTrue(`${name}: every % is its own balance over the amortised total`, combined.rows.every((r) => Math.abs(r.percent - (total > 0 ? (r.balance / total) * 100 : 0)) < 0.001))
  check(`${name}: only the projected row has a delta`, combined.rows.filter((r) => r.delta !== undefined).map((r) => r.kind), ['projected'])
  checkTrue(`${name}: the delta is projected − paid`, Math.abs(row(combined, 'projected')!.delta! - (row(combined, 'projected')!.balance - row(combined, 'paid')!.balance)) < 0.01)

  const currentOnly = loansRagProgress(summary, false)
  check(`${name}: this cycle drops the projected row`, currentOnly.rows.map((r) => r.kind), ['paid', 'remaining'])
  checkTrue(`${name}: this cycle's remaining === total − paid`, Math.abs(row(currentOnly, 'remaining')!.balance - Math.max(0, total - summary.totalPaid)) < 0.01)
  checkTrue(`${name}: this cycle's two balances sum to the total`, Math.abs(row(currentOnly, 'paid')!.balance + row(currentOnly, 'remaining')!.balance - total) < 0.01)

  // A2: "Build the rows in that file, not in Home.tsx" — a per-loan
  // legend must come out of the same helper, per §0b Q4 (one legend above
  // EVERY ring, not just the combined one).
  for (const entry of summary.perLoan) {
    const perLoan = loanEntryRagProgress(entry, true)
    const loanTotal = entry.progress.amortisedTotalPayable
    check(`${name}: "${entry.loan.name}" has all three rows`, perLoan.rows.map((r) => r.kind), ['paid', 'projected', 'remaining'])
    checkTrue(`${name}: "${entry.loan.name}" Paid balance === its own totalPaid`, Math.abs(row(perLoan, 'paid')!.balance - entry.progress.totalPaid) < 0.01)
    checkTrue(
      `${name}: "${entry.loan.name}" Projected balance === its own projected totalPaid`,
      Math.abs(row(perLoan, 'projected')!.balance - (entry.projected?.totalPaid ?? entry.progress.totalPaid)) < 0.01,
    )
    checkTrue(`${name}: "${entry.loan.name}" balances close against its own total`, Math.abs(row(perLoan, 'projected')!.balance + row(perLoan, 'remaining')!.balance - loanTotal) < 0.01)
    check(`${name}: "${entry.loan.name}" only amber carries a delta`, perLoan.rows.filter((r) => r.delta !== undefined).map((r) => r.kind), ['projected'])
  }
}

console.log(failures === 0 ? '\n✅ All RAG legend checks passed\n' : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
