// SYNC APP ONLY. An import gets fresh ids (PROMPT-10 Part 3; MIGRATION-LESSONS
// §31; Adam, 2026-09-19).
//
// Every synced table has one table-wide text primary key. Importing the same
// backup into two households would give both the same row ids: the second
// household's upload is refused (23505 / 42501) and the connector discards
// it, silently. So an import keeps ONLY the 35 fixed category ids (the sync
// layer already makes those unique per household with '@<household>') and
// gives everything else a new id.
//
// Why a generic walk and not a list of fields (MIGRATION-LESSONS §22: the
// field nobody thought of fails silently): every object in the data that
// has an `id` gets a new one, and then EVERY string value anywhere in the
// data that equals one of the old ids is replaced by its new one: ownerId,
// payee, personId, potId, savingsPotId, creditCardId, categoryId, sourceId,
// transactionId, followsIncomeSource.pensionId, interestDestination.*,
// transferFrom/To, from/toLocation, locationHistory[].potId, scenario
// targets/linkedTargetId/linkedLoanId/loanAllocations, salary sort targets,
// primaryPersonId, and anything added later. verify-import-regenerates-ids.ts
// proves it by mapping the result back and comparing it with the original.
//
// Composite ids are re-derived, not just remapped, so they keep meaning what
// they say and stay deterministic across two devices (§36):
//   - an auto-cleared payment is 'auto:<dedupeKey>', and the key contains the
//     source's id;
//   - a Salary Sort, its targets and their transfers are
//     'sort:<personId>:<payDate>[:<destination>[:tx]]' (PROMPT-11).
// Both differ between two households once the ids inside them do.
//
// Pure: no PowerSync or Supabase import (runs in Node).

import { nanoid } from 'nanoid'
import type { AppDataV2, Transaction } from '../../types/ledger'
import { defaultCategories } from '../categories'
import { dedupeKey } from '../projection'
import { salarySortId, salarySortTargetId, salarySortTransactionId } from '../salarySortLedger'

/** The app's 35 fixed category ids, kept as they are. */
export const FIXED_CATEGORY_IDS: ReadonlySet<string> = new Set(defaultCategories().map((c) => c.id))

const AUTO_PREFIX = 'auto:'
const SORT_PREFIX = 'sort:'

/** Every `id` of every object anywhere in `data` (dedupeKey-derived auto ids excluded). */
function collectIds(value: unknown, out: Set<string>) {
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, out)
  } else if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'string' && id && !id.startsWith(AUTO_PREFIX)) out.add(id)
    for (const v of Object.values(value)) collectIds(v, out)
  }
}

/** Replaces every string equal to an old id, at any depth. New objects throughout; the input is untouched. */
function remap<T>(value: T, map: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') return (map.get(value) ?? value) as T
  if (Array.isArray(value)) return value.map((v) => remap(v, map)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, map)])) as T
  }
  return value
}

/** An auto-cleared payment's id follows its (remapped) occurrence key. */
function rederiveAutoIds(transactions: Transaction[], newId: () => string): Transaction[] {
  return transactions.map((t) => {
    if (!t.id.startsWith(AUTO_PREFIX)) return t
    const key = dedupeKey(t)
    const id = key ? AUTO_PREFIX + key : AUTO_PREFIX + newId()
    return id === t.id ? t : { ...t, id }
  })
}

/** Salary Sort ids follow the (remapped) person and payday, and their targets and transfers follow them. */
function rederiveSalarySortIds(data: AppDataV2): AppDataV2 {
  const map = new Map<string, string>()
  for (const sort of data.salarySorts) {
    if (!sort.id.startsWith(SORT_PREFIX)) continue
    const id = salarySortId(sort.personId, sort.payDate)
    if (id !== sort.id) map.set(sort.id, id)
    for (const target of sort.targets) {
      const targetId = salarySortTargetId(id, target.to)
      if (targetId !== target.id) map.set(target.id, targetId)
      const txId = salarySortTransactionId(targetId)
      if (target.transactionId && txId !== target.transactionId) map.set(target.transactionId, txId)
    }
  }
  return map.size === 0 ? data : remap(data, map)
}

export interface RegeneratedImport {
  data: AppDataV2
  /** old id → new id (the fixed category ids and auto ids are not in it). */
  map: Map<string, string>
}

/** The data with a fresh id for everything but the fixed categories, and every reference remapped. */
export function regenerateIds(data: AppDataV2, newId: () => string = () => nanoid(8)): RegeneratedImport {
  const ids = new Set<string>()
  collectIds(data, ids)
  const map = new Map<string, string>()
  for (const id of ids) {
    if (FIXED_CATEGORY_IDS.has(id)) continue
    let fresh = newId()
    while (ids.has(fresh) || FIXED_CATEGORY_IDS.has(fresh)) fresh = newId()
    map.set(id, fresh)
  }
  return { data: applyIdMap(data, map, newId), map }
}

/**
 * Applies an existing old → new map (a save that still carries the imported ids, before the store's
 * own delivery has replaced them in the app).
 */
export function applyIdMap(data: AppDataV2, map: ReadonlyMap<string, string>, newId: () => string = () => nanoid(8)): AppDataV2 {
  const out = rederiveSalarySortIds(remap(data, map))
  return { ...out, transactions: rederiveAutoIds(out.transactions, newId) }
}
