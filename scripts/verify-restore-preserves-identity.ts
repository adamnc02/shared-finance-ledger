// PROMPT-14 Part 5 (2026-09-22), rewritten by PROMPT-16 Part F the same day —
// a restore must not silently reassign who everyone is.
//
// 🚨 THE REAL BUG, and it shipped. An import deletes every `people` row and
// inserts a fresh one with a new id (regenerateIds, MIGRATION-LESSONS §31),
// and `linked_user_id` is a server-only column `toRows` never writes. So the
// restore takes every OTHER member's link with it. On Ella's next sync,
// `assemble` walks choice → linked → people[0]: no link, no (or a dead)
// choice, so she becomes WHOEVER SORTS FIRST — Adam — with his pay cycle. No
// error, no warning, on a phone nobody touched (§23 through another door).
//
// 🚨 WHY PART 5's FIX COULD NEVER WORK, and this check passed anyway. Part 5
// had the RESTORER's device re-link every member by name. But the server's
// `people_enforce_self_link` trigger refuses any linked_user_id that is not
// auth.uid() (42501, discarded by the connector): a link can only ever be
// written by the user it belongs to. Adam's phone was writing Ella's link,
// the server threw it away, and Ella stayed unlinked — three UAT runs on
// 2026-09-22, the last with names matching cleanly. The unit was green
// because FakeSyncDb had no trigger. It has one now (`actingUser`), and
// section 2 proves the restorer emits NO op the server would refuse.
//
// 🚨 AND WHY SHE WAS NOT EVEN ASKED. The boot's "which person are you?" was
// gated on `staleChoice`, which only exists for a user who OVERRODE their
// link. Ella was resolved BY link, so no choice was ever stored, nothing went
// stale, and SyncRoot fell through to `ready`. The rule now: the device
// remembers who it last showed, whatever resolved it; when that person is
// gone or someone else's, identityAction links the ONE unlinked person with
// the same name (run by Ella, on Ella's device — the only writer the trigger
// allows), and ASKS otherwise. Section 1 is the control for the old fallback;
// section 3's control is the old gate, shown walking straight past her.
//
// What it asserts:
//  1. control — a restore with no re-link resolves a dead-choice device to
//     Adam, with Adam's pay cycle (staleChoice would at least have asked);
//  2. the restorer writes ONLY its own link (2 narrow ops), the server
//     refuses nothing, and a write of another member's link IS refused by
//     the modelled trigger (the fake fails the way the server does);
//  3. 🚨 Ella, resolved by LINK and never having chosen: after Adam's
//     restore her device is told to LINK the new Ella row by remembered
//     name — not ready, not people[0] — and the old gate would have said
//     ready. Acting on it links her, as her, and her pay cycle is unchanged;
//  4. a file restore does the same (both routes converge, Part 3);
//  5. the name is gone (a rename) or ambiguous (two Ellas) → ASK, never a guess;
//  6. a patch of this household's own file (Part 4) needs nothing: no link
//     op, Ella untouched;
//  7. a device that has never shown anyone, in a one-person household, is
//     ready — not asked a question with one answer (the trap named in F3).

import { readFileSync } from 'node:fs'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { toRows } from '../src/lib/powersync/mapping'
import { regenerateIds } from '../src/lib/powersync/importIds'
import { createPowerSyncLedgerStore, identityAction, type PowerSyncLedgerStore } from '../src/lib/store/powerSyncLedgerStore'
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
const BACKUP = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-15.json'
const raw = readFileSync(BACKUP, 'utf8')
const silent = { error: () => {}, warn: () => {}, info: () => {} }

const personNamed = (d: AppDataV2, name: string) => d.people.find((p) => p.name === name)!
const nameOf = (d: AppDataV2, id: string) => d.people.find((p) => p.id === id)?.name ?? '(nobody)'
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

type Device = { storage: ReturnType<typeof memoryStorage>; userId: string }
const device = (userId: string, choice: string | null = null): Device => {
  const storage = memoryStorage()
  if (choice) storage.setItem('k', choice)
  return { storage, userId }
}

