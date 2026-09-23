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
// 2026-09-19: Set as me = link + view). LedgerContext changes primaryPersonId
// AND calls setPrimaryPerson() first (LedgerStore.ts, PROMPT-16 Part A); this
// store turns the TAP into people.linked_user_id = me, clearing my previous
// row first (the (household, linked_user_id) unique index), as one-column
// UPDATEs at the ends of the save:
//   - a tap on an unlinked row, or an import's own "Me" row → linked to me,
//     whether or not the view moved (tapping the person you already look at
//     still links: the button's contract is "this is me", not "change view");
//   - a tap on a row linked to someone else → view only, never taken, UNLESS
//     I have no linked row at all (Ella claiming her row after Adam tapped it
//     before she joined);
//   - a save with NO tap never writes a link, whatever primaryPersonId did.
// 🚨 PROMPT-16 (2026-09-22): the tap used to be INFERRED from
// primaryPersonId changing. Two live defects fell out of that one line:
// Adam's production row was never linked (his view was already right, so
// "Set as me" changed nothing, so nothing was written — and low-balance
// alerts are addressed from the link, so they were silent), and the claim
// path was reachable from ANY save that moved the view, not only a tap. §39,
// one field down: intent comes from the caller, never from a diff.
// verify-set-as-me.ts.
//
// 🚨 A SECOND DEVICE MUST NOT RE-CREATE WHAT A RESTORE DELETED (PROMPT-16
// Part G, found in UAT 2026-09-23). A wholesale restore reaches the other
// device as many server commits: the new rows arrive, then the old
// transactions are deleted, then the old templates, people and pay cycles.
// In that window the app's auto-clearing pass sees old templates whose
// occurrences have "gone missing" and materialises them again, and the
// server accepts the inserts (right household). Eight such orphans, all
// `auto:` rows pointing at ids of the previous generation, were in a real
// export. So: a row id that arrived DELETED from the server during this
// session is never re-inserted from this device's derived state. Only an
// explicit setData (a restore or patch the user asked for) may bring one
// back. With the other device offline for the restore nothing stale was
// ever written, which is the control that pinned the mechanism.
//
// 🚨 A LINK CAN ONLY BE WRITTEN BY THE USER IT BELONGS TO. The server's
// people_enforce_self_link trigger refuses (42501, discarded by the
// connector) any linked_user_id that is not auth.uid(). So this device can
// link ME and nobody else — which is why PROMPT-14 Part 5's "re-link every
// member by name after a restore" could never work live (the unit passed
// against a fake with no trigger; the integration failed three times on
// 2026-09-22) and is gone. Instead EVERY DEVICE REMEMBERS WHO IT LAST SHOWED
// (id + name, resolved by choice or by link) and, on boot, identityAction()
// decides: linked → ready; my chosen row unlinked → link it (self-heal, fills
// an empty column, can never take anyone's); the person I was showing is
// gone or now someone else's → link the ONE unlinked person with the same
// name, else ASK — never fall back to people[0], which is the silent
// reassignment §23 and Part 5 exist to prevent. verify-restore-preserves-
// identity.ts.

import type { AppDataV2 } from '../../types/ledger'
import { migrateLedgerData } from '../ledgerStorage'
import type { LedgerStore } from './LedgerStore'
import { fromRows, toRows, type Rows } from '../powersync/mapping'
import { diffRows, type Op, type Positions } from '../powersync/writes'
import { applyIdMap, FIXED_CATEGORY_IDS, regenerateIds } from '../powersync/importIds'
import { dedupeKey } from '../projection'

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

/** How the last read resolved `primaryPersonId` (header: "primaryPersonId never syncs"). */
export type ResolvedBy = 'choice' | 'link' | 'fallback' | 'none'

/** The person this device last showed by choice or by link, remembered per device (PROMPT-16 Part F). */
export interface ShownPerson {
  id: string
  name: string
}

