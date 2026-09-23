// PROMPT-09 (2026-09-19) — two devices auto-clearing the same payment.
//
// autoClearDuePayments materialises every due payment as a cleared
// Transaction. It used to give each one a random nanoid. With two devices in
// one household (the sync app), both clear the same salary/bill on their own
// before either has synced; random ids made that two rows, and the payment
// counted twice in the household balance, with no error anywhere. Adam chose
// deterministic ids in all three apps: `auto:<dedupeKey>`.
//
//  1. every newly auto-cleared row's id is `auto:` + its dedupeKey (and
//     rows that existed before keep their ids);
//  2. two devices clearing the same data independently produce the SAME ids;
//     merged the way sync merges (upsert on id) no occurrence appears twice,
//     and the cleared total equals one device's;
//  3. a device that clears later (a week on) doesn't duplicate what the
//     other already cleared, and converges on one row per occurrence;
//  4. offline behaviour is unchanged apart from the ids: the same rows, same
//     amounts, same dates as a run with the ids blanked.
//
// Fails on the old code: checks 1 and 2 (random ids differ between runs).

import { readFileSync } from 'node:fs'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { dedupeKey } from '../src/lib/projection'
import type { AppDataV2, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', JSON.stringify(detail).slice(0, 800))
  }
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/'
const files = ['finance-ledger-backup-2026-09-17-mum.json', 'finance-ledger-backup-2026-09-15.json']

/** What sync does with two devices' rows: one row per id (the connector upserts on id). */
const mergeById = (a: Transaction[], b: Transaction[]) => [...new Map([...a, ...b].map((t) => [t.id, t])).values()]
const cleared = (ts: Transaction[]) => ts.filter((t) => t.status === 'cleared').reduce((s, t) => s + (t.direction === 'in' ? t.amount : -t.amount), 0)

for (const file of files) {
  console.log(`\n${file}`)
  const data: AppDataV2 = parseLedgerBackupJson(readFileSync(DIR + file, 'utf8'))
  const asOf = new Date(2026, 9, 20, 12) // 20 Oct 2026: a month of due payments after either backup
  const before = new Set(data.transactions.map((t) => t.id))

  const deviceA = autoClearDuePayments(data, asOf)
  const deviceB = autoClearDuePayments(data, asOf)
  const added = deviceA.transactions.filter((t) => !before.has(t.id))
  check(`${added.length} payments auto-cleared (a real test, not an empty one)`, added.length > 5, added.length)
  check('every new row id is `auto:` + its dedupeKey', added.every((t) => t.id === `auto:${dedupeKey(t)}`), added.find((t) => t.id !== `auto:${dedupeKey(t)}`))
  check('rows that existed before keep their ids', data.transactions.every((t) => deviceA.transactions.some((x) => x.id === t.id)))

  const idsA = deviceA.transactions.map((t) => t.id).sort()
  const idsB = deviceB.transactions.map((t) => t.id).sort()
  check('two devices clearing independently produce the same ids', JSON.stringify(idsA) === JSON.stringify(idsB))
  const merged = mergeById(deviceA.transactions, deviceB.transactions)
  const keys = merged.map(dedupeKey).filter((k): k is string => !!k)
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
  check('merged as sync merges them: no occurrence twice', dupes.length === 0, dupes.slice(0, 5))
  check('the household total equals one device\'s (not double)', Math.abs(cleared(merged) - cleared(deviceA.transactions)) < 0.005, { merged: cleared(merged), one: cleared(deviceA.transactions) })

  // Device B last opened a week earlier, then catches up after A's rows synced.
  const weekEarlier = autoClearDuePayments(data, new Date(2026, 9, 13, 12))
  const bLater = autoClearDuePayments({ ...weekEarlier, transactions: mergeById(weekEarlier.transactions, deviceA.transactions) }, asOf)
  const merged2 = mergeById(bLater.transactions, deviceA.transactions)
  const keys2 = merged2.map(dedupeKey).filter((k): k is string => !!k)
  check('a device clearing on a different day converges on one row per occurrence', keys2.length === new Set(keys2).size && merged2.length === deviceA.transactions.length, { merged: merged2.length, a: deviceA.transactions.length })

  const blank = (ts: Transaction[]) => ts.map(({ id: _id, ...rest }) => rest)
  check('offline behaviour unchanged apart from ids (rows, amounts, dates)', JSON.stringify(blank(deviceA.transactions)) === JSON.stringify(blank(deviceB.transactions)))
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)