/** One boot of `dev` against `db`: what SyncRoot sees after load(). */
async function boot(db: FakeSyncDb, dev: Device) {
  const sync = deferred()
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: dev.userId, firstSync: sync.promise, storageKey: 'k', storage: dev.storage, log: silent })
  sync.resolve()
  const data = (await store.load())!
  return {
    store,
    data,
    landedOn: nameOf(data, data.primaryPersonId),
    action: identityAction(store, data.people, false),
    // The OLD gate (SyncRoot before PROMPT-16), verbatim: ask only when nothing is linked to me AND my stored choice is gone.
    oldGateAsks: store.linkedPersonId === null && store.staleChoice,
  }
}

/** What SyncRoot does with a 'link' action: the explicit tap, the save, the flush — as that user. */
async function act(db: FakeSyncDb, store: PowerSyncLedgerStore, data: AppDataV2, personId: string, userId: string) {
  db.actingUser = userId
  store.setPrimaryPerson(personId)
  store.save({ ...data, primaryPersonId: personId }, data)
  await store.flush()
  await tick(10)
}

/** Adam restores `file` into `db` from a device that already shows his own row. */
async function restoreBy(db: FakeSyncDb, adam: Device, file: AppDataV2) {
  db.actingUser = ADAM_USER
  const { store, data } = await boot(db, adam)
  db.clearLog()
  db.rejected = []
  store.save(file, data) // setData with a dataset no list of which the store has seen: an import
  await store.flush()
  await tick(10)
  return store
}

// 🚨 What the household holds now is deliberately NOT the file being restored.
// Since Part 4, re-importing this household's OWN file is a patch: ids are
// kept, so nobody's link is touched. The restore that matters is a genuine
// import — an older snapshot, another device's household, anything whose ids
// this household does not hold. So the household is a regenerated copy, and
// the backup file keeps the original ids: no overlap, a real import.
const before = regenerateIds(parseLedgerBackupJson(raw)).data
const ellaBefore = personNamed(before, 'Ella')
const adamBefore = personNamed(before, 'Adam')

console.log('\n1. CONTROL — the old fallback: a restore with no re-link, a device with a dead choice')
{
  const imported = regenerateIds(parseLedgerBackupJson(raw)).data
  const db = new FakeSyncDb()
  db.seed(toRows(imported, { householdId: HH }))
  db.tables.get('people')!.get(personNamed(imported, 'Adam').id)!.linked_user_id = ADAM_USER // only the restorer's survives
  const ella = await boot(db, device(ELLA_USER, ellaBefore.id)) // her choice is now a dead id
  check("Ella's device RESOLVES to someone who is not Ella (assemble's people[0] fallback, unchanged)", ella.landedOn !== 'Ella', ella.landedOn)
  check('…specifically to Adam, whoever sorts first', ella.landedOn === 'Adam', ella.landedOn)
  check("…and takes Adam's pay cycle with him", payCycleOf(ella.data, ella.data.primaryPersonId) !== payCycleOf(before, ellaBefore.id))
  check('a dead choice was the ONE signal the old gate had', ella.store.staleChoice === true && ella.oldGateAsks === true)
  check('the new decision does not let that resolution stand either: she is asked (no name remembered on this device)', ella.action.kind === 'ask', ella.action)
}