/** What the boot sequence needs to know about identity, as of the last read. */
export interface IdentityView {
  /** The row linked to the signed-in user, if any. */
  linkedPersonId: string | null
  /** The person the last read resolved to, and how. */
  primaryPersonId: string
  resolvedBy: ResolvedBy
  /** This device had chosen a person and that person no longer exists. */
  staleChoice: boolean
  /** The person this device last showed (by choice or link), or null on a device that never has. */
  lastShown: ShownPerson | null
  /** `linked_user_id` of a person row as the database holds it, or null. */
  ownerOf(personId: string): string | null
}

export type IdentityAction =
  | { kind: 'ready' }
  | { kind: 'link'; personId: string; reason: 'self_heal' | 'remembered_name' }
  | { kind: 'ask' }

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * 🚨 PROMPT-16 Parts B and F — what a device does about its identity on boot, in one place.
 *
 * The rule, in order:
 *  1. A row is linked to me → nothing to do. The link is the identity; the view follows it.
 *  2. No link, but this device CHOSE the person it shows and that row is unlinked → link it
 *     (Part B self-heal). This is Adam's production state: his device had always resolved to his
 *     own row by choice, so the view was right and the link was never written. It can only ever
 *     fill an EMPTY column, so it cannot move, overwrite or take anyone's link.
 *  3. No link, and the person this device WAS showing is gone (a restore regenerated every id) or
 *     is now linked to someone else → find the one UNLINKED incoming person with the same name.
 *     Exactly one → link it (this is Part 5's re-link by name, now run by the only user the server
 *     lets write that link). None, or more than one → ASK. A rename is the everyday case here and
 *     it must ask, not guess.
 *  4. No link, and either I have just joined bringing nothing, or my stored choice is dead → ASK
 *     (the two cases SyncRoot already asked about).
 *  5. Otherwise ready — a brand-new device in a one-person household is not asked a question with
 *     one answer.
 *
 * 🚨 The trap this replaces: the ask was gated on `staleChoice`, which only exists for a user who
 * OVERRODE their link. A member resolved BY link never stored a choice, so when a restore
 * destroyed the link there was nothing to go stale, no ask, and `assemble` fell back to
 * `people[0]` — Ella's phone silently showed Adam's dashboard and pay cycle (UAT 2026-09-22, run
 * three, names matching). The device now remembers who it showed WHATEVER resolved it.
 */
export function identityAction(view: IdentityView, people: ReadonlyArray<{ id: string; name: string }>, justJoined: boolean): IdentityAction {
  if (view.linkedPersonId) return { kind: 'ready' }
  if (view.resolvedBy === 'choice' && view.primaryPersonId && view.ownerOf(view.primaryPersonId) === null) {
    return { kind: 'link', personId: view.primaryPersonId, reason: 'self_heal' }
  }
  if (view.lastShown) {
    const shown = view.lastShown
    const owner = people.some((p) => p.id === shown.id) ? view.ownerOf(shown.id) : undefined
    const lost = owner === undefined || owner !== null // gone, or now someone else's (mine is handled by rule 1)
    if (lost) {
      const matches = people.filter((p) => sameName(p.name, shown.name) && view.ownerOf(p.id) === null)
      if (matches.length === 1) return { kind: 'link', personId: matches[0].id, reason: 'remembered_name' }
      return { kind: 'ask' }
    }
  }
  if (justJoined || view.staleChoice) return { kind: 'ask' }
  return { kind: 'ready' }
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
  /** TESTS ONLY: the control for verify-stale-writes-during-restore.ts. Never set in the app. */
  unsafeRecreateRemotelyDeleted?: boolean
  /** Coalesce change events for this long before re-reading (PROMPT-16 Part G). The app passes 400; checks leave it 0. */
  deliveryDebounceMs?: number
}

