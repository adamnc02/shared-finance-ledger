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

/**
 * `tables.ts`'s view of the synced schema, as { table: [column, ...] }.
 * PROMPT-13 B6 (2026-09-20).
 *
 * 🚨 WHY IT EXISTS — MIGRATION-LESSONS §34. `mapping.ts` once wrote
 * `from_type` where the column is `from_location_type`. `toRows`/`fromRows`
 * used the same wrong name both ways, so the round trip passed perfectly,
 * and the in-memory fake accepted any column. It was caught only by running
 * the real PowerSync database in headless Chromium.
 *
 * §34's own fix hardened `scripts/lib/fakeSyncDb.ts` to reject unknown
 * columns, which covers mapping → tables.ts. Nothing covered tables.ts →
 * POSTGRES, and that is the worse direction: an unknown-column error is not
 * in FATAL_RESPONSE_CODES, so PowerSync retries it forever and blocks the
 * device's entire upload queue rather than discarding one row.
 *
 * Emitted from here rather than from a file of its own so this repo gains no
 * new sync-only script, and `check:divergence` reports the same file count it
 * did before this prompt. Consumed by
 * silver-octo-invention/tools/schema-test/check-app-schema.mjs, which has
 * PGlite and the migrations:
 *
 *   npx tsx scripts/print-sync-streams.ts --columns
 */
export function syncedColumns(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const t of SYNCED_TABLES) out[t.remote] = Object.keys(t.columns).sort()
  return out
}

if (process.argv[1]?.endsWith('print-sync-streams.ts')) {
  if (process.argv.includes('--columns')) console.log(JSON.stringify(syncedColumns(), null, 2))
  else console.log(`  ${STREAM_NAME}:\n    auto_subscribe: false\n    queries:\n${streamQueries().map((q) => `      - ${q}`).join('\n')}`)
}
