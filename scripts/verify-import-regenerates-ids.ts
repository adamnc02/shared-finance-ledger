// PROMPT-10 Part 3 (2026-09-19) — an import gets fresh ids (MIGRATION-LESSONS
// §31, §22, §36; Adam, 2026-09-19).
//
// One backup imported into two households must not share a row id (the
// second upload would be refused, 23505/42501, and silently discarded), and
// restoring twice must leave no duplicate and no dangling reference.
//
//  1. regenerateIds, on the real backups AND the synthetic fixture
//     (scripts/lib/syntheticFixture.ts — PROMPT-12 Part 4, 2026-09-23: the
//     pension/savings-pot overrides and the salary sort no real file
//     carries): every id but the 35 fixed
//     categories is new; no old id survives ANYWHERE; mapping the result back
//     gives the original exactly (so every reference was remapped, and nothing
//     else changed); each field the prompt lists is covered;
//  2. auto-cleared payments: 'auto:<key>' is re-derived from the remapped
//     transaction (deterministic, and different per household);
//  3. through the store: every dataset imported into two households
//     shares no row id (fails on the PROMPT-09 store, which kept the backup's);
//  4. restore twice into one household (§22): the same rows, no duplicate, no
//     new dangling reference, and a real edit afterwards is not an import.

import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { defaultCategories } from '../src/lib/categories'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { dedupeKey } from '../src/lib/projection'
import { FIXED_CATEGORY_IDS, applyIdMap, regenerateIds } from '../src/lib/powersync/importIds'
import { createPowerSyncLedgerStore } from '../src/lib/store/powerSyncLedgerStore'
import type { AppDataV2 } from '../src/types/ledger'
import { FakeSyncDb, memoryStorage, tick } from './lib/fakeSyncDb'
import { buildSyntheticFixture } from './lib/syntheticFixture'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', JSON.stringify(detail).slice(0, 800))
  }
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/'
const BACKUPS = { adam: 'finance-ledger-backup-2026-09-15.json', mum: 'finance-ledger-backup-2026-09-17-mum.json', mum20: 'finance-ledger-backup-2026-09-20-mum.json' }
const SYNTHETIC = 'synthetic'
const read = (f: string): AppDataV2 => (f === SYNTHETIC ? buildSyntheticFixture().data : parseLedgerBackupJson(readFileSync(DIR + f, 'utf8')))
const DATASETS = { ...BACKUPS, synthetic: SYNTHETIC }
const quiet = { error: (...a: unknown[]) => console.log('    [log.error]', ...a), warn: () => {}, info: () => {} }

/** Every `id` of every object, anywhere. */
function objectIds(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => objectIds(v, out))
  else if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'string') out.add(id)
    Object.values(value).forEach((v) => objectIds(v, out))
  }
  return out
}
/** Every string value, anywhere. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out))
  return out
}
/** Values of the given key, anywhere. */
function valuesOf(value: unknown, key: string, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => valuesOf(v, key, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === key && typeof v === 'string' && v) out.push(v)
      valuesOf(v, key, out)
    }
  }
  return out
}

// The reference fields PROMPT-10 Part 3 lists (by key name, at any depth).
const REFERENCE_KEYS = [
  'ownerId', 'payee', 'personId', 'potId', 'savingsPotId', 'creditCardId', 'categoryId', 'sourceId', 'transactionId',
  'pensionId', 'linkedTargetId', 'linkedLoanId', 'loanId', 'primaryPersonId',
]

/** References (by the keys above) that point at no object in the data. */
function dangling(d: AppDataV2): string[] {
  const ids = objectIds(d)
  return REFERENCE_KEYS.flatMap((k) => valuesOf(d, k).filter((v) => !ids.has(v)).map((v) => `${k}:${v}`)).sort()
}

