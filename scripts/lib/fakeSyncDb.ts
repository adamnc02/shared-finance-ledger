// PROMPT-09 test double for verify-powersync-store-diff.ts and
// verify-first-sync-gate.ts (not a verify-* script itself, so the sweep
// doesn't run it). An in-memory stand-in for PowerSync's local database that
// executes the exact SQL writes.ts' applyOps emits, so the real write path is
// exercised, and records every statement for assertions.

import { applyOps, type Op, type WriteTx } from '../../src/lib/powersync/writes'
import { LOCAL_PREFIX, SYNCED_TABLES } from '../../src/lib/powersync/tables'
import type { Row, Rows, Value } from '../../src/lib/powersync/mapping'
import type { SyncDatabase } from '../../src/lib/store/powerSyncLedgerStore'

export interface Statement {
  kind: 'insert' | 'update' | 'delete'
  table: string // Postgres name
  id: string
  columns: string[]
}

const toSqlite = (v: Value | undefined) => (v === undefined || v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)

export class FakeSyncDb implements SyncDatabase {
  tables = new Map<string, Map<string, Row>>(SYNCED_TABLES.map((t) => [t.remote, new Map()]))
  log: Statement[] = []
  private listeners = new Set<() => void>()

  /** Puts rows in as if they had arrived by sync (no statements logged, no callbacks). */
  seed(rows: Rows) {
    for (const [table, list] of Object.entries(rows)) {
      const t = this.tables.get(table)!
      for (const r of list) t.set(r.id, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toSqlite(v)])) as Row)
    }
  }

  /** A change arriving from the server (another device). */
  remoteChange(table: string, id: string, set: Record<string, Value>) {
    const row = this.tables.get(table)!.get(id)
    if (!row) throw new Error(`no ${table} ${id}`)
    for (const [k, v] of Object.entries(set)) row[k] = toSqlite(v)
    this.fire()
  }

  async readAll(): Promise<Rows> {
    const out: Rows = {}
    for (const [table, rows] of this.tables) out[table] = [...rows.values()].map((r) => ({ ...r }))
    return out
  }

  async write(ops: Op[]): Promise<void> {
    await applyOps(this.tx(), ops)
    this.fire()
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  clearLog() {
    this.log = []
  }

  private fire() {
    for (const l of this.listeners) setTimeout(l, 0)
  }

  private tx(): WriteTx {
    const table = (local: string) => {
      if (!local.startsWith(LOCAL_PREFIX)) throw new Error(`write to a non-sfl table: ${local}`)
      const t = this.tables.get(local.slice(LOCAL_PREFIX.length))
      if (!t) throw new Error(`unknown table ${local}`)
      return [local.slice(LOCAL_PREFIX.length), t] as const
    }
    // Like SQLite: a column the table doesn't have is an error, not a silent extra key.
    const known = (name: string, cols: string[]) => {
      const spec = SYNCED_TABLES.find((t) => t.remote === name)!.columns
      const bad = cols.filter((c) => c !== 'id' && !(c in spec))
      if (bad.length) throw new Error(`table ${LOCAL_PREFIX}${name} has no column named ${bad.join(', ')}`)
    }
    return {
      getOptional: async <T,>(sql: string, params: unknown[] = []) => {
        const m = sql.match(/^SELECT id FROM (\w+) WHERE id = \?$/)
        if (!m) throw new Error(`unexpected read: ${sql}`)
        const [, t] = table(m[1])
        return (t.has(String(params[0])) ? { id: params[0] } : null) as T | null
      },
      execute: async (sql: string, params: unknown[] = []) => {
        let m
        if ((m = sql.match(/^INSERT INTO (\w+) \(([^)]*)\) VALUES/))) {
          const [name, t] = table(m[1])
          const cols = m[2].split(',').map((c) => c.trim())
          known(name, cols)
          const row = Object.fromEntries(cols.map((c, i) => [c, params[i] as Value])) as Row
          if (t.has(row.id)) throw new Error(`UNIQUE constraint failed: ${m[1]}.id ${row.id}`)
          t.set(row.id, row)
          this.log.push({ kind: 'insert', table: name, id: row.id, columns: cols.filter((c) => c !== 'id') })
        } else if ((m = sql.match(/^UPDATE (\w+) SET (.*) WHERE id = \?$/))) {
          const [name, t] = table(m[1])
          const cols = m[2].split(',').map((c) => c.trim().replace(/ = \?$/, ''))
          known(name, cols)
          const id = String(params[params.length - 1])
          const row = t.get(id)
          if (!row) throw new Error(`update of a missing row ${m[1]} ${id}`)
          cols.forEach((c, i) => (row[c] = params[i] as Value))
          this.log.push({ kind: 'update', table: name, id, columns: cols })
        } else if ((m = sql.match(/^DELETE FROM (\w+) WHERE id = \?$/))) {
          const [name, t] = table(m[1])
          t.delete(String(params[0]))
          this.log.push({ kind: 'delete', table: name, id: String(params[0]), columns: [] })
        } else throw new Error(`unexpected SQL: ${sql}`)
      },
    }
  }
}

/** A promise you resolve by hand (the first-sync signal). */
export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

export function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}
