// SYNC APP ONLY (DIVERGENCE.md). Proves what the LIVE bundle actually carries,
// after `vite build` and before `gh-pages` (`npm run deploy` runs it and fails
// the deploy if it fails). PROMPT-10 Part 1.
//
// Deliberately not named verify-*.ts: it reads build output, so it doesn't
// belong in the verify sweep.
//
// What it is for: every one of these is invisible until it has already gone
// wrong on a real device.
//  - the local database file must be THIS app's ('shared-finance-ledger.db').
//    OPFS is per ORIGIN, and personal-f, personal-ledger, this app and the
//    test app all live on adamnc02.github.io. A build that picked up
//    personal-f's or the test app's file name would have two apps reading and
//    uploading each other's rows, with no error anywhere (MIGRATION-LESSONS
//    §32). database.ts throws without the variable, so the real risk is the
//    WRONG one, which this catches;
//  - it must subscribe to this app's own stream and opt out of the default
//    ones, or it downloads personal-f's auto-subscribed household data into
//    the same local tables;
//  - it must carry the sync layer at all: this app went live on localStorage
//    first (PROMPT-09 landed the sync code unwired), and a build that still
//    shipped that way would silently keep every device local-only;
//  - the legacy rescue must be in the same bundle as the switch
//    (MIGRATION-LESSONS §24), which is the whole reason they ship together.

import { existsSync, readdirSync, readFileSync } from 'node:fs'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) {
    failures++
    if (detail !== undefined) console.log('     ', JSON.stringify(detail).slice(0, 800))
  }
}

const dist = new URL('../dist/', import.meta.url).pathname
const assets = dist + 'assets/'
const files = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.js')) : []
const bundle = files.map((f) => readFileSync(assets + f, 'utf8')).join('\n')

const OWN_DB = 'shared-finance-ledger.db'
const OTHER_DBS = ['personal-finance.db', 'finance-ledger-test-sync.db']

console.log('\nLive build (adamnc02.github.io/shared-finance-ledger/)')
check('dist/ was built, with JS', existsSync(dist + 'index.html') && bundle.length > 0)
check(`uses its own PowerSync database file (${OWN_DB})`, bundle.includes(OWN_DB))
for (const db of OTHER_DBS) check(`never another app's database file (${db})`, !bundle.includes(db))
check('subscribes to this app\'s stream (shared_ledger_household)', bundle.includes('shared_ledger_household'))
check('opts out of the default streams (personal-f\'s is auto-subscribed)', bundle.includes('includeDefaultStreams'))
// The local table names are built at runtime (`sfl_` + the Postgres name: tables.ts localName), so
// the prefix is what a bundle can be checked for, not 'sfl_people'.
check('local tables carry the sfl_ prefix (never personal-f\'s bare names)', /`sfl_`|"sfl_"|'sfl_'/.test(bundle))
check('the sync layer is actually wired in (not the localStorage store)', bundle.includes('ensure_household') && bundle.includes('OPFSCoopSyncVFS'))
check('sign-in is in the bundle', bundle.includes('supabase') || bundle.includes('nxekrfdagkdwhjuunsrl'))
check('Delete my app data is in the bundle', bundle.includes('erase_my_data'))
// MIGRATION-LESSONS §24: the moment this app reads from PowerSync, anything under the old
// localStorage key is invisible. The rescue must be in the SAME release as the switch.
check('the legacy-data rescue shipped with it (§24)', bundle.includes('ledger:app-data-v2:v1') && bundle.includes('ledger:sync:legacy-offered:'))
check('household linking shipped with it', bundle.includes('redeem_household_link_code'))

console.log(failures === 0 ? '\nAll live-build checks passed.' : `\nFAIL: ${failures} live-build check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
