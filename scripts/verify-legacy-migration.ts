// PROMPT-10 Part 2 (2026-09-19) — data saved on this device before sign-in
// existed (MIGRATION-LESSONS §24), and the trap in it.
//
// 🚨 'ledger:app-data-v2:v1' is the SAME key, on the SAME origin
// (adamnc02.github.io), as the offline personal-ledger app's: Adam's mum's
// real, unbacked-up ledger. personal-f's LegacyDataMigration removes its old
// key after importing and after "Start fresh". Ported as-is, that would
// delete her data on any device with both apps. So this proves, both from
// the source and from behaviour, that this app only ever READS that key.
//
//  1. source: nothing in src/ writes or removes the ledger key except the
//     ledger's own store, and the sync-only files that mention it do nothing
//     but read it;
//  2. behaviour, with a Storage that records every call: the key is only ever
//     getItem'd, and its bytes are identical afterwards — including through a
//     full import and a "Start fresh";
//  3. it is offered once per account, under this app's own key;
//  4. an untouched default is skipped; corrupt or absent data is skipped;
//  5. mum's pre-feature backup (no pots/salarySorts/jointAccount: DMR §11.8)
//     parses, and imports into an empty household through the store;
//  6. the screen runs only on an empty household.

import { readFileSync, readdirSync } from 'node:fs'
import { defaultCategories } from '../src/lib/categories'
import { STORAGE_KEY, defaultLedgerData, parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { findLegacyData, isUntouchedDefault, legacyOfferedKey, markLegacyOffered } from '../src/lib/powersync/legacyData'
import { createPowerSyncLedgerStore } from '../src/lib/store/powerSyncLedgerStore'
import type { AppDataV2 } from '../src/types/ledger'
import { FakeSyncDb, memoryStorage, tick } from './lib/fakeSyncDb'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', JSON.stringify(detail).slice(0, 800))
  }
}

const HH = '11111111-2222-3333-4444-555555555555'
const ME = 'user-me'
const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/'
const MUM = DIR + 'finance-ledger-backup-2026-09-17-mum.json'
const quiet = { error: (...a: unknown[]) => console.log('    [log.error]', ...a), warn: () => {}, info: () => {} }

/** localStorage that records every single call, so "read-only" can be proved rather than assumed. */
function recordingStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  const calls: string[] = []
  return {
    map,
    calls,
    getItem: (k: string) => (calls.push(`getItem ${k}`), map.get(k) ?? null),
    setItem: (k: string, v: string) => void (calls.push(`setItem ${k}`), map.set(k, v)),
    removeItem: (k: string) => void (calls.push(`removeItem ${k}`), map.delete(k)),
    key: (i: number) => [...map.keys()][i] ?? null,
    clear: () => void (calls.push('clear'), map.clear()),
    get length() {
      return map.size
    },
  } as Storage & { map: Map<string, string>; calls: string[] }
}

