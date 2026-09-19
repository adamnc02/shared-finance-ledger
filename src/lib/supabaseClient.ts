// SYNC APP ONLY. The one Supabase client, scoped to this app's schema once
// here, so every `.from()` / `.rpc()` targets shared_finance_ledger. The
// publishable key is public by design: RLS protects the data, not the key
// (MIGRATION-LESSONS §12). Values come from .env.local (created from the
// terminal, never Finder: §9).

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Put them in .env.local (see ADAM-TASKS standing facts).')
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: { schema: 'shared_finance_ledger' },
})

/** OAuth providers the sign-in gate offers (personal-f's list; Google only). */
export const AUTH_PROVIDERS = [{ id: 'google', provider: 'google' as const, label: 'Continue with Google' }]