export interface PowerSyncLedgerStore extends LedgerStore, IdentityView {
  /** "Set as me": the next save whose primaryPersonId is `id` writes the link (LedgerStore.ts). */
  setPrimaryPerson(id: string): void
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
  /** The person the last read resolved to, and how (choice → link → fallback). */
  readonly primaryPersonId: string
  readonly resolvedBy: ResolvedBy
  /**
   * This device had chosen a person and that person no longer exists (PROMPT-14 Part 5). One of
   * the two inputs `identityAction` uses to ASK rather than let `assemble` fall back to people[0].
   */
  readonly staleChoice: boolean
  /** The person this device last showed by choice or link (PROMPT-16 Part F), or null. */
  readonly lastShown: ShownPerson | null
  ownerOf(personId: string): string | null
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
  let resolvedBy: ResolvedBy = 'none'
  let resolvedPrimary = ''
  // PROMPT-16 Part G (2026-09-23): rows another device deleted during this
  // session, as `table:id`. This device must never re-create one from its own
  // derived state — see the header. `ownDeletes` keeps this device's deletes
  // out of that set.
  const remotelyDeleted = new Set<string>()
  const ownDeletes = new Set<string>()
  const rowKey = (table: string, id: string) => `${table}:${id}`
  // …and the occurrence SLOTS those deleted transactions filled (projection's dedupeKey). The
  // auto-clearing pass regenerates a missing slot under an `auto:` id even when the row it replaces
  // had a hand-logged id, so matching on the id alone misses most of the damage.
  const remotelyDeletedSlots = new Set<string>()
  // …and the other half of the same window: PARENT rows (people, templates, loans, pots, cards,
  // pensions) that arrived from the server in the LATEST read and were not there before. A restore
  // inserts parents before transactions (TABLE_ORDER), so for a moment the other device sees new
  // templates with no occurrences and materialises them — and then the file's own rows arrive for
  // the same slots. A derived transaction insert that points at a just-arrived parent is dropped;
  // the parent counts as settled from the next read on. Rows this device inserted itself are not
  // "just arrived".
  const PARENT_TABLES = ['people', 'recurring_templates', 'loans', 'pots', 'savings_pots', 'credit_cards', 'pensions'] as const
  const newParents = new Set<string>()
  const ownInserts = new Set<string>()
  let pendingTap: string | null = null // setPrimaryPerson(id): the next save carrying this id IS "Set as me"
  const shownKey = `${storageKey}:shown` // PROMPT-16 Part F: who this device last showed, by choice or link
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
  const readShown = (): ShownPerson | null => {
    try {
      const raw = storage?.getItem(shownKey)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<ShownPerson>
      return typeof parsed.id === 'string' && typeof parsed.name === 'string' ? { id: parsed.id, name: parsed.name } : null
    } catch {
      return null
    }
  }
  const writeShown = (shown: ShownPerson) => {
    const prev = readShown()
    if (prev && prev.id === shown.id && prev.name === shown.name) return
    try {
      storage?.setItem(shownKey, JSON.stringify(shown))
    } catch (err) {
      log.warn('[powersync] could not remember the shown person on this device', err)
    }
  }

