// PROMPT-11 (2026-09-19) — Salary Sort across two devices
// (DATA-MODEL-REVIEW §9.5: "the most sync-fragile feature in the app").
//
// A sort is a record in one table, its targets are rows in another, and each
// target points at a REAL transfer transaction in a third. Offline that is one
// synchronous state update over one blob. Under PowerSync it is three tables,
// two devices and a network in between, so:
//
//  1. two devices sorting the SAME payday before either has synced converge on
//     ONE sort, ONE target per destination and ONE transfer — the ids are
//     derived from the person and the payday, so the upsert merges them
//     (MIGRATION-LESSONS §36). With per-device nanoids, the household gets two
//     of everything and the money moves twice;
//  2. two PEOPLE paid on the same date get a sort each, and each device reads
//     only its own (a sort was keyed on payDate alone until this prompt);
//  3. the two-way edit (amount changed on the transaction, or on the sort)
//     writes one column on each row, not a rewrite of either;
//  4. detaching (the date edited) deletes the target, and the sort with it when
//     that empties it, child row first;
//  5. a target whose transaction is gone on the other device is invisible to
//     the app and makes this device write NOTHING — a read must never turn a
//     partial view into deletes;
//  6. whose sort it is survives the round trip: it is derived from the owner of
//     the transfers, so there is no column to drift.

import { defaultCategories } from '../src/lib/categories'
import { defaultLedgerData, defaultPayCycleConfig, migrateLedgerData } from '../src/lib/ledgerStorage'
import { newSavingsPot } from '../src/lib/savingsPotLedger'
import { buildTransferTransaction } from '../src/lib/transferLedger'
import { salarySortId, salarySortTargetId, salarySortTransactionId } from '../src/lib/salarySortLedger'
import { fromRows, toRows } from '../src/lib/powersync/mapping'
import { createPowerSyncLedgerStore } from '../src/lib/store/powerSyncLedgerStore'
import type { AppDataV2, SalarySort } from '../src/types/ledger'
import { FakeSyncDb, memoryStorage } from './lib/fakeSyncDb'

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
const PAYDAY = '2026-01-28'
const quiet = { error: (...a: unknown[]) => console.log('    [log.error]', ...a), warn: () => {}, info: () => {} }
const ctx = { householdId: HH }

/** Two people, a savings pot, no sorts yet. */
function household(): AppDataV2 {
  const base = defaultLedgerData()
  const me = { ...base.people[0], id: 'adam-1', name: 'Adam' }
  const ella = { ...base.people[0], id: 'ella-1', name: 'Ella' }
  const pot = {
    id: 'pot-savings',
    ...newSavingsPot({
      personId: me.id,
      name: 'Savings',
      openingBalance: 0,
      openingDate: '2025-12-01',
      interestMethod: { type: 'simple', aer: 0 },
      color: '#ff5b4c',
    }),
  }
  return migrateLedgerData({
    ...base,
    people: [me, ella],
    primaryPersonId: me.id,
    payCycles: [defaultPayCycleConfig(me.id), defaultPayCycleConfig(ella.id)],
    savingsPots: [pot],
  })
}

/** What saveSalarySort produces, built with the same deterministic ids the provider uses. */
function withSort(data: AppDataV2, personId: string, payDate: string, amount: number, deviceSuffix?: string): AppDataV2 {
  const to = { type: 'savings' as const, savingsPotId: data.savingsPots[0].id }
  // `deviceSuffix` reproduces the OLD behaviour for the control case below: an id minted per save,
  // so two devices write two of everything instead of converging.
  const sortId = deviceSuffix ? `${salarySortId(personId, payDate)}-${deviceSuffix}` : salarySortId(personId, payDate)
  const targetId = salarySortTargetId(sortId, to)
  const txId = salarySortTransactionId(targetId)
  const transaction = buildTransferTransaction({ type: 'personal' }, to, amount, payDate, personId, {
    note: 'Salary Sort → Savings',
    sourceType: 'salary_sort',
    sourceId: sortId,
    id: txId,
  })
  const sort: SalarySort = { id: sortId, payDate, personId, targets: [{ id: targetId, to, amount, transactionId: txId }] }
  return { ...data, salarySorts: [...data.salarySorts, sort], transactions: [...data.transactions, transaction] }
}

function seedEmptyHousehold(db: FakeSyncDb, data: AppDataV2) {
  // Everything except the sort tables and the transfers: the state both devices start from.
  const rows = toRows({ ...data, salarySorts: [], transactions: [] }, ctx)
  db.seed({ ...rows, categories: defaultCategories().map((c, i) => ({ id: `${c.id}@${HH}`, household_id: HH, name: c.name, icon: c.icon, icon_color: c.iconColor, is_built_in: !!c.isBuiltIn, position: i })) })
}

async function storeFor(db: FakeSyncDb, userId = ADAM) {
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId, firstSync: Promise.resolve(), storageKey: `k-${userId}`, storage: memoryStorage(), log: quiet })
  const current = (await store.load())!
  return { store, current }
}