console.log('\n2. 🚨 The restorer writes only its OWN link — the server would refuse anyone else\'s')
{
  const db = seededDb(before)
  const store = await restoreBy(db, device(ADAM_USER, adamBefore.id), parseLedgerBackupJson(raw))
  const linkOps = db.log.filter((s) => s.columns.includes('linked_user_id'))
  // Counted, not "every": an empty list would pass vacuously (§53).
  check('exactly two link ops: my old row cleared, my new row linked', linkOps.length === 2, linkOps)
  check('every link op is a narrow one-column UPDATE on people', linkOps.length > 0 && linkOps.every((s) => s.kind === 'update' && s.table === 'people' && s.columns.length === 1), linkOps)
  check('the server (modelled trigger) refused NOTHING — before PROMPT-16 it refused the write of Ella\'s link', db.rejected.length === 0, db.rejected)
  const newAdam = store.importMap!.get(personNamed(parseLedgerBackupJson(raw), 'Adam').id)!
  check("the restorer's own link survives, on the new row", db.tables.get('people')!.get(newAdam)?.linked_user_id === ADAM_USER)
  check('nobody else is linked to anything: Ella\'s link died with her old row, as it always did', [...db.tables.get('people')!.values()].filter((r) => r.linked_user_id).length === 1)

  // The model itself: Adam writing Ella's link is refused, exactly as people_enforce_self_link does.
  const newElla = store.importMap!.get(personNamed(parseLedgerBackupJson(raw), 'Ella').id)!
  await db.write([{ kind: 'update', table: 'people', id: newElla, set: { linked_user_id: ELLA_USER } }])
  check('the fake refuses a link to another user (the 42501 the live runs hit)', db.rejected.length === 1 && (db.tables.get('people')!.get(newElla)?.linked_user_id ?? null) === null, db.rejected)
  db.actingUser = ELLA_USER
  await db.write([{ kind: 'update', table: 'people', id: newElla, set: { linked_user_id: ELLA_USER } }])
  check('…and accepts the same write from Ella herself', db.tables.get('people')!.get(newElla)?.linked_user_id === ELLA_USER)
}

console.log('\n3. 🚨 Ella, resolved by LINK, never chose: after the restore her device re-links itself by name')
{
  const db = seededDb(before)
  const ellaDev = device(ELLA_USER) // no choice: the link is what resolves her
  const first = await boot(db, ellaDev)
  check('before the restore: Ella\'s device shows Ella, by link, and remembers it', first.landedOn === 'Ella' && first.store.resolvedBy === 'link' && first.store.lastShown?.name === 'Ella', first.store.lastShown)
  check('…with nothing stored as a "choice" (so nothing can ever go stale)', ellaDev.storage.map.get('k') === undefined)
  const cycleBefore = payCycleOf(first.data, first.data.primaryPersonId)

  await restoreBy(db, device(ADAM_USER, adamBefore.id), parseLedgerBackupJson(raw))

  const after = await boot(db, ellaDev) // her next sync
  check("assemble alone still lands her on Adam (the fallback is unchanged — it is the DECISION that changed)", after.landedOn === 'Adam', after.landedOn)
  check('🚨 CONTROL — the old gate says READY here: no link, and no stale choice to notice', after.oldGateAsks === false && after.store.staleChoice === false)
  check('the new decision is to LINK the one unlinked person with the remembered name', after.action.kind === 'link' && after.action.reason === 'remembered_name' && nameOf(after.data, after.action.personId) === 'Ella', after.action)
  check('…and that is not the row Adam is linked to', after.action.kind === 'link' && after.store.ownerOf(after.action.personId) === null)

  if (after.action.kind === 'link') await act(db, after.store, after.data, after.action.personId, ELLA_USER)
  check('the link was written as Ella and accepted', db.rejected.length === 0 && [...db.tables.get('people')!.values()].some((r) => r.name === 'Ella' && r.linked_user_id === ELLA_USER), db.rejected)
  const healed = await boot(db, ellaDev)
  // Acting on the decision is a "Set as me", so this device also records it as a choice; either way
  // the LINK is what every other device of hers will resolve by.
  check("Ella's device now lands on Ella, and her account is linked to that row", healed.landedOn === 'Ella' && healed.store.linkedPersonId === healed.data.primaryPersonId, [healed.landedOn, healed.store.resolvedBy])
  check('…with her own pay cycle, unchanged', payCycleOf(healed.data, healed.data.primaryPersonId) === cycleBefore, [payCycleOf(healed.data, healed.data.primaryPersonId), cycleBefore])
  check('…and she is ready, not asked', healed.action.kind === 'ready')
  const adam = await boot(db, device(ADAM_USER))
  check("Adam's device (no choice) still lands on Adam", adam.landedOn === 'Adam' && adam.action.kind === 'ready')
}

console.log('\n4. A file restore does the same (both routes converge, Part 3)')
{
  const db = seededDb(before)
  const ellaDev = device(ELLA_USER)
  await boot(db, ellaDev)
  await restoreBy(db, device(ADAM_USER, adamBefore.id), parseLedgerBackupJson(readFileSync(BACKUP, 'utf8'))) // the file picker's parse, of the same bytes
  const after = await boot(db, ellaDev)
  check('Ella is told to re-link herself by name', after.action.kind === 'link' && nameOf(after.data, after.action.personId) === 'Ella', after.action)
}