  function assemble(rows: Rows): AppDataV2 {
    // Part G: which rows vanished since the last read, and who deleted them.
    const wasPresent = new Map([...present].map(([t, ids]) => [t, new Set(ids)]))
    positions.clear()
    present.clear()
    linkedTo.clear()
    for (const r of rows.people ?? []) if (typeof r.linked_user_id === 'string' && r.linked_user_id) linkedTo.set(r.id, r.linked_user_id)
    const lastTx = new Map((lastDelivered ?? shadow)?.transactions.map((t) => [t.id, t]) ?? [])
    const firstRead = wasPresent.size === 0
    newParents.clear()
    for (const [table, list] of Object.entries(rows)) {
      const now = new Set(list.map((r) => r.id))
      if (!firstRead && (PARENT_TABLES as readonly string[]).includes(table)) {
        const before = wasPresent.get(table) ?? new Set<string>()
        for (const id of now) if (!before.has(id) && !ownInserts.has(rowKey(table, id))) newParents.add(id)
      }
      for (const id of wasPresent.get(table) ?? []) {
        if (now.has(id)) continue
        const key = rowKey(table, id)
        if (ownDeletes.delete(key)) continue // this device deleted it: not a remote deletion
        remotelyDeleted.add(key)
        if (table === 'transactions') {
          const slot = lastTx.get(id) ? dedupeKey(lastTx.get(id)!) : null
          if (slot) remotelyDeletedSlots.add(slot)
        }
      }
      for (const id of now) remotelyDeleted.delete(rowKey(table, id)) // re-created by someone: no longer "deleted"
      present.set(table, now)
      const known = new Map<string, number>()
      for (const r of list) if (typeof r.position === 'number') known.set(r.id, r.position)
      positions.set(table, known)
    }
    const base = fromRows(rows)
    // A slot filled again by anyone (the server holds a row for it) is no longer "deleted".
    if (remotelyDeletedSlots.size > 0) for (const t of base.transactions) {
      const slot = dedupeKey(t)
      if (slot) remotelyDeletedSlots.delete(slot)
    }
    const ids = new Set(base.people.map((p) => p.id))
    const choice = readChoice()
    const linked = (rows.people ?? []).find((r) => r.linked_user_id === userId)?.id
    staleChoice = choice !== null && !ids.has(choice)
    let primaryPersonId: string
    if (choice && ids.has(choice)) {
      primaryPersonId = choice
      resolvedBy = 'choice'
    } else if (linked && ids.has(linked)) {
      primaryPersonId = linked
      resolvedBy = 'link'
    } else {
      primaryPersonId = base.people[0]?.id ?? ''
      resolvedBy = primaryPersonId ? 'fallback' : 'none'
    }
    resolvedPrimary = primaryPersonId
    // Part F: remember who this device shows, but only when it can SAY who — the people[0]
    // fallback is the failure this memory exists to detect, so it never counts as "shown".
    if (resolvedBy === 'choice' || resolvedBy === 'link') {
      const shown = base.people.find((p) => p.id === primaryPersonId)
      if (shown) writeShown({ id: shown.id, name: shown.name })
    }
    return migrateLedgerData({ ...base, primaryPersonId })
  }

