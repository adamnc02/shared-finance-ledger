// PROMPT-14 Part 4 (2026-09-22) — re-importing THIS household's own file is a
// surgical patch, not a full replace.
//
// The bug this prevents is a cost, not a crash, and that is why it survived:
// "export the JSON, fix one number, import it back" is the app's own answer to
// hand-editing, and until now it paid the FULL import price every time. Every
// row in 27 tables deleted and reinserted with new ids, Part 5's re-link
// needed, a wholesale delivery on both phones — to change one amount.
//
// 🚨 The predicate has two exclusions, and dropping either turns a genuinely
// FOREIGN backup into a "patch". That is the §31 failure — two households with
// the same row ids, the second one's upload refused 23505 and discarded
// silently by the connector — reintroduced through the front door:
//   - the 35 fixed category ids are kept by regenerateIds on purpose, so every
//     household has them and they prove nothing;
//   - `auto:` and `sort:` ids are DERIVED from the ids inside them.
// Sections 3 and 4 are the controls for exactly those two.
//
// What it asserts:
//  1. export → re-import unchanged writes ZERO ops;
//  2. one field edited writes exactly that field, on that row, and nothing
//     else — and the ids do not change;
//  3. a foreign backup still regenerates every id (§31 intact);
//  4. a foreign backup that shares only the fixed category ids is still
//     foreign — the control for exclusion one;
//  5. a trimmed file reports its deletions BEFORE applying them (§22), and the
//     count it reports is the count it then deletes;
//  6. an empty household importing a backup is still a full import, so a
//     first restore into a fresh account behaves as it always has.

import { readFileSync } from 'node:fs'
import { defaultLedgerData, parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { toRows } from '../src/lib/powersync/mapping'
import { FIXED_CATEGORY_IDS } from '../src/lib/powersync/importIds'
import { createPowerSyncLedgerStore, isSameHouseholdPatch, rowsRemovedByPatch } from '../src/lib/store/powerSyncLedgerStore'
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
const ME = 'user-me'
const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures'
const raw = readFileSync(`${DIR}/finance-ledger-backup-2026-09-15.json`, 'utf8')
const foreignRaw = readFileSync(`${DIR}/finance-ledger-backup-2026-09-17-mum.json`, 'utf8')
const silent = { error: () => {}, warn: () => {}, info: () => {} }

/** A synced device holding `data`, ready to be handed a restore. */
async function device(data: AppDataV2) {
  const db = new FakeSyncDb()
  db.seed(toRows(data, { householdId: HH }))
  const sync = deferred()
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: ME, firstSync: sync.promise, storageKey: 'k', storage: memoryStorage(), log: silent })
  sync.resolve()
  const loaded = (await store.load())!
  db.clearLog()
  return { db, store, loaded }
}

const backup = parseLedgerBackupJson(raw)

console.log('\n1. Export → re-import, unchanged: nothing is written')
{
  const { db, store } = await device(backup)
  store.save(parseLedgerBackupJson(raw), backup) // a fresh parse: no list is one the store has seen
  await store.flush()
  await tick(10)
  check('zero write ops', db.log.length === 0, db.log.slice(0, 6))
}

console.log('\n2. One field edited: exactly that field')
{
  const { db, store, loaded } = await device(backup)
  const edited = parseLedgerBackupJson(raw)
  const target = edited.people[1] ?? edited.people[0]
  const originalName = target.name
  target.name = `${originalName} (edited)`
  store.save(edited, loaded)
  await store.flush()
  await tick(10)
  check('exactly one op', db.log.length === 1, db.log.slice(0, 6))
  check('…an UPDATE on people', db.log[0]?.kind === 'update' && db.log[0]?.table === 'people', db.log[0])
  check('…of the one column that changed', JSON.stringify(db.log[0]?.columns) === '["name"]', db.log[0]?.columns)
  check('…on the row that already existed — no id churn', db.log[0]?.id === target.id, [db.log[0]?.id, target.id])
  check('the store did not treat it as an import', store.importMap === null, store.importMap)
}

console.log('\n3. A foreign backup still regenerates every id (§31 intact)')
{
  const { db, store, loaded } = await device(backup)
  const foreign = parseLedgerBackupJson(foreignRaw)
  check('the predicate says foreign', isSameHouseholdPatch(foreign, loaded) === false)
  store.save(foreign, loaded)
  await store.flush()
  await tick(10)
  const inserted = db.log.filter((s) => s.kind === 'insert' && s.table === 'people').map((s) => s.id)
  check('people rows were inserted with ids the file did not carry', inserted.length > 0 && inserted.every((id) => !foreign.people.some((p) => p.id === id)), inserted)
  check('an import map was recorded', (store.importMap?.size ?? 0) > 0)
}

console.log('\n4. CONTROL — sharing only the fixed category ids is NOT evidence')
{
  const { loaded } = await device(backup)
  const foreign = parseLedgerBackupJson(foreignRaw)
  const shared = foreign.categories.filter((c) => loaded.categories.some((o) => o.id === c.id)).map((c) => c.id)
  check('the two households really do share category ids', shared.length > 0, shared.slice(0, 4))
  check('…and every shared one is a FIXED id, not household data', shared.every((id) => FIXED_CATEGORY_IDS.has(id)))
  check('…so the file is still judged foreign', isSameHouseholdPatch(foreign, loaded) === false)

  // Without the exclusion, this is what the predicate would have said.
  const naive = foreign.categories.some((c) => loaded.categories.some((o) => o.id === c.id))
  check('a predicate without the exclusion would have called it a patch (the bug)', naive === true)
}

console.log('\n5. A trimmed file: the deletions are counted before they are applied (§22)')
{
  const { db, store, loaded } = await device(backup)
  const trimmed = parseLedgerBackupJson(raw)
  const dropped = trimmed.transactions.splice(0, 5).map((t) => t.id)
  const predicted = rowsRemovedByPatch(trimmed, loaded)
  check('it is still a patch', isSameHouseholdPatch(trimmed, loaded) === true)
  check('the count shown in the confirm is the 5 rows removed', predicted === dropped.length, [predicted, dropped.length])
  store.save(trimmed, loaded)
  await store.flush()
  await tick(10)
  const deletes = db.log.filter((s) => s.kind === 'delete')
  check('…and that is exactly what gets deleted', deletes.length === dropped.length && deletes.every((d) => dropped.includes(d.id)), deletes)
}

console.log('\n6. An empty household is still a full import')
{
  const { store, loaded } = await device(defaultLedgerData())
  check('the seed shares only fixed category ids, so nothing matches', isSameHouseholdPatch(parseLedgerBackupJson(raw), loaded) === false)
  store.save(parseLedgerBackupJson(raw), loaded)
  await store.flush()
  await tick(10)
  check('ids were regenerated, as a first restore always has', (store.importMap?.size ?? 0) > 0)
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
