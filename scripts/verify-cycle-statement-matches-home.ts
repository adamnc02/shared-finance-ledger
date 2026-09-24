// The statement and the Home page must agree, row for row and figure for
// figure, about the same window.
//
// This is the "statement matches Home" check, and the reason the statement is a
// serialiser rather than a second engine: a statement that disagrees with
// the Home screen is worse than no statement at all — it is two numbers,
// both claiming to be the balance, with nothing on either screen to say
// which is wrong.
//
// What it does: builds the statement over exactly the window the Home
// page's "Next 3 cycles" pill covers, then rebuilds what Home itself
// renders — the same engine call, the same salary-first order, the same
// opening-balance-then-fold-forward shape DateOrderedList uses — and
// compares every row.
//
// 🚨 THE CONTROL IS AT THE BOTTOM. A comparison that can only pass proves
// nothing, so the last section deliberately breaks a row and asserts this
// file notices.

import { statementFixture, ASOF } from './statementFixture'
import { buildStatementPayload } from '../src/lib/statement'
import { computeProjection, horizonCycles } from '../src/lib/projection'
import { computeJointAccountProjection, jointAccountSignedAmount } from '../src/lib/jointAccountLedger'
import { isLedgerTransaction, signedAmount } from '../src/lib/runningBalance'
import { compareByDateSalaryFirst } from '../src/lib/cycleSummary'
import { summarizeLoan } from '../src/lib/ledgerLoans'
import { toLocalIsoDate as iso, parseLocalDate } from '../src/lib/date'
import type { Transaction } from '../src/types/ledger'

