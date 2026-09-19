// SYNC APP ONLY. The PowerSync database singleton.
//
// OPFSCoopSyncVFS, not the default VFS: PowerSync's docs flag the default as
// unreliable for multi-tab Safari/iOS, and this is a PWA (as personal-f).
//
// 🚨 dbFilename MUST differ per app. OPFS is per ORIGIN, and personal-f, both
// live ledger apps and the test app all live on adamnc02.github.io. Two apps
// sharing a file would each read, and upload, the other's rows. personal-f
// uses 'personal-finance.db'; this app's name comes from the build
// (VITE_POWERSYNC_DB_FILENAME): 'shared-finance-ledger.db' live,
// 'finance-ledger-test-sync.db' in the test app's /sync/ build. No default,
// so a build that forgot it fails loudly rather than sharing a file.

import { PowerSyncDatabase, WASQLiteVFS } from '@powersync/web'
import { AppSchema } from './schema'
import { SupabaseConnector } from './connector'

export const POWERSYNC_DB_FILENAME = import.meta.env.VITE_POWERSYNC_DB_FILENAME
if (!POWERSYNC_DB_FILENAME || POWERSYNC_DB_FILENAME === 'personal-finance.db') {
  throw new Error('VITE_POWERSYNC_DB_FILENAME must be set, and must not be personal-f\'s file.')
}

export const powerSyncDb = new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: POWERSYNC_DB_FILENAME, vfs: WASQLiteVFS.OPFSCoopSyncVFS },
})

export const powerSyncConnector = new SupabaseConnector()

/** This app's own stream (Sync Streams, auto_subscribe: false). */
export const LEDGER_STREAM = 'shared_ledger_household'
