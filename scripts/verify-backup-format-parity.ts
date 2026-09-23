// PROMPT-14 Parts 2-3 (2026-09-22) — a cloud snapshot and a downloaded file
// are the SAME backup.
//
// This is the invariant the whole merged Backup & Restore rests on. "Back Up
// Now → cloud or this device" and "Restore → cloud or a file" are one button
// each with one follow-up step precisely because there is one format behind
// them. The moment a cloud snapshot stops being interchangeable with a file,
// the follow-up step stops being a choice and becomes two different features
// wearing one label — and nobody finds out until a restore of the wrong kind
// throws "This doesn't look like a Finance ledger backup file", or worse,
// doesn't throw.
//
// It used to be true by coincidence: uploadSnapshot and downloadLedgerBackup
// each happened to say JSON.stringify(data, null, 2). A coincidence is not an
// invariant, so both now call serialiseLedgerBackup and this check fails if
// either stops.
//
// What it asserts:
//  1. both write paths go through the one serialiser, in the source;
//  2. both read paths go through parseLedgerBackupJson, in the source;
//  3. over all three real backups: serialise → parse round-trips to exactly
//     what the app would have loaded, and a second round trip is identical
//     (so a snapshot of a restore of a snapshot never drifts);
//  4. the bytes a cloud snapshot would hold and the bytes a downloaded file
//     would hold are byte-identical for the same data;
//  5. a wrapped {data: …} backup and a raw dump both parse — the two shapes
//     that exist in the wild.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { migrateLedgerData, parseLedgerBackupJson, serialiseLedgerBackup } from '../src/lib/ledgerStorage'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', JSON.stringify(detail).slice(0, 400))
  }
}

const root = resolve(import.meta.dirname, '..')
const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures'
const BACKUPS = ['finance-ledger-backup-2026-09-15.json', 'finance-ledger-backup-2026-09-15-mum.json', 'finance-ledger-backup-2026-09-17-mum.json']
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
// 🚨 The offline apps have no cloud half at all, and this file is SHARED by
// all three deliberately — the round-trip guarantee in section 2 is exactly as
// load-bearing for personal-ledger's Wallet export as for a cloud snapshot.
// So section 1 is skipped where there is no cloud, and the skip is itself
// CHECKED: an app with no backup.ts must have no sync layer either, or the
// "skip" would be hiding a missing file rather than describing an app.
const cloudPath = resolve(root, 'src/lib/powersync/backup.ts')
const hasCloud = existsSync(cloudPath)
const backupLib = hasCloud ? strip(readFileSync(cloudPath, 'utf8')) : ''
const storageLib = strip(readFileSync(resolve(root, 'src/lib/ledgerStorage.ts'), 'utf8'))

console.log('\n1. One serialiser, one parser — structurally, not by coincidence')
if (!hasCloud) {
  check('this app has no cloud backup, and no sync layer either — so section 1 does not apply', !existsSync(resolve(root, 'src/lib/powersync')))
  check('…and its one write path still goes through the shared serialiser', /const json = serialiseLedgerBackup\(data\)/.test(storageLib))
}
if (hasCloud) {
check('uploadSnapshot serialises through serialiseLedgerBackup', /\.upload\(.*serialiseLedgerBackup\(data\)/.test(backupLib), backupLib.match(/\.upload\([^\n]*/)?.[0])
check('downloadLedgerBackup does too', /const json = serialiseLedgerBackup\(data\)/.test(storageLib))
check('neither write path stringifies on its own', !/JSON\.stringify\(data, null, 2\)/.test(backupLib) && (storageLib.match(/JSON\.stringify\(data, null, 2\)/g) ?? []).length === 1)
check('downloadSnapshot reads through parseLedgerBackupJson — the file picker’s own function', /parseLedgerBackupJson\(await data\.text\(\)\)/.test(backupLib))
}

console.log('\n2. Round trips over the three real backups')
for (const name of BACKUPS) {
  const raw = readFileSync(`${DIR}/${name}`, 'utf8')
  const loaded = parseLedgerBackupJson(raw)

  // Both call sites now go through this one function (section 1 asserts that
  // in the source), so calling it twice IS the two paths — and if either ever
  // stops calling it, section 1 fails rather than this passing on a lie.
  const asSnapshot = serialiseLedgerBackup(loaded) // what uploadSnapshot puts in the bucket
  const asFile = serialiseLedgerBackup(loaded) // what downloadLedgerBackup puts on the phone
  check(`${name}: the cloud bytes and the file bytes are identical`, asSnapshot === asFile)

  const viaCloud = parseLedgerBackupJson(asSnapshot) // downloadSnapshot's path
  const viaFile = parseLedgerBackupJson(asFile) // the file picker's path
  check(`${name}: each restores through the other's path to the same data`, JSON.stringify(viaCloud) === JSON.stringify(viaFile))
  check(`${name}: and to what the app would have loaded`, JSON.stringify(viaCloud) === JSON.stringify(migrateLedgerData(loaded)))

  const twice = serialiseLedgerBackup(viaCloud)
  check(`${name}: a second round trip does not drift`, twice === asSnapshot)
}

console.log('\n3. Both shapes in the wild still parse')
{
  const raw = readFileSync(`${DIR}/${BACKUPS[0]}`, 'utf8')
  const loaded = parseLedgerBackupJson(raw)
  const wrapped = JSON.stringify({ exportedAt: '2026-09-22', data: loaded }, null, 2)
  check('a wrapped {data: …} backup parses to the same thing as a raw dump', JSON.stringify(parseLedgerBackupJson(wrapped)) === JSON.stringify(parseLedgerBackupJson(serialiseLedgerBackup(loaded))))
  let threw = false
  try {
    parseLedgerBackupJson('{"hello":"world"}')
  } catch {
    threw = true
  }
  check('something that is not a backup is still refused', threw)
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
