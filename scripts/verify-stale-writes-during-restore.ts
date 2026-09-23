// PROMPT-16 Part G (2026-09-23) — a second device must not write stale rows
// while another device's restore is syncing down.
//
// 🚨 THE BUG, found in UAT exports rather than in the UAT script. A wholesale
// restore reaches the OTHER device as several server commits: the new rows
// first (inserts), then the old transactions (deletes, child tables first),
// then the old templates, people and pay cycles. In the window between those
// two delete batches, the other device's app sees old templates and pay
// cycles whose occurrences and salary have "gone missing", and
// autoClearDuePayments — which runs on every data change — materialises them
// again. The store diffs them against a shadow that no longer holds them,
// emits inserts, and the server accepts them (right household, no FK). The
// old templates are then deleted; the re-created `auto:` rows stay behind,
// pointing at ids that no longer exist. Eight of them were in Adam's
// before-D export on 2026-09-23. With the second device OFFLINE for the
// restore (UAT section G) nothing stale was written — the control that
// pinned the mechanism.
//
// The rule now: a row id that arrived DELETED from the server during this
// session is never re-inserted from this device's derived state. Only an
// explicit setData (a restore or patch the user asked for) may bring one
// back.
//
// What it asserts:
//  1. the setup reproduces the window: after the first half of the
//     restorer's write, the other device is delivered a snapshot in which the
//     old transactions are gone but the old templates and pay cycles remain,
//     and autoClearDuePayments DOES re-materialise rows from it;
//  2. 🚨 saving that re-materialised state writes NO insert of a row the
//     server deleted (the fix);
//  3. CONTROL — the same save with the guard disabled DOES insert them (the
//     bug, reproduced);
//  4. after the restore completes, the household holds exactly the file's
//     rows: no transaction points at a person, template or pot that does not
//     exist;
//  5. this device's OWN deletes are not confused with remote ones: deleting a
//     transaction here and re-adding it (setData patch) still works;
//  6. an explicit restore (setData) may re-create a remotely deleted id;
//  7. 🚨 the INSERT half of the window: new templates arrive before the file's
//     transactions, the reader must not materialise occurrences for them
//     (control: it does, and the file's rows then duplicate every slot —
//     the TV License / Barkin Bistro pairs seen in three real exports);
//  8. a template that has been present for two reads is materialised as
//     normal, so a bill added on the other device still gets its occurrences.

import { readFileSync } from 'node:fs'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { toRows } from '../src/lib/powersync/mapping'
import { regenerateIds } from '../src/lib/powersync/importIds'
import type { Op } from '../src/lib/powersync/writes'
import { createPowerSyncLedgerStore, type SyncDatabase } from '../src/lib/store/powerSyncLedgerStore'
import { dedupeKey } from '../src/lib/projection'
import type { AppDataV2 } from '../src/types/ledger'
import { FakeSyncDb, memoryStorage, tick } from './lib/fakeSyncDb'

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
const ADAM = 'user-adam'
const ELLA = 'user-ella'
const raw = readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-15.json', 'utf8')
const silent = { error: () => {}, warn: () => {}, info: () => {} }
const ASOF = new Date('2026-09-23T12:00:00Z')

/** The household as it stands before the restore: a previous generation, with every due occurrence already materialised. */
function household(): AppDataV2 {
  return autoClearDuePayments(regenerateIds(parseLedgerBackupJson(raw)).data, ASOF)
}

/**
 * The restorer's database, seen through a wrapper that lands its write in TWO commits the way the
 * server does: everything up to the old transactions' deletes, then the rest. The other device's
 * onChange fires after each, so it is delivered the in-between state.
 */
function splitWrites(db: FakeSyncDb, onHalf: () => Promise<void>, at: 'after-tx-deletes' | 'before-tx-inserts' = 'after-tx-deletes'): SyncDatabase {
  return {
    readAll: () => db.readAll(),
    onChange: (cb) => db.onChange(cb),
    write: async (ops: Op[]) => {
      let i = -1
      if (at === 'after-tx-deletes') {
        // Just after the LAST delete of an old transaction: the new rows are in, the old
        // transactions are gone, the old templates / people / pay cycles (parents, deleted last) remain.
        ops.forEach((op, k) => {
          if (op.kind === 'delete' && op.table === 'transactions') i = k + 1
        })
      } else {
        // Just BEFORE the first insert of a new transaction: the new parents are in, none of the
        // file's transactions are — the window in which the reader materialises them itself.
        i = ops.findIndex((op) => op.kind === 'insert' && op.table === 'transactions')
      }
      if (i <= 0) return db.write(ops)
      await db.write(ops.slice(0, i))
      await onHalf()
      await db.write(ops.slice(i))
    },
  }
}

