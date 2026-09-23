/**
 * PowerSync free-plan keep-alive.
 *
 * PowerSync Cloud deprovisions Free-plan instances that have had "no
 * deploys or client connections for over 7 days" (docs.powersync.com/
 * resources/usage-and-billing). This happened to personal-f's instance in
 * Sept 2026 after a week of nobody opening the app. A real client
 * connection is the cheapest way to count as activity — unlike a scheduled
 * redeploy, it doesn't make PowerSync reprocess from scratch and re-sync
 * every device, and it needs no PowerSync admin token.
 *
 * What this does, once per scheduled run:
 *   1. Signs in to Supabase as a dedicated keep-alive user (email/password).
 *      That user belongs to no household, so every Sync Streams query
 *      resolves to zero rows for it — it can't see anyone's data.
 *   2. Connects to PowerSync with that session's JWT, exactly like the app
 *      does, and waits for the first sync checkpoint.
 *   3. Disconnects, signs out (revoking the refresh token), deletes the
 *      throwaway local database.
 *
 * Exits non-zero on ANY failure, so GitHub emails Adam about the failed
 * run — this doubles as the early warning if the instance is ever down
 * again. Never logs the password or the JWT.
 *
 * Standalone package (own package.json) on purpose: nothing here touches
 * the app's dependencies or build. It lives in shared-finance-ledger (moved
 * here from personal-f on 2026-09-23, BUILD-PLAN.md Phase 7) because this
 * repo is committed to far more often — GitHub disables scheduled workflows
 * in public repos with no commits for 60 days. Only ONE repo runs it: the
 * PowerSync instance is shared across the apps on this project.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { column, PowerSyncDatabase, Schema, Table } from '@powersync/node'
import { createClient } from '@supabase/supabase-js'

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'POWERSYNC_URL', 'KEEPALIVE_EMAIL', 'KEEPALIVE_PASSWORD']
const TIMEOUT_MS = 90_000

const missing = REQUIRED_ENV.filter((name) => !process.env[name])
if (missing.length > 0) {
  console.error(`✗ Missing environment variables: ${missing.join(', ')}`)
  process.exit(1)
}

const { SUPABASE_URL, SUPABASE_ANON_KEY, POWERSYNC_URL, KEEPALIVE_EMAIL, KEEPALIVE_PASSWORD } = process.env

// persistSession: false — nothing to store between runs, and no local
// token file left lying around on the runner.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// The keep-alive user syncs nothing, so the local schema is irrelevant —
// but PowerSyncDatabase requires one. A single placeholder table is enough.
const schema = new Schema({ keepalive_placeholder: new Table({ note: column.text }) })

const dbDir = mkdtempSync(join(tmpdir(), 'powersync-keepalive-'))
const db = new PowerSyncDatabase({
  schema,
  database: { dbFilename: 'keepalive.db', dbLocation: dbDir },
})

const connector = {
  async fetchCredentials() {
    const { data, error } = await supabase.auth.getSession()
    if (error || !data.session) throw new Error(`No Supabase session: ${error?.message ?? 'not signed in'}`)
    return { endpoint: POWERSYNC_URL, token: data.session.access_token }
  },
  // Read-only client — it never writes, so there's never anything queued.
  async uploadData() {},
}

function withTimeout(promise, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

let exitCode = 0
try {
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: KEEPALIVE_EMAIL,
    password: KEEPALIVE_PASSWORD,
  })
  if (signInError) throw new Error(`Supabase sign-in failed: ${signInError.message}`)
  console.log('✓ Signed in to Supabase as the keep-alive user')

  // Surface PowerSync's own connection error (e.g. instance deprovisioned,
  // JWT rejected) instead of only a bare timeout.
  let lastStatusError = null
  const unsubscribe = db.registerListener({
    statusChanged: (status) => {
      const err = status.dataFlowStatus?.downloadError
      if (err) lastStatusError = err
    },
  })

  await db.connect(connector)
  try {
    await withTimeout(db.waitForFirstSync(), 'Waiting for first PowerSync checkpoint')
  } catch (err) {
    if (lastStatusError) throw new Error(`${err.message} — last PowerSync error: ${lastStatusError.message ?? lastStatusError}`)
    throw err
  } finally {
    unsubscribe?.()
  }

  const status = db.currentStatus
  if (!status.hasSynced) throw new Error('Connected, but PowerSync never reported a completed sync')
  console.log(`✓ Connected to PowerSync and completed a sync (lastSyncedAt: ${status.lastSyncedAt?.toISOString()})`)
} catch (err) {
  exitCode = 1
  console.error(`✗ PowerSync keep-alive FAILED: ${err instanceof Error ? err.message : err}`)
  console.error('  If this keeps failing, check the PowerSync dashboard → Health for this instance.')
} finally {
  await db.disconnect().catch(() => {})
  await db.close().catch(() => {})
  await supabase.auth.signOut().catch(() => {})
  rmSync(dbDir, { recursive: true, force: true })
}

process.exit(exitCode)
