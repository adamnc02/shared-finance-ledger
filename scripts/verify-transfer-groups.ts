// Transactions → Transfers groups every transfer by where its money comes
// FROM, one tile per location, with each tile's per-cycle figure.
//
// THE BUGS THIS PREVENTS:
// 1. A transfer that vanishes. Grouping is a partition: a transfer that
//    matches no group (a From the location list does not know, or no From
//    at all) must still be listed somewhere, or it silently disappears from
//    the only page that edits it.
// 2. Grouping on the wrong field. The derived `location` says which LEDGER
//    a transfer is on, not where it starts: Savings → Christmas pot is a
//    'pot' transfer by location. Grouped that way it lands under the pot it
//    is going TO. The control below reproduces that on the real file.
// 3. A per-cycle figure on the viewer's cycle. A transfer follows its
//    OWNER's payday (TECHNICAL.md §20); on the other person's cycle it
//    counts payments in a window they never fall in.
// 4. The 3-day grace period drifting between the two lists that fold
//    cleared items (Transactions' months, Transfers' single Cleared group).
//
// Plus the arithmetic that snaps a chosen tile into view: centred, or flush
// with the row's end for the first and last tile.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { groupTransfersByFrom, isSettled, transferAmountThisCycle } from '../src/lib/transferGroups'
import { transferLocationKey } from '../src/lib/transferLedger'
import { centredScrollLeft } from '../src/components/TransferFromTiles'
import type { AppDataV2, RecurringTemplate, Transaction, TransferLocation } from '../src/types/ledger'
import { statementFixture } from './statementFixture'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label}${pass ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`)
  if (!pass) failures++
}

function template(id: string, over: Partial<RecurringTemplate>): RecurringTemplate {
  return {
    id,
    name: id,
    amount: 100,
    categoryId: 'cat-home',
    paymentMethod: 'bank_transfer',
    frequency: 'monthly',
    anchorDate: '2026-09-20',
    location: 'personal',
    ownerId: 'p1',
    payee: '',
    payeeSharePercent: 100,
    active: true,
    kind: 'transfer',
    transferFrom: { type: 'personal' },
    transferTo: { type: 'savings', savingsPotId: 'sp1' },
    ...over,
  } as RecurringTemplate
}
function oneOff(id: string, date: string, from: TransferLocation | undefined, to: TransferLocation, status: 'cleared' | 'pending' = 'cleared'): Transaction {
  return { id, date, amount: 25, direction: 'out', categoryId: 'cat-home', paymentMethod: 'bank_transfer', status, type: 'transfer', location: 'personal', ownerId: 'p1', fromLocation: from, toLocation: to } as Transaction
}

// ── 1. The per-cycle figure ───────────────────────────────────────────
console.log('\n1. PER CYCLE: what each recurring transfer moves in its owner\'s current cycle')
const base = statementFixture()
const data: AppDataV2 = {
  ...base,
  savingsPots: [{ id: 'sp1', name: 'Holiday', personId: 'p1', color: '#4cd08a' }],
  pots: [{ id: 'pot1', name: 'Bills', personId: 'p1', color: '#f5a524' }],
  // p2 is paid on the 1st with cycles running 1st → end of month, so the
  // two people's cycles containing 24 Sep differ: p1 14 Sep–13 Oct, p2 1–30 Sep.
  payCycles: base.payCycles.map((c) => (c.personId === 'p2' ? { ...c, paydayDayOfMonth: 1, cycleStartDayOfMonth: 1, paydayAdjustForNonWorkingDay: false } : c)),
} as unknown as AppDataV2
const asOf = new Date(2026, 8, 24, 12) // 24 Sep 2026

const monthly = template('monthly', {})
const weekly = template('weekly', { amount: 10, frequency: 'weekly', anchorDate: '2026-09-15', transferTo: { type: 'pot', potId: 'pot1' } })
const paused = template('paused', { active: false })
const theirs = template('theirs', { ownerId: 'p2', anchorDate: '2026-10-05', transferFrom: { type: 'joint' }, location: 'joint' })

check('monthly on the 20th: one payment, £100', transferAmountThisCycle(monthly, data, asOf), 100)
check('weekly from 15 Sep: 15, 22, 29 Sep, 6, 13 Oct — five payments, £50', transferAmountThisCycle(weekly, data, asOf), 50)
check('paused: nothing', transferAmountThisCycle(paused, data, asOf), 0)
check("p2's transfer on 5 Oct counts on p2's cycle (1–30 Sep): nothing due", transferAmountThisCycle(theirs, data, asOf), 0)
// Control: the same transfer owned by p1 is due in p1's cycle — so the
// check above is reading the owner's cycle, not failing to find anything.
check('control: owned by p1 instead, it is due this cycle — £100', transferAmountThisCycle({ ...theirs, ownerId: 'p1' }, data, asOf), 100)

// ── 2. The groups ─────────────────────────────────────────────────────
console.log('\n2. GROUPS: a partition, in picker order, with nothing dropped')
const oneOffs = [
  oneOff('o-pot', '2026-09-20', { type: 'pot', potId: 'pot1' }, { type: 'personal' }),
  oneOff('o-sav', '2026-09-21', { type: 'savings', savingsPotId: 'sp1' }, { type: 'pot', potId: 'pot1' }),
  oneOff('o-me', '2026-09-22', { type: 'personal' }, { type: 'savings', savingsPotId: 'sp1' }, 'pending'),
  oneOff('o-none', '2026-09-23', undefined, { type: 'personal' }),
]
const groups = groupTransfersByFrom([monthly, weekly, paused, theirs], oneOffs, data, asOf)
check('order: Current Account, Joint, savings, pots, then a transfer with no From', groups.map((g) => g.key), ['personal', 'joint', 'savings:sp1', 'pot:pot1', 'unknown'])
check('every transfer is in exactly one group', groups.flatMap((g) => [...g.recurring.map((t) => t.id), ...g.oneOffs.map((t) => t.id)]).sort(), ['monthly', 'o-me', 'o-none', 'o-pot', 'o-sav', 'paused', 'theirs', 'weekly'])
const me = groups[0]
check('Current Account: its per-cycle total is £150 (the paused one adds nothing)', me.perCycleTotal, 150)
check('…split by destination, largest first', me.recurringByDestination.map((d) => [d.label, d.amount]), [['Holiday', 100], ['Bills', 50]])
check('a group with no payment due this cycle totals 0, and has no recurring split', [groups[1].perCycleTotal, groups[1].recurringByDestination.length], [0, 0])
check('a one-off-only group has no split: the bar and key show only money due this cycle', [groups[3].perCycleTotal, groups[3].recurringByDestination.length], [0, 0])
check('labels', groups.map((g) => g.label), ['Current Account', 'Joint Account', 'Holiday', 'Bills', 'Unknown'])

// ── 3. The grace period ───────────────────────────────────────────────
console.log('\n3. GRACE PERIOD: cleared within 3 days stays out; older folds away')
check('cleared today: stays out', isSettled('2026-09-24', true, asOf), false)
check('cleared 2 days ago: stays out', isSettled('2026-09-22', true, asOf), false)
check('cleared 3 days ago: folds', isSettled('2026-09-21', true, asOf), true)
check('pending, however old: stays out', isSettled('2026-01-01', false, asOf), false)
const expenses = readFileSync(new URL('../src/pages/Expenses.tsx', import.meta.url), 'utf8')
check('the Transactions month list uses the same rule, not its own copy', expenses.includes('isSettled(getDate(i), isCleared(i))') && !/addDays\(new Date\(\), -3\)/.test(expenses), true)

// ── 4. Snapping a tile into view ──────────────────────────────────────
console.log('\n4. SNAP: centred where it can be, flush at the ends')
// A 390px row, 6 tiles of 160px with 8px gaps after 16px of padding: 1040px wide.
const row = (scrollLeft: number) => ({ scrollLeft, clientWidth: 390, scrollWidth: 16 + 6 * 160 + 5 * 8 + 16, left: 0 })
const tileAt = (i: number, scrollLeft: number) => ({ left: 16 + i * 168 - scrollLeft, width: 160 })
check('first tile: flush left (0)', centredScrollLeft(row(200), tileAt(0, 200)), 0)
check('last tile: flush right (the maximum)', centredScrollLeft(row(0), tileAt(5, 0)), 1032 - 390)
check('a middle tile: its centre at the row\'s centre', centredScrollLeft(row(0), tileAt(2, 0)) + 195, 16 + 2 * 168 + 80)
check('…the same wherever the row is already scrolled', centredScrollLeft(row(300), tileAt(2, 300)), centredScrollLeft(row(0), tileAt(2, 0)))

// ── 5. Real files ─────────────────────────────────────────────────────
console.log('\n5. REAL FILES: every transfer listed once, under its own From')
const F = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/'
const today = new Date(2026, 9, 8, 12)
for (const f of ['finance-ledger-backup-2026-09-22-PROD.json', 'finance-ledger-backup-2026-10-05-mum.json', 'finance-ledger-backup-2026-10-06-mum.json']) {
  const raw = JSON.parse(readFileSync(F + f, 'utf8'))
  const d = migrateLedgerData(raw.data ?? raw)
  const rec = d.recurringTemplates.filter((t) => t.kind === 'transfer')
  const one = d.transactions.filter((t) => t.type === 'transfer' && (!t.sourceType || t.sourceType === 'salary_sort'))
  const gs = groupTransfersByFrom(rec, one, d, today)
  const listed = gs.reduce((n, g) => n + g.recurring.length + g.oneOffs.length, 0)
  check(`${f}: ${rec.length + one.length} transfers, all listed once`, listed, rec.length + one.length)
  check(`${f}: each sits under its own From`, gs.every((g) => g.recurring.every((t) => t.transferFrom && transferLocationKey(t.transferFrom) === g.key) && g.oneOffs.every((t) => t.fromLocation && transferLocationKey(t.fromLocation) === g.key)), true)
  check(`${f}: no transfer without a From`, gs.some((g) => g.key === 'unknown'), false)
}

// The reported case: three recurring transfers out of a savings pot, none
// due in the cycle containing 8 Oct, and one cleared £600 one-off. The key
// once fell back to that one-off and printed "£600" above Recurring.
{
  const raw = JSON.parse(readFileSync(F + 'finance-ledger-backup-2026-10-06-mum.json', 'utf8'))
  const d = migrateLedgerData(raw.data ?? raw)
  const rec = d.recurringTemplates.filter((t) => t.kind === 'transfer')
  const one = d.transactions.filter((t) => t.type === 'transfer' && (!t.sourceType || t.sourceType === 'salary_sort'))
  const saver = groupTransfersByFrom(rec, one, d, today).find((g) => g.from.type === 'savings')!
  check('nothing due this cycle from the saver: no total, no key, no bar', [saver.recurring.length, saver.oneOffs.length, saver.perCycleTotal, saver.recurringByDestination.length], [3, 1, 0, 0])
}

// ── 6. Control ────────────────────────────────────────────────────────
console.log('\n6. CONTROL: grouping on the derived location puts a transfer under where it goes')
{
  const raw = JSON.parse(readFileSync(F + 'finance-ledger-backup-2026-10-05-mum.json', 'utf8'))
  const d = migrateLedgerData(raw.data ?? raw)
  const christmas = d.recurringTemplates.find((t) => t.id === 'jeGygw7h')!
  check('Savings → Christmas is a pot transfer by its derived location', christmas.location, 'pot')
  const g = groupTransfersByFrom([christmas], [], d, today)
  check('…and is grouped under its savings pot, where it starts', g[0].key.startsWith('savings:'), true)
}

console.log(failures === 0 ? '\nALL PASS' : `\nFAIL: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