const idsIn = (d: AppDataV2) => ({
  people: new Set(d.people.map((p) => p.id)),
  templates: new Set(d.recurringTemplates.map((t) => t.id)),
  pots: new Set(d.pots.map((p) => p.id)),
  loans: new Set(d.loans.map((l) => l.id)),
})
/** Transactions whose references point at nothing (the orphans), optionally only among `among` ids. */
function orphans(d: AppDataV2, among?: Set<string>): string[] {
  const ids = idsIn(d)
  return d.transactions
    .filter((t) => !among || among.has(t.id))
    .filter((t) => {
      if (t.ownerId && !ids.people.has(t.ownerId)) return true
      if (t.payee && !ids.people.has(t.payee)) return true
      if (t.personId && !ids.people.has(t.personId)) return true
      if (t.potId && !ids.pots.has(t.potId)) return true
      if (t.sourceType === 'recurring_template' && t.sourceId && !ids.templates.has(t.sourceId)) return true
      if ((t.sourceType === 'loan_recurring_overpayment' || t.sourceType === 'loan') && t.sourceId && !ids.loans.has(t.sourceId)) return true
      return false
    })
    .map((t) => t.id)
}

async function scenario(unsafe: boolean, at: 'after-tx-deletes' | 'before-tx-inserts' = 'after-tx-deletes') {
  const before = household()
  const db = new FakeSyncDb()
  db.seed(toRows(before, { householdId: HH }))
  const people = db.tables.get('people')!
  people.get(before.people[0].id)!.linked_user_id = ADAM
  people.get(before.people[1].id)!.linked_user_id = ELLA
  const seededTxIds = new Set(before.transactions.map((t) => t.id))

  // Device B (Ella), online, subscribed — the LedgerProvider stand-in.
  const b = createPowerSyncLedgerStore({ db, householdId: HH, userId: ELLA, firstSync: Promise.resolve(), storageKey: 'kB', storage: memoryStorage(), log: silent, unsafeRecreateRemotelyDeleted: unsafe })
  const deliveries: AppDataV2[] = []
  b.subscribe!((d) => deliveries.push(d))
  await tick(30)
  const bBefore = deliveries[deliveries.length - 1]

  let partial: AppDataV2 | null = null
  let staleInserts: string[] = []
  let earlyInserts: string[] = [] // rows materialised for parents that had only just arrived
  let materialised = 0
  const onHalf = async () => {
    await tick(30) // B's onChange → deliver
    partial = deliveries[deliveries.length - 1]
    // What LedgerProvider does on every data change: auto-clear, then save if anything settled.
    const settled = autoClearDuePayments(partial, ASOF)
    materialised = settled.transactions.length - partial.transactions.length
    const logBefore = db.log.length
    b.save(settled, partial)
    await b.flush()
    staleInserts = db.log.slice(logBefore).filter((s) => s.kind === 'insert' && s.table === 'transactions' && seededTxIds.has(s.id)).map((s) => s.id)
    earlyInserts = db.log.slice(logBefore).filter((s) => s.kind === 'insert' && s.table === 'transactions' && !seededTxIds.has(s.id)).map((s) => s.id)
  }

  // Device A (Adam) restores a foreign file.
  db.actingUser = ADAM
  const a = createPowerSyncLedgerStore({ db: splitWrites(db, onHalf, at), householdId: HH, userId: ADAM, firstSync: Promise.resolve(), storageKey: 'kA', storage: memoryStorage(), log: silent })
  const loaded = (await a.load())!
  a.save(parseLedgerBackupJson(raw), loaded)
  await a.flush()
  await tick(40)
  const final = deliveries[deliveries.length - 1]
  return { before, bBefore, partial: partial!, materialised, staleInserts, earlyInserts, final, db, seededTxIds }
}

