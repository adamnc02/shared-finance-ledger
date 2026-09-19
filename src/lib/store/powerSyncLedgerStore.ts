// SYNC APP ONLY (shared-finance-ledger; the test app's /sync/ build).
// The PowerSync LedgerStore (PROMPT-09). Implements lib/store/LedgerStore.ts
// without changing it, so LedgerContext.tsx stays byte-identical in every app.
//
// 🚨 THE FIRST-SYNC GATE (BUILD-PLAN 3.3a, Adam's Q9: "never push empty
// data"). Nothing is written until PowerSync reports this app's stream has
// synced: `save` is a no-op before then and `load` doesn't resolve. Three
// things write without the user touching anything — defaultLedgerData()'s
// seed, migrateLedgerData()'s re-added built-ins, and autoClearDuePayments —
// and ungated, a device that hasn't synced would duplicate categories across
// the household and push transactions against an empty ledger.
// verify-first-sync-gate.ts proves it.
//
// What the store does:
// - load(): after first sync, reads every table and returns the app's data,
//   run through migrateLedgerData (the contract: load returns migrated data).
// - save(next): diffs what the DATABASE holds (the store's own shadow, not
//   the provider's `prev`) against `next`, per table, per row, per column,
//   and writes only that (writes.ts: narrow UPDATEs). Logs, never throws.
//   Data the store delivered itself through `subscribe` is recognised by
//   reference and never written back.
// - subscribe(): re-reads on every local or synced change and hands the
//   provider one consistent dataset. The first delivery is `wholesale`, so
//   pages resync derived state (BUILD-PLAN 3.3b, APP-KNOWLEDGE §1.6).
// - migrateLedgerData never writes through here: its backfills are part of
//   what the store believes the database holds, so they are re-derived on
//   every read rather than pushed to the household.
//
// primaryPersonId never syncs (DECISIONS Q3): it's "which person am I looking
// at", per device. Resolved on EVERY read (MIGRATION-LESSONS §23 — never lock
// onto whichever row happened to arrive first):
//   1. a choice made on this device (setPrimaryPerson), if that person exists;
//   2. otherwise the person linked to the signed-in user (people.linked_user_id,
//      "Set as me" — written by PROMPT-10's linking UI, read here already);
//   3. otherwise the first person.
// A choice is recorded only when the app changes primaryPersonId away from
// what the store resolved, so the store's own resolution is never mistaken
// for a manual one.
//
// 🚨 THE HOUSEHOLD CAN CHANGE UNDER A RUNNING SESSION (UAT 2026-09-19).
// "Delete my app data" on another device deletes the household; PROMPT-10's
// redeem moves the user to another one. A device that stays open keeps the
// old household id, sync removes the old rows, and stale app state was then
// written back as fresh inserts into a household the user no longer belongs
// to (16 writes rejected by RLS, 42501, and an offline bill lost). In a
// household that still existed they would have RESURRECTED deleted data.
// So every read checks the synced membership (sfl_household_members): once
// this user has been seen as a member of the session's household, losing
// that membership (or appearing in a different household) SUSPENDS the
// store — nothing is written or delivered again — and onHouseholdLost()
// tells the boot sequence to clear the local copy and start over.

import type { AppDataV2 } from '../../types/ledger'
import { migrateLedgerData } from '../ledgerStorage'
import type { LedgerStore } from './LedgerStore'
import { fromRows, toRows, type Rows } from '../powersync/mapping'
import { diffRows, type Op, type Positions } from '../powersync/writes'

/** What the store needs from the database; the real one wraps PowerSync (powerSyncAdapter.ts), tests pass a fake. */
export interface SyncDatabase {
  /** Every synced table's rows, keyed by Postgres table name, in one consistent read. */
  readAll(): Promise<Rows>
  /** Applies ops in one local transaction. */
  write(ops: Op[]): Promise<void>
  /** Calls back after any change to a synced table (local or from sync). Returns unsubscribe. */
  onChange(callback: () => void): () => void
}

export interface PowerSyncLedgerStoreOptions {
  db: SyncDatabase
  householdId: string
  userId: string
  /** Resolves when this app's stream has completed its first sync. Nothing is written before. */
  firstSync: Promise<void>
  /** Per-device primaryPersonId choice. Defaults to localStorage. */
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  /** Keeps two apps (or two accounts) on one origin apart. */
  storageKey: string
  /** Called once if this user stops being a member of `householdId` (see header). */
  onHouseholdLost?: (reason: string) => void
  log?: Pick<Console, 'error' | 'warn' | 'info'>
}

export interface PowerSyncLedgerStore extends LedgerStore {
  /** True once first sync is complete (the gate is open). */
  readonly synced: boolean
  /** True once the household was lost: nothing is written or delivered any more. */
  readonly suspended: boolean
  /** Resolves when every write handed to save() so far has been applied locally. */
  flush(): Promise<void>
}

