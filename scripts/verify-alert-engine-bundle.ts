// SYNC APP ONLY. PROMPT-14 Part 7 (2026-09-22) — the Edge Function really is
// running THIS app's engine.
//
// 🚨 THIS IS WHAT §0b Q6 BECAME. Q5 originally chose to reimplement the
// projection in SQL, and Q6's parity check existed to catch that second engine
// drifting from this one. The revised Q5 removed the second engine entirely:
// the `ledger-alerts` Edge Function runs the app's own TypeScript, because
// Edge Functions are Deno. So there is no parity to check.
//
// What CAN still go wrong is smaller and entirely mechanical: the function
// needs a BUNDLE of that engine, and a bundle can go stale. Change a pay-cycle
// rule in src/lib, forget to rebuild, and the phone says one thing while the
// 20:00 alert says another — which is the exact failure Q6 was written to
// prevent, arriving by a different route. This check is the thing that makes
// it loud.
//
// It is also the only check in the sweep that reads the OTHER repo. That is
// deliberate: the two repos have to agree about one file, and the agreement is
// worthless if only the Supabase repo knows about it.
//
// What it asserts:
//  1. the committed bundle is byte-identical to what the current src/lib
//     produces — the freshness check, and the one that fails after any
//     engine change until `npx tsx scripts/build-alert-engine.ts` is run;
//  2. it carries the generated-file banner, so nobody edits it by hand
//     without being told not to;
//  3. it is pure computation: no React, no lucide components, no Supabase
//     client, no PowerSync, no DOM — it has to run in Deno with none of that;
//  4. 🚨 BEHAVIOURALLY, it is the same engine: loading the BUNDLE and running
//     it over a real backup produces exactly the shortfalls the in-repo
//     source does, account for account, date for date, penny for penny. Bytes
//     matching proves it was built from this source; this proves the build is
//     not silently dropping something.
//  5. the recipient mapping comes from people.linked_user_id, and a person
//     nobody is linked to yields no alert (§0b Q8).

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { toRows } from '../src/lib/powersync/mapping'
import { findShortfalls } from '../src/lib/shortfall'
import { alertsFor, shortfallsForHousehold } from '../src/lib/powersync/alertEngine'
import { BANNER, BUNDLE_PATH, buildAlertEngine } from './alertEngineBundle'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', String(detail).slice(0, 500))
  }
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger'
const HH = '11111111-2222-3333-4444-555555555555'
const AS_OF = new Date(2026, 8, 15)
const LONDON_DATE = '2026-09-15'

console.log('\n1. The committed bundle is what this source produces')
check(`the bundle exists at ${BUNDLE_PATH}`, existsSync(BUNDLE_PATH))
const committed = existsSync(BUNDLE_PATH) ? readFileSync(BUNDLE_PATH, 'utf8') : ''
const fresh = await buildAlertEngine()
check(
  'byte-identical to a fresh build — run `npx tsx scripts/build-alert-engine.ts` if this fails',
  committed === fresh,
  committed === fresh ? '' : `committed ${committed.length} bytes, fresh ${fresh.length} bytes`,
)
check('it carries the DO-NOT-EDIT banner', committed.startsWith(BANNER.split('\n')[0]))

console.log('\n2. Pure computation — it has to run in Deno')
for (const banned of ['react/jsx-runtime', 'from "react"', "from 'react'", 'createElement', '@supabase/supabase-js', '@powersync/', 'document.', 'window.']) {
  check(`no ${banned}`, !committed.includes(banned))
}
check('lucide icon components were stubbed out, not bundled', !committed.includes('lucide-react/dist'))

