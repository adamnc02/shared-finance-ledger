// PROMPT-01 Part B — the home page credit hero's ledger, which is the
// DOWNSTREAM CONSUMER of everything else (Adam's standing rule: "everything
// done in the other pages feeds the home page ledger"). A fix that looks
// right on Borrowing and wrong here is not finished.
//
// TWO DEFECTS, both fixed in Home.tsx's CreditCardHero:
//
// 1. The flat list (cycle-totals OFF) was built purely from
//    `data.transactions`, so it contained only MATERIALISED rows — a
//    pending minimum charge, the very row that will clear the balance,
//    could never appear. Adam: "the minimum 100% charge is not clearing
//    the ledger in the home page credit hero card's ledger."
//
// 2. It filtered by the HOUSEHOLD pay cycle (resolveCycleBounds /
//    horizonRangeEnd), violating the hard rule that a credit card uses its
//    OWN pay cycle windows (Adam, 2026-09-15). For mum's cards the
//    household window ends 2026-10-13 — one day before the card's own due
//    date of 2026-10-14 — so the upcoming charge was unreachable even in
//    principle. Both halves were required; neither alone is enough.
//
// The flat list is now derived by flattening the SAME
// buildCreditCardCycleSections output the cycle-totals-on path renders, so
// the two toggle states cannot disagree about the same card on the same
// data. This file asserts that equivalence directly — it is the property
// that was broken, not just the figures.
//
// NOTE ON DATES: the cycle periods are pinned here via asOf. Row STATUS
// (pending vs cleared) is derived inside buildCreditCardCycleSections from
// the real wall clock, so the status assertions below hold while today is
// on or before 2026-10-14 and are skipped after it, with the date-stable
// amount/date/closing-balance assertions still enforced.
import { readFileSync } from 'node:fs'
import { cardBalanceAsOf, creditCardCyclePeriods, buildCreditCardCycleSections } from '../src/lib/creditCards'
import { toLocalIsoDate as toIso } from '../src/lib/date'
import type { CreditCard, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const BACKUP = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15-mum.json'
const raw = JSON.parse(readFileSync(BACKUP, 'utf8'))
const txns: Transaction[] = raw.transactions
const cardOf = (id: string): CreditCard => {
  const c = (raw.creditCards as CreditCard[]).find((x) => x.id === id)!
  return { ...c, lumpPayments: c.lumpPayments ?? [] }
}
const asOf = new Date(2026, 8, 15)
const THREE_CYCLES_AHEAD = 3
const statusAssertable = toIso(new Date()) <= '2026-10-14'

// Mirrors Home.tsx CreditCardHero exactly: periods from the CARD's own
// cycles, sections built for both toggle states, flat list flattened from
// those same sections with the showCleared filter applied.
function heroLedger(card: CreditCard, horizon: 'this_cycle' | 'three_cycles', showCleared: boolean) {
  const cycles = creditCardCyclePeriods(card, asOf, horizon === 'three_cycles' ? 1 + THREE_CYCLES_AHEAD : 1)
  const sections = buildCreditCardCycleSections(card, txns, cycles)
  const flat = sections
    .flatMap((s) => s.rows)
    .filter((r) => showCleared || r.status !== 'cleared')
    .sort((a, b) => a.date.localeCompare(b.date))
  return { cycles, sections, flat }
}
const totalPaid = (cardId: string) =>
  Math.round(txns.filter((t) => t.creditCardId === cardId && t.type === 'credit_card_payment').reduce((s, t) => s + t.amount, 0) * 100) / 100

for (const [id, name, owed, paid] of [['lhF0fbR8', 'Santander', 91.24, 228.07], ['M2Ak3QNc', 'Natwest', 1400, 200]] as const) {
  console.log(`\n--- ${name}: headline figures ---`)
  const card = cardOf(id)
  check(`${name} "owed" headline`, cardBalanceAsOf(card, txns, asOf), owed)
  check(`${name} total paid`, totalPaid(id), paid)
}

// --- HARD RULE: the card's OWN periods, never the household pay cycle ---
// The household cycle runs 2026-09-14 → 2026-10-13, ending one day before
// the card's due date. The card's own period runs 2026-09-15 → 2026-10-14
// and includes it. This assertion is the hard rule itself.
console.log('\n--- the card\'s own periods (hard rule) ---')
const santanderCycles = heroLedger(cardOf('lhF0fbR8'), 'this_cycle', false).cycles
check('this cycle is the CARD\'s window 2026-09-15 → 2026-10-14', [toIso(santanderCycles[0].windowStart), toIso(santanderCycles[0].windowEnd)], ['2026-09-15', '2026-10-14'])
check('its due date is 2026-10-14 (NOT the household cycle\'s 2026-10-13)', toIso(santanderCycles[0].dueDate), '2026-10-14')
const threeCycles = heroLedger(cardOf('lhF0fbR8'), 'three_cycles', false).cycles
check('next 3 cycles run to 2027-01-14', toIso(threeCycles[threeCycles.length - 1].dueDate), '2027-01-14')

// --- Santander: cycle-end totals ON ---
console.log('\n--- Santander: cycle totals ON ---')
const sThis = heroLedger(cardOf('lhF0fbR8'), 'this_cycle', false)
check('this cycle balance due is £91.24', sThis.sections[0].closingBalance, 91.24)
check('this cycle rows: the 14 Oct charge for £91.24', sThis.sections[0].rows.map((r) => `${r.date}/${r.amount}`), ['2026-10-14/91.24'])
if (statusAssertable) check('that row is pending', sThis.sections[0].rows[0]?.status, 'pending')
const sThree = heroLedger(cardOf('lhF0fbR8'), 'three_cycles', false)
// The 100% charge clears the balance outright, so every later cycle is £0.
check('next 3 cycles closing balances: £91.24 / £0 / £0 / £0', sThree.sections.map((s) => s.closingBalance), [91.24, 0, 0, 0])
check('only the Oct cycle carries a row', sThree.sections.map((s) => s.rows.length), [1, 0, 0, 0])

// --- Natwest: cycle-end totals ON. Part C must not change this card. ---
console.log('\n--- Natwest: cycle totals ON ---')
const nThis = heroLedger(cardOf('M2Ak3QNc'), 'this_cycle', false)
check('this cycle balance due is £1400', nThis.sections[0].closingBalance, 1400)
check('this cycle rows: £200 pending on 14 Oct', nThis.sections[0].rows.map((r) => `${r.date}/${r.amount}`), ['2026-10-14/200'])
const nThree = heroLedger(cardOf('M2Ak3QNc'), 'three_cycles', false)
check('next 3 cycles closing balances: £1400 / £1200 / £1000 / £800', nThree.sections.map((s) => s.closingBalance), [1400, 1200, 1000, 800])
check('£200 pending in each of the four cycles', nThree.sections.map((s) => s.rows.map((r) => r.amount)), [[200], [200], [200], [200]])

// --- The flat list (cycle totals OFF) — the actual Part B fix ---
// Expected, NOT a regression: the 14 Sept cleared payment correctly drops
// out of "This cycle", because it belongs to the PREVIOUS period under the
// card's own window. The household cycle used to include it.
console.log('\n--- flat list, cycle totals OFF (Part B) ---')
for (const [id, name, amount] of [['lhF0fbR8', 'Santander', 91.24], ['M2Ak3QNc', 'Natwest', 200]] as const) {
  const flat = heroLedger(cardOf(id), 'this_cycle', false).flat
  check(`${name} flat list shows the generated 14 Oct charge`, flat.map((r) => `${r.date}/${r.amount}`), [`2026-10-14/${amount}`])
  const flatWithCleared = heroLedger(cardOf(id), 'this_cycle', true).flat
  check(`${name}: the 14 Sept cleared payment is NOT in this cycle (previous period — expected)`, flatWithCleared.some((r) => r.date === '2026-09-14'), false)
}

// --- Both toggle states must agree. This is the property that was broken. ---
console.log('\n--- the two toggle states agree (the property that was broken) ---')
for (const [id, name] of [['lhF0fbR8', 'Santander'], ['M2Ak3QNc', 'Natwest']] as const) {
  for (const horizon of ['this_cycle', 'three_cycles'] as const) {
    const { sections, flat } = heroLedger(cardOf(id), horizon, true)
    const fromSections = sections.flatMap((s) => s.rows).map((r) => `${r.date}/${r.type}/${r.amount}`).sort()
    check(`${name} / ${horizon}: flat list === cycle sections, row for row`, flat.map((r) => `${r.date}/${r.type}/${r.amount}`).sort(), fromSections)
  }
}

// --- showCleared still filters correctly (a deliberate earlier UAT fix) ---
console.log('\n--- regression: showCleared and horizon still behave ---')
const sClearedOff = heroLedger(cardOf('lhF0fbR8'), 'three_cycles', false).flat
const sClearedOn = heroLedger(cardOf('lhF0fbR8'), 'three_cycles', true).flat
check('showCleared=false hides every cleared row', sClearedOff.some((r) => r.status === 'cleared'), false)
check('showCleared=true is a superset', sClearedOn.length >= sClearedOff.length, true)
check('the horizon toggle widens the window', heroLedger(cardOf('M2Ak3QNc'), 'three_cycles', false).flat.length > heroLedger(cardOf('M2Ak3QNc'), 'this_cycle', false).flat.length, true)
// Rows must read ascending in both states (the 2026-09-09 UAT fix).
const asc = heroLedger(cardOf('M2Ak3QNc'), 'three_cycles', true).flat.map((r) => r.date)
check('flat list still sorts ascending', asc.join(',') === [...asc].sort().join(','), true)

console.log(`\n${failures === 0 ? '✓ ALL CHECKS PASSED' : `✗ ${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
