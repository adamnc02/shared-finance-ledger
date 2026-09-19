// SYNC APP ONLY (PROMPT-09). Prints this app's Sync Streams block for the
// PowerSync dashboard (ADAM-TASKS TASK 6a), generated from
// src/lib/powersync/tables.ts so every alias is exactly a local table name.
//
//   npx tsx scripts/print-sync-streams.ts
//
// ADD the output under the existing `streams:` key, beside personal-f's
// `household_data` block. Never edit that block.
//
// Why each line looks like this:
// - `AS sfl_<table>`: the alias names the LOCAL table (PowerSync docs:
//   "the alias maps the table to the new client-side name"). Deliberate, so
//   this app's `people`/`households`/`loans`/... never share a local table
//   with personal-f's (MIGRATION-LESSONS §7 is the accidental version).
// - `household_id IN (SELECT household_id FROM household_members WHERE
//   user_id = auth.user_id())`: the same rule as every table's RLS
//   (`household_id in (select my_household_ids())`), so a partner syncs
//   exactly the rows they can write. Every table carries household_id, so
//   no line joins through a parent.
// - scenarios: per user (DECISIONS Q4), matching its RLS.
// - auto_subscribe: false. The ledger subscribes explicitly and connects
//   with includeDefaultStreams: false; personal-f devices never download it.

import { SCHEMA, SYNCED_TABLES, localName } from '../src/lib/powersync/tables'

export const STREAM_NAME = 'shared_ledger_household'
const MY_HOUSEHOLDS = `SELECT household_id FROM ${SCHEMA}.household_members WHERE user_id = auth.user_id()`

export function streamQueries(): string[] {
  return SYNCED_TABLES.map((t) => {
    const from = `SELECT * FROM ${SCHEMA}.${t.remote} AS ${localName(t.remote)}`
    if (t.remote === 'households') return `${from} WHERE id IN (${MY_HOUSEHOLDS})`
    if (!t.household) return `${from} WHERE user_id = auth.user_id()`
    return `${from} WHERE household_id IN (${MY_HOUSEHOLDS})`
  })
}

if (process.argv[1]?.endsWith('print-sync-streams.ts')) {
  console.log(`  ${STREAM_NAME}:\n    auto_subscribe: false\n    queries:\n${streamQueries().map((q) => `      - ${q}`).join('\n')}`)
}