console.log('\n1. The window is real: old transactions gone, old templates and pay cycles still there')
const fixed = await scenario(false)
{
  const oldTemplateIds = new Set(fixed.before.recurringTemplates.map((t) => t.id))
  const oldTxIds = new Set(fixed.before.transactions.map((t) => t.id))
  check('before the restore, Device B held the previous generation', fixed.bBefore.transactions.some((t) => oldTxIds.has(t.id)))
  check("in the half-synced snapshot the OLD templates are still present", fixed.partial.recurringTemplates.some((t) => oldTemplateIds.has(t.id)))
  check('…but the OLD transactions are already gone', !fixed.partial.transactions.some((t) => oldTxIds.has(t.id)))
  check('…and autoClearDuePayments re-materialises occurrences from that snapshot (the writer)', fixed.materialised > 0, fixed.materialised)
}

console.log('\n2. 🚨 The fix: nothing the server deleted is re-inserted')
{
  check('Device B wrote NO insert of a transaction the server had deleted', fixed.staleInserts.length === 0, fixed.staleInserts)
}

console.log('\n3. CONTROL — with the guard off, the same save re-creates them (the bug)')
const control = await scenario(true)
{
  check('the control re-inserts previously deleted transaction ids', control.staleInserts.length > 0, control.staleInserts.length)
  check('…and they survive the restore as ORPHANS pointing at ids that no longer exist', orphans(control.final, control.seededTxIds).length > 0, orphans(control.final, control.seededTxIds).slice(0, 4))
}

console.log('\n4. After the restore the household holds exactly the file\'s rows')
{
  // (The 2026-09-15 file itself carries one dangling reference — a "Bills Top Up" whose template was
  // deleted before the export — so orphans are judged among the PREVIOUS generation's ids only.)
  check('no previous-generation transaction survived the restore', orphans(fixed.final, fixed.seededTxIds).length === 0 && !fixed.final.transactions.some((t) => fixed.seededTxIds.has(t.id)), orphans(fixed.final, fixed.seededTxIds).slice(0, 4))
  // Everything else Device B wrote is a legitimate derived row for the NEW generation, so the only
  // dangling references left are the ones the file itself carries — no more, no fewer.
  const fileOrphans = orphans(parseLedgerBackupJson(raw)).length
  check('the only dangling references left are the file\'s own', orphans(fixed.final).length === fileOrphans, [orphans(fixed.final), fileOrphans])
  check('…and the control has MORE than that', orphans(control.final).length > fileOrphans, [orphans(control.final).length, fileOrphans])
}

/** Occurrence slots filled by more than one transaction — a bill counted twice. */
function duplicateSlots(d: AppDataV2): string[] {
  const seen = new Map<string, number>()
  for (const t of d.transactions) {
    const k = dedupeKey(t)
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k)
}

console.log('\n7. 🚨 The INSERT window: new templates arrive before the file\'s transactions do')
{
  const early = await scenario(false, 'before-tx-inserts')
  check('the window is real: the half-synced snapshot holds the NEW templates with no transactions of theirs', early.partial.recurringTemplates.some((t) => !early.before.recurringTemplates.some((b) => b.id === t.id)) && early.materialised > 0, early.materialised)
  check('the fix: Device B writes NO occurrence for a template that only just arrived', early.earlyInserts.length === 0, early.earlyInserts)
  check('after the restore no occurrence slot is filled twice (yesterday\'s TV License / Barkin Bistro pairs)', duplicateSlots(early.final).length === 0, duplicateSlots(early.final))
  const earlyControl = await scenario(true, 'before-tx-inserts')
  check('CONTROL — guard off: the reader materialises occurrences for the just-arrived templates', earlyControl.earlyInserts.length > 0, earlyControl.earlyInserts.length)
  check('…and the file\'s own rows then land on the same slots: DUPLICATES', duplicateSlots(earlyControl.final).length > 0, duplicateSlots(earlyControl.final).slice(0, 3))
}