console.log('\n3. The BUNDLE and the SOURCE agree, over the real backups')
const tmp = join(tmpdir(), `alert-engine-${process.pid}.mjs`)
writeFileSync(tmp, committed)
const bundled = (await import(pathToFileURL(tmp).href)) as typeof import('../src/lib/powersync/alertEngine')
try {
  for (const name of ['finance-ledger-backup-2026-09-15.json', 'finance-ledger-backup-2026-09-15-mum.json', 'finance-ledger-backup-2026-09-17-mum.json']) {
    const data = parseLedgerBackupJson(readFileSync(`${DIR}/${name}`, 'utf8'))
    const rows = toRows(data, { householdId: HH })
    // Link every person to a user, so the recipient mapping has something to
    // resolve — otherwise section 3 would pass vacuously with zero alerts.
    rows.people = rows.people.map((r, i) => ({ ...r, linked_user_id: `user-${i}` }))

    const fromBundle = bundled.shortfallsForHousehold(rows, AS_OF)
    const fromSource = shortfallsForHousehold(rows, AS_OF)
    check(`${name}: the bundle rebuilds the same household`, JSON.stringify(fromBundle.data) === JSON.stringify(fromSource.data))

    const direct = findShortfalls(fromSource.data, AS_OF)
    const key = (s: (typeof direct)[number]) => `${s.account.kind}:${s.account.id}:${s.date}:${s.amount}`
    check(
      `${name}: the same shortfalls, to the penny and the day`,
      JSON.stringify(fromBundle.shortfalls.map(key)) === JSON.stringify(direct.map(key)),
      `${fromBundle.shortfalls.map(key).join(' | ')} vs ${direct.map(key).join(' | ')}`,
    )

    const alertsBundle = bundled.alertsFor(rows, AS_OF, LONDON_DATE)
    const alertsSource = alertsFor(rows, AS_OF, LONDON_DATE)
    check(`${name}: the same alerts, keys and messages included`, JSON.stringify(alertsBundle) === JSON.stringify(alertsSource))
    check(`${name}: every dedupe key carries the London date`, alertsBundle.send.every((a) => a.dedupeKey.endsWith(`:${LONDON_DATE}`)))
    check(`${name}: every dedupe key carries the severity too`, alertsBundle.send.every((a) => a.dedupeKey.startsWith(`shortfall:${a.severity}:`)))
    check(`${name}: every tag carries the date — a reused tag replaces yesterday's silently`, alertsBundle.send.every((a) => a.tag.endsWith(`:${LONDON_DATE}`)))
  }

  console.log('\n3b. …and the comparison is not vacuous')
  {
    // 🚨 Real households are usually solvent, so sections 3's comparisons can
    // be "[] === []" and prove nothing (INFO §53). This forces a dip the
    // engine MUST find, so both sides have something to disagree about.
    const data = parseLedgerBackupJson(readFileSync(`${DIR}/finance-ledger-backup-2026-09-15.json`, 'utf8'))
    const owner = data.people[0].id
    const broke = {
      ...data,
      pots: [{ id: 'bundle-dip', personId: owner, name: 'Dip', openingBalance: -25, openingDate: '2026-01-01', active: true, color: '#888' }],
    }
    const rows = toRows(broke, { householdId: HH })
    rows.people = rows.people.map((r, i) => ({ ...r, linked_user_id: `user-${i}` }))

    const fromBundle = bundled.shortfallsForHousehold(rows, AS_OF).shortfalls
    const fromSource = shortfallsForHousehold(rows, AS_OF).shortfalls
    check('the forced dip is found at all', fromSource.some((s) => s.account.id === 'bundle-dip'), fromSource.map((s) => s.account.id).join(','))
    check('the bundle finds exactly the same ones', JSON.stringify(fromBundle) === JSON.stringify(fromSource), `${fromBundle.length} vs ${fromSource.length}`)
    const alerts = bundled.alertsFor(rows, AS_OF, LONDON_DATE).send
    check('and it turns into at least one addressed alert', alerts.length > 0 && alerts.every((a) => a.userId && a.title && a.body), alerts.length)
  }

  console.log('\n4. Recipients come from linked_user_id, and nothing else')
  {
    const data = parseLedgerBackupJson(readFileSync(`${DIR}/finance-ledger-backup-2026-09-15.json`, 'utf8'))
    const rows = toRows(data, { householdId: HH })
    const linkedAll = { ...rows, people: rows.people.map((r, i) => ({ ...r, linked_user_id: `user-${i}` })) }
    const linkedNone = { ...rows, people: rows.people.map((r) => ({ ...r, linked_user_id: null })) }
    check('with nobody linked, no alert is produced at all (§0b Q8)', bundled.alertsFor(linkedNone, AS_OF, LONDON_DATE).send.length === 0)
    const users = bundled.linkedUsers(linkedAll)
    check('linkedUsers maps person id → user id', Object.keys(users).length === data.people.length, users)
    check('every alert names a user that mapping produced', bundled.alertsFor(linkedAll, AS_OF, LONDON_DATE).send.every((a) => users[a.personId] === a.userId))
  }
} finally {
  rmSync(tmp, { force: true })
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
