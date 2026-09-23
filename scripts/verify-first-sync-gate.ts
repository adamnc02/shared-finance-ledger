// PROMPT-09 (2026-09-19) — the first-sync gate (BUILD-PLAN 3.3a; Adam's Q9:
// "it must not push empty data"), the wholesale first delivery (3.3b), and
// the per-device primaryPersonId (DECISIONS Q3, MIGRATION-LESSONS §23).
//
// Three things write with nobody touching anything: defaultLedgerData()'s
// seed, migrateLedgerData()'s re-added built-ins and autoClearDuePayments. On
// a device that hasn't synced, any of them would push defaults/duplicates
// into the household. The gate lives inside the store, so LedgerContext.tsx
// stays identical everywhere.
//
//  1. before first sync: save() writes nothing — the default seed, an
//     auto-clear pass, or anything else; load() hasn't resolved; subscribe
//     delivers nothing;
//  2. after: load() resolves, the first delivery is wholesale and later ones
//     are not, and save() writes;
//  3. migrateLedgerData's backfill never writes (a missing built-in category
//     is re-derived on read, not pushed);
//  4. primaryPersonId: the row linked to me beats the first row, and is
//     re-preferred when it arrives LATE (§23); a choice made on this device
//     wins and survives a reload; a chosen person who's gone falls back;
//  5. the household changing under a running session (deleted on another
//     device, or moved) suspends the store: no stale ledger or new row is
//     written into the old household (UAT 2026-09-19, 16 RLS rejections).

import { readFileSync } from 'node:fs'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { defaultLedgerData, parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { toRows } from '../src/lib/powersync/mapping'
import { createPowerSyncLedgerStore } from '../src/lib/store/powerSyncLedgerStore'
import type { AppDataV2 } from '../src/types/ledger'
import { FakeSyncDb, deferred, memoryStorage, tick } from './lib/fakeSyncDb'

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
const ME = 'user-me'
const BACKUP = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-15.json'
const backup = parseLedgerBackupJson(readFileSync(BACKUP, 'utf8'))
let warnings = 0
let errors = 0
const log = { error: (...a: unknown[]) => (errors++, console.log('    [log.error]', ...a)), warn: () => void warnings++, info: () => {} }

console.log('\n1. Before first sync: nothing is written, nothing is read out')
const sync = deferred()
const db = new FakeSyncDb() // what an unsynced device holds: nothing
const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: ME, firstSync: sync.promise, storageKey: 'k', storage: memoryStorage(), log })
let loaded: AppDataV2 | null | undefined
void Promise.resolve(store.load()).then((d) => (loaded = d))
const deliveries: boolean[] = []
store.subscribe!((_d, wholesale) => deliveries.push(wholesale))

const seeded = defaultLedgerData() // the provider's fallback: 'Me' + built-in categories
store.save(seeded, seeded)
store.save({ ...seeded, categories: [...seeded.categories, { id: 'x', name: 'X', icon: 'home', iconColor: '#fff' }] }, seeded)
const cleared = autoClearDuePayments(backup)
store.save(cleared, backup)
store.save(backup, seeded)
await store.flush()
await tick(30)
check('store reports not synced', store.synced === false)
check('the default seed, an extra category, an auto-clear pass and a whole dataset: 0 writes', db.log.length === 0, db.log)
check('each refused save was logged', warnings === 4, warnings)
check('load() has not resolved', loaded === undefined)
check('subscribe has delivered nothing', deliveries.length === 0)

console.log('\n2. First sync completes')
db.seed(toRows(backup, { householdId: HH }))
sync.resolve()
await tick(30)
check('store reports synced', store.synced === true)
check('load() resolved with the synced data', !!loaded && loaded.transactions.length === backup.transactions.length)
check('the first delivery is wholesale (pages resync, APP-KNOWLEDGE §1.6)', deliveries[0] === true, deliveries)
const edited = { ...loaded!, people: loaded!.people.map((p, i) => (i === 0 ? { ...p, color: '#123456' } : p)) }
store.save(edited, loaded!)
await store.flush()
await tick(30)
check('save() now writes (one column)', db.log.length === 1 && db.log[0].columns.join() === 'color', db.log)
check('later deliveries are not wholesale', deliveries.length >= 2 && deliveries.slice(1).every((w) => w === false), deliveries)

console.log('\n3. migrateLedgerData never writes')
{
  const db2 = new FakeSyncDb()
  const rows = toRows(backup, { householdId: HH })
  rows.categories = rows.categories.filter((r) => r.id !== `category-savings@${HH}`) // a built-in missing server-side
  db2.seed(rows)
  const s2 = createPowerSyncLedgerStore({ db: db2, householdId: HH, userId: ME, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log })
  const d = (await s2.load())!
  check('the missing built-in is re-derived on read', d.categories.some((c) => c.id === 'category-savings'))
  s2.save(d, d)
  await s2.flush()
  check('and not pushed to the household (no write attempted at all)', db2.log.length === 0 && errors === 0, { log: db2.log, errors })
  const renamed = { ...d, categories: d.categories.map((c) => (c.id === 'category-savings' ? { ...c, name: 'Savings!' } : c)) }
  s2.save(renamed, d)
  await s2.flush()
  check('once the user edits it, it is inserted whole (not an UPDATE of a missing row)',
    db2.log.length === 1 && db2.log[0].kind === 'insert' && db2.log[0].id === `category-savings@${HH}` && errors === 0, { log: db2.log, errors })
}

