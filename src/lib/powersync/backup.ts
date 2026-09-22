// SYNC APP ONLY. Cloud snapshots (BUILD-PLAN 4.5; personal-f's lib/backup.ts,
// rewired). Private bucket 'shared-finance-ledger-backups', path
// '<user id>/<yyyy-mm-dd>.json' (the bucket's policies limit each user to
// their own folder). One file per day: a second backup the same day
// replaces it.
//
// A snapshot is the same JSON as Wallet → Backup's download (the app's own
// AppDataV2), so either can be restored anywhere. Restoring goes through
// the app's normal restore (setData), which the sync store treats as an
// import: fresh ids (importIds.ts) and a full replace of the household.
// It is always a deliberate action behind a whole-household warning
// (DECISIONS Q9): never offered at sign-in.

import type { AppDataV2 } from '../../types/ledger'
import { parseLedgerBackupJson, serialiseLedgerBackup } from '../ledgerStorage'
import { toLocalIsoDate } from '../date'
import { supabase } from '../supabaseClient'

export const BACKUP_BUCKET = 'shared-finance-ledger-backups'

/** How many daily snapshots survive a prune (PROMPT-14 §0 Q5). */
export const SNAPSHOTS_KEPT = 30

export interface SnapshotInfo {
  name: string
  createdAt: string | null
}

const today = () => toLocalIsoDate(new Date())

export async function uploadSnapshot(userId: string, data: AppDataV2): Promise<void> {
  const { error } = await supabase.storage
    .from(BACKUP_BUCKET)
    .upload(`${userId}/${today()}.json`, serialiseLedgerBackup(data), { contentType: 'application/json', upsert: true })
  if (error) throw error
}

/** Newest first. */
export async function listSnapshots(userId: string): Promise<SnapshotInfo[]> {
  const { data, error } = await supabase.storage.from(BACKUP_BUCKET).list(userId, { sortBy: { column: 'name', order: 'desc' } })
  if (error) throw error
  return (data ?? []).filter((f) => f.name.endsWith('.json')).map((f) => ({ name: f.name, createdAt: f.created_at ?? null }))
}

export async function downloadSnapshot(userId: string, name: string): Promise<AppDataV2> {
  const { data, error } = await supabase.storage.from(BACKUP_BUCKET).download(`${userId}/${name}`)
  if (error) throw error
  return parseLedgerBackupJson(await data.text())
}

/**
 * Keep the newest `keep` daily snapshots, delete the rest (PROMPT-14 §0 Q5, Adam 2026-09-22:
 * "keep the last 30"). Nothing pruned anything before this, so a long-lived household grew a
 * file a day forever.
 *
 * 🚨 This is deliberately NOT removeAllSnapshots with an argument. That function is Delete my
 * app data's, it takes no filter, and one refactor joining the two is a household with no
 * restore point. Keep them separate even though they look similar.
 *
 * Newest is decided by NAME (the yyyy-mm-dd the snapshot is FOR), never by position in a
 * listing or by created_at: an upsert the same day keeps the original created_at, so sorting
 * by it would prune the wrong file.
 */
export async function pruneSnapshots(userId: string, keep = SNAPSHOTS_KEPT): Promise<number> {
  const list = await listSnapshots(userId) // newest first, by name
  const stale = list.slice(keep)
  if (stale.length === 0) return 0
  const { error } = await supabase.storage.from(BACKUP_BUCKET).remove(stale.map((s) => `${userId}/${s.name}`))
  if (error) throw error
  console.info(`[backup] pruned ${stale.length} snapshot(s), kept ${keep}`)
  return stale.length
}

/** Every file in this user's folder (Delete my app data removes them first: SQL can't). */
export async function removeAllSnapshots(userId: string): Promise<number> {
  const { data: files, error } = await supabase.storage.from(BACKUP_BUCKET).list(userId)
  if (error) throw error
  if (!files?.length) return 0
  const { error: rmError } = await supabase.storage.from(BACKUP_BUCKET).remove(files.map((f) => `${userId}/${f.name}`))
  if (rmError) throw rmError
  return files.length
}

/**
 * Once a day, silently, if today's snapshot doesn't exist yet (personal-f / BLOC's opportunistic
 * backup). Best effort: a failure is logged and retried on the next load, never shown.
 */
export async function maybeUploadDailySnapshot(userId: string, data: AppDataV2): Promise<void> {
  try {
    if (data.people.length === 0) return // nothing worth keeping yet
    const list = await listSnapshots(userId)
    if (list.some((s) => s.name === `${today()}.json`)) return
    await uploadSnapshot(userId, data)
    console.info('[backup] daily snapshot uploaded')
    await pruneSnapshots(userId)
  } catch (err) {
    console.warn('[backup] daily snapshot failed, will retry next load:', err)
  }
}
