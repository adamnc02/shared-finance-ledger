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
//      "Set as me", written by this store: see below);
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
//
// A RE-IMPORT OF THIS HOUSEHOLD'S OWN FILE IS A PATCH (PROMPT-14 Part 4).
// If any id in the incoming data is one this store already holds, the file
// came from here and was edited, so the ids are kept and diffRows writes only
// what actually changed — the workflow behind "export, edit the JSON,
// re-import" (APP-KNOWLEDGE). Everything else below still applies to a
// genuinely foreign file. isSameHouseholdPatch names the two id classes that
// must NOT count as evidence.
//
// IMPORTS GET FRESH IDS (PROMPT-10 Part 3, MIGRATION-LESSONS §31). A save
// whose lists are ALL new to the store (setData with parsed JSON: Wallet →
// Backup's restore, a cloud restore, the empty-household import; see
// isImport) is an import: its ids are
// regenerated (importIds.ts) before anything is written, so one backup
// imported into two households never collides. The app still holds the
// backup's ids until the store's next delivery (flagged wholesale, so pages
// resync); saves in between are translated through the same id map.
//
// "SET AS ME" LINKS THE ROW (PROMPT-10 Part 4; MIGRATION-LESSONS §18; Adam,
// 2026-09-19: Set as me = link + view). LedgerContext only changes
// primaryPersonId; this store turns that into people.linked_user_id = me,
// clearing my previous row first (the (household, linked_user_id) unique
// index), as one-column UPDATEs at the ends of the save:
//   - an unlinked row, or an import's own "Me" row → linked to me;
//   - a row linked to someone else → view only, never taken, UNLESS I have
//     no linked row at all (Ella claiming her row after Adam tapped it:
//     she can; his device falls back to its own choice);
//   - primaryPersonId moving only because my person was deleted → nothing.
// verify-set-as-me.ts.

import type { AppDataV2 } from '../../types/ledger'
import { migrateLedgerData } from '../ledgerStorage'
import type { LedgerStore } from './LedgerStore'
import { fromRows, toRows, type Rows } from '../powersync/mapping'
import { diffRows, type Op, type Positions } from '../powersync/writes'
import { applyIdMap, FIXED_CATEGORY_IDS, regenerateIds } from '../powersync/importIds'

/** Every list in AppDataV2. */
const LISTS = [
  'people', 'categories', 'recurringTemplates', 'loans', 'creditCards', 'pensions',
  'savingsPots', 'pots', 'transactions', 'payCycles', 'salarySorts', 'scenarios',
] as const satisfies readonly (keyof AppDataV2)[]

/**
 * An import (setData with parsed JSON) is the only save where NO list is one the store has seen:
 * every edit starts from data the store delivered, loaded or was saved, and keeps at least the lists
 * it didn't touch. (Comparing with the provider's `prev` is not enough: when a delivery and an edit
 * land in one render, `prev` is older than the edit's base, and every list looks new.)
 */
export function isImport(next: AppDataV2, known: WeakSet<object>): boolean {
  return LISTS.every((k) => !known.has(next[k]))
}

/**
 * PROMPT-14 Part 4 — is this file a PATCH of the data this store already holds, rather than a
 * foreign import?
 *
 * `isImport` regenerates ids because two households importing one backup would collide (§31). But
 * a file exported from THIS household and hand-edited is not a foreign import — it is a patch of
 * rows the store already has. Paying the full price for it means every row deleted and reinserted,
 * Part 5's re-link, and a wholesale delivery, to change one number.
 *
 * So: if ANY id in the incoming data is one the store currently holds, it is a patch. Skip
 * `regenerateIds` and let `diffRows` do its ordinary narrow work — one field edited, one column
 * written, and Ella sees one narrow update.
 *
 * 🚨 TWO ID CLASSES MUST BE EXCLUDED, and forgetting either makes this return true for a genuinely
 * foreign backup — which is the 23505-and-silently-discarded failure §31 exists to prevent:
 *
 *   - **the 35 fixed category ids.** `regenerateIds` deliberately KEEPS them, so every household
 *     on earth has the same ones. They prove nothing about provenance.
 *   - **`auto:` and `sort:` ids.** They are DERIVED from the ids inside them, so if one matches,
 *     the person or source id inside it matches too and is already doing the work. Excluding them
 *     costs nothing and removes a whole class of false positives.
 *
 * After `erase_my_data()` nothing matches, so it correctly falls back to a full import.
 */
export function isSameHouseholdPatch(next: AppDataV2, shadow: AppDataV2): boolean {
  const own = new Set<string>()
  collectOwnIds(shadow, own)
  const incoming = new Set<string>()
  collectOwnIds(next, incoming)
  for (const id of incoming) if (own.has(id)) return true
  return false
}

/**
 * How many rows this household currently holds that the incoming file does NOT — the rows a patch
 * will DELETE.
 *
 * 🚨 The foot-gun this exists for: a hand-trimmed backup with rows removed still reads as a patch,
 * and the diff does exactly what it is told. So the confirm says how many rows will be deleted, not
 * only how many are being replaced (PROMPT-14 Part 4, guard rails).
 */
