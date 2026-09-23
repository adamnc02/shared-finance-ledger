// PROMPT-02 / DATA-MODEL-REVIEW-2026-09-15.md §11.7a — SalarySnapshot.recordedSeq.
//
// `Person.salaryHistory` is the one order-dependent history array that
// becomes a real TABLE (`salary_snapshots`) in the Supabase migration.
// The other five stay jsonb, which preserves array order; this one does
// not. `SELECT * FROM salary_snapshots WHERE person_id = ?` has no
// inherent row order, so whatever order the local SQLite happened to
// return would become the same-effectiveFrom tie-break — and it can
// legitimately differ between two devices holding identical rows. Adam's
// device and Ella's could resolve DIFFERENT salaries from the same data,
// producing a wrong net-pay figure with nothing indicating a fault.
//
// Already live in real data: finance-ledger-backup-2026-09-15.json has
// two snapshots for Adam both dated 2026-09-30 (£62,500 and £62,400).
//
// THE TEST THAT MATTERS is the shuffle: resolution must be identical for
// any permutation of the array. Array-order dependence fails it, which is
// exactly what proves the table migration is safe.
//
// ⚠️ This verifies that recordedSeq ADDS information. It must never be
// taken as licence to sort, reorder or de-duplicate these arrays —
// §11.7b, decided by Adam 2026-09-15. Sorting reassigns the indices the
// OTHER five resolvers still tie-break on and silently restores the
// stale-value bug scripts/verify-bill-amount-tiebreak.ts exists to
// prevent.

import { readFileSync } from 'node:fs'
import { findApplicableSnapshot, latestSalarySnapshot, nextRecordedSeq } from '../src/lib/salaryLedger'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import type { Person, SalarySnapshot } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const BACKUP_DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures'

function snap(over: Partial<SalarySnapshot> & Pick<SalarySnapshot, 'id' | 'effectiveFrom' | 'grossAnnual' | 'recordedSeq'>): SalarySnapshot {
  return {
    personId: 'me',
    taxCode: '1257L',
    studentLoanPlan: 'none',
    payFrequency: 'monthly',
    deductions: [],
    ...over,
  }
}
const personWith = (salaryHistory: SalarySnapshot[]): Person => ({ id: 'me', name: 'Me', color: '#ff5b4c', salaryHistory, salaryOverrides: [] })

// ─────────────────────────────────────────────────────────────────────
// 1. Two snapshots sharing an effectiveFrom — the later-RECORDED wins.
// ─────────────────────────────────────────────────────────────────────
const tied = [
  snap({ id: 'a', effectiveFrom: '2026-09-30', grossAnnual: 62500, recordedSeq: 0 }),
  snap({ id: 'b', effectiveFrom: '2026-09-30', grossAnnual: 62400, recordedSeq: 1 }),
]
check('same effectiveFrom — the higher recordedSeq wins', findApplicableSnapshot(personWith(tied), '2026-10-01')?.id, 'b')
check('...and latestSalarySnapshot agrees with it', latestSalarySnapshot(personWith(tied))?.id, 'b')

// recordedSeq, not array position: put the WINNER first in the array.
const tiedReversed = [tied[1], tied[0]]
check('the winner is unchanged when it sits FIRST in the array', findApplicableSnapshot(personWith(tiedReversed), '2026-10-01')?.id, 'b')
check('...latestSalarySnapshot likewise', latestSalarySnapshot(personWith(tiedReversed))?.id, 'b')

// ─────────────────────────────────────────────────────────────────────
// 2. THE SHUFFLE TEST — the one that proves the table migration is safe.
// ─────────────────────────────────────────────────────────────────────
const history = [
  snap({ id: 'old', effectiveFrom: '2025-01-01', grossAnnual: 50000, recordedSeq: 0 }),
  snap({ id: 'mid', effectiveFrom: '2026-09-30', grossAnnual: 62500, recordedSeq: 1 }),
  snap({ id: 'new', effectiveFrom: '2026-09-30', grossAnnual: 62400, recordedSeq: 2 }),
  snap({ id: 'future', effectiveFrom: '2027-06-01', grossAnnual: 70000, recordedSeq: 3 }),
]

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]))
}
const allOrders = permutations(history)
check('every permutation of a 4-snapshot history is exercised', allOrders.length, 24)

