// PROMPT-10 Part 4 (2026-09-19) — "Set as me" writes people.linked_user_id
// (MIGRATION-LESSONS §18: a button named like the feature was never wired to
// it; §5; §23). Adam, 2026-09-19: Set as me = link + view.
//
// PROMPT-16 Parts A and B (2026-09-22) — the tap is EXPLICIT. LedgerContext
// calls store.setPrimaryPerson(id) before it changes primaryPersonId, and the
// store links on that, never on a state diff. Two live defects came from the
// diff (§39, one field down):
//   - Adam's production row was NEVER linked. His device always resolved to
//     his own row by choice, so tapping "Set as me" changed nothing, so the
//     diff saw nothing, so no link — and low-balance alerts are addressed
//     from the link, so they were silent, with no symptom in the app.
//   - The claim-back path (a user with no link takes a row linked to someone
//     else) was reachable from ANY save that moved the view.
//
// What this asserts:
//  1. a tap on an unlinked row → one UPDATE, one column, linked_user_id = me;
//  2. moving my link → my old row cleared FIRST, then the new one (the
//     (household, linked_user_id) unique index; the connector discards a
//     23505);
//  3. a tap on a row linked to someone else → view only, unless I have no
//     linked row at all (Ella claiming her row after Adam tapped it);
//  4. my person deleted (primaryPersonId moves as a side effect) → nothing;
//  5. an import links its own "Me" row (after inserting it); Start fresh
//     links the new "Me";
//  6. a fresh device (no choice of its own) resolves to the linked row, and
//     re-prefers it when it arrives late (§23);
//  7. 🚨 PROMPT-16 A2 — my person is ALREADY the view and unlinked: a tap
//     writes the link. (The control ran before the fix: nothing written.)
//  8. 🚨 PROMPT-16 A1/A3 — an ordinary save with NO tap never writes a
//     link, even when primaryPersonId moves, and even onto a row someone
//     else owns while I have no link. (Control before the fix: Ella's row
//     taken by Adam's device with nobody tapping anything.)
//  9. 🚨 PROMPT-16 B1 — identityAction: Adam's production shape (2 members,
//     resolved by choice, own row unlinked) heals; a row linked to someone
//     else is never touched; the people[0] fallback never heals.

import { readFileSync } from 'node:fs'
import { defaultCategories } from '../src/lib/categories'
import { removePersonFromData } from '../src/lib/deleteReassign'
import { defaultLedgerData, parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { toRows } from '../src/lib/powersync/mapping'
import { createPowerSyncLedgerStore, identityAction } from '../src/lib/store/powerSyncLedgerStore'
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

/** A household holding the backup, with the given links, and a store for `user` (with the server's trigger modelled). */
async function setup(user: string, links: Record<string, string>, choice?: string) {
  const db = new FakeSyncDb()
  db.actingUser = user
  const rows = toRows(backup, { householdId: HH })
  db.seed({ ...rows, people: rows.people.map((r) => ({ ...r, linked_user_id: links[r.id] ?? null })) })
  const storage = memoryStorage()
  if (choice) storage.setItem('k', choice)
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: user, firstSync: Promise.resolve(), storageKey: 'k', storage, log: quiet })
  const got: AppDataV2[] = []
  store.subscribe!((d) => got.push(d))
  await tick(30)
  db.clearLog()
  return { db, store, storage, current: () => got[got.length - 1] }
}

/** What LedgerContext.setPrimaryPerson does: tell the store, then change the state. */
function tap(store: ReturnType<typeof createPowerSyncLedgerStore>, now: AppDataV2, id: string) {
  store.setPrimaryPerson(id)
  store.save({ ...now, primaryPersonId: id }, now)
}

