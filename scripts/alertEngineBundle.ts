// SYNC APP ONLY. Shared by build-alert-engine.ts and
// verify-alert-engine-bundle.ts, so "how the bundle is built" is stated ONCE.
//
// If these two disagreed by so much as a flag, the verify script would either
// fail on a perfectly fresh bundle or pass on a stale one — and the whole
// point of the bundle check is that it is the single thing standing between
// "the server runs the app's own engine" and "the server runs whatever it was
// given in September".
//
// Not named verify-*: the sweep runs every verify-* in the repo and this is a
// helper, not a check.

import { build } from 'esbuild'
import { resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dirname, '..')
export const ENTRY = resolve(REPO_ROOT, 'src/lib/powersync/alertEngine.ts')

/**
 * Where the committed bundle lives. The Supabase repo, by absolute path —
 * the same convention the verify scripts already use for the real backups
 * (TECHNICAL.md §44), and for the same reason: the two repos are separate
 * checkouts that have to agree about one file.
 */
export const BUNDLE_PATH =
  process.env.ALERT_ENGINE_BUNDLE ??
  '/Users/adamcox/Documents/GitHub/silver-octo-invention/supabase/functions/ledger-alerts/_engine.js'

export const BANNER = `// GENERATED FILE — DO NOT EDIT.
//
// Bundled from shared-finance-ledger's src/lib/powersync/alertEngine.ts by
// scripts/build-alert-engine.ts. It is the app's OWN projection engine,
// running server-side in Deno, which is why there is no second implementation
// of pay cycles, loans, cards or round-ups anywhere in SQL (PROMPT-14 §0b Q5,
// revised 2026-09-22).
//
// Editing this file by hand breaks that guarantee silently: the alert would
// start disagreeing with the number on the phone with nothing to say so.
// scripts/verify-alert-engine-bundle.ts rebuilds it and fails the sweep on any
// difference, so a hand edit is caught — but only on the next sweep, and only
// in the app repo. Change alertEngine.ts and rebuild instead.`

/** The bundle, as bytes, exactly as both scripts must produce it. */
export async function buildAlertEngine(): Promise<string> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    // Deno, so ESM; and a modern target, because Edge Functions are current V8
    // and downlevelling would only make the diff noisier.
    format: 'esm',
    // 'browser' so node_modules resolve normally (date-fns, nanoid); nothing
    // on this path touches the DOM, and the one UI dependency it reaches is
    // aliased away below.
    platform: 'browser',
    target: 'es2022',
    // Readable on purpose: this file gets read when an alert is wrong, and a
    // minified engine would be unreadable at exactly that moment. It is not
    // served to a browser, so its size costs nothing.
    minify: false,
    write: false,
    banner: { js: BANNER },
    // date-fns and nanoid are bundled in: the function must not depend on the
    // registry resolving at cold start.
    //
    // lucide-react is NOT. The engine reaches it only for BILL_ICONS' KEYS
    // (categories.ts), never the components, and bundling it would drag React
    // into a server function that renders nothing. See the stub's own header.
    alias: { 'lucide-react': resolve(REPO_ROOT, 'scripts/lucide-react.server-stub.cjs') },
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}