console.log('\n1. Two devices sort the same payday before either has synced')
{
  const base = household()
  const dbA = new FakeSyncDb()
  const dbB = new FakeSyncDb()
  seedEmptyHousehold(dbA, base)
  seedEmptyHousehold(dbB, base)
  const a = await storeFor(dbA)
  const b = await storeFor(dbB)
  a.store.save(withSort(a.current, 'adam-1', PAYDAY, 300), a.current)
  b.store.save(withSort(b.current, 'adam-1', PAYDAY, 300), b.current)
  await a.store.flush()
  await b.store.flush()

  // The server merges by primary key: device B's rows land on top of device A's.
  const bRows = await dbB.readAll()
  dbA.seed({ salary_sorts: bRows.salary_sorts, salary_sort_targets: bRows.salary_sort_targets, transactions: bRows.transactions })
  const merged = (await storeFor(dbA)).current
  check('one sort, not two', merged.salarySorts.length === 1, merged.salarySorts.map((s) => s.id))
  check('one target, not two', merged.salarySorts[0]?.targets.length === 1)
  const transfers = merged.transactions.filter((t) => t.sourceType === 'salary_sort')
  check('one transfer, not two: the money moves once', transfers.length === 1 && transfers[0].amount === 300, transfers.map((t) => `${t.id} ${t.amount}`))
  check('the ids say what they are (sort:<person>:<payday>)', merged.salarySorts[0]?.id === `sort:adam-1:${PAYDAY}`, merged.salarySorts[0]?.id)

  // Control: the SAME flow with per-device ids, which is what this had before (a nanoid per save).
  // Nothing merges, and the household ends up moving the money twice.
  const dbC = new FakeSyncDb()
  const dbD = new FakeSyncDb()
  seedEmptyHousehold(dbC, base)
  seedEmptyHousehold(dbD, base)
  const c = await storeFor(dbC)
  const d = await storeFor(dbD)
  c.store.save(withSort(c.current, 'adam-1', PAYDAY, 300, 'device-c'), c.current)
  d.store.save(withSort(d.current, 'adam-1', PAYDAY, 300, 'device-d'), d.current)
  await c.store.flush()
  await d.store.flush()
  const dRows = await dbD.readAll()
  dbC.seed({ salary_sorts: dRows.salary_sorts, salary_sort_targets: dRows.salary_sort_targets, transactions: dRows.transactions })
  const clashed = (await storeFor(dbC)).current
  check('control — with per-device ids the same flow gives two sorts and two transfers (£600 moved)',
    clashed.salarySorts.length === 2 && clashed.transactions.filter((t) => t.sourceType === 'salary_sort').reduce((sum, t) => sum + t.amount, 0) === 600,
    { sorts: clashed.salarySorts.length, transfers: clashed.transactions.filter((t) => t.sourceType === 'salary_sort').length })
}

console.log('\n2. Two people, one payday: a sort each, and each device sees only its own')
{
  const base = household()
  const db = new FakeSyncDb()
  seedEmptyHousehold(db, base)
  const a = await storeFor(db)
  const both = withSort(withSort(a.current, 'adam-1', PAYDAY, 300), 'ella-1', PAYDAY, 125)
  a.store.save(both, a.current)
  await a.store.flush()

  const adamView = (await storeFor(db, ADAM)).current
  check('two sorts on that payday, one per person', adamView.salarySorts.filter((s) => s.payDate === PAYDAY).length === 2)
  const mine = adamView.salarySorts.filter((s) => s.personId === adamView.primaryPersonId && s.payDate === PAYDAY)
  check("this device's own sort is the only one it reads for itself", mine.length === 1 && mine[0].targets[0].amount === 300, mine)
  const hers = adamView.salarySorts.filter((s) => s.personId === 'ella-1')
  check("the partner's sort is present but separate, with its own transfer", hers.length === 1 && hers[0].targets[0].amount === 125)
  const owners = adamView.transactions.filter((t) => t.sourceType === 'salary_sort').map((t) => t.ownerId).sort()
  check('one transfer each, owned by the right person', JSON.stringify(owners) === JSON.stringify(['adam-1', 'ella-1']), owners)

  // Control: the lookup this replaced — by payDate alone — hands you both people's sorts, which is
  // how one device came to read and overwrite the other's.
  const unscoped = adamView.salarySorts.filter((s) => s.payDate === PAYDAY)
  check('control — a payDate-only lookup returns BOTH people\'s sorts', unscoped.length === 2 && new Set(unscoped.map((s) => s.personId)).size === 2)
}