console.log('\n1. regenerateIds on the real backups and the synthetic fixture')
{
  // Not vacuous (§53): the fixture really does carry the shapes this file was extended for.
  const f = read(SYNTHETIC)
  const sort = f.salarySorts[0]
  check('the synthetic fixture carries a pension override, both savings-pot override lists and a salary sort with targets',
    f.pensions.some((p) => (p.occurrenceOverrides?.length ?? 0) > 0) && f.savingsPots.some((p) => (p.interestOverrides?.length ?? 0) > 0 && (p.recurringDepositOverrides?.length ?? 0) > 0) &&
      sort?.targets.length === 2 && sort.id.startsWith('sort:'),
    { pensions: f.pensions.length, sorts: f.salarySorts.length })
  // The derived sort id `sort:<personId>:<payDate>` embeds a person id (PROMPT-11), so it must be
  // remapped to `sort:<newPersonId>:…` — the "no old id survives INSIDE a value" check below is
  // what catches a sort left carrying the old household's person.
  const { data: out, map } = regenerateIds(f)
  const newPerson = map.get(f.people[0].id)!
  // 🚨 CONTROL for the PROMPT-12 fix: before it, every one of these came out a nanoid (the generic
  // walk took the 'sort:' id first and the re-derivation, keyed on the prefix, never saw it).
  check('the salary sort\'s derived id is rebuilt around the NEW person id — not handed a nanoid',
    out.salarySorts[0].id === `sort:${newPerson}:2026-09-25` && out.salarySorts[0].personId === newPerson,
    { id: out.salarySorts[0].id, personId: out.salarySorts[0].personId })
  check('its targets and their transfers are derived from it too (sort:…:<destination>[:tx]), and the transfers point back at it',
    out.salarySorts[0].targets.every((t) => t.id.startsWith(`${out.salarySorts[0].id}:`) && t.transactionId === `${t.id}:tx` &&
      out.transactions.some((x) => x.id === t.transactionId && x.sourceId === out.salarySorts[0].id)),
    out.salarySorts[0].targets.map((t) => [t.id, t.transactionId]))
  // 🚨 A moved occurrence keeps its SLOT across an import (mum's 2026-09-20 backup has two such rows).
  const movedIn = f.transactions.find((t) => t.id.startsWith('auto:') && t.occurrenceOriginalDate === '2026-09-20')!
  const movedOut = out.transactions.find((t) => t.occurrenceOriginalDate === '2026-09-20' && t.sourceId === map.get(movedIn.sourceId!))!
  check('a moved, auto-cleared occurrence keeps the slot date in its id after an import (§1.5a), with the source id remapped',
    movedOut?.id === `auto:recurring_template:${map.get(movedIn.sourceId!)}:2026-09-20` && movedOut.date === '2026-09-21',
    { before: movedIn.id, after: movedOut?.id, date: movedOut?.date })
}
for (const [name, file] of Object.entries(DATASETS)) {
  const original = read(file)
  const before = JSON.stringify(original)
  const { data: out, map } = regenerateIds(original)
  const composite = (id: string) => id.startsWith('auto:') || id.startsWith('sort:')
  const oldIds = [...objectIds(original)].filter((id) => !FIXED_CATEGORY_IDS.has(id) && !composite(id))
  const oldComposite = [...objectIds(original)].filter(composite)
  check(`${name}: input untouched`, JSON.stringify(original) === before)
  check(`${name}: every one of ${oldIds.length} non-fixed ids has a new id`, oldIds.every((id) => map.has(id) && map.get(id) !== id), oldIds.filter((id) => !map.has(id)).slice(0, 5))
  // Composite ids (auto:, sort:) are re-derived from the ids inside them, never handed a nanoid —
  // so they are not in the map, they still changed, and they kept their shape.
  const newComposite = [...objectIds(out)].filter(composite)
  check(`${name}: the ${oldComposite.length} composite auto:/sort: ids are re-derived (changed, same prefix and shape, not in the map)`,
    oldComposite.every((id) => !map.has(id)) && newComposite.length === oldComposite.length &&
      newComposite.every((id) => !oldComposite.includes(id) && oldComposite.some((o) => o.split(':').length === id.split(':').length && o.split(':')[0] === id.split(':')[0])),
    { old: oldComposite.slice(0, 3), new: newComposite.slice(0, 3) })
  check(`${name}: the 35 fixed category ids are kept`, FIXED_CATEGORY_IDS.size === 35 && [...FIXED_CATEGORY_IDS].every((id) => !map.has(id)) &&
    out.categories.filter((c) => FIXED_CATEGORY_IDS.has(c.id)).length === original.categories.filter((c) => FIXED_CATEGORY_IDS.has(c.id)).length)
  const all = strings(out)
  const survivors = oldIds.filter((id) => all.some((s) => s.includes(id)))
  check(`${name}: no old id survives anywhere (as a value or inside one)`, survivors.length === 0, survivors.slice(0, 5))
  const back = new Map([...map].map(([o, n]) => [n, o]))
  check(`${name}: mapped back, the result IS the original (every reference remapped, nothing else changed)`, isDeepStrictEqual(applyIdMap(out, back), original))
  const covered = REFERENCE_KEYS.map((k) => {
    const was = valuesOf(original, k).filter((v) => map.has(v)).length
    const now = valuesOf(out, k).filter((v) => map.has(v)).length
    return { k, was, now }
  })
  check(`${name}: each listed reference field is remapped (${covered.filter((c) => c.was > 0).map((c) => `${c.k} ${c.was}`).join(', ')})`,
    covered.every((c) => c.now === 0), covered.filter((c) => c.now > 0))
  check(`${name}: dangling references unchanged in number (${dangling(original).length}, e.g. DMR §11.2's sourceId)`, dangling(out).length === dangling(original).length)
  const again = regenerateIds(original)
  const shared = [...objectIds(out)].filter((id) => objectIds(again.data).has(id) && !FIXED_CATEGORY_IDS.has(id))
  check(`${name}: two imports share no id but the fixed categories`, shared.length === 0, shared.slice(0, 5))
}