export function rowsRemovedByPatch(next: AppDataV2, shadow: AppDataV2): number {
  const incoming = new Set<string>()
  collectOwnIds(next, incoming)
  const own = new Set<string>()
  collectOwnIds(shadow, own)
  let removed = 0
  for (const id of own) if (!incoming.has(id)) removed++
  return removed
}

/** Every id in the data that actually identifies THIS household's rows (see the exclusions above). */
function collectOwnIds(data: AppDataV2, out: Set<string>) {
  for (const list of LISTS) {
    for (const row of data[list] as ReadonlyArray<{ id?: unknown }>) {
      const id = row?.id
      if (typeof id !== 'string' || !id) continue
      if (FIXED_CATEGORY_IDS.has(id)) continue
      if (id.startsWith('auto:') || id.startsWith('sort:')) continue
      out.add(id)
    }
  }
}

/** The one op shape "Set as me" and Part 5's re-link both write: one column, one row. */
export type LinkUpdate = Extract<Op, { kind: 'update' }> & { set: { linked_user_id: string } }

/**
 * 🚨 PROMPT-14 Part 5 — a restore must not silently reassign who everyone is.
 *
 * An import deletes every `people` row and inserts a fresh one (regenerateIds, §31), and
 * `linked_user_id` is a server-only column `toRows` never writes — so every OTHER member's link
 * dies with their old row. `linkOps` re-links only the person doing the restore. On Ella's next
 * sync, `assemble` walks choice → linked → people[0]: her stored choice is a dead id and there is
 * no linked row, so **she silently becomes whoever sorts first, and her pay cycle flips**. That is
 * the §23 failure `verify-first-sync-gate.ts` exists to prevent, arriving through a door it does
 * not watch.
 *
 * So: carry each pre-restore link across to the incoming person **with the same name** (§0 Q4a).
 *
 * 🚨 Ambiguous or missing → DO NOT GUESS. No match, or more than one, leaves that member
 * unlinked, and their device asks "which person are you?" on its next boot (§0 Q4b, the flow a
 * fresh join already uses). "Just take the first match" is the same silent reassignment wearing a
 * different hat — it is the bug, not a simplification of the fix.
 *
 * Names are compared trimmed and case-insensitively, because a restore of a hand-edited file is
 * exactly where "Ella" becomes "ella".
 *
 * @param linked   person id → linked_user_id, as the DATABASE holds it right now (pre-restore)
 * @param before   the data those ids belong to (the shadow), for looking a person's name up
 * @param after    the incoming data, AFTER regenerateIds — the ids that will exist
 * @param exclude  a person id already being linked by linkOps (the restorer's own): never touched here
 */