console.log('\n8. A template that settles (present in two reads) is materialised normally')
{
  const before = household()
  const db = new FakeSyncDb()
  db.seed(toRows(before, { householdId: HH }))
  const s = createPowerSyncLedgerStore({ db, householdId: HH, userId: ELLA, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: silent })
  const got: AppDataV2[] = []
  s.subscribe!((d) => got.push(d))
  await tick(30)
  // Another device adds a bill due in the past, with no occurrence rows.
  const cur = got[got.length - 1]
  const tpl: AppDataV2['recurringTemplates'][number] = {
    id: 'new-bill', name: 'New bill', amount: 5, categoryId: 'category-bills', paymentMethod: 'standing_order', frequency: 'monthly',
    anchorDate: '2026-09-20', location: 'personal', ownerId: cur.people[0].id, payee: '', payeeSharePercent: 100, active: true,
  }
  db.seed(toRows({ ...cur, recurringTemplates: [tpl] }, { householdId: HH }))
  db.remoteChange('recurring_templates', 'new-bill', {})
  await tick(30)
  const d1 = got[got.length - 1]
  db.clearLog()
  s.save(autoClearDuePayments(d1, ASOF), d1)
  await s.flush()
  check('first read with the new template: nothing materialised for it yet', !db.log.some((x) => x.kind === 'insert' && x.table === 'transactions'), db.log.map((x) => x.id))
  db.remoteChange('recurring_templates', 'new-bill', {}) // any later sync: it is settled now
  await tick(30)
  const d2 = got[got.length - 1]
  db.clearLog()
  s.save(autoClearDuePayments(d2, ASOF), d2)
  await s.flush()
  check('next read: its due occurrences are materialised as normal', db.log.some((x) => x.kind === 'insert' && x.table === 'transactions' && x.id.includes('new-bill')), db.log.map((x) => x.id).slice(0, 3))
}

console.log("\n5. This device's own deletes are not mistaken for remote ones")
{
  const before = household()
  const db = new FakeSyncDb()
  db.seed(toRows(before, { householdId: HH }))
  const s = createPowerSyncLedgerStore({ db, householdId: HH, userId: ADAM, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: silent })
  const got: AppDataV2[] = []
  s.subscribe!((d) => got.push(d))
  await tick(30)
  const cur = got[got.length - 1]
  const victim = cur.transactions.find((t) => !t.id.startsWith('auto:'))!
  s.save({ ...cur, transactions: cur.transactions.filter((t) => t.id !== victim.id) }, cur)
  await s.flush()
  await tick(30)
  const afterDelete = got[got.length - 1]
  check('deleted here: gone', !afterDelete.transactions.some((t) => t.id === victim.id))
  // The user re-imports the household's own file with the row back (a patch: same ids).
  db.clearLog()
  s.save({ ...JSON.parse(JSON.stringify(afterDelete)), transactions: [...afterDelete.transactions, victim] } as AppDataV2, afterDelete)
  await s.flush()
  check('re-adding it through an explicit setData patch is allowed', db.log.some((x) => x.kind === 'insert' && x.id === victim.id), db.log.map((x) => `${x.kind} ${x.id}`))
}

console.log('\n6. An explicit restore may bring a remotely deleted id back')
{
  const before = household()
  const db = new FakeSyncDb()
  db.seed(toRows(before, { householdId: HH }))
  const s = createPowerSyncLedgerStore({ db, householdId: HH, userId: ELLA, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: silent })
  const got: AppDataV2[] = []
  s.subscribe!((d) => got.push(d))
  await tick(30)
  const cur = got[got.length - 1]
  const victim = cur.transactions[0]
  // Another device deletes it.
  db.tables.get('transactions')!.delete(victim.id)
  db.remoteChange('people', cur.people[0].id, {})
  await tick(30)
  const afterRemote = got[got.length - 1]
  check('the remote delete was delivered', !afterRemote.transactions.some((t) => t.id === victim.id))
  db.clearLog()
  // A derived save (autoClear-like) that puts it back: dropped.
  s.save({ ...afterRemote, transactions: [...afterRemote.transactions, victim] }, afterRemote)
  await s.flush()
  check('a derived save cannot re-create it', !db.log.some((x) => x.kind === 'insert' && x.id === victim.id))
  // The user restores the household's own file containing it: allowed (a patch, same ids).
  const patched = JSON.parse(JSON.stringify({ ...afterRemote, transactions: [...afterRemote.transactions, victim] })) as AppDataV2
  db.clearLog()
  s.save(patched, afterRemote)
  await s.flush()
  check('an explicit setData restore CAN', db.log.some((x) => x.kind === 'insert' && x.id === victim.id), db.log.map((x) => `${x.kind} ${x.id}`).slice(0, 5))
}

console.log(failures === 0 ? '\nAll stale-write checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
