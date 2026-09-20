// PROMPT-10 Part 4 (2026-09-19) — "Set as me" writes people.linked_user_id
// (MIGRATION-LESSONS §18: a button named like the feature was never wired to
// it; §5; §23). Adam, 2026-09-19: Set as me = link + view.
//
// LedgerContext.setPrimaryPerson only changes primaryPersonId (it must stay
// identical to personal-ledger's). The sync store turns that change into the
// link, narrowly:
//  1. an unlinked row → one UPDATE, one column, linked_user_id = me;
//  2. moving my link → my old row cleared FIRST, then the new one (the
//     (household, linked_user_id) unique index would refuse the other order,
//     and the connector discards a 23505);
//  3. a row linked to someone else → view only, nothing written, unless I
//     have no linked row at all (Ella claiming her row after Adam tapped it);
//  4. my person deleted (primaryPersonId moves as a side effect) → nothing;
//  5. an import links its own "Me" row (after inserting it); Start fresh
//     links the new "Me";
//  6. afterwards a fresh device (no choice of its own) resolves to the linked
//     row, and re-prefers it when it arrives late (§23).

import { readFileSync } from 'node:fs'
import { defaultCategories } from '../src/lib/categories'
import { removePersonFromData } from '../src/lib/deleteReassign'
import { defaultLedgerData, parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { toRows } from '../src/lib/powersync/mapping'
import { createPowerSyncLedgerStore } from '../src/lib/store/powerSyncLedgerStore'
import type { AppDataV2 } from '../src/types/ledger'
import { FakeSyncDb, memoryStorage, tick, type Statement } from './lib/fakeSyncDb'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', JSON.stringify(detail).slice(0, 800))
  }
}

const HH = '11111111-2222-3333-4444-555555555555'
const ADAM = 'user-adam'
const ELLA = 'user-ella'
const backup = parseLedgerBackupJson(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15.json', 'utf8'))
const [adamP, ellaP] = backup.people
const quiet = { error: (...a: unknown[]) => console.log('    [log.error]', ...a), warn: () => {}, info: () => {} }
const brief = (log: Statement[]) => log.map((s) => `${s.kind} ${s.table} ${s.id} [${s.columns.join(',')}]`)
const linkOf = (db: FakeSyncDb, id: string) => db.tables.get('people')!.get(id)?.linked_user_id ?? null

/** A household holding the backup, with the given links, and a store for `user`. */
async function setup(user: string, links: Record<string, string>) {
  const db = new FakeSyncDb()
  const rows = toRows(backup, { householdId: HH })
  db.seed({ ...rows, people: rows.people.map((r) => ({ ...r, linked_user_id: links[r.id] ?? null })) })
  const storage = memoryStorage()
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: user, firstSync: Promise.resolve(), storageKey: 'k', storage, log: quiet })
  const got: AppDataV2[] = []
  store.subscribe!((d) => got.push(d))
  await tick(30)
  db.clearLog()
  return { db, store, storage, current: () => got[got.length - 1] }
}

console.log('\n1. An unlinked row: one UPDATE, one column')
{
  const { db, store, current } = await setup(ADAM, {})
  const now = current()
  const other = now.people.find((p) => p.id !== now.primaryPersonId)!
  store.save({ ...now, primaryPersonId: other.id }, now)
  await store.flush()
  check('exactly: update people <row> [linked_user_id]', JSON.stringify(brief(db.log)) === JSON.stringify([`update people ${other.id} [linked_user_id]`]), brief(db.log))
  check('the row is linked to me', linkOf(db, other.id) === ADAM)
}

console.log('\n2. Moving my link: the old row is cleared first')
{
  const { db, store, current } = await setup(ADAM, { [adamP.id]: ADAM })
  const now = current()
  check('resolved to my linked row to start with', now.primaryPersonId === adamP.id, now.primaryPersonId)
  store.save({ ...now, primaryPersonId: ellaP.id }, now)
  await store.flush()
  check('clear old, then link new, one column each', JSON.stringify(brief(db.log)) === JSON.stringify([`update people ${adamP.id} [linked_user_id]`, `update people ${ellaP.id} [linked_user_id]`]), brief(db.log))
  check('never two rows linked to me at once (unique index)', linkOf(db, adamP.id) === null && linkOf(db, ellaP.id) === ADAM)
}

console.log('\n3. A row linked to someone else')
{
  const { db, store, storage, current } = await setup(ADAM, { [adamP.id]: ADAM, [ellaP.id]: ELLA })
  const now = current()
  store.save({ ...now, primaryPersonId: ellaP.id }, now)
  await store.flush()
  check('Adam (already linked) viewing Ella: nothing written, her link kept', db.log.length === 0 && linkOf(db, ellaP.id) === ELLA, brief(db.log))
  check('the view still switches on this device', storage.map.get('k') === ellaP.id)
}
{
  // Before Ella joined, Adam tapped Set as me on her row (so it's linked to him, and his own row isn't).
  const { db, store, current } = await setup(ELLA, { [ellaP.id]: ADAM })
  const now = current()
  // Tap her row from the other one (her device may already resolve to it).
  const from = { ...now, primaryPersonId: adamP.id }
  store.save({ ...from, primaryPersonId: ellaP.id }, from)
  await store.flush()
  check('Ella (no link of her own) can claim her row from Adam: one column', linkOf(db, ellaP.id) === ELLA && db.log.every((s) => s.columns.join() === 'linked_user_id'), brief(db.log))
}