export function relinkOps(
  linked: ReadonlyMap<string, string>,
  before: AppDataV2,
  after: AppDataV2,
  myUserId: string,
  exclude: string | null,
): { ops: LinkUpdate[]; unresolved: string[] } {
  const ops: LinkUpdate[] = []
  const unresolved: string[] = []
  const namesBefore = new Map(before.people.map((p) => [p.id, p.name]))
  const byName = new Map<string, string[]>()
  for (const p of after.people) {
    const key = p.name.trim().toLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), p.id])
  }
  for (const [personId, userId] of linked) {
    if (userId === myUserId) continue // linkOps owns mine
    const name = namesBefore.get(personId)
    if (name === undefined) {
      unresolved.push(userId)
      continue
    }
    const matches = (byName.get(name.trim().toLowerCase()) ?? []).filter((id) => id !== exclude)
    if (matches.length !== 1) {
      unresolved.push(userId)
      continue
    }
    ops.push({ kind: 'update', table: 'people', id: matches[0], set: { linked_user_id: userId } })
  }
  return { ops, unresolved }
}

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
  /** The last import's old → new ids (null before any import). For checks. */
  readonly importMap: ReadonlyMap<string, string> | null
  /** The person row linked to the signed-in user ("Set as me"), as of the last read. */
  readonly linkedPersonId: string | null
  /**
   * This device had chosen a person and that person no longer exists (PROMPT-14 Part 5). After a
   * restore that could not re-link by name, this is how the boot sequence knows to ASK rather than
   * let `assemble` fall back to people[0].
   */
  readonly staleChoice: boolean
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
  let importMap: Map<string, string> | null = null // the last import's old → new ids
  let nextDeliveryWholesale = false
  const linkedTo = new Map<string, string>() // person id → linked_user_id, as the database holds it
  let staleChoice = false // a choice is stored on this device and that person is gone (Part 5)
  const knownLists = new WeakSet<object>() // every list the store has delivered, loaded or saved (isImport)
  const deliveries = new WeakSet<AppDataV2>() // every dataset the store handed out
  const remember = (d: AppDataV2) => {
    for (const k of LISTS) knownLists.add(d[k])
  }

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
    linkedTo.clear()
    for (const r of rows.people ?? []) if (typeof r.linked_user_id === 'string' && r.linked_user_id) linkedTo.set(r.id, r.linked_user_id)
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
    staleChoice = choice !== null && !ids.has(choice)
    const primaryPersonId = choice && ids.has(choice) ? choice : linked && ids.has(linked) ? linked : (base.people[0]?.id ?? '')
    return migrateLedgerData({ ...base, primaryPersonId })
  }

  /** "Set as me" as one-column UPDATEs: `first` before the diff's writes, `last` after (see header). */
  function linkOps(before: AppDataV2, after: AppDataV2, imported: boolean): { first: Op[]; last: Op[] } {
    const none = { first: [], last: [] }
    const target = after.primaryPersonId
    if (!target || !after.people.some((p) => p.id === target)) return none
    if (!imported) {
      if (target === before.primaryPersonId) return none
      const old = before.primaryPersonId
      if (before.people.some((p) => p.id === old) && !after.people.some((p) => p.id === old)) return none // my person was deleted
    }
    const mine = [...linkedTo].find(([, uid]) => uid === userId)?.[0]
    if (mine === target) return none
    const owner = linkedTo.get(target)
    if (owner && owner !== userId && mine) {
      log.info('[powersync] Set as me: that person is linked to someone else — switched view only')
      return none
    }
    const first: Op[] = mine ? [{ kind: 'update', table: 'people', id: mine, set: { linked_user_id: null } }] : []
    if (mine) linkedTo.delete(mine)
    linkedTo.set(target, userId)
    return { first, last: [{ kind: 'update', table: 'people', id: target, set: { linked_user_id: userId } }] }
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
    get importMap() {
      return importMap
    },
    get linkedPersonId() {
      return [...linkedTo].find(([, uid]) => uid === userId)?.[0] ?? null
    },
    get staleChoice() {
      return staleChoice
    },

    async load() {
      await gate
      const data = await read()
      if (data) {
        shadow = data
        remember(data)
        deliveries.add(data)
      }
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
      if (deliveries.has(next)) return // an older delivery, already superseded: nothing to write
      if (!shadow) {
        log.error('[powersync] save() before load() — ignored')
        return
      }
      try {
        let target = next
        const setDataCall = isImport(next, knownLists)
        // Part 4: setData with a file this household exported is a PATCH, not
        // a foreign import. Same code path, minus the id churn.
        const patch = setDataCall && isSameHouseholdPatch(next, shadow)
        const imported = setDataCall && !patch
        if (imported) {
          const fresh = regenerateIds(next)
          target = fresh.data
          importMap = fresh.map
          nextDeliveryWholesale = true
          log.info(`[powersync] import: ${fresh.map.size} ids regenerated (the 35 fixed categories kept)`)
        } else if (patch) {
          // No remap: the file already carries this household's own ids, which
          // is exactly what makes it a patch. Still wholesale, because whole
          // lists were replaced and pages must resync (APP-KNOWLEDGE §1.6).
          nextDeliveryWholesale = true
          log.info('[powersync] re-import of this household\'s own file: patched, ids kept (PROMPT-14 Part 4)')
        } else if (importMap) {
          target = applyIdMap(next, importMap)
        }
        if (target.primaryPersonId !== shadow.primaryPersonId && target.primaryPersonId) writeChoice(target.primaryPersonId)
        // linkOps mutates linkedTo, so take the database's view first.
        const linkedBeforeImport = new Map(linkedTo)
        const link = linkOps(shadow, target, imported)
        // Part 5: an import kills every other member's link, because their row
        // is deleted and reborn. Carry each one across by name, in the same
        // narrow one-column shape, AFTER the diff has done the deleting (the
        // (household, linked_user_id) unique index).
        const relink = imported ? relinkOps(linkedBeforeImport, shadow, target, userId, link.last[0]?.kind === 'update' ? link.last[0].id : null) : { ops: [] as LinkUpdate[], unresolved: [] as string[] }
        if (relink.unresolved.length > 0) {
          log.warn(
            `[powersync] restore: ${relink.unresolved.length} household member(s) could not be re-linked by name — their device will ask which person they are (PROMPT-14 Part 5)`,
          )
        }
        for (const op of relink.ops) linkedTo.set(op.id, op.set.linked_user_id)
        const ops = [...link.first, ...diffRows(toRows(shadow, ctx), toRows(target, ctx), positions, present), ...link.last, ...relink.ops]
        for (const op of ops) {
          if (op.kind === 'insert') (present.get(op.table) ?? present.set(op.table, new Set()).get(op.table)!).add(op.row.id)
          if (op.kind === 'delete') present.get(op.table)?.delete(op.id)
        }
        remember(next)
        remember(target)
        shadow = target
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
        deliveries.add(data)
        remember(data)
        shadow = data
        const wholesale = first || nextDeliveryWholesale
        first = false
        nextDeliveryWholesale = false
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
