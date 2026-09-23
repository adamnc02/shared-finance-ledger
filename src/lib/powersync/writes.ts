// SYNC APP ONLY. Turns "the app's data changed from A to B" into the smallest
// set of row writes, and applies them to the local PowerSync database (which
// queues them for upload).
//
// 🚨 HARD RULE — NARROW UPDATEs ONLY (DECISIONS Q2). Every UPDATE sets only
// the columns whose value genuinely changed. PowerSync resolves conflicts
// per COLUMN (the connector PATCHes only what the local UPDATE set), and
// the whole table split rests on that: two partners editing two different
// fields of one bill must both survive. A "write the whole row" shortcut
// would silently destroy that on every table at once. verify-powersync-
// store-diff.ts proves a one-field edit writes one column.
//
// Order within one save (MIGRATION-LESSONS §27, FKs are NO ACTION):
//   1. inserts, parent tables first (TABLE_ORDER), and within savings_pots
//      a pot before any pot whose interest goes to it;
//   2. updates (so a reference is re-pointed before its old target goes);
//   3. deletes, child tables first.
// A write the server rejects for an FK is DISCARDED, not retried, so this
// order is what stops data vanishing.
//
// Positions (20260919230000): the app's arrays are ordered, tables aren't.
// A new row gets a position after its previous sibling (or between its
// neighbours, for a mid-list insert). Existing rows keep theirs; only rows
// whose relative order genuinely changed get a new one (the longest run
// already in order is left alone). Deleting never renumbers anything.

import { TABLE_ORDER, canonicalJson, type Row, type Rows, type Value } from './mapping'
import { localName, tableSpec } from './tables'

export type Op =
  | { kind: 'insert'; table: string; row: Row }
  | { kind: 'update'; table: string; id: string; set: Record<string, Value> }
  | { kind: 'delete'; table: string; id: string }

/** Known `position` per table per row id, as stored locally. */
export type Positions = Map<string, Map<string, number>>

/** Which column groups a child table's rows into sibling lists (its parent). */
const PARENT_COLUMN: Record<string, string> = {
  salary_snapshots: 'person_id',
  salary_deductions: 'salary_snapshot_id',
  salary_overrides: 'person_id',
  savings_pot_interest_overrides: 'savings_pot_id',
  savings_pot_recurring_deposit_overrides: 'savings_pot_id',
  pension_occurrence_overrides: 'pension_id',
  recurring_template_occurrence_overrides: 'recurring_template_id',
  loan_overpayments: 'loan_id',
  loan_statement_calibration_lines: 'loan_id',
  credit_card_lump_payments: 'credit_card_id',
  credit_card_minimum_payment_overrides: 'credit_card_id',
  salary_sort_targets: 'salary_sort_id',
}

