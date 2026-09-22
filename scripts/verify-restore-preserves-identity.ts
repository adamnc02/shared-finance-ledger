// PROMPT-14 Part 5 (2026-09-22) — a restore must not silently reassign who
// everyone is.
//
// 🚨 THE REAL BUG, and it shipped. An import deletes every `people` row and
// inserts a fresh one with a new id (regenerateIds, MIGRATION-LESSONS §31),
// and `linked_user_id` is a server-only column `toRows` never writes. So the
// restore takes every OTHER member's link with it. `linkOps` re-links only
// the person doing the restore.
//
// On Ella's next sync, `assemble` walks choice → linked → people[0]. Her
// stored choice is a dead id and there is no linked row, so she becomes
// WHOEVER SORTS FIRST — Adam — and his pay cycle with him. No error, no
// warning, on a phone nobody touched. That is precisely the §23 failure
// `verify-first-sync-gate.ts` was written to prevent, arriving through a door
// that check does not watch.
//
// Section 1 is the CONTROL: the old behaviour, reproduced, which must show
// Ella landing on Adam's row. If section 1 ever goes quiet, this check has
// stopped being able to fail and is worth nothing.
//
// What it asserts:
//  1. control — a restore with no re-link leaves Ella unlinked, resolving her
//     to Adam, with Adam's pay cycle;
//  2. a cloud restore re-links every member by name; Ella stays Ella, and her
//     pay cycle does not flip;
//  3. a file restore does the same — both routes converge (Part 3), so both
//     are tested, not just the one that happens to be wired up;
//  4. the restorer's own link still works (linkOps is not broken by this);
//  5. the ops are NARROW: one linked_user_id column, one row each — never a
//     whole-row rewrite (DECISIONS Q2: PowerSync's per-column conflict
//     resolution rests on it);
//  6. a patch of this household's own file (Part 4) needs no re-link at all,
//     because nothing was unlinked;
//  7. ambiguity is never guessed: two incoming people with the same name, or
//     no match at all, leave that member unlinked and set staleChoice, which
//     is what makes their device ASK (§0 Q4b) instead of choosing for them;
//  8. an unchanged name that differs only in case or spacing still re-links —
//     a restore of a hand-edited file is exactly where "Ella" becomes "ella".

import { readFileSync } from 'node:fs'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { toRows } from '../src/lib/powersync/mapping'
import { regenerateIds } from '../src/lib/powersync/importIds'
import { createPowerSyncLedgerStore, relinkOps } from '../src/lib/store/powerSyncLedgerStore'
import type { AppDataV2 } from '../src/types/ledger'
import { FakeSyncDb, deferred, memoryStorage, tick } from './lib/fakeSyncDb'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', JSON.stringify(detail).slice(0, 600))
  }
}

const HH = '11111111-2222-3333-4444-555555555555'
const ADAM_USER = 'user-adam'
const ELLA_USER = 'user-ella'
const BACKUP = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15.json'
const raw = readFileSync(BACKUP, 'utf8')
const silent = { error: () => {}, warn: () => {}, info: () => {} }

const personNamed = (d: AppDataV2, name: string) => d.people.find((p) => p.name === name)!
/** The cycle itself, with the ids a restore legitimately changes stripped — what "her pay cycle" means to her. */
const payCycleOf = (d: AppDataV2, personId: string) => {
  const cycle = d.payCycles.find((c) => c.personId === personId)
  if (!cycle) return 'none'
  const { id: _id, personId: _p, ...rest } = cycle as Record<string, unknown> & { id?: string; personId?: string }
  return JSON.stringify(rest)
}

/** The household as it really is: Adam and Ella, each linked to their own account. */
function seededDb(data: AppDataV2): FakeSyncDb {
  const db = new FakeSyncDb()
  db.seed(toRows(data, { householdId: HH }))
  const people = db.tables.get('people')!
  people.get(personNamed(data, 'Adam').id)!.linked_user_id = ADAM_USER
  people.get(personNamed(data, 'Ella').id)!.linked_user_id = ELLA_USER
  return db
}