export function createPowerSyncLedgerStore(opts: PowerSyncLedgerStoreOptions): PowerSyncLedgerStore {
  const { db, householdId, userId, firstSync, storageKey } = opts
  const log = opts.log ?? console
  const storage = opts.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  const ctx = { householdId }

  let synced = false
  const gate = firstSync.then(() => {
    synced = true
  })

  let shadow: AppDataV2 | null = null // what the local database holds, as the app sees it
  let lastDelivered: AppDataV2 | null = null
  const positions: Positions = new Map()
  const present = new Map<string, Set<string>>() // ids the local database actually holds
  let writeChain: Promise<void> = Promise.resolve()
  let writeVersion = 0
  let seenMember = false
  let suspended = false

  /** False (and suspends the store) if the synced membership says this session's household is no longer ours. */
  function checkMembership(rows: Rows): boolean {
    if (suspended) return false
    const mine = (rows.household_members ?? []).filter((r) => r.user_id === userId)
    const inSession = mine.some((r) => r.household_id === householdId)
    const elsewhere = mine.find((r) => r.household_id !== householdId)
    if (inSession && !elsewhere) {
      seenMember = true
      return true
    }
    // Before the membership row has ever synced (a brand-new household), absence proves nothing.
    if (!elsewhere && !seenMember) return true
    suspended = true
    const reason = elsewhere ? 'this account is now in a different household' : 'this household no longer exists for this account'
    log.error(`[powersync] 🚨 household changed under this session (${reason}) — store suspended, nothing more is written`)
    opts.onHouseholdLost?.(reason)
    return false
  }

  const readChoice = () => {
    try {
      return storage?.getItem(storageKey) ?? null
    } catch {
      return null
    }
  }
  const writeChoice = (id: string) => {
    try {
      storage?.setItem(storageKey, id)
    } catch (err) {
      log.warn('[powersync] could not remember the chosen person on this device', err)
    }
  }

  function assemble(rows: Rows): AppDataV2 {
    positions.clear()
    present.clear()
    for (const [table, list] of Object.entries(rows)) {
      present.set(table, new Set(list.map((r) => r.id)))
      const known = new Map<string, number>()
      for (const r of list) if (typeof r.position === 'number') known.set(r.id, r.position)
      positions.set(table, known)
    }
    const base = fromRows(rows)
    const ids = new Set(base.people.map((p) => p.id))
    const choice = readChoice()
    const linked = (rows.people ?? []).find((r) => r.linked_user_id === userId)?.id
    const primaryPersonId = choice && ids.has(choice) ? choice : linked && ids.has(linked) ? linked : (base.people[0]?.id ?? '')
    return migrateLedgerData({ ...base, primaryPersonId })
  }

  /** null when the household was lost (see checkMembership). */
  async function read(): Promise<AppDataV2 | null> {
    await writeChain // see every write already handed over
    const rows = await db.readAll()
    if (!checkMembership(rows)) return null
    return assemble(rows)
  }

  return {
    get synced() {
      return synced
    },
    get suspended() {
      return suspended
    },

    async load() {
      await gate
      const data = await read()
      if (data) shadow = data
      return data
    },

    save(next, _prev) {
      if (suspended) {
        log.error('[powersync] save() after the household changed — ignored')
        return
      }
      if (!synced) {
        // The gate. Deliberately silent in the UI and loud in the console: any
        // call here means something tried to write before first sync.
        log.warn('[powersync] save() before first sync — ignored (first-sync gate)')
        return
      }
      if (next === lastDelivered) {
        shadow = next // our own delivery coming back: nothing to write
        return
      }
      if (!shadow) {
        log.error('[powersync] save() before load() — ignored')
        return
      }
      try {
        if (next.primaryPersonId !== shadow.primaryPersonId && next.primaryPersonId) writeChoice(next.primaryPersonId)
        const ops = diffRows(toRows(shadow, ctx), toRows(next, ctx), positions, present)
        for (const op of ops) {
          if (op.kind === 'insert') (present.get(op.table) ?? present.set(op.table, new Set()).get(op.table)!).add(op.row.id)
          if (op.kind === 'delete') present.get(op.table)?.delete(op.id)
        }
        shadow = next
        if (ops.length === 0) return
        writeVersion++
        writeChain = writeChain
          .then(() => db.write(ops))
          .catch((err) => log.error('[powersync] 🚨 local write FAILED — this change was not saved', err, ops))
      } catch (err) {
        log.error('[powersync] 🚨 could not work out what changed — nothing written', err)
      }
    },

    subscribe(onExternalChange) {
      let first = true
      let cancelled = false
      const deliver = async () => {
        await gate
        const version = writeVersion
        let data: AppDataV2 | null
        try {
          data = await read()
        } catch (err) {
          log.error('[powersync] could not read the local database', err)
          return
        }
        if (!data) return // household lost: deliver nothing more
        // A save landed while we read: this snapshot may predate it. The
        // change that save makes will call us again.
        if (cancelled || version !== writeVersion) return
        lastDelivered = data
        shadow = data
        const wholesale = first
        first = false
        onExternalChange(data, wholesale)
      }
      const unsubscribe = db.onChange(() => void deliver())
      void deliver() // the first, wholesale delivery (3.3b)
      return () => {
        cancelled = true
        unsubscribe()
      }
    },

    flush: () => writeChain,
  }
}