/** Indices (into `values`) of one longest strictly increasing subsequence. */
function longestIncreasing(values: number[]): Set<number> {
  const tails: number[] = []
  const prev: number[] = new Array(values.length).fill(-1)
  for (let i = 0; i < values.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (values[tails[mid]] < values[i]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
  }
  const keep = new Set<number>()
  for (let k = tails.length ? tails[tails.length - 1] : -1; k !== -1; k = prev[k]) keep.add(k)
  return keep
}

/**
 * Positions for one ordered sibling list. Rows whose known position already
 * fits the order keep it; every other row (new, or moved) gets one between
 * its neighbours.
 */
export function assignPositions(ids: string[], known: Map<string, number>): Map<string, number> {
  const withPos = ids.map((id, i) => ({ i, p: known.get(id) })).filter((x): x is { i: number; p: number } => typeof x.p === 'number')
  const keepIdx = longestIncreasing(withPos.map((x) => x.p))
  const kept = new Map<number, number>() // list index → kept position
  withPos.forEach((x, k) => {
    if (keepIdx.has(k)) kept.set(x.i, x.p)
  })
  const out = new Map<string, number>()
  let last = -Infinity
  for (let i = 0; i < ids.length; i++) {
    const keep = kept.get(i)
    if (keep !== undefined) {
      out.set(ids[i], keep)
      last = keep
      continue
    }
    let upper: number | undefined
    for (let k = i + 1; k < ids.length; k++) {
      const u = kept.get(k)
      if (u !== undefined) {
        upper = u
        break
      }
    }
    const pos = last === -Infinity ? (upper === undefined ? 0 : upper - 1) : upper === undefined ? last + 1 : (last + upper) / 2
    out.set(ids[i], pos)
    last = pos
  }
  return out
}

function siblingGroups(table: string, rows: Row[]): string[][] {
  const col = PARENT_COLUMN[table]
  if (!col) return [rows.map((r) => r.id)]
  const groups = new Map<string, string[]>()
  for (const r of rows) {
    const k = String(r[col] ?? '')
    const g = groups.get(k)
    if (g) g.push(r.id)
    else groups.set(k, [r.id])
  }
  return [...groups.values()]
}

/** savings_pots: a pot before any pot whose interest destination is it (the FK is within the table). */
function orderSavingsPotInserts(rows: Row[]): Row[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: Row[] = []
  const seen = new Set<string>()
  const visit = (r: Row, depth = 0) => {
    if (seen.has(r.id) || depth > rows.length) return
    const dest = r.interest_destination_savings_pot_id
    if (typeof dest === 'string' && dest !== r.id && byId.has(dest)) visit(byId.get(dest)!, depth + 1)
    if (!seen.has(r.id)) {
      seen.add(r.id)
      out.push(r)
    }
  }
  rows.forEach((r) => visit(r))
  return out
}

/**
 * The writes that turn `prev` into `next`. Both are mapping.ts rows (from the
 * same household context). `positions` is what the local database holds; it
 * is updated in place with every position this diff assigns.
 *
 * `present` (ids per table the local database actually holds) matters for
 * rows the app has but the database doesn't: migrateLedgerData re-derives a
 * missing built-in category on every read. Such a row is left alone (no
 * UPDATE of a row that isn't there, no position) unless the app changes it,
 * and then it is INSERTed whole. Without `present`, every `prev` row is
 * assumed to exist.
 */
export function diffRows(prev: Rows, next: Rows, positions: Positions, present?: Map<string, Set<string>>): Op[] {
  const inserts: Op[] = []
  const updates: Op[] = []
  const deletes: Op[] = []

  for (const table of TABLE_ORDER) {
    const before = new Map((prev[table] ?? []).map((r) => [r.id, r]))
    const afterList = next[table] ?? []
    const after = new Map(afterList.map((r) => [r.id, r]))
    const hasPosition = 'position' in tableSpec(table).columns
    const known = positions.get(table) ?? new Map<string, number>()
    positions.set(table, known)

    const assigned = new Map<string, number>()
    if (hasPosition) {
      for (const ids of siblingGroups(table, afterList)) {
        for (const [id, p] of assignPositions(ids, known)) assigned.set(id, p)
      }
    }

    const inDb = present?.get(table)
    const newRows: Row[] = []
    for (const row of afterList) {
      let old = before.get(row.id)
      const pos = assigned.get(row.id)
      if (old && inDb && !inDb.has(row.id)) {
        // Only in the app (re-derived): write it only once the app changes it.
        const changed = Object.keys(row).some((col) => col !== 'id' && col !== 'position' && !sameValue(old![col], row[col]))
        if (!changed) continue
        old = undefined
      }
      if (!old) {
        const { position: _p, ...rest } = row
        newRows.push(hasPosition ? { ...rest, id: row.id, position: pos ?? 0 } : ({ ...rest, id: row.id } as Row))
        continue
      }
      const set: Record<string, Value> = {}
      for (const [col, value] of Object.entries(row)) {
        if (col === 'id' || col === 'position') continue
        if (!sameValue(old[col], value)) set[col] = value
      }
      if (hasPosition && pos !== undefined && known.get(row.id) !== pos) set.position = pos
      if (Object.keys(set).length > 0) updates.push({ kind: 'update', table, id: row.id, set })
    }
    for (const row of table === 'savings_pots' ? orderSavingsPotInserts(newRows) : newRows) inserts.push({ kind: 'insert', table, row })
    for (const id of before.keys()) if (!after.has(id) && (!inDb || inDb.has(id))) deletes.push({ kind: 'delete', table, id })

    for (const [id, p] of assigned) if (!inDb || inDb.has(id) || newRows.some((r) => r.id === id)) known.set(id, p)
    for (const id of before.keys()) if (!after.has(id)) known.delete(id)
  }

  // Deletes: child tables first (reverse FK order).
  const deleteOrder = new Map<string, number>(TABLE_ORDER.map((t, i) => [t, -i]))
  deletes.sort((a, b) => deleteOrder.get(a.table)! - deleteOrder.get(b.table)!)
  return [...inserts, ...updates, ...deletes]
}

function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  const na = a === undefined ? null : a
  const nb = b === undefined ? null : b
  if (typeof na === 'boolean' || typeof nb === 'boolean') return toBit(na) === toBit(nb)
  return na === nb
}
const toBit = (v: Value): number | null => (v === null ? null : v === true || v === 1 || v === '1' ? 1 : 0)

/**
 * SQLite has no boolean: store 1/0. And no json type: store canonical TEXT.
 *
 * `toRows` already canonicalises every jsonb column, so an object should never
 * arrive here — but `Value` admits one (PostgREST parses jsonb, see mapping.ts)
 * and the local column is text either way, so encode rather than let
 * `[object Object]` reach the database.
 */
const sqliteValue = (v: Value | undefined): string | number | null =>
  v === undefined || v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'object' ? canonicalJson(v) : v

/** The subset of PowerSync's transaction this needs (so tests can pass a fake). */
export interface WriteTx {
  execute(sql: string, params?: unknown[]): Promise<unknown>
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
}

/**
 * Applies ops inside ONE local transaction, which PowerSync uploads as one
 * CRUD transaction in the same order. An insert whose id already exists
 * locally (another device wrote the same derived id first, e.g. an
 * auto-cleared payment) becomes an update of the columns given, so the two
 * converge on one row instead of failing.
 */
export async function applyOps(tx: WriteTx, ops: Op[]): Promise<void> {
  for (const op of ops) {
    const table = localName(op.table)
    if (op.kind === 'insert') {
      const existing = await tx.getOptional<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, [op.row.id])
      const cols = Object.keys(op.row).filter((c) => c !== 'id')
      if (existing) {
        if (cols.length) {
          await tx.execute(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => sqliteValue(op.row[c])), op.row.id])
        }
      } else {
        await tx.execute(
          `INSERT INTO ${table} (id${cols.map((c) => `, ${c}`).join('')}) VALUES (?${cols.map(() => ', ?').join('')})`,
          [op.row.id, ...cols.map((c) => sqliteValue(op.row[c]))],
        )
      }
    } else if (op.kind === 'update') {
      const cols = Object.keys(op.set)
      await tx.execute(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => sqliteValue(op.set[c])), op.id])
    } else {
      await tx.execute(`DELETE FROM ${table} WHERE id = ?`, [op.id])
    }
  }
}
