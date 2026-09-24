// The cycle statement's date picker offers REAL cycles, and commits the
// bounds it displayed.
//
// The defect this exists to prevent has happened before, in this app:
// `verify-overpayment-picker-real-dates.ts` covers a picker that
// displayed one set of dates and keyed another, silently writing against
// the wrong one. A statement picker has the same shape — a list of dates
// a person taps — and the same failure would be invisible, because the
// file it produced would look entirely plausible.
//
// 🚨 The control is at the bottom: move the opening-balance date and the
// offered list must actually shorten. A check that cannot fail proves
// nothing.

import { statementFixture, ASOF, PAY_CYCLE } from './statementFixture'
import { offerableCycles } from '../src/components/StatementRangeSheet'
import { horizonCycles, THREE_CYCLES_AHEAD, cyclesInRange } from '../src/lib/projection'
import { resolveCycleBounds } from '../src/lib/pensionLedger'
import { buildStatementPayload } from '../src/lib/statement'
import { toLocalIsoDate as iso, parseLocalDate } from '../src/lib/date'
import type { AppDataV2 } from '../src/types/ledger'

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

const data = statementFixture()
const personId = data.primaryPersonId
const earliest = PAY_CYCLE.openingBalanceDate

const cycles = offerableCycles(data, personId, ASOF, earliest)
const currentIndex = cycles.findIndex((c) => c.current)

// ── E6.1 — display what you key ────────────────────────────────────────
{
  assert('every offered cycle round-trips through resolveCycleBounds', cycles.every((c) => {
    const real = resolveCycleBounds(data, personId, parseLocalDate(c.start))
    return iso(real.start) === c.start && iso(real.end) === c.end
  }))
  assert('no two offered cycles share a start', new Set(cycles.map((c) => c.start)).size === cycles.length)
  assert('the cycles tile with no gap and no overlap', cycles.every((c, i) => {
    if (i === 0) return true
    const previousEnd = parseLocalDate(cycles[i - 1].end)
    return c.start === iso(new Date(previousEnd.getFullYear(), previousEnd.getMonth(), previousEnd.getDate() + 1))
  }))
  assert('exactly one cycle is marked "this cycle"', cycles.filter((c) => c.current).length === 1)
  assert('the current cycle really contains today', cycles[currentIndex].start <= iso(ASOF) && iso(ASOF) <= cycles[currentIndex].end)
}

// ── E3.2 — the default window is the Home page's own horizon ───────────
{
  // 🚨 Read from THREE_CYCLES_AHEAD; never hardcode 4.
  const defaultTo = Math.min(currentIndex + THREE_CYCLES_AHEAD, cycles.length - 1)
  const horizon = horizonCycles(data, personId, 'three_cycles', ASOF)
  check('the default window starts where "Next 3 cycles" starts', cycles[currentIndex].start, iso(horizon[0].start))
  check('and ends where it ends', cycles[defaultTo].end, iso(horizon[horizon.length - 1].end))
  check('which is four whole cycles', defaultTo - currentIndex + 1, horizon.length)
  assert('the constant is genuinely being read, not a coincidence of the number 4', horizon.length === THREE_CYCLES_AHEAD + 1)
}

// ── An empty cycle is not offered at all ───────────────────────────────
// 🚨 This REVERSES the round's original design, which had empty
// cycles listed-but-disabled. Adam,
// 2026-09-24, having seen it in the first UAT round: a row of greyed
// "no data" cycles is clutter, not an explanation. The assertions below
// are the reversal made enforceable, so a later session restoring the old
// behaviour fails here rather than quietly shipping.
{
  assert('no cycle that ends before the reconciliation point is offered', cycles.every((c) => c.end >= earliest))
  // The shared fixture's floor falls exactly on a cycle START (payday is
  // the 14th, the floor is the 14th), so nothing straddles it and nothing
  // is partial. That is the ordinary case and it is asserted as such.
  check('a floor landing exactly on a cycle start leaves nothing partial', cycles.filter((c) => c.partial).length, 0)
  check('and the list then begins exactly at the floor', cycles[0].start, earliest)

  // 🚨 The straddling case gets its own fixture, because real data will
  // have one: an opening balance reconciled MID-CYCLE. That cycle holds
  // rows from the floor onward, so it is offered — and flagged, so a
  // half-empty first cycle is not passed off as a whole one.
  const midCycleFloor = '2026-09-20'
  const straddled = offerableCycles(data, personId, ASOF, midCycleFloor)
  check('a mid-cycle floor leaves exactly one partial cycle', straddled.filter((c) => c.partial).length, 1)
  assert('that cycle starts before the floor and ends after it', straddled[0].start < midCycleFloor && straddled[0].end >= midCycleFloor)
  assert('it is the earliest one offered — nothing emptier is listed', straddled.every((c) => c.end >= midCycleFloor))
  assert('every other offered cycle starts at or after the floor', straddled.filter((c) => !c.partial).every((c) => c.start >= midCycleFloor))
  check('and the straddling cycle keeps its REAL bounds, not bounds trimmed to the floor', straddled[0].start, cycles.find((c) => c.end >= midCycleFloor)!.start)
}