console.log('\n1. A tap on an unlinked row: one UPDATE, one column')
{
  const { db, store, current } = await setup(ADAM, {})
  const now = current()
  const other = now.people.find((p) => p.id !== now.primaryPersonId)!
  tap(store, now, other.id)
  await store.flush()
  check('exactly: update people <row> [linked_user_id]', JSON.stringify(brief(db.log)) === JSON.stringify([`update people ${other.id} [linked_user_id]`]), brief(db.log))
  check('the row is linked to me', linkOf(db, other.id) === ADAM)
  check('the server accepted it (a link to MYSELF is what the trigger allows)', db.rejected.length === 0, db.rejected)
}

console.log('\n2. Moving my link: the old row is cleared first')
{
  const { db, store, current } = await setup(ADAM, { [adamP.id]: ADAM })
  const now = current()
  check('resolved to my linked row to start with', now.primaryPersonId === adamP.id, now.primaryPersonId)
  tap(store, now, ellaP.id)
  await store.flush()
  check('clear old, then link new, one column each', JSON.stringify(brief(db.log)) === JSON.stringify([`update people ${adamP.id} [linked_user_id]`, `update people ${ellaP.id} [linked_user_id]`]), brief(db.log))
  check('never two rows linked to me at once (unique index)', linkOf(db, adamP.id) === null && linkOf(db, ellaP.id) === ADAM)
}

console.log('\n3. A tap on a row linked to someone else')
{
  const { db, store, storage, current } = await setup(ADAM, { [adamP.id]: ADAM, [ellaP.id]: ELLA })
  const now = current()
  tap(store, now, ellaP.id)
  await store.flush()
  check('Adam (already linked) viewing Ella: nothing written, her link kept', db.log.length === 0 && linkOf(db, ellaP.id) === ELLA, brief(db.log))
  check('the view still switches on this device', storage.map.get('k') === ellaP.id)
}
{
  // Before Ella joined, Adam tapped Set as me on her row (so it's linked to him, and his own row isn't).
  const { db, store, current } = await setup(ELLA, { [ellaP.id]: ADAM })
  const now = current()
  const from = { ...now, primaryPersonId: adamP.id }
  tap(store, from, ellaP.id)
  await store.flush()
  check('Ella (no link of her own) can claim her row from Adam, by TAPPING: one column', linkOf(db, ellaP.id) === ELLA && db.log.every((s) => s.columns.join() === 'linked_user_id'), brief(db.log))
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
  check("Ella's row stays unlinked", linkOf(db, ellaP.id) === null)
}

console.log('\n5. Import and Start fresh link the new "Me"')
{
  const db = new FakeSyncDb()
  db.actingUser = ADAM
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
  db.actingUser = ELLA
  db.seed({ categories: defaultCategories().map((c, i) => ({ id: `${c.id}@${HH}`, household_id: HH, name: c.name, icon: c.icon, icon_color: c.iconColor, is_built_in: !!c.isBuiltIn, position: i })) })
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: ELLA, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: quiet })
  const empty = (await store.load())!
  const d = defaultLedgerData() // SyncRoot's Start fresh
  store.setPrimaryPerson(d.primaryPersonId)
  store.save({ ...empty, people: d.people, payCycles: d.payCycles, primaryPersonId: d.primaryPersonId }, empty)
  await store.flush()
  check('Start fresh: the new "Me" is linked, and it was not treated as an import (id kept)', linkOf(db, d.primaryPersonId) === ELLA && store.importMap === null)
}