/** A device booting against `db`, with `choice` already stored on it. */
async function deviceView(db: FakeSyncDb, userId: string, choice: string | null) {
  const sync = deferred()
  const storage = memoryStorage()
  if (choice) storage.setItem('k', choice)
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId, firstSync: sync.promise, storageKey: 'k', storage, log: silent })
  sync.resolve()
  const data = await store.load()
  return {
    data: data!,
    staleChoice: store.staleChoice,
    // SyncRoot's boot rule, verbatim, for a device that has not just joined:
    // ask only when nothing is linked to me AND my stored choice is gone.
    asksWhichPersonAmI: store.linkedPersonId === null && store.staleChoice,
  }
}

// 🚨 What the household holds now is deliberately NOT the file being restored.
// Since Part 4, re-importing this household's OWN file is a patch: ids are
// kept, so nobody's link is touched and Part 5 has nothing to do. The restore
// that still needs Part 5 is a genuine import — an older snapshot taken before
// an erase, a file from another device's household, anything whose ids this
// household does not hold. So the household below is a regenerated copy, and
// the backup file keeps the original ids: no overlap, a real import.
const before = regenerateIds(parseLedgerBackupJson(raw)).data
const ellaBefore = personNamed(before, 'Ella')
const adamBefore = personNamed(before, 'Adam')

console.log('\n1. CONTROL — the old behaviour: a restore with no re-link')
{
  // Exactly what the diff alone produces: every old row deleted, every new row
  // inserted, and linked_user_id written by nobody.
  const imported = regenerateIds(parseLedgerBackupJson(raw)).data
  const db = new FakeSyncDb()
  db.seed(toRows(imported, { householdId: HH }))
  db.tables.get('people')!.get(personNamed(imported, 'Adam').id)!.linked_user_id = ADAM_USER // only the restorer's
  const ella = await deviceView(db, ELLA_USER, ellaBefore.id) // her choice is now a dead id
  const landedOn = ella.data.people.find((p) => p.id === ella.data.primaryPersonId)!
  check("Ella's device lands on someone who is not Ella", landedOn.name !== 'Ella', landedOn.name)
  check('…specifically on Adam, whoever sorts first', landedOn.name === 'Adam', landedOn.name)
  check("…and takes Adam's pay cycle with him", payCycleOf(ella.data, landedOn.id) !== payCycleOf(before, ellaBefore.id))
  check('the signal the fallback needs does exist: this device knows its choice is stale', ella.staleChoice === true)
  check('…so with Part 5 she is at least ASKED rather than silently reassigned', ella.asksWhichPersonAmI === true)
}

console.log('\n2. A cloud restore re-links every member by name')
{
  const db = seededDb(before)
  const sync = deferred()
  const storage = memoryStorage()
  storage.setItem('k', adamBefore.id)
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: ADAM_USER, firstSync: sync.promise, storageKey: 'k', storage, log: silent })
  sync.resolve()
  const loaded = await store.load()
  db.clearLog()
  // A cloud restore: downloadSnapshot parses the snapshot, setData hands the
  // store a dataset no list of which it has ever seen. That IS the import.
  store.save(parseLedgerBackupJson(raw), loaded!)
  await store.flush()
  await tick(10)

  const linkOps = db.log.filter((s) => s.columns.includes('linked_user_id'))
  // Counted, not just "every", or an empty list would pass this vacuously
  // (SHARED-FINANCE-LEDGER-INFO §53: count what you can see before trusting a zero).
  // Three: linkOps clears my OLD row first (the (household, linked_user_id)
  // unique index), linkOps sets my new one, and Part 5 sets Ella's.
  check('three link ops: my old row cleared, my new row linked, Ella re-linked', linkOps.length === 3, linkOps)
  check('every link op is a narrow one-column UPDATE on people', linkOps.length > 0 && linkOps.every((s) => s.kind === 'update' && s.table === 'people' && s.columns.length === 1), linkOps)

  const ella = await deviceView(db, ELLA_USER, ellaBefore.id)
  const landedOn = ella.data.people.find((p) => p.id === ella.data.primaryPersonId)!
  check("Ella's device still lands on Ella", landedOn.name === 'Ella', landedOn.name)
  check('…with her own pay cycle, unchanged', payCycleOf(ella.data, landedOn.id) === payCycleOf(before, ellaBefore.id), [payCycleOf(ella.data, landedOn.id), payCycleOf(before, ellaBefore.id)])
  // Her stored choice IS stale — a restore regenerates every id, so it always
  // is — but it is never consulted, because the re-linked row answers first.
  check('…and she is not asked to choose again', ella.asksWhichPersonAmI === false)

  const adam = await deviceView(db, ADAM_USER, null) // no choice: falls through to the linked row
  check("the restorer's own link survives too", adam.data.people.find((p) => p.id === adam.data.primaryPersonId)!.name === 'Adam')
}

