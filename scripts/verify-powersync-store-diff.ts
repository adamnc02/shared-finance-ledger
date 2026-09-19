// PROMPT-09 (2026-09-19) — powerSyncLedgerStore's save(): narrow writes only.
//
// PowerSync resolves conflicts per column, and the whole table split rests on
// every write touching only what changed (DECISIONS Q2, HARD RULE). Runs the
// real store and the real writes.ts against an in-memory database
// (scripts/lib/fakeSyncDb.ts) holding Adam's real backup.
//
//  1. no change → no writes (including the provider's first save(data, data));
//  2. one field edit → ONE update of ONE column; two edits → two, one column each;
//  3. data delivered through subscribe is never written back (the echo);
//  4. deleting an item deletes its child rows first and renumbers nothing;
//  5. new items get positions after / between their neighbours, and a later
//     read returns the app's order;
//  6. FK order: inserts parent-first, then updates, then deletes child-first —
//     re-pointing a bill off a pot reaches the server before the pot's delete;
//  7. a whole import into an empty household (35 seeded categories) lands and
//     reads back as the backup, with categories suffixed in every write;
//  8. a remote change from the other device arrives through subscribe and is
//     not echoed.

import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { defaultCategories } from '../src/lib/categories'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { toRows } from '../src/lib/powersync/mapping'
import { createPowerSyncLedgerStore } from '../src/lib/store/powerSyncLedgerStore'
import type { AppDataV2 } from '../src/types/ledger'
import { FakeSyncDb, memoryStorage, tick } from './lib/fakeSyncDb'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', JSON.stringify(detail).slice(0, 1200))
  }
}

const HH = '11111111-2222-3333-4444-555555555555'
const USER = 'user-adam'
const BACKUP = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15.json'
const quiet = { error: (...a: unknown[]) => console.log('    [log.error]', ...a), warn: () => {}, info: () => {} }

async function storeWith(data: AppDataV2 | null) {
  const db = new FakeSyncDb()
  if (data) db.seed(toRows(data, { householdId: HH }))
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: USER, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: quiet })
  const loaded = (await store.load())!
  return { db, store, loaded }
}

const backup = parseLedgerBackupJson(readFileSync(BACKUP, 'utf8'))

console.log('\n1. No change, no writes')
{
  const { db, store, loaded } = await storeWith(backup)
  store.save(loaded, loaded)
  store.save({ ...loaded }, loaded)
  await store.flush()
  check('save(data, data) and a shallow copy write nothing', db.log.length === 0, db.log)
}

console.log('\n2. One field edit → one column')
{
  const { db, store, loaded } = await storeWith(backup)
  const t = loaded.recurringTemplates[3]
  const next = { ...loaded, recurringTemplates: loaded.recurringTemplates.map((x) => (x.id === t.id ? { ...x, amount: x.amount + 1 } : x)) }
  store.save(next, loaded)
  await store.flush()
  check('exactly one statement', db.log.length === 1, db.log)
  check(`UPDATE recurring_templates SET amount only (${t.name})`, isDeepStrictEqual(db.log[0], { kind: 'update', table: 'recurring_templates', id: t.id, columns: ['amount'] }), db.log[0])

  db.clearLog()
  const person = next.people[0]
  const card = next.creditCards[0]
  const next2 = {
    ...next,
    people: next.people.map((p) => (p.id === person.id ? { ...p, name: p.name + '!' } : p)),
    creditCards: next.creditCards.map((c) => (c.id === card.id ? { ...c, active: !c.active } : c)),
  }
  store.save(next2, next)
  await store.flush()
  check('two edits in two tables → two updates, one column each',
    db.log.length === 2 && db.log.every((s) => s.kind === 'update' && s.columns.length === 1) &&
    db.log.some((s) => s.table === 'people' && s.columns[0] === 'name') && db.log.some((s) => s.table === 'credit_cards' && s.columns[0] === 'active'), db.log)
  check('the boolean went to SQLite as 1/0', [0, 1].includes(db.tables.get('credit_cards')!.get(card.id)!.active as number))

  db.clearLog()
  const withNote = { ...next2, transactions: next2.transactions.map((x, i) => (i === 0 ? { ...x, note: 'edited' } : x)) }
  store.save(withNote, next2)
  await store.flush()
  check('an edit to a transaction note touches only `note`', db.log.length === 1 && isDeepStrictEqual(db.log[0].columns, ['note']), db.log)
}