console.log('\n2. Auto-cleared payments (auto:<dedupeKey>, §36)')
{
  const adam = read(BACKUPS.adam)
  const cleared = autoClearDuePayments(adam, new Date('2026-12-31T12:00:00'))
  const autos = cleared.transactions.filter((t) => t.id.startsWith('auto:'))
  check(`the backup auto-clears into ${autos.length} auto: payments to test with`, autos.length > 0)
  const a = regenerateIds(cleared).data.transactions.filter((t) => t.id.startsWith('auto:'))
  const b = regenerateIds(cleared).data.transactions.filter((t) => t.id.startsWith('auto:'))
  check('each is still auto:<its own key>, from the remapped fields', a.length === autos.length && a.every((t) => t.id === `auto:${dedupeKey(t)}`), a.slice(0, 2).map((t) => t.id))
  check('none keeps its old id', a.every((t) => !autos.some((o) => o.id === t.id)))
  check('two imports give different auto ids', a.every((t) => !b.some((u) => u.id === t.id)))
}

async function importInto(householdId: string, data: AppDataV2) {
  const db = new FakeSyncDb()
  db.seed({ categories: defaultCategories().map((c, i) => ({ id: `${c.id}@${householdId}`, household_id: householdId, name: c.name, icon: c.icon, icon_color: c.iconColor, is_built_in: !!c.isBuiltIn, position: i })) })
  const store = createPowerSyncLedgerStore({ db, householdId, userId: `user-${householdId}`, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: quiet })
  const empty = (await store.load())!
  store.save(data, empty)
  await store.flush()
  return { db, store }
}
const rowIds = (db: FakeSyncDb) => new Set([...db.tables.entries()].flatMap(([t, rows]) => [...rows.keys()].map((id) => `${t}/${id}`)))

console.log('\n3. Through the store: one dataset into two households')
for (const [name, file] of Object.entries(DATASETS)) {
  const h1 = await importInto('aaaaaaaa-0000-0000-0000-000000000001', read(file))
  const h2 = await importInto('bbbbbbbb-0000-0000-0000-000000000002', read(file))
  const ids1 = rowIds(h1.db)
  const shared = [...rowIds(h2.db)].filter((id) => ids1.has(id))
  check(`${name}: ${ids1.size} rows in each, no row id shared between the households`, ids1.size > 40 && shared.length === 0, shared.slice(0, 5))
}

console.log('\n4. Restore twice into one household (§22)')
{
  const H = 'cccccccc-0000-0000-0000-000000000003'
  const { db, store } = await importInto(H, read(BACKUPS.mum))
  const got: AppDataV2[] = []
  store.subscribe!((d) => got.push(d))
  await tick(40)
  const afterFirst = rowIds(db).size
  const first = got[got.length - 1]
  store.save(read(BACKUPS.mum), first) // Wallet → Backup → restore the same file again
  await store.flush()
  await tick(40)
  const final = got[got.length - 1]
  const counts = (d: AppDataV2) => ({ people: d.people.length, bills: d.recurringTemplates.length, loans: d.loans.length, cards: d.creditCards.length, tx: d.transactions.length, cats: d.categories.length })
  check(`same number of rows as after one restore (${afterFirst})`, rowIds(db).size === afterFirst, { afterFirst, now: rowIds(db).size })
  check('the app sees one copy of everything', isDeepStrictEqual(counts(final), counts(read(BACKUPS.mum))), { final: counts(final), backup: counts(read(BACKUPS.mum)) })
  check('no dangling reference beyond the backup\'s own', dangling(final).length === dangling(read(BACKUPS.mum)).length, dangling(final).slice(0, 5))
  const people = db.tables.get('people')!
  check('the restored people are new rows, the first restore\'s are gone', [...people.keys()].every((id) => !first.people.some((p) => p.id === id)))
  db.clearLog()
  store.save({ ...final, loans: final.loans.map((l, i) => (i === 0 ? { ...l, name: l.name + ' (edited)' } : l)) }, final)
  await store.flush()
  check('a real edit afterwards is not an import: one UPDATE of one column', db.log.length === 1 && db.log[0].kind === 'update' && db.log[0].columns.join() === 'name', db.log)
}

console.log(failures === 0 ? '\nAll import-id checks passed.' : `\nFAIL: ${failures} import-id check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