console.log('\n3. Editing the amount writes one column on each row')
{
  const base = household()
  const db = new FakeSyncDb()
  seedEmptyHousehold(db, base)
  const a = await storeFor(db)
  const sorted = withSort(a.current, 'adam-1', PAYDAY, 300)
  a.store.save(sorted, a.current)
  await a.store.flush()
  db.clearLog()

  // What LedgerContext.updateTransaction produces when the linked transaction's amount is edited:
  // the transaction AND its target's amount (the two-way sync).
  const tx = sorted.transactions.find((t) => t.sourceType === 'salary_sort')!
  const edited: AppDataV2 = {
    ...sorted,
    transactions: sorted.transactions.map((t) => (t.id === tx.id ? { ...t, amount: 275 } : t)),
    salarySorts: sorted.salarySorts.map((s) => ({ ...s, targets: s.targets.map((t) => (t.transactionId === tx.id ? { ...t, amount: 275 } : t)) })),
  }
  a.store.save(edited, sorted)
  await a.store.flush()
  const written = db.log.map((s) => `${s.kind} ${s.table} [${s.columns.join(',')}]`)
  check('exactly two one-column updates: the transfer and its target', JSON.stringify(written) === JSON.stringify(['update transactions [amount]', 'update salary_sort_targets [amount]']), written)
}

console.log('\n4. Detaching (the date edited) removes the target, and the sort with it')
{
  const base = household()
  const db = new FakeSyncDb()
  seedEmptyHousehold(db, base)
  const a = await storeFor(db)
  const sorted = withSort(a.current, 'adam-1', PAYDAY, 300)
  a.store.save(sorted, a.current)
  await a.store.flush()
  db.clearLog()

  // LedgerContext.updateTransaction's detach: the transfer stays as an ordinary one, its target
  // goes, and an emptied sort goes with it.
  const tx = sorted.transactions.find((t) => t.sourceType === 'salary_sort')!
  const detached: AppDataV2 = {
    ...sorted,
    transactions: sorted.transactions.map((t) => (t.id === tx.id ? { ...t, date: '2026-02-03', sourceType: undefined, sourceId: undefined } : t)),
    salarySorts: [],
  }
  a.store.save(detached, sorted)
  await a.store.flush()
  const kinds = db.log.map((s) => `${s.kind} ${s.table}`)
  check('the transfer is updated, not deleted', db.log.some((s) => s.kind === 'update' && s.table === 'transactions'))
  check('its source link is cleared in the same update', db.log.find((s) => s.table === 'transactions')?.columns.includes('source_id') === true, db.log[0])
  check('the target row is deleted before the sort row (child first)', kinds.indexOf('delete salary_sort_targets') !== -1 && kinds.indexOf('delete salary_sort_targets') < kinds.indexOf('delete salary_sorts'), kinds)
  const after = (await storeFor(db)).current
  check('nothing is left behind: no sort, and the transfer is an ordinary one', after.salarySorts.length === 0 && after.transactions.filter((t) => t.sourceType === 'salary_sort').length === 0)
}

console.log('\n5. A target whose transaction is gone on the other device')
{
  const base = household()
  const db = new FakeSyncDb()
  seedEmptyHousehold(db, base)
  const a = await storeFor(db)
  const sorted = withSort(a.current, 'adam-1', PAYDAY, 300)
  a.store.save(sorted, a.current)
  await a.store.flush()

  // The other device deleted the transfer; its target row is still here.
  const txId = salarySortTransactionId(salarySortTargetId(salarySortId('adam-1', PAYDAY), { type: 'savings', savingsPotId: base.savingsPots[0].id }))
  db.tables.get('transactions')!.delete(txId)
  const fresh = await storeFor(db)
  check('the app is shown no orphan: the target, and the emptied sort, are hidden', fresh.current.salarySorts.length === 0, fresh.current.salarySorts)
  db.clearLog()
  // An unrelated edit must not turn that read into deletes of rows this device can't see.
  fresh.store.save({ ...fresh.current, people: fresh.current.people.map((p, i) => (i === 0 ? { ...p, name: 'Adam C' } : p)) }, fresh.current)
  await fresh.store.flush()
  const written = db.log.map((s) => `${s.kind} ${s.table} [${s.columns.join(',')}]`)
  check('only the edit is written — no delete of the hidden rows', JSON.stringify(written) === JSON.stringify(['update people [name]']), written)
  check('the rows are still there for whichever device can still explain them', db.tables.get('salary_sort_targets')!.size === 1 && db.tables.get('salary_sorts')!.size === 1)
}

console.log('\n6. Whose sort it is survives the round trip (derived, not stored)')
{
  const base = household()
  const sorted = withSort(base, 'ella-1', PAYDAY, 125)
  const rows = toRows(sorted, ctx)
  check('no person column is written for a sort (nothing to drift)', Object.keys(rows.salary_sorts[0]).every((c) => c !== 'person_id'), Object.keys(rows.salary_sorts[0]))
  const back = fromRows(rows)
  check("read back, the sort belongs to the owner of its transfers", back.salarySorts[0]?.personId === 'ella-1', back.salarySorts[0])
  check('everything else round-trips unchanged', back.salarySorts[0]?.payDate === PAYDAY && back.salarySorts[0]?.targets[0].amount === 125)
}

console.log(failures === 0 ? '\nAll Salary Sort sync checks passed.' : `\nFAIL: ${failures} Salary Sort sync check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
