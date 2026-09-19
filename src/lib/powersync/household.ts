// SYNC APP ONLY. The caller's household id, from ensure_household() (creates
// one on first call, seeded server-side with the 35 categories). Resolved once
// per user per session; cleared on sign-out so a different account on the
// same device never reuses it (as personal-f's household.ts).

import { supabase } from '../supabaseClient'

let cachedHouseholdId: string | null = null
let cachedForUserId: string | null = null

export async function getHouseholdId(userId: string): Promise<string> {
  if (cachedHouseholdId && cachedForUserId === userId) return cachedHouseholdId
  const { data, error } = await supabase.rpc('ensure_household')
  if (error) throw error
  if (typeof data !== 'string' || !data) throw new Error('ensure_household returned no household')
  cachedHouseholdId = data
  cachedForUserId = userId
  return data
}

export function clearHouseholdCache(): void {
  cachedHouseholdId = null
  cachedForUserId = null
}
