/// <reference types="vite/client" />

// SYNC APP ONLY (DIVERGENCE.md). The sync build's environment.
interface ImportMetaEnv {
  /**
   * The OPFS database file name. NO DEFAULT, on purpose: OPFS is per ORIGIN and personal-f, both
   * live ledger apps and the test app all live on adamnc02.github.io, so two apps sharing a file
   * would read and upload each other's rows. This app's is 'shared-finance-ledger.db' (.env.production);
   * never 'personal-finance.db' or 'finance-ledger-test-sync.db'. scripts/check-sync-build.ts
   * proves what the built bundle carries.
   */
  readonly VITE_POWERSYNC_DB_FILENAME?: string
  /** From .env.local, never committed (MIGRATION-LESSONS §9: create dotfiles from the terminal). */
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_POWERSYNC_URL?: string
  /**
   * The PUBLIC half of the VAPID pair the `ledger-alerts` Edge Function signs
   * with (PROMPT-14 Part 7). Public by definition — it is handed to the push
   * service by every browser that subscribes — so it ships in the bundle. The
   * private half is a Supabase function secret and is never in this repo.
   * Absent in a build → the toggle says this build cannot register, rather
   * than failing silently at subscribe time.
   */
  readonly VITE_VAPID_PUBLIC_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
