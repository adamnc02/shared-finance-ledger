// Verifies parseLocalDate (src/lib/date.ts) and the specific bug it was
// introduced to fix: a recurring transaction anchored exactly on a pay
// cycle's own LAST day silently dropped out of "This cycle" projections
// during BST (Adam-reported, 2026-09-16, from finance-ledger-backup-
// 2026-09-15-mum.json — the "Jennifer - Imogen tutor" £50 transaction
// anchored 2026-10-13).
//
// Root cause: `new Date("2026-10-13")` parses per ISO 8601 as UTC
// MIDNIGHT. During BST (UTC+1) that is 2026-10-12 23:00 local — one hour
// EARLIER than local midnight on the 13th. schedule.ts's walkOccurrences
// compared that UTC-parsed anchor against a local-midnight cycle end
// built via the safe `new Date(year, month, day)` pattern, so the
// occurrence sorted as falling AFTER the cycle end and was dropped —
// but only from "current_cycle", where the anchor date IS the range
// end; "three_cycles" swamps the one-hour gap with a much later end
// date, which is why the bug was invisible there.

import { parseLocalDate, toLocalIsoDate } from '../src/lib/date'
import { computeProjectionToDate } from '../src/lib/projection'
import type { AppDataV2, PayCycleConfig, RecurringTemplate, Transaction } from '../src/types/ledger'

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed++
  } else {
    failed++
    console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  }
}

function assert(label: string, condition: boolean) {
  check(label, condition, true)
}

// ── 1. parseLocalDate itself: must construct LOCAL midnight, matching
// the safe y/m/d constructor exactly — never the UTC-midnight timestamp
// `new Date(iso)` would produce during BST. ────────────────────────────

const bstDateIso = '2026-10-13' // October: BST is in effect (clocks go back late Oct)
const viaParseLocalDate = parseLocalDate(bstDateIso)
const viaSafeConstructor = new Date(2026, 9, 13)
const viaUnsafeConstructor = new Date(bstDateIso)

check('parseLocalDate produces the exact same instant as the safe y/m/d constructor', viaParseLocalDate.getTime(), viaSafeConstructor.getTime())
assert('parseLocalDate differs from the naive new Date(iso) during BST (proves the hazard is real)', viaParseLocalDate.getTime() !== viaUnsafeConstructor.getTime())
check('the naive UTC parse sorts an hour LATER than local midnight during BST (the exact bug mechanism)', viaUnsafeConstructor.getTime() - viaSafeConstructor.getTime(), 60 * 60 * 1000)
check('round-trips back to the same ISO string', toLocalIsoDate(viaParseLocalDate), bstDateIso)

// ── 2. End-to-end: the exact reported scenario ──────────────────────────
// A pay cycle running 14 Sep – 13 Oct 2026 (BST throughout), with an
// ad-hoc recurring "transaction"-kind template anchored on 2026-10-13 —
// the cycle's own last day. It must appear in BOTH current_cycle and
// three_cycles projections, not just the latter.

const payCycle: PayCycleConfig = {
  personId: 'p1',
  openingBalance: 0,
  openingBalanceDate: '2026-09-14',
  paydayDayOfMonth: 14,
  paydayAdjustForNonWorkingDay: false,
  cycleStartDayOfMonth: 14,
}

const tutorTemplate: RecurringTemplate = {
  id: 'tutor-1',
  kind: 'transaction',
  active: true,
  name: 'Jennifer - Imogen tutor',
  amount: 50,
  recurringTransactionType: 'income',
  personId: 'p1',
  anchorDate: '2026-10-13',
  frequency: 'monthly',
  categoryId: 'cat-1',
  paymentMethod: 'debit_card',
  location: 'personal',
  ownerId: 'p1',
  payee: 'Jennifer',
  payeeSharePercent: 100,
} as unknown as RecurringTemplate

function dataWithTutor(): AppDataV2 {
  return {
    primaryPersonId: 'p1',
    people: [{ id: 'p1', name: 'Test', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [] }],
    categories: [],
    recurringTemplates: [tutorTemplate],
    loans: [],
    creditCards: [],
    transactions: [] as Transaction[],
    payCycles: [payCycle],
    pensions: [],
    savingsPots: [],
    scenarios: [],
  } as unknown as AppDataV2
}

const asOf = new Date(2026, 9, 1) // 1 Oct 2026, inside the cycle, well before its 13 Oct end

const currentCycleProjection = computeProjectionToDate(dataWithTutor(), 'p1', payCycle, new Date(2026, 9, 13), asOf)
const threeCyclesEnd = new Date(2027, 0, 13) // far enough to cover "three_cycles" without depending on horizonRangeEnd's own internals
const threeCyclesProjection = computeProjectionToDate(dataWithTutor(), 'p1', payCycle, threeCyclesEnd, asOf)

const currentCycleHasTutor = currentCycleProjection.transactions.some((t) => t.date === '2026-10-13' && t.amount === 50)
const threeCyclesHasTutor = threeCyclesProjection.transactions.some((t) => t.date === '2026-10-13' && t.amount === 50)

assert('FIXED: the tutor occurrence on the cycle\'s own last day appears in "This cycle"', currentCycleHasTutor)
assert('the tutor occurrence also appears in "Next 3 cycles" (was never broken here)', threeCyclesHasTutor)
assert('both horizons now agree — no more £50 discrepancy between them', currentCycleHasTutor === threeCyclesHasTutor)

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\nverify-bst-date-parsing: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
