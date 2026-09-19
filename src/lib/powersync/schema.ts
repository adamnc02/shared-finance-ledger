// SYNC APP ONLY. The local PowerSync schema, built from tables.ts so it can't
// drift from the table list the connector and the Sync Streams YAML use.
// No `id` column is declared: PowerSync adds it.

import { column, Schema, Table } from '@powersync/web'
import { SYNCED_TABLES, localName, type ColumnKind } from './tables'

const COLUMN = { text: column.text, real: column.real, integer: column.integer, bool: column.integer, json: column.text } satisfies Record<ColumnKind, unknown>

export const AppSchema = new Schema(
  Object.fromEntries(
    SYNCED_TABLES.map((spec) => [
      localName(spec.remote),
      new Table(Object.fromEntries(Object.entries(spec.columns).map(([name, kind]) => [name, COLUMN[kind]]))),
    ]),
  ),
)