console.log('\n3. Our own delivery is never written back')
{
  const { db, store } = await storeWith(backup)
  const delivered: { data: AppDataV2; wholesale: boolean }[] = []
  const unsub = store.subscribe!((data, wholesale) => delivered.push({ data, wholesale }))
  await tick(20)
  check('first delivery arrives, wholesale', delivered.length === 1 && delivered[0].wholesale)
  store.save(delivered[0].data, delivered[0].data)
  await store.flush()
  check('save(delivered) writes nothing', db.log.length === 0, db.log)

  // An edit, then its own echo.
  const d = delivered[0].data
  const edited = { ...d, pots: d.pots.map((p, i) => (i === 0 ? { ...p, name: p.name + ' 2' } : p)) }
  store.save(edited, d)
  await store.flush()
  await tick(20)
  check('the edit wrote one column', db.log.length === 1 && db.log[0].columns.length === 1, db.log)
  const echo = delivered[delivered.length - 1]
  check('the change came back through subscribe, not wholesale', delivered.length === 2 && echo.wholesale === false && echo.data.pots[0].name.endsWith(' 2'))
  db.clearLog()
  store.save(echo.data, edited)
  await store.flush()
  check('and saving that echo writes nothing', db.log.length === 0, db.log)
  unsub()
}

console.log('\n4. Deletes: children first, nothing renumbered')
{
  const { db, store, loaded } = await storeWith(backup)
  const withOverrides = loaded.recurringTemplates.find((t) => (t.occurrenceOverrides?.length ?? 0) > 0)
  check('Adam\'s backup has a bill with occurrence overrides', !!withOverrides)
  if (withOverrides) {
    const next = { ...loaded, recurringTemplates: loaded.recurringTemplates.filter((t) => t.id !== withOverrides.id) }
    store.save(next, loaded)
    await store.flush()
    const overrideDeletes = db.log.filter((s) => s.kind === 'delete' && s.table === 'recurring_template_occurrence_overrides')
    const templateDelete = db.log.findIndex((s) => s.kind === 'delete' && s.table === 'recurring_templates')
    check(`its ${withOverrides.occurrenceOverrides!.length} override row(s) deleted`, overrideDeletes.length === withOverrides.occurrenceOverrides!.length, db.log)
    check('before the bill itself', templateDelete > db.log.lastIndexOf(overrideDeletes[overrideDeletes.length - 1]))
    check('no other row was touched (no renumbering)', db.log.every((s) => s.kind === 'delete'), db.log.filter((s) => s.kind !== 'delete'))
  }
}

console.log('\n5. Positions for new items, and the order reads back')
{
  const { db, store, loaded } = await storeWith(backup)
  const cats = loaded.categories
  const custom = { id: 'cat-new-mid', name: 'Mid', icon: 'home', iconColor: '#fff' }
  const next = { ...loaded, categories: [...cats.slice(0, 2), custom, ...cats.slice(2), { id: 'cat-new-end', name: 'End', icon: 'home', iconColor: '#fff' }] }
  store.save(next, loaded)
  await store.flush()
  const p = (id: string) => db.tables.get('categories')!.get(`${id}@${HH}`)?.position as number
  check('mid-list insert sits between its neighbours', p(cats[1].id) < p('cat-new-mid') && p('cat-new-mid') < p(cats[2].id), [p(cats[1].id), p('cat-new-mid'), p(cats[2].id)])
  check('append sits after the last', p('cat-new-end') > p(cats[cats.length - 1].id))
  check('only two inserts, no renumbering', db.log.length === 2 && db.log.every((s) => s.kind === 'insert'), db.log)
  const reread = (await createPowerSyncLedgerStore({ db, householdId: HH, userId: USER, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: quiet }).load())!
  check('a fresh read returns the app\'s order', isDeepStrictEqual(reread.categories.map((c) => c.id), next.categories.map((c) => c.id)))

  db.clearLog()
  const swapped = { ...next, people: [...next.people].reverse() }
  store.save(swapped, next)
  await store.flush()
  check('swapping two people moves one row\'s position only', db.log.length === 1 && isDeepStrictEqual(db.log[0].columns, ['position']), db.log)
}