for (const date of ['2025-06-01', '2026-10-01', '2027-07-01']) {
  const resolved = new Set(allOrders.map((order) => findApplicableSnapshot(personWith(order), date)?.id ?? 'null'))
  check(`SHUFFLE — findApplicableSnapshot('${date}') is identical across all 24 orderings`, [...resolved], [findApplicableSnapshot(personWith(history), date)?.id])
}
const latestAcrossOrders = new Set(allOrders.map((order) => latestSalarySnapshot(personWith(order))?.id ?? 'null'))
check('SHUFFLE — latestSalarySnapshot is identical across all 24 orderings', [...latestAcrossOrders], ['future'])

// Sanity: the shuffle test would genuinely CATCH array-order dependence.
// Resolved purely by array index (the old rule) against a shuffled array,
// the answer changes — so the assertions above are not vacuous.
const byIndexOnly = (p: Person, date: string) =>
  p.salaryHistory
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s.effectiveFrom <= date)
    .sort((a, b) => b.s.effectiveFrom.localeCompare(a.s.effectiveFrom) || b.index - a.index)[0]?.s.id
check('guard — the OLD index rule really does vary with order', new Set(allOrders.map((o) => byIndexOnly(personWith(o), '2026-10-01'))).size, 2)

// ─────────────────────────────────────────────────────────────────────
// 3. The backfill path — no recordedSeq anywhere still resolves as before.
// ─────────────────────────────────────────────────────────────────────
const unstamped = history.map(({ recordedSeq: _drop, ...rest }) => rest as SalarySnapshot)
check('fixture really is unstamped', unstamped.every((s) => s.recordedSeq === undefined), true)
check('a wholly unstamped history falls back to array index', findApplicableSnapshot(personWith(unstamped), '2026-10-01')?.id, 'new')
check('...and latestSalarySnapshot does too', latestSalarySnapshot(personWith(unstamped))?.id, 'future')

// migrateLedgerData assigns 0,1,2… in CURRENT array order, so behaviour
// is preserved exactly rather than changed.
const backfilled = parseLedgerBackupJson(JSON.stringify({ people: [personWith(unstamped)], transactions: [] }))
check('migrateLedgerData backfills recordedSeq in array order', backfilled.people[0].salaryHistory.map((s) => s.recordedSeq), [0, 1, 2, 3])
check('...and does NOT reorder the array (§11.7b)', backfilled.people[0].salaryHistory.map((s) => s.id), ['old', 'mid', 'new', 'future'])
check('...resolving to the same snapshot it did unstamped', findApplicableSnapshot(backfilled.people[0], '2026-10-01')?.id, 'new')

// An already-stamped history is left alone, including a legitimate 0.
const preStamped = parseLedgerBackupJson(JSON.stringify({ people: [personWith([...history].reverse())], transactions: [] }))
check('an existing recordedSeq is never recomputed from position', preStamped.people[0].salaryHistory.map((s) => s.recordedSeq), [3, 2, 1, 0])

// ─────────────────────────────────────────────────────────────────────
// 4. nextRecordedSeq — max + 1, never reused.
// ─────────────────────────────────────────────────────────────────────
check('nextRecordedSeq on an empty history is 0', nextRecordedSeq([]), 0)
check('nextRecordedSeq is max + 1', nextRecordedSeq(history), 4)
// The invariant is "greater than every ordinal CURRENTLY in the array",
// not "globally never reused". Deleting the newest snapshot does free its
// number, and that is harmless — ordinals are only ever compared against
// other snapshots in the same live array, and the deleted one is not in
// it. What must never happen is a new ordinal COLLIDING with one that is
// still present, which is exactly what `salaryHistory.length` would do
// after a middle deletion.
check('deleting the newest frees its ordinal — harmless, nothing to collide with', nextRecordedSeq(history.filter((s) => s.id !== 'future')), 3)
const afterMiddleDelete = history.filter((s) => s.id !== 'mid') // seqs [0, 2, 3]
check('deleting a MIDDLE snapshot still yields max + 1', nextRecordedSeq(afterMiddleDelete), 4)
check('...which `length` would have got wrong, colliding with a live ordinal', afterMiddleDelete.length !== nextRecordedSeq(afterMiddleDelete), true)
check('the new ordinal beats every ordinal still present', afterMiddleDelete.every((s) => s.recordedSeq < nextRecordedSeq(afterMiddleDelete)), true)
check('array position is irrelevant to it', nextRecordedSeq([...history].reverse()), 4)
check('a partially-unstamped history still yields max + 1', nextRecordedSeq([...unstamped.slice(0, 2), history[3]]), 4)