console.log('\n1. Source: only the ledger store writes the ledger key')
{
  const srcRoot = new URL('../src/', import.meta.url).pathname
  const files = (readdirSync(srcRoot, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  // Comments are stripped first: this file is full of prose ABOUT the key, and a check that a
  // comment can satisfy (or break) proves nothing (MIGRATION-LESSONS §37).
  const code = (f: string) => readFileSync(srcRoot + f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const mentions = files.filter((f) => /ledger:app-data-v2|STORAGE_KEY/.test(code(f)))
  const ALLOWED = ['lib/ledgerStorage.ts', 'lib/store/localStorageLedgerStore.ts', 'lib/store/selectLedgerStore.ts', 'lib/powersync/legacyData.ts']
  check(`only ${ALLOWED.length} files mention the ledger key`, mentions.every((f) => ALLOWED.includes(f)), mentions)
  const legacy = code('lib/powersync/legacyData.ts')
  // The read is loadLedgerData(storage, STORAGE_KEY) and nothing else: no setItem/removeItem near
  // the key, and the only key this file ever writes is its own "offered" key.
  check('legacyData.ts never calls removeItem', !/removeItem/.test(legacy))
  const writes = [...legacy.matchAll(/setItem\(([^)]*)\)/g)].map((m) => m[1])
  check('legacyData.ts writes only legacyOfferedKey(...)', writes.length === 1 && writes[0].includes('legacyOfferedKey'), writes)
  const screen = code('components/LegacyDataMigration.tsx')
  check('the screen itself never touches the ledger key or removes anything', !/ledger:app-data-v2|STORAGE_KEY|removeItem/.test(screen))
  check('the screen runs only on an empty household (SyncRoot gates it on people.length === 0)',
    /people\.length === 0\) return setPhase\(\{ kind: 'empty'/.test(code('components/SyncRoot.tsx')))
}

console.log("\n2. Behaviour: the old key is read, never written (mum's real backup)")
{
  const raw = JSON.stringify(parseLedgerBackupJson(readFileSync(MUM, 'utf8')))
  const storage = recordingStorage({ [STORAGE_KEY]: raw })
  const found = findLegacyData(storage, ME)
  check('found, and migrated (a pre-feature backup gains pots/salarySorts/jointAccount: DMR §11.8)',
    !!found && found.people.length > 0 && Array.isArray(found.pots) && Array.isArray(found.salarySorts) && found.jointAccount === null)
  markLegacyOffered(storage, ME, 'imported')
  check('every call on the ledger key was a read', storage.calls.filter((c) => c.endsWith(STORAGE_KEY)).every((c) => c.startsWith('getItem')), storage.calls)
  check('its bytes are byte-for-byte what they were', storage.map.get(STORAGE_KEY) === raw)
  check('the choice went under this app\'s own key', storage.map.has(legacyOfferedKey(ME)) && JSON.parse(storage.map.get(legacyOfferedKey(ME))!).choice === 'imported')
  check('offered once: the second time there is nothing to offer', findLegacyData(storage, ME) === null)
  check('a different account is still offered it', findLegacyData(recordingStorage({ [STORAGE_KEY]: raw }), 'user-ella') !== null)

  // "Start fresh" (personal-f removed the key here: the line that would have deleted mum's data).
  const fresh = recordingStorage({ [STORAGE_KEY]: raw })
  findLegacyData(fresh, ME)
  markLegacyOffered(fresh, ME, 'fresh')
  check('Start fresh leaves the old data exactly where it was', fresh.map.get(STORAGE_KEY) === raw && !fresh.calls.some((c) => c === `removeItem ${STORAGE_KEY}`), fresh.calls)
}

console.log('\n3. What is worth offering')
{
  const empty = recordingStorage()
  check('nothing stored: nothing offered', findLegacyData(empty, ME) === null)
  check('an untouched default is skipped', isUntouchedDefault(defaultLedgerData()) &&
    findLegacyData(recordingStorage({ [STORAGE_KEY]: JSON.stringify(defaultLedgerData()) }), ME) === null)
  const oneBill = defaultLedgerData()
  oneBill.recurringTemplates = parseLedgerBackupJson(readFileSync(MUM, 'utf8')).recurringTemplates.slice(0, 1)
  check('one real bill is enough to be offered', findLegacyData(recordingStorage({ [STORAGE_KEY]: JSON.stringify(oneBill) }), ME) !== null)
  const corrupt = recordingStorage({ [STORAGE_KEY]: '{"people": [ not json' })
  const realError = console.error
  console.error = () => {} // loadLedgerData logs the parse failure on purpose; the sweep reads stderr
  const offered = findLegacyData(corrupt, ME)
  console.error = realError
  check('corrupt data: nothing offered, nothing written', offered === null && corrupt.map.get(STORAGE_KEY) === '{"people": [ not json')
}

console.log("\n4. Mum's data imports into an empty household, through the store")
{
  const db = new FakeSyncDb()
  db.seed({ categories: defaultCategories().map((c, i) => ({ id: `${c.id}@${HH}`, household_id: HH, name: c.name, icon: c.icon, icon_color: c.iconColor, is_built_in: !!c.isBuiltIn, position: i })) })
  const store = createPowerSyncLedgerStore({ db, householdId: HH, userId: ME, firstSync: Promise.resolve(), storageKey: 'k', storage: memoryStorage(), log: quiet })
  const current = (await store.load())!
  check('the household is empty: 35 categories, no people (so the screen shows)', current.people.length === 0 && current.categories.length === 35)
  const storage = recordingStorage({ [STORAGE_KEY]: JSON.stringify(parseLedgerBackupJson(readFileSync(MUM, 'utf8'))) })
  const legacy = findLegacyData(storage, ME)!
  store.save(legacy, current) // what the screen's Import button does
  await store.flush()
  const got: AppDataV2[] = []
  store.subscribe!((d) => got.push(d))
  await tick(40)
  const live = got[got.length - 1]
  const same = (k: 'people' | 'recurringTemplates' | 'loans' | 'creditCards' | 'transactions') => live[k].length === legacy[k].length
  check(`imported: ${live.people.length} people, ${live.recurringTemplates.length} bills, ${live.loans.length} loans, ${live.creditCards.length} cards, ${live.transactions.length} transactions`,
    (['people', 'recurringTemplates', 'loans', 'creditCards', 'transactions'] as const).every(same),
    { live: live.people.length, legacy: legacy.people.length })
  check('with fresh ids (importIds.ts), so another household can import the same data', store.importMap !== null && live.people.every((p) => !legacy.people.some((o) => o.id === p.id)))
  check('the importer is linked to the imported "Me"', store.linkedPersonId === live.primaryPersonId)
  check('and the old key is STILL untouched after a real import', storage.map.get(STORAGE_KEY) === JSON.stringify(parseLedgerBackupJson(readFileSync(MUM, 'utf8'))))
}

console.log(failures === 0 ? '\nAll legacy-migration checks passed.' : `\nFAIL: ${failures} legacy-migration check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
