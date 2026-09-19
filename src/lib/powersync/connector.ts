// SYNC APP ONLY. PowerSync ↔ Supabase, mirroring personal-f's connector:
//   - fetchCredentials(): the PowerSync URL + the Supabase session's JWT;
//   - uploadData(): drains the local write queue one transaction at a time.
//
// Differences from personal-f, all deliberate:
// - Local tables are `sfl_<table>` (tables.ts); uploads go to `<table>`.
// - A PUT (local INSERT) drops null columns before the upsert. A PUT only
//   ever creates a row, so a null adds nothing on insert; but if the row
//   already exists (two devices inserting one derived id) it would blank a
//   column the other device set (e.g. people.linked_user_id).
// - jsonb columns are sent as JSON values, not the TEXT SQLite holds, or
//   Postgres stores a string and it syncs back as one (toServerRecord).
// - A discarded write is logged LOUDLY and kept in a small local list the
//   app can show (recordRejectedWrite), never silently dropped. The
//   discard itself stays: a write Postgres permanently rejects would
//   otherwise block every later write behind it forever.

import type { AbstractPowerSyncDatabase, CrudEntry, PowerSyncBackendConnector } from '@powersync/web'
import { UpdateType } from '@powersync/web'
import { supabase } from '../supabaseClient'
import { remoteName, toServerRecord } from './tables'

const POWERSYNC_URL: string = import.meta.env.VITE_POWERSYNC_URL ?? ''
if (!POWERSYNC_URL) {
  throw new Error('Missing VITE_POWERSYNC_URL. Put the Development instance URL in .env.local.')
}

// Not retried: bad data (22xxx), a constraint (23xxx: FK, CHECK, unique),
// or an RLS/privilege refusal (42501). Same list as personal-f and
// PowerSync's reference Supabase connector. Everything else (network, 5xx,
// PGRST002) is thrown and retried.
export const FATAL_RESPONSE_CODES = [/^22...$/, /^23...$/, /^42501$/]

export const REJECTED_WRITES_KEY = 'ledger:sync:rejected-writes'

export interface RejectedWrite {
  at: string
  table: string
  op: string
  id: string
  code: string
  message: string
}

function recordRejectedWrite(entry: RejectedWrite) {
  try {
    const list: RejectedWrite[] = JSON.parse(localStorage.getItem(REJECTED_WRITES_KEY) ?? '[]')
    list.unshift(entry)
    localStorage.setItem(REJECTED_WRITES_KEY, JSON.stringify(list.slice(0, 50)))
  } catch {
    // Storage full or unavailable: the console.error below is still there.
  }
}

export function readRejectedWrites(): RejectedWrite[] {
  try {
    return JSON.parse(localStorage.getItem(REJECTED_WRITES_KEY) ?? '[]')
  } catch {
    return []
  }
}

export class SupabaseConnector implements PowerSyncBackendConnector {
  async fetchCredentials() {
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession()
    if (error || !session) {
      throw new Error(`Could not fetch Supabase credentials: ${error?.message ?? 'no session'}`)
    }
    return { endpoint: POWERSYNC_URL, token: session.access_token }
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction()
    if (!transaction) return

    let lastOp: CrudEntry | null = null
    try {
      for (const op of transaction.crud) {
        lastOp = op
        const table = supabase.from(remoteName(op.table))
        let result
        switch (op.op) {
          case UpdateType.PUT:
            result = await table.upsert({ ...toServerRecord(op.table, op.opData ?? {}, { dropNulls: true }), id: op.id })
            break
          case UpdateType.PATCH:
            result = await table.update(toServerRecord(op.table, op.opData ?? {}, { dropNulls: false })).eq('id', op.id)
            break
          case UpdateType.DELETE:
            result = await table.delete().eq('id', op.id)
            break
        }

        if (result?.error) {
          const code = result.error.code ?? ''
          if (FATAL_RESPONSE_CODES.some((pattern) => pattern.test(code))) {
            console.error(
              `[powersync] 🚨 DISCARDED a write the server rejected (${code}) — ${op.op} ${op.table} ${op.id}. ` +
                'This change is NOT on the server. See MIGRATION-LESSONS §27.',
              result.error,
              op.opData,
            )
            recordRejectedWrite({ at: new Date().toISOString(), table: op.table, op: op.op, id: op.id, code, message: result.error.message })
            continue
          }
          throw new Error(`Could not update Supabase (${op.table}): ${result.error.message}`)
        }
      }
      await transaction.complete()
    } catch (err) {
      console.warn('[powersync] Upload failed, will retry:', lastOp, err)
      throw err
    }
  }
}