console.log('\n5. Ambiguity is never guessed (§0 Q4b)')
{
  // A rename between the backup and the restore (UAT run one): she was "Ella X", the file says "Ella".
  const db = seededDb(before)
  db.tables.get('people')!.get(ellaBefore.id)!.name = 'Ella X'
  const ellaDev = device(ELLA_USER)
  const first = await boot(db, ellaDev)
  check('her device remembers the name it showed: Ella X', first.store.lastShown?.name === 'Ella X', first.store.lastShown)
  await restoreBy(db, device(ADAM_USER, adamBefore.id), parseLedgerBackupJson(raw))
  const after = await boot(db, ellaDev)
  check('the name is gone from the incoming data: ASK, do not guess', after.action.kind === 'ask', after.action)

  // Two incoming people with her name.
  const db2 = seededDb(before)
  const dev2 = device(ELLA_USER)
  await boot(db2, dev2)
  // A third person in the file also called Ella. (Renaming Adam would not do: the restorer's own
  // row is linked to him, so it is not a candidate, and one unlinked Ella is not ambiguous.)
  const twoEllas = parseLedgerBackupJson(raw)
  const spare = personNamed(twoEllas, 'Ella')
  twoEllas.people = [...twoEllas.people, { ...spare, id: 'second-ella', salaryHistory: [], salaryOverrides: [] }]
  await restoreBy(db2, device(ADAM_USER, adamBefore.id), twoEllas)
  const after2 = await boot(db2, dev2)
  check('two unlinked incoming people with that name: ASK', after2.action.kind === 'ask', after2.action)

  // Case and spacing still match — a restore of a hand-edited file is exactly where "Ella" becomes " ella ".
  const db3 = seededDb(before)
  const dev3 = device(ELLA_USER)
  await boot(db3, dev3)
  const cased = parseLedgerBackupJson(raw)
  cased.people = cased.people.map((p) => (p.name === 'Ella' ? { ...p, name: '  ella ' } : p))
  await restoreBy(db3, device(ADAM_USER, adamBefore.id), cased)
  const after3 = await boot(db3, dev3)
  check('case and spacing still match', after3.action.kind === 'link' && after3.action.reason === 'remembered_name', after3.action)
}

console.log("\n6. A patch of this household's own file needs nothing (Part 4)")
{
  const db = seededDb(before)
  const ellaDev = device(ELLA_USER)
  await boot(db, ellaDev)
  db.actingUser = ADAM_USER
  const { store, data } = await boot(db, device(ADAM_USER, adamBefore.id))
  db.clearLog()
  store.save(JSON.parse(JSON.stringify(data)) as AppDataV2, data) // the household's own file, re-imported unchanged
  await store.flush()
  await tick(10)
  check('no link op at all: nothing was unlinked', db.log.filter((s) => s.columns.includes('linked_user_id')).length === 0, db.log.slice(0, 5))
  const ella = await boot(db, ellaDev)
  check("Ella's device is untouched: Ella, by link, ready", ella.landedOn === 'Ella' && ella.action.kind === 'ready')
}

console.log('\n7. A device that never showed anyone, in a one-person household, is not asked')
{
  const solo = regenerateIds(parseLedgerBackupJson(raw)).data
  const onlyAdam: AppDataV2 = { ...solo, people: solo.people.filter((p) => p.name === 'Adam'), payCycles: solo.payCycles.filter((c) => c.personId === personNamed(solo, 'Adam').id) }
  const db = new FakeSyncDb()
  db.seed(toRows(onlyAdam, { householdId: HH })) // nobody linked yet
  const fresh = await boot(db, device(ADAM_USER))
  check('resolved by the fallback, with no memory and no link: ready, not asked', fresh.store.resolvedBy === 'fallback' && fresh.action.kind === 'ready', fresh.action)
  check('…and nothing was healed from a fallback (that would be a guess)', fresh.action.kind !== 'link')
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