console.log('\n4. primaryPersonId is per device, and re-preferred (§23)')
{
  const [adam, ella] = backup.people
  const rows = toRows(backup, { householdId: HH })
  const ellaRow = rows.people.find((r) => r.id === ella.id)!
  const db3 = new FakeSyncDb()
  // Partial delivery: only Adam's row has arrived; Ella (linked to ME) hasn't.
  db3.seed({ ...rows, people: rows.people.filter((r) => r.id !== ella.id) })
  const storage = memoryStorage()
  const s3 = createPowerSyncLedgerStore({ db: db3, householdId: HH, userId: ME, firstSync: Promise.resolve(), storageKey: 'k', storage, log })
  const got: AppDataV2[] = []
  s3.subscribe!((d) => got.push(d))
  await tick(30)
  check('partial data: falls back to the first person present', got[0]?.primaryPersonId === adam.id, got[0]?.primaryPersonId)
  db3.seed({ people: [{ ...ellaRow, linked_user_id: ME }] })
  db3.remoteChange('people', ella.id, {}) // her row arrives
  await tick(30)
  const latest = got[got.length - 1]
  check('when the row linked to me arrives, it is re-preferred (not locked on the first)', latest.primaryPersonId === ella.id, latest.primaryPersonId)
  check('nothing about that was written', db3.log.length === 0, db3.log)

  // PROMPT-16 Part A: "Set as me" is an explicit tap (setPrimaryPerson), never inferred from the
  // view moving — LedgerContext.setPrimaryPerson does exactly these two calls.
  s3.setPrimaryPerson(adam.id)
  s3.save({ ...latest, primaryPersonId: adam.id }, latest)
  await s3.flush()
  // PROMPT-10 (Adam, 2026-09-19): "Set as me" = link + view. The choice itself never syncs; the link
  // moves with it, as two one-column UPDATEs: my old row cleared first, then the new one
  // (verify-set-as-me.ts covers the rules).
  check('choosing a person: only linked_user_id is written (old row cleared, then the new one)',
    JSON.stringify(db3.log.map((s) => [s.id, s.columns])) === JSON.stringify([[ella.id, ['linked_user_id']], [adam.id, ['linked_user_id']]]), db3.log)
  check('the choice is remembered on this device', storage.map.get('k') === adam.id)
  const reload = createPowerSyncLedgerStore({ db: db3, householdId: HH, userId: ME, firstSync: Promise.resolve(), storageKey: 'k', storage, log })
  check('and wins over the linked row after a reload', (await reload.load())!.primaryPersonId === adam.id)
  storage.setItem('k', 'someone-deleted')
  const fallback = createPowerSyncLedgerStore({ db: db3, householdId: HH, userId: ME, firstSync: Promise.resolve(), storageKey: 'k', storage, log })
  check('a remembered person who no longer exists falls back to the linked row', (await fallback.load())!.primaryPersonId === adam.id)
}

console.log('\n5. The household changes under a running session (UAT 2026-09-19)')
{
  // A phone left open across "Delete my app data" on another device kept the old
  // household id; sync removed the old rows, and stale app state went back up as
  // fresh inserts into a household the user no longer belongs to (16 RLS rejections).
  const H1 = HH
  const H2 = '99999999-8888-7777-6666-555555555555'
  const member = (household: string) => ({ id: `m-${household}`, household_id: household, user_id: ME, joined_at: '2026-09-19' })
  const errorsBefore = errors
  for (const scenario of ['deleted', 'moved'] as const) {
    const db5 = new FakeSyncDb()
    db5.seed({ ...toRows(backup, { householdId: H1 }), household_members: [member(H1)] })
    let lost = ''
    const s5 = createPowerSyncLedgerStore({ db: db5, householdId: H1, userId: ME, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log, onHouseholdLost: (r) => (lost = r) })
    const got: AppDataV2[] = []
    s5.subscribe!((d) => got.push(d))
    await tick(30)
    const stale = got[0] // what the app still holds
    // The server's view now: household H1 gone (deleted), or the user now in H2 (moved by a link code).
    db5.remoteReplace(scenario === 'deleted' ? {} : { household_members: [member(H2)] })
    await tick(30)
    // The stale state comes back through save (autoClear, any edit, the new offline bill…).
    s5.save({ ...stale, recurringTemplates: [...stale.recurringTemplates, { ...stale.recurringTemplates[0], id: 'new-offline-bill' }] }, stale)
    await s5.flush()
    check(`${scenario}: nothing is written — no stale ledger, no new bill into the old household`, db5.log.length === 0, db5.log.slice(0, 5))
    check(`${scenario}: the boot sequence is told (${lost || 'not called'})`, lost !== '')
    check(`${scenario}: the store is suspended and delivers nothing more`, s5.suspended && got.length === 1, { suspended: s5.suspended, deliveries: got.length })
  }
  errors = errorsBefore // the suspension is logged as an error on purpose
  const db6 = new FakeSyncDb()
  db6.seed({ ...toRows(backup, { householdId: H1 }) }) // membership row not synced yet (a brand-new household)
  const s6 = createPowerSyncLedgerStore({ db: db6, householdId: H1, userId: ME, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log, onHouseholdLost: () => {} })
  const d6 = (await s6.load())!
  s6.save({ ...d6, people: d6.people.map((p, i) => (i === 0 ? { ...p, name: 'X' } : p)) }, d6)
  await s6.flush()
  check('a household whose membership row has not synced yet is NOT treated as lost', !s6.suspended && db6.log.length === 1, { suspended: s6.suspended, log: db6.log })
}

check('no errors were logged anywhere in this script', errors === 0, errors)
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)