// ── The window the picker promises is the window the payload carries ───
{
  const from = cycles[currentIndex]
  const to = cycles[Math.min(currentIndex + THREE_CYCLES_AHEAD, cycles.length - 1)]
  const payload = buildStatementPayload(data, { selectedStart: from.start, selectedEnd: to.end, asOfDate: ASOF })
  check('the payload spans exactly the cycles the picker offered', [payload.meta.fullRangeStart, payload.meta.fullRangeEnd], [from.start, to.end])
  check('one payload cycle per offered cycle in the window', payload.meta.cycles.length, THREE_CYCLES_AHEAD + 1)
  check('the payload cycle labels are the picker\'s labels', payload.meta.cycles.map((c) => c.label), cycles.slice(currentIndex, currentIndex + THREE_CYCLES_AHEAD + 1).map((c) => c.label))

  // Symmetric window — exact dates still hold the whole containing cycles.
  const exact = buildStatementPayload(data, { selectedStart: '2026-09-20', selectedEnd: '2026-10-05', asOfDate: ASOF })
  assert('an exact-date window still carries the whole containing cycles', exact.meta.fullRangeStart < exact.meta.selectedStart && exact.meta.fullRangeEnd > exact.meta.selectedEnd)
  check('a window inside ONE cycle is one cycle, not none', exact.meta.cycles.length, 1)
}

// ── B12.13 — a start below the floor is clamped, and says so ───────────
{
  const clamped = buildStatementPayload(data, { selectedStart: '2026-01-01', selectedEnd: '2026-10-31', asOfDate: ASOF })
  check('the window used starts at the floor', clamped.meta.selectedStart, earliest)
  check('the clamp records what was asked for', clamped.meta.clamp?.requestedStart, '2026-01-01')
  assert('and gives a reason naming the reconciliation date', !!clamped.meta.clamp?.reason.includes('14 September 2026'))
  assert('no row predates the floor', clamped.cards.every((c) => c.rows.every((r) => r.date >= earliest)))
}

// ── E3.4 — an impossible window is never offered ───────────────────────
{
  // The sheet disables the invalid rows; the payload must also refuse to
  // invert a window if one ever reached it.
  const reversed = buildStatementPayload(data, { selectedStart: '2026-10-14', selectedEnd: '2026-09-14', asOfDate: ASOF })
  assert('an end before the start collapses to a single cycle rather than an empty file', reversed.meta.cycles.length >= 1)
  assert('and the full range is still ordered', reversed.meta.fullRangeStart <= reversed.meta.fullRangeEnd)
}

// ── 🚨 THE CONTROL ─────────────────────────────────────────────────────
// Move the opening-balance date forward and the offered list must
// genuinely shorten. Without this, every assertion above would still
// pass against a picker that ignored the floor entirely.
{
  const later: AppDataV2 = {
    ...data,
    payCycles: data.payCycles.map((pc) => (pc.personId === personId ? { ...pc, openingBalanceDate: '2026-09-14' } : pc)),
  }
  const withEarlyFloor = offerableCycles(data, personId, ASOF, '2025-01-01')
  const withLateFloor = offerableCycles(later, personId, ASOF, '2026-09-14')
  assert('CONTROL: moving the floor forward genuinely shortens the offered list', withLateFloor.length < withEarlyFloor.length)
  assert('CONTROL: an early floor offers cycles the late floor does not', withEarlyFloor.some((c) => c.end < '2026-09-14'))
  // The floor decides WHERE THE LIST STARTS, never where a cycle begins:
  // every cycle the two lists share must have identical bounds.
  const shared = withLateFloor.filter((l) => withEarlyFloor.some((e) => e.start === l.start))
  check('CONTROL: the floor changes the list, never a cycle bound', shared.map((c) => c.end), shared.map((l) => withEarlyFloor.find((e) => e.start === l.start)!.end))
  assert('CONTROL: and the shared portion is not empty, so the check above is not vacuous', shared.length > 0)
}

// ── E6.3 — one cycle walker, not two ───────────────────────────────────
{
  const walked = cyclesInRange(data, personId, parseLocalDate(cycles[currentIndex].start), parseLocalDate(cycles[currentIndex + 2].end))
  check('the picker\'s cycles and cyclesInRange agree exactly', walked.map((c) => iso(c.start)), cycles.slice(currentIndex, currentIndex + 3).map((c) => c.start))
}

console.log(`\n${passed} passed, ${failed} failed.`)
if (failed > 0) process.exit(1)