// The regression this whole mechanism protects: record a second change
// effective the SAME day, and it must be the one that shows.
const sameDay = [...history, snap({ id: 'second-edit', effectiveFrom: '2026-09-30', grossAnnual: 61000, recordedSeq: nextRecordedSeq(history) })]
check('a second same-day edit is what resolves', findApplicableSnapshot(personWith(sameDay), '2026-10-01')?.grossAnnual, 61000)
check('...regardless of where it sits in the array', findApplicableSnapshot(personWith([sameDay[4], ...sameDay.slice(0, 4)]), '2026-10-01')?.grossAnnual, 61000)

// ─────────────────────────────────────────────────────────────────────
// 5. The REAL backup files — resolution must be byte-identical to what
//    the app produced before this change. Adam's own person is the live
//    instance of the duplicate-effectiveFrom case.
// ─────────────────────────────────────────────────────────────────────
for (const [label, file] of [
  ['Adam', 'finance-ledger-backup-2026-09-15.json'],
  ["Adam's mum", 'finance-ledger-backup-2026-09-15-mum.json'],
] as const) {
  let data
  try {
    data = parseLedgerBackupJson(readFileSync(`${BACKUP_DIR}/${file}`, 'utf8'))
  } catch (e) {
    console.log(`✗ FAIL ${label}'s backup could not be loaded from ${BACKUP_DIR}/${file} — ${(e as Error).message}`)
    failures++
    continue
  }
  for (const person of data.people) {
    const seqs = person.salaryHistory.map((s) => s.recordedSeq)
    check(`[${label}] ${person.name}: every snapshot has a recordedSeq`, seqs.every((n) => typeof n === 'number'), true)
    check(`[${label}] ${person.name}: backfilled in array order`, seqs, person.salaryHistory.map((_s, i) => i))

    // The pre-change answer, computed by the OLD array-index rule, must
    // equal the post-change answer for every date that matters.
    for (const date of ['2026-09-15', '2026-10-01', '2027-01-01']) {
      check(`[${label}] ${person.name} @ ${date}: resolves as it did before`, findApplicableSnapshot(person, date)?.id, byIndexOnly(person, date))
    }

    // And it is order-independent now, on the real data.
    const reversed = { ...person, salaryHistory: [...person.salaryHistory].reverse() }
    check(
      `[${label}] ${person.name}: same gross when the rows come back reversed (the migration risk)`,
      findApplicableSnapshot(reversed, '2026-10-01')?.grossAnnual,
      findApplicableSnapshot(person, '2026-10-01')?.grossAnnual,
    )
  }
}

// The specific live case §11.7a names: Adam's two 2026-09-30 snapshots.
const adamBackup = parseLedgerBackupJson(readFileSync(`${BACKUP_DIR}/finance-ledger-backup-2026-09-15.json`, 'utf8'))
const adam = adamBackup.people.find((p) => p.salaryHistory.filter((s) => s.effectiveFrom === '2026-09-30').length > 1)
check('the real duplicate-effectiveFrom person from §11.7a is present', adam !== undefined, true)
if (adam) {
  const dupes = adam.salaryHistory.filter((s) => s.effectiveFrom === '2026-09-30')
  check('...still has BOTH snapshots — nothing was de-duplicated (§11.7b)', dupes.length, 2)
  const resolved = findApplicableSnapshot(adam, '2026-10-01')
  check('...and resolves to the later-recorded one of the two', resolved?.recordedSeq, Math.max(...dupes.map((s) => s.recordedSeq)))
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll checks passed')
}