  /**
   * "Set as me" as one-column UPDATEs: `first` before the diff's writes, `last` after (see header).
   * `tapped` is the ONLY thing that makes an ordinary save write a link (PROMPT-16 Part A); an
   * import links its own new "Me" as before. Nothing is inferred from `primaryPersonId` moving.
   */
  function linkOps(after: AppDataV2, imported: boolean, tapped: boolean): { first: Op[]; last: Op[] } {
    const none = { first: [], last: [] }
    const target = after.primaryPersonId
    if (!target || !after.people.some((p) => p.id === target)) return none
    if (!imported && !tapped) return none
    const mine = [...linkedTo].find(([, uid]) => uid === userId)?.[0]
    if (mine === target) return none // my link is already right
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
    get primaryPersonId() {
      return resolvedPrimary
    },
    get resolvedBy() {
      return resolvedBy
    },
    get staleChoice() {
      return staleChoice
    },
    get lastShown() {
      return readShown()
    },
    ownerOf: (personId) => linkedTo.get(personId) ?? null,

    setPrimaryPerson(id) {
      pendingTap = id
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
        // The tap is consumed by the first save that gets this far: the one
        // carrying its id is "Set as me"; one carrying anything else means the
        // tap's state never landed (the person vanished), and it is stale.
        const tapped = pendingTap !== null && pendingTap === target.primaryPersonId
        pendingTap = null
        const link = linkOps(target, imported, tapped)
        if (imported) {
          const others = [...linkedTo.values()].filter((uid) => uid !== userId).length
          if (others > 0) {
            // Their rows are deleted and reborn, and only THEY can write their
            // link (people_enforce_self_link). Each of their devices re-links
            // itself by the remembered name, or asks (identityAction).
            log.info(`[powersync] restore: ${others} other household member(s) will re-link themselves by name on their next boot, or be asked (PROMPT-16 Part F)`)
          }
        }
        let ops = [...link.first, ...diffRows(toRows(shadow, ctx), toRows(target, ctx), positions, present), ...link.last]
        // 🚨 PROMPT-16 Part G: never re-create a row another device deleted in
        // this session, unless the user explicitly restored a file (setData).
        // While a restore syncs down, this device sees the old transactions
        // gone before the old templates and pay cycles are, and the app's
        // auto-clearing pass materialises them again from derived state; the
        // server accepts them (right household) and they survive as orphans
        // pointing at ids that no longer exist. verify-stale-writes-during-
        // restore.ts. `unsafeRecreateRemotelyDeleted` exists ONLY for that
        // check's control.
        let droppedRows: Map<string, Set<string>> | null = null
        if (!setDataCall && !opts.unsafeRecreateRemotelyDeleted) {
          const kept: Op[] = []
          const txById = new Map(target.transactions.map((t) => [t.id, t]))
          const refillsDeletedSlot = (op: Op) => {
            if (op.kind !== 'insert' || op.table !== 'transactions') return false
            const t = txById.get(op.row.id)
            const slot = t ? dedupeKey(t) : null
            return slot !== null && remotelyDeletedSlots.has(slot)
          }
          const pointsAtNewParent = (op: Op) => {
            if (op.kind !== 'insert' || op.table !== 'transactions' || newParents.size === 0) return false
            const t = txById.get(op.row.id)
            if (!t) return false
            const refs = [t.ownerId, t.personId, t.payee, t.sourceId, t.potId, t.savingsPotId, t.creditCardId]
            return refs.some((id) => id && newParents.has(id))
          }
          for (const op of ops) {
            if (op.kind === 'insert' && (remotelyDeleted.has(rowKey(op.table, op.row.id)) || refillsDeletedSlot(op) || pointsAtNewParent(op))) {
              droppedRows ??= new Map()
              ;(droppedRows.get(op.table) ?? droppedRows.set(op.table, new Set()).get(op.table)!).add(op.row.id)
            } else kept.push(op)
          }
          if (droppedRows) {
            const n = [...droppedRows.values()].reduce((s, ids) => s + ids.size, 0)
            log.warn(`[powersync] 🚨 dropped ${n} insert(s) that would re-create rows another device deleted — a restore is syncing down (PROMPT-16 Part G)`)
            ops = kept
          }
        }
        for (const op of ops) {
          if (op.kind === 'insert') {
            ;(present.get(op.table) ?? present.set(op.table, new Set()).get(op.table)!).add(op.row.id)
            ownInserts.add(rowKey(op.table, op.row.id))
            remotelyDeleted.delete(rowKey(op.table, op.row.id)) // an explicit restore may legitimately bring one back
            if (op.table === 'transactions') {
              const t = target.transactions.find((x) => x.id === op.row.id)
              const slot = t ? dedupeKey(t) : null
              if (slot) remotelyDeletedSlots.delete(slot)
            }
          }
          if (op.kind === 'delete') {
            present.get(op.table)?.delete(op.id)
            ownDeletes.add(rowKey(op.table, op.id))
          }
        }
        remember(next)
        remember(target)
        if (droppedRows) {
          // The shadow must not carry the rows that were NOT written, or an
          // explicit restore of them later would diff as "already there".
          const rows = toRows(target, ctx)
          for (const [table, ids] of droppedRows) rows[table] = (rows[table] ?? []).filter((r) => !ids.has(r.id))
          shadow = migrateLedgerData({ ...fromRows(rows), primaryPersonId: target.primaryPersonId })
        } else {
          shadow = target
        }
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
      // Part G: a restore arrives as a burst of commits. Coalescing change
      // events for a moment reads them as one state instead of several
      // partial ones (the app's own writes are already in React state, so
      // the delay is invisible). 0 in checks, which time their ticks.
      const debounce = opts.deliveryDebounceMs ?? 0
      let timer: ReturnType<typeof setTimeout> | null = null
      const schedule = () => {
        if (debounce <= 0) return void deliver()
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          void deliver()
        }, debounce)
      }
      const unsubscribe = db.onChange(schedule)
      void deliver() // the first, wholesale delivery (3.3b)
      return () => {
        if (timer) clearTimeout(timer)
        cancelled = true
        unsubscribe()
      }
    },

    flush: () => writeChain,
  }
}