console.log('\n3. A file restore does the same (both routes converge, Part 3)')
{
  const db = seededDb(before)
  const sync = deferred()
  const storage = memoryStorage()
  storage.setItem('k', adamBefore.id)
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: ADAM_USER, firstSync: sync.promise, storageKey: 'k', storage, log: silent })
  sync.resolve()
  const loaded = await store.load()
  // The file picker's path: the same parse, of the same bytes off disk.
  store.save(parseLedgerBackupJson(readFileSync(BACKUP, 'utf8')), loaded!)
  await store.flush()
  await tick(10)
  const ella = await deviceView(db, ELLA_USER, ellaBefore.id)
  check("Ella's device still lands on Ella", ella.data.people.find((p) => p.id === ella.data.primaryPersonId)!.name === 'Ella')
}

console.log("\n4. A patch of this household's own file needs no re-link at all (Part 4)")
{
  const db = seededDb(before)
  const sync = deferred()
  const storage = memoryStorage()
  storage.setItem('k', adamBefore.id)
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: ADAM_USER, firstSync: sync.promise, storageKey: 'k', storage, log: silent })
  sync.resolve()
  const loaded = await store.load()
  db.clearLog()
  store.save(JSON.parse(JSON.stringify(loaded)) as AppDataV2, loaded!) // the household's own file, re-imported unchanged
  await store.flush()
  await tick(10)
  check('no link op at all: nothing was unlinked, so nothing needs re-linking', db.log.filter((s) => s.columns.includes('linked_user_id')).length === 0, db.log.slice(0, 5))
  const ella = await deviceView(db, ELLA_USER, personNamed(before, 'Ella').id)
  check("Ella's device is untouched", ella.data.people.find((p) => p.id === ella.data.primaryPersonId)!.name === 'Ella')
}

console.log('\n5. Ambiguity is never guessed (§0 Q4b)')
{
  const linked = new Map([[ellaBefore.id, ELLA_USER]])
  const twoSams: AppDataV2 = { ...before, people: [{ ...adamBefore, name: 'Sam' }, { ...ellaBefore, id: 'new-ella', name: 'Sam' }] }
  const ambiguous = relinkOps(linked, { ...before, people: [{ ...ellaBefore, name: 'Sam' }] }, twoSams, ADAM_USER, null)
  check('two incoming people with one name: no op, and the member is reported unresolved', ambiguous.ops.length === 0 && ambiguous.unresolved.length === 1, ambiguous)

  const renamed: AppDataV2 = { ...before, people: [{ ...ellaBefore, id: 'new-ella', name: 'Elle' }] }
  const noMatch = relinkOps(linked, before, renamed, ADAM_USER, null)
  check('the name is gone from the incoming data: no op, reported unresolved', noMatch.ops.length === 0 && noMatch.unresolved.length === 1, noMatch)

  const cased: AppDataV2 = { ...before, people: [{ ...ellaBefore, id: 'new-ella', name: '  ella ' }] }
  const loose = relinkOps(linked, before, cased, ADAM_USER, null)
  check('case and spacing still match — a hand-edited file usually differs by exactly that', loose.ops.length === 1 && loose.ops[0].id === 'new-ella', loose)

  const mine = relinkOps(new Map([[adamBefore.id, ADAM_USER]]), before, before, ADAM_USER, null)
  check('my own link is left to linkOps, never written twice', mine.ops.length === 0 && mine.unresolved.length === 0, mine)

  const clash = relinkOps(linked, before, { ...before, people: [{ ...ellaBefore, id: 'shared-row', name: 'Ella' }] }, ADAM_USER, 'shared-row')
  check('a row linkOps is already claiming is never also claimed here', clash.ops.length === 0 && clash.unresolved.length === 1, clash)
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
