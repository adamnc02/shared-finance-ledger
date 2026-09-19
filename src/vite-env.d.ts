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
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