let passed = 0
let failed = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed++
    console.log(`✓ ${label}`)
  } else {
    failed++
    console.error(`✗ FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  }
}
const assert = (label: string, condition: boolean) => check(label, condition, true)
const round2 = (n: number) => Math.round(n * 100) / 100

const data = statementFixture()
const personId = data.primaryPersonId
const payCycle = data.payCycles.find((pc) => pc.personId === personId)!

// The window the Home page's own "Next 3 cycles" pill covers. Using the
// app's own horizon — never a hand-written date pair — is what makes the
// two sides comparable at all.
const cycles = horizonCycles(data, personId, 'three_cycles', ASOF)
const windowStart = iso(cycles[0].start)
const windowEnd = iso(cycles[cycles.length - 1].end)

const payload = buildStatementPayload(data, { selectedStart: windowStart, selectedEnd: windowEnd, asOfDate: ASOF })

console.log(`\nWindow: ${windowStart} → ${windowEnd} (${cycles.length} cycles)\n`)

// ── The window itself ──────────────────────────────────────────────────
check('the statement spans exactly the cycles the Home horizon does', [payload.meta.fullRangeStart, payload.meta.fullRangeEnd], [windowStart, windowEnd])
check('one payload cycle per Home cycle', payload.meta.cycles.length, cycles.length)
check('each cycle key carries the cycle\'s own start as its sort key', payload.meta.cycles.map((c) => c.start), cycles.map((c) => iso(c.start)))

// ── The deck ───────────────────────────────────────────────────────────
// Household is the one deliberate exclusion (the one deliberate exclusion from "one section per deck card"). Everything else the
// Home page swipes through must have a section.
assert('no Household section', !payload.cards.some((c) => c.kind === 'household'))
assert('the Personal card is present', payload.cards.some((c) => c.id === 'personal'))
assert('the Joint card is present', payload.cards.some((c) => c.id === 'joint'))
assert('every loan and card the fixture defines has a section', payload.cards.filter((c) => c.kind === 'loan').length === data.loans.length && payload.cards.filter((c) => c.kind === 'credit_card').length === data.creditCards.length)

/**
 * What Home actually renders: the projection's ledger rows, ordered
 * salary-first, folded forward from the projection's opening balance,
 * then trimmed to the cycle window. Exactly DateOrderedList's shape.
 */
function homeRows(all: Transaction[], opening: number, sign: (t: Transaction) => number) {
  const ordered = all.slice().sort(compareByDateSalaryFirst)
  let running = opening
  const withRunning = ordered.map((t) => {
    running = round2(running + sign(t))
    return { t, running }
  })
  return withRunning.filter(({ t }) => t.date >= windowStart && t.date <= windowEnd)
}

// ── Personal ───────────────────────────────────────────────────────────
{
  const projection = computeProjection(data, personId, payCycle, 'three_cycles', ASOF)
  const home = homeRows(projection.transactions.filter(isLedgerTransaction), projection.openingBalance, signedAmount)
  const card = payload.cards.find((c) => c.id === 'personal')!

  check('Personal: same number of rows as the Home card', card.rows.length, home.length)
  check('Personal: same rows, in the same order', card.rows.map((r) => `${r.date}|${r.description}`), home.map(({ t }) => `${t.date}|${t.note || data.categories.find((c) => c.id === t.categoryId)?.name || t.type}`))
  check('Personal: every running balance is identical', card.rows.map((r) => r.balance), home.map((h) => h.running))
  check('Personal: every amount is identical', card.rows.map((r) => r.amount), home.map(({ t }) => round2(signedAmount(t))))
  // The figure Home prints in its own caption.
  check('Personal: the last row\'s balance is the projected balance Home shows', card.rows[card.rows.length - 1].balance, round2(projection.projectedBalance))
  assert('Personal: salary sorts first within its own date (a bill above the salary that funds it would show a dip that never happens)', card.rows[0].kind === 'salary')
  assert('Personal: nothing is dated outside the window', card.rows.every((r) => r.date >= windowStart && r.date <= windowEnd))
}

// ── Joint ──────────────────────────────────────────────────────────────
{
  const projection = computeJointAccountProjection(data, 'three_cycles', ASOF)!
  const home = homeRows(projection.transactions, projection.openingBalance, jointAccountSignedAmount)
  const card = payload.cards.find((c) => c.id === 'joint')!

  check('Joint: same number of rows as the Home card', card.rows.length, home.length)
  check('Joint: every running balance is identical', card.rows.map((r) => r.balance), home.map((h) => h.running))
  check('Joint: the joint sign convention is used, not the personal one (a joint_deposit reads the opposite way)', card.rows.map((r) => r.amount), home.map(({ t }) => round2(jointAccountSignedAmount(t))))
}

// ── Loan ───────────────────────────────────────────────────────────────
// A loan is measured against the AMORTISATION ENGINE rather than against
// the Home card's transaction list, and deliberately so: an ad-hoc
// overpayment lives on the loan, not in `data.transactions`, so it has no
// transaction row at all. Folding the card's rows dropped £250 of capital
// in exactly this fixture (statement.ts's own note) — which is why the
// rows come from buildLoanLedgerRows and the closing figure has to match
// summarizeLoan.
{
  const loan = data.loans[0]
  const card = payload.cards.find((c) => c.kind === 'loan')!
  const last = card.rows[card.rows.length - 1]

  check('Loan: the opening figure is the engine\'s owed balance the day before the window', card.openingBalance, summarizeLoan(loan, parseLocalDate(windowStart)).remainingBalance)
  check('Loan: the closing figure is the engine\'s owed balance at the window\'s end', last.balance, summarizeLoan(loan, parseLocalDate(last.date)).remainingBalance)
  assert('Loan: every row carries its capital/interest split', card.rows.every((r) => r.capital !== null && r.interest !== null))
  assert('Loan: capital + interest equals the payment on every row', card.rows.every((r) => Math.abs(Math.abs(r.amount) - (r.capital! + r.interest!)) < 0.005))
  // 🚨 T1: folding the CASH amount overstates the debt by the whole
  // interest bill, and still looks plausible. This is the arithmetic that
  // catches it.
  const cashFold = round2(card.rows.reduce((owed, r) => owed - Math.abs(r.amount), card.openingBalance))
  const capitalFold = round2(card.rows.reduce((owed, r) => owed - r.capital!, card.openingBalance))
  check('Loan: the balance folds by CAPITAL, not by cash', last.balance, capitalFold)
  assert('Loan: and the cash fold genuinely differs, so the check above is not vacuous', Math.abs(cashFold - capitalFold) > 0.01)
  const overpayment = card.rows.find((r) => r.interest === 0)
  assert('Loan: an overpayment is 100% capital and zero interest', !!overpayment && overpayment.capital === Math.abs(overpayment.amount))
}

// ── Credit card ────────────────────────────────────────────────────────
{
  const card = payload.cards.find((c) => c.kind === 'credit_card')!
  assert('Card: the balance column is headed for a card, not a bank account', card.balanceLabel === 'Card balance')
  assert('Card: every row sits inside the window', card.rows.every((r) => r.date >= windowStart && r.date <= windowEnd))
}

// ── Trimming changes the view, never a figure (the file never computes a balance) ──────────────────
{
  // The same statement asked for a NARROWER selected window: the payload
  // still carries the whole cycles, and a row's balance is a fact about
  // that row, not about which window it is being looked at through.
  const narrow = buildStatementPayload(data, { selectedStart: '2026-09-18', selectedEnd: '2026-10-31', asOfDate: ASOF })
  const wide = payload.cards.find((c) => c.id === 'personal')!
  const narrowCard = narrow.cards.find((c) => c.id === 'personal')!
  assert('a narrower selection still carries the whole containing cycles', narrow.meta.fullRangeStart <= narrow.meta.selectedStart && narrow.meta.fullRangeEnd >= narrow.meta.selectedEnd)
  // Matched on what the row IS, not on its id: a row's id is its position
  // in its own card, and the two windows hold different numbers of rows.
  const mismatched = narrowCard.rows.filter((r) => {
    const same = wide.rows.find((w) => w.date === r.date && w.description === r.description && w.amount === r.amount)
    return !same || same.balance !== r.balance
  })
  check('every row\'s balance is identical in the narrow and wide payloads', mismatched.length, 0)
}

// ── 🚨 THE CONTROL ─────────────────────────────────────────────────────
// Everything above compares two things this file built. If the comparison
// could not fail, it would prove nothing — so break one figure and prove
// it is caught.
{
  const card = payload.cards.find((c) => c.id === 'personal')!
  const tampered = card.rows.map((r, i) => (i === 2 ? { ...r, balance: round2(r.balance + 0.01) } : r))
  const projection = computeProjection(data, personId, payCycle, 'three_cycles', ASOF)
  const home = homeRows(projection.transactions.filter(isLedgerTransaction), projection.openingBalance, signedAmount)
  const caught = JSON.stringify(tampered.map((r) => r.balance)) !== JSON.stringify(home.map((h) => h.running))
  assert('CONTROL: a single penny moved on one row makes this comparison fail', caught)
  assert('CONTROL: the untampered rows still match, so the control changed only what it meant to', JSON.stringify(card.rows.map((r) => r.balance)) === JSON.stringify(home.map((h) => h.running)))
}

console.log(`\n${passed} passed, ${failed} failed.`)
if (failed > 0) process.exit(1)
