// SYNC APP ONLY. The real SyncDatabase behind powerSyncLedgerStore: every
// table read in ONE read transaction (a consistent snapshot, never half a
// sync), writes in one write transaction (uploaded as one, in order), and a
// change callback over this app's tables only.

import type { AbstractPowerSyncDatabase } from '@powersync/web'
import type { SyncDatabase } from '../store/powerSyncLedgerStore'
import type { Row, Rows } from './mapping'
import { applyOps } from './writes'
import { SYNCED_TABLES, localName } from './tables'

const LOCAL_TABLES = SYNCED_TABLES.map((t) => localName(t.remote))

export function powerSyncAdapter(db: AbstractPowerSyncDatabase): SyncDatabase {
  return {
    readAll: () =>
      db.readTransaction(async (tx) => {
        const rows: Rows = {}
        for (const t of SYNCED_TABLES) rows[t.remote] = await tx.getAll<Row>(`SELECT * FROM ${localName(t.remote)}`)
        return rows
      }),
    write: (ops) => db.writeTransaction((tx) => applyOps(tx, ops)),
    onChange: (callback) => db.onChange({ onChange: () => callback() }, { tables: LOCAL_TABLES, throttleMs: 50 }),
  }
}