console.log('\n4. My person deleted: primaryPersonId moves, nothing is linked')
{
  const { db, store, current } = await setup(ADAM, { [adamP.id]: ADAM })
  const now = current()
  const next = removePersonFromData(now, adamP.id)
  check('the delete moved primaryPersonId to the other person', next.primaryPersonId === ellaP.id, next.primaryPersonId)
  store.save(next, now)
  await store.flush()
  check('no linked_user_id write (and no import: nothing else rewritten)', !db.log.some((s) => s.columns.includes('linked_user_id')) && db.log.every((s) => s.kind !== 'insert'), brief(db.log).slice(0, 6))
  check('Ella\'s row stays unlinked', linkOf(db, ellaP.id) === null)
}

console.log('\n5. Import and Start fresh link the new "Me"')
{
  const db = new FakeSyncDb()
  db.seed({ categories: defaultCategories().map((c, i) => ({ id: `${c.id}@${HH}`, household_id: HH, name: c.name, icon: c.icon, icon_color: c.iconColor, is_built_in: !!c.isBuiltIn, position: i })) })
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: ADAM, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: quiet })
  const empty = (await store.load())!
  store.save(backup, empty)
  await store.flush()
  const newMe = store.importMap!.get(backup.primaryPersonId)!
  const insertAt = db.log.findIndex((s) => s.kind === 'insert' && s.table === 'people' && s.id === newMe)
  const linkAt = db.log.findIndex((s) => s.kind === 'update' && s.table === 'people' && s.id === newMe)
  check('import: the backup\'s own "Me" (new id) is linked to the importer', linkOf(db, newMe) === ADAM)
  check('inserted first, then linked (the insert carries no linked_user_id)', insertAt !== -1 && linkAt > insertAt && !db.log[insertAt].columns.includes('linked_user_id'), { insertAt, linkAt })
  check('only that one row is linked', [...db.tables.get('people')!.values()].filter((r) => r.linked_user_id).length === 1)

  // A second import into the same household moves the link to the new "Me".
  const got: AppDataV2[] = []
  store.subscribe!((d) => got.push(d))
  await tick(30)
  const cur = got[got.length - 1]
  db.clearLog()
  store.save(parseLedgerBackupJson(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15.json', 'utf8')), cur)
  await store.flush()
  const second = store.importMap!.get(backup.primaryPersonId)!
  const clearAt = db.log.findIndex((s) => s.kind === 'update' && s.id === newMe && s.columns.join() === 'linked_user_id')
  const relinkAt = db.log.findIndex((s) => s.kind === 'update' && s.id === second)
  check('restore again: old "Me" cleared before anything else, new "Me" linked last', clearAt === 0 && relinkAt === db.log.length - 1 && linkOf(db, second) === ADAM, { clearAt, relinkAt, n: db.log.length })
}
{
  const db = new FakeSyncDb()
  db.seed({ categories: defaultCategories().map((c, i) => ({ id: `${c.id}@${HH}`, household_id: HH, name: c.name, icon: c.icon, icon_color: c.iconColor, is_built_in: !!c.isBuiltIn, position: i })) })
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: ELLA, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: quiet })
  const empty = (await store.load())!
  const d = defaultLedgerData() // SyncRoot's Start fresh
  store.save({ ...empty, people: d.people, payCycles: d.payCycles, primaryPersonId: d.primaryPersonId }, empty)
  await store.flush()
  check('Start fresh: the new "Me" is linked, and it was not treated as an import (id kept)', linkOf(db, d.primaryPersonId) === ELLA && store.importMap === null)
}

console.log('\n6. Another device resolves to the linked row (§23)')
{
  const { db, store, current } = await setup(ADAM, {})
  const now = current()
  const pick = now.people.find((p) => p.id !== now.primaryPersonId)!
  store.save({ ...now, primaryPersonId: pick.id }, now)
  await store.flush()
  const other = createPowerSyncLedgerStore({ db, householdId: HH, userId: ADAM, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: quiet })
  check('a second device with no choice of its own shows the linked person', (await other.load())!.primaryPersonId === pick.id)
  const rows = toRows(backup, { householdId: HH })
  const partial = new FakeSyncDb()
  partial.seed({ ...rows, people: rows.people.filter((r) => r.id !== pick.id) })
  const late = createPowerSyncLedgerStore({ db: partial, householdId: HH, userId: ADAM, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: quiet })
  const seen: AppDataV2[] = []
  late.subscribe!((d) => seen.push(d))
  await tick(30)
  partial.seed({ people: [{ ...rows.people.find((r) => r.id === pick.id)!, linked_user_id: ADAM }] })
  partial.remoteChange('people', pick.id, {})
  await tick(30)
  check('when the linked row arrives late it is re-preferred, not locked on the first', seen[0]?.primaryPersonId !== pick.id && seen[seen.length - 1].primaryPersonId === pick.id)
  check('and resolving it wrote nothing', partial.log.length === 0, brief(partial.log))
}

console.log(failures === 0 ? '\nAll Set as me checks passed.' : `\nFAIL: ${failures} Set as me check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