console.log('\n6. FK order: inserts, then updates, then deletes (child first)')
{
  const { db, store, loaded } = await storeWith(backup)
  const pot = loaded.pots[0]
  const onPot = loaded.recurringTemplates.filter((t) => t.potId === pot.id || t.transferTo?.potId === pot.id || t.transferFrom?.potId === pot.id)
  check(`Adam's pot "${pot?.name}" has bills/transfers on it`, onPot.length > 0)
  const newPerson = { id: 'person-new', name: 'New', color: '#fff', salaryHistory: [], salaryOverrides: [] }
  const newPot = { id: 'pot-new', personId: 'person-new', name: 'New pot', openingBalance: 0, openingDate: '2026-09-19', active: true, color: '#fff' }
  const next: AppDataV2 = {
    ...loaded,
    people: [...loaded.people, newPerson],
    pots: [...loaded.pots.filter((p) => p.id !== pot.id), newPot],
    recurringTemplates: loaded.recurringTemplates
      .filter((t) => !(t.transferTo?.potId === pot.id || t.transferFrom?.potId === pot.id))
      .map((t) => (t.potId === pot.id ? { ...t, location: 'personal' as const, potId: undefined } : t)),
  }
  store.save(next, loaded)
  await store.flush()
  const idx = (pred: (s: (typeof db.log)[number]) => boolean) => db.log.findIndex(pred)
  const personIns = idx((s) => s.kind === 'insert' && s.table === 'people')
  const potIns = idx((s) => s.kind === 'insert' && s.table === 'pots')
  const lastInsert = db.log.map((s) => s.kind).lastIndexOf('insert')
  const firstUpdate = db.log.map((s) => s.kind).indexOf('update')
  const lastUpdate = db.log.map((s) => s.kind).lastIndexOf('update')
  const firstDelete = db.log.map((s) => s.kind).indexOf('delete')
  const potDel = idx((s) => s.kind === 'delete' && s.table === 'pots')
  check('new person inserted before the pot that references it', personIns !== -1 && personIns < potIns, db.log)
  check('all inserts before all updates before all deletes', lastInsert < firstUpdate || firstUpdate === -1 ? (lastUpdate === -1 || lastUpdate < firstDelete) : false, db.log.map((s) => s.kind))
  check('the pot is deleted after the templates referencing it are deleted/re-pointed', potDel === db.log.length - 1 || db.log.slice(potDel + 1).every((s) => s.kind === 'delete' && s.table === 'pots'), db.log.slice(potDel))
}

console.log('\n7. Import into an empty household (35 categories seeded server-side)')
{
  const db = new FakeSyncDb()
  db.seed({ categories: defaultCategories().map((c, i) => ({ id: `${c.id}@${HH}`, household_id: HH, name: c.name, icon: c.icon, icon_color: c.iconColor, is_built_in: !!c.isBuiltIn, position: i })) })
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: USER, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: quiet })
  const empty = (await store.load())!
  check('empty household: 35 categories, no people', empty.categories.length === 35 && empty.people.length === 0, { cats: empty.categories.length, people: empty.people.length })
  store.save(backup, empty)
  await store.flush()
  const inserts = db.log.filter((s) => s.kind === 'insert')
  const catWrites = db.log.filter((s) => s.table === 'categories')
  const seeded = new Set(defaultCategories().map((c) => `${c.id}@${HH}`))
  const expectedInserts = Object.values(toRows(backup, { householdId: HH })).flat().filter((r) => !seeded.has(r.id)).length
  check(`${inserts.length} rows inserted: every backup row not already seeded (${expectedInserts})`, inserts.length === expectedInserts)
  check('every category write carries the household suffix', catWrites.every((s) => s.id.endsWith('@' + HH)), catWrites.slice(0, 3))
  check('a seeded category the backup kept unchanged is not rewritten',
    !catWrites.some((s) => s.id === `category-credit-card@${HH}` && s.kind !== 'update'))
  const reread = (await createPowerSyncLedgerStore({ db, householdId: HH, userId: USER, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: quiet }).load())!
  const strip = (d: AppDataV2) => JSON.parse(JSON.stringify({ ...d, primaryPersonId: '' }, (k, v) => (k === 'payee' && v === '' ? undefined : Array.isArray(v) && v.length === 0 && ['occurrenceOverrides', 'recurringDepositOverrides', 'interestOverrides', 'minimumPaymentOverrides', 'statementCalibrationLines'].includes(k) ? undefined : v)))
  check('reading it back gives the backup (people, bills, loans, cards, pots, transactions, categories)', isDeepStrictEqual(strip(reread), strip(backup)))
  check('and the store picked a primary person', reread.people.some((p) => p.id === reread.primaryPersonId))
}

console.log('\n8. A change from the other device arrives and is not echoed')
{
  const { db, store } = await storeWith(backup)
  const delivered: AppDataV2[] = []
  store.subscribe!((data) => delivered.push(data))
  await tick(20)
  const first = delivered[0]
  const bill = first.recurringTemplates[0]
  db.remoteChange('recurring_templates', bill.id, { name: 'Renamed on Ella\'s phone' })
  await tick(20)
  const latest = delivered[delivered.length - 1]
  check('the rename arrives', latest.recurringTemplates[0].name === 'Renamed on Ella\'s phone')
  store.save(latest, first)
  await store.flush()
  check('saving it writes nothing', db.log.length === 0, db.log)
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)