console.log('\n6. Another device resolves to the linked row (§23)')
{
  const { db, store, current } = await setup(ADAM, {})
  const now = current()
  const pick = now.people.find((p) => p.id !== now.primaryPersonId)!
  tap(store, now, pick.id)
  await store.flush()
  const other = createPowerSyncLedgerStore({ db, householdId: HH, userId: ADAM, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: quiet })
  check('a second device with no choice of its own shows the linked person', (await other.load())!.primaryPersonId === pick.id)
  check('…and knows it was resolved by the link', other.resolvedBy === 'link')
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

console.log('\n7. 🚨 PROMPT-16 A2 — my person is already the view, and unlinked: a tap writes the link')
{
  // Adam's production device: a stored choice pointing at his own row, which nobody ever linked.
  const { db, store, current } = await setup(ADAM, {}, adamP.id)
  const now = current()
  check('the view is already right (resolved by this device\'s choice)', now.primaryPersonId === adamP.id && store.resolvedBy === 'choice' && store.linkedPersonId === null)
  tap(store, now, adamP.id) // primaryPersonId does NOT change
  await store.flush()
  check('one UPDATE, one column, on my own row — even though the view did not move', JSON.stringify(brief(db.log)) === JSON.stringify([`update people ${adamP.id} [linked_user_id]`]), brief(db.log))
  check('the link is written', linkOf(db, adamP.id) === ADAM)
  // Control (documented, ran on 2026-09-22 before the fix): the same save with no
  // setPrimaryPerson() wrote nothing — a tap on the viewed person was a no-op.
  const again = await setup(ADAM, {}, adamP.id)
  again.store.save({ ...again.current() }, again.current())
  await again.store.flush()
  check('CONTROL: the same save with no tap still writes nothing (the tap is the only trigger)', again.db.log.length === 0, brief(again.db.log))
}

console.log('\n8. 🚨 PROMPT-16 A1/A3 — no tap, no link, whatever primaryPersonId did')
{
  // Adam's production state, one step worse: his person unlinked, and his view has
  // fallen onto Ella's row (linked to her). An ORDINARY save moves the view.
  const { db, store, current } = await setup(ADAM, { [ellaP.id]: ELLA })
  const now = current()
  store.save({ ...now, primaryPersonId: ellaP.id }, now) // no setPrimaryPerson: nobody tapped
  await store.flush()
  check("an ordinary save that moves the view writes NO link op", !db.log.some((s) => s.columns.includes('linked_user_id')), brief(db.log))
  check("Ella's row is still Ella's (the control before the fix: linked to user-adam)", linkOf(db, ellaP.id) === ELLA, linkOf(db, ellaP.id))
  // And the same state WITH a tap is the deliberate claim-back (case 3), still allowed.
  const claim = await setup(ADAM, { [ellaP.id]: ELLA })
  tap(claim.store, claim.current(), ellaP.id)
  await claim.store.flush()
  check('…while an explicit tap on it, with no link of my own, still claims it (case 3 kept)', linkOf(claim.db, ellaP.id) === ADAM)
}

console.log('\n9. 🚨 PROMPT-16 B1 — identityAction: heal the empty column, never anyone else\'s')
{
  // Adam's production shape: 2 members, Ella linked, Adam resolved by choice and unlinked.
  const { store, current } = await setup(ADAM, { [ellaP.id]: ELLA }, adamP.id)
  const action = identityAction(store, current().people, false)
  check('heals: link my chosen, unlinked row', action.kind === 'link' && action.personId === adamP.id && action.reason === 'self_heal', action)

  // The choice points at a row linked to someone else: never taken, and — since the person this
  // device was showing is now "someone else's" — the device is ASKED rather than left there.
  const other = await setup(ADAM, { [ellaP.id]: ELLA }, ellaP.id)
  const a2 = identityAction(other.store, other.current().people, false)
  check("a chosen row linked to someone else is never healed onto me", a2.kind !== 'link', a2)

  // Resolved by the people[0] FALLBACK (no choice, no link): not a heal — that would be guessing.
  const fb = await setup(ADAM, {})
  check('the fallback resolution is recognised as such', fb.store.resolvedBy === 'fallback')
  const a3 = identityAction(fb.store, fb.current().people, false)
  check('…and is never healed into a link; a device with no memory and no link is simply ready', a3.kind === 'ready', a3)

  // Already linked: nothing to do, whatever the choice says.
  const linked = await setup(ADAM, { [adamP.id]: ADAM }, ellaP.id)
  check('a linked account is ready, even while viewing someone else', identityAction(linked.store, linked.current().people, false).kind === 'ready')
}

console.log(failures === 0 ? '\nAll Set as me checks passed.' : `\nFAIL: ${failures} Set as me check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
