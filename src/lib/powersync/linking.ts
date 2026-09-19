// SYNC APP ONLY. Household link codes (BUILD-PLAN 4.4; PROMPT-10 Part 4).
// The functions live in shared_finance_ledger (silver-octo-invention
// docs/shared-finance-ledger-SUPABASE.md): security definer, the caller only.
//
// Redeem moves the joiner's OWN data server-side (their "Set as me" person
// and everything attached to it; joint items stay behind). The local copy
// does not follow: the caller must clear this device's database and boot
// again through the first-sync gate (SyncRoot's restart). The redeemer's
// OTHER open devices find out from synced membership and do the same
// (powerSyncLedgerStore, MIGRATION-LESSONS §38).

import { supabase } from '../supabaseClient'

export interface RedeemResult {
  household_id: string
  brought_own_data: boolean
  own_person_id: string | null
  moved: Record<string, number>
  duplicate_person_id: string | null
  old_household_deleted: boolean
}

/** The household's permanent code, made on first call. */
export async function getLinkCode(): Promise<string> {
  const { data, error } = await supabase.rpc('create_household_link_code')
  if (error) throw error
  return String(data)
}

/** "This code leaked": the old code stops working. */
export async function regenerateLinkCode(): Promise<string> {
  const { data, error } = await supabase.rpc('regenerate_household_link_code')
  if (error) throw error
  return String(data)
}

export async function redeemLinkCode(code: string): Promise<RedeemResult> {
  const { data, error } = await supabase.rpc('redeem_household_link_code', { p_code: code.trim() })
  if (error) throw error
  return data as RedeemResult
}

// A same-named, unlinked person left in the new household (someone's guess
// of the joiner) is reported, not merged. It's kept on this device until the
// banner resolves it (DuplicatePersonBanner).
export const duplicatePersonKey = (userId: string) => `ledger:sync:duplicate-person:${userId}`

export function rememberDuplicate(storage: Pick<Storage, 'setItem'>, userId: string, personId: string | null): void {
  if (!personId) return
  try {
    storage.setItem(duplicatePersonKey(userId), personId)
  } catch {
    /* storage unavailable: the banner just won't appear */
  }
}

// Set after a join that brought nothing (the joiner had no people yet), so
// the next boot asks "which of these is you?" once. Cleared when answered.
export const justJoinedKey = (userId: string) => `ledger:sync:just-joined:${userId}`
