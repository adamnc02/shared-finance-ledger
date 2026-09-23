// 2026-09-17 — legacy `savingsEntries` removed everywhere (Adam: "drop it
// everywhere", DECISIONS-2026-09-15.md Q6).
//
// Savings goals/plans (Person.savingsEntries) were superseded by SavingsPot on
// 2026-09-02, and nothing could create an entry after that. Both real
// backups have none. Removed with them: SavingsEntry (ledger.ts and
// models.ts), the 'savings_contribution' transaction type, the
// 'savings_entry' sourceType, lib/savings.ts, lib/savingsLedger.ts,
// lib/clearTransaction.ts (its only remaining side effect was the goal
// one), and the What-if "lump sum toward a savings goal" action (to be
// rebuilt against savings pots in PROMPT-07).
//
// Proves:
//  1. migrateLedgerData drops `savingsEntries` from every person and
//     changes nothing else: migrating the real backups gives exactly what
//     migrating them with the key already stripped gives;
//  2. that holds for a legacy blob with NON-empty entries too, and the
//     result is idempotent;
//  3. what the store writes back no longer contains the key;
//  4. new data (defaultLedgerData) never has it;
//  5. no source file still refers to the removed names.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { defaultLedgerData, migrateLedgerData, parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { createLocalStorageLedgerStore } from '../src/lib/store/localStorageLedgerStore'
import type { AppDataV2 } from '../src/types/ledger'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) {
    failures++
    if (detail !== undefined) console.log('     ', detail)
  }
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/'
const files = [
  DIR + 'finance-ledger-backup-2026-09-15.json',
  DIR + 'finance-ledger-backup-2026-09-15-mum.json',
  new URL('./fixtures/backup-2026-09-02.json', import.meta.url).pathname,
  new URL('./fixtures/backup-2026-09-10-uat.json', import.meta.url).pathname,
]

type LegacyBlob = AppDataV2 & { people: (AppDataV2['people'][number] & { savingsEntries?: unknown })[] }
const readRaw = (path: string): LegacyBlob => {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return parsed?.data ?? parsed
}
const withoutKey = (blob: LegacyBlob): AppDataV2 => ({
  ...blob,
  people: blob.people.map((p) => {
    const copy = { ...p }
    delete copy.savingsEntries
    return copy
  }),
})
const hasKey = (data: unknown) => JSON.stringify(data).includes('"savingsEntries"')

console.log('\n1. Real backups: the key is dropped and nothing else changes')
check('both real backups are present', existsSync(files[0]) && existsSync(files[1]))
for (const path of files.filter((f) => existsSync(f))) {
  const name = path.split('/').pop()
  const raw = readRaw(path)
  check(`${name}: had the legacy key before (all empty)`, raw.people.every((p) => Array.isArray(p.savingsEntries) && p.savingsEntries.length === 0))
  const migrated = migrateLedgerData(JSON.parse(JSON.stringify(raw)))
  check(`${name}: no savingsEntries after migration`, !hasKey(migrated))
  check(`${name}: identical to migrating it with the key already removed`, JSON.stringify(migrated) === JSON.stringify(migrateLedgerData(withoutKey(raw))))
  check(`${name}: no savings_contribution / savings_entry rows exist`, !JSON.stringify(raw).includes('"savings_contribution"') && !JSON.stringify(raw).includes('"savings_entry"'))
  check(`${name}: no savings_lump_sum scenario actions exist`, !JSON.stringify(raw).includes('savings_lump_sum'))
}

console.log('\n2. A legacy blob with NON-empty entries')
{
  const base = defaultLedgerData() as LegacyBlob
  const legacy: LegacyBlob = {
    ...base,
    people: base.people.map((p) => ({ ...p, savingsEntries: [{ id: 'g1', type: 'goal', name: 'House', includeInSummary: true, targetAmount: 1000 }] })),
  }
  const migrated = migrateLedgerData(legacy)
  check('entries are dropped', !hasKey(migrated))
  check('people otherwise unchanged', JSON.stringify(migrated.people) === JSON.stringify(migrateLedgerData(withoutKey(legacy)).people))
  check('idempotent', JSON.stringify(migrateLedgerData(migrated)) === JSON.stringify(migrated))
  check('parseLedgerBackupJson (restore) drops them too', !hasKey(parseLedgerBackupJson(JSON.stringify({ data: legacy }))))
}

console.log('\n3. The store writes the key away on the first save')
{
  const map = new Map<string, string>()
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as Storage
  map.set('ledger:app-data-v2:v1', JSON.stringify(readRaw(files[1])))
  const store = createLocalStorageLedgerStore({ storage })
  const loaded = store.load() as AppDataV2
  store.save(loaded, loaded)
  check("mum's stored blob no longer contains savingsEntries", !map.get('ledger:app-data-v2:v1')!.includes('savingsEntries'))
}

console.log('\n4. New data')
check('defaultLedgerData() has no savingsEntries', !hasKey(defaultLedgerData()))

console.log('\n5. No source references remain')
{
  const root = new URL('../src/', import.meta.url).pathname
  const removed = /\b(SavingsEntry|savings_contribution|savings_entry|savings_lump_sum|savingsEntryId|SavingsLumpSumImpact|savingsImpacts|applyClearSideEffects|monthlyAmountForEntry|totalMonthlySavingsForPerson|generateSavingsContributions)\b/
  const offenders = (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => removed.test(readFileSync(root + f, 'utf8')))
  check('no src file names a removed type/function', offenders.length === 0, offenders)
  const entriesUsers = (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && readFileSync(root + f, 'utf8').includes('savingsEntries'))
  check('savingsEntries appears only in the migration (lib/ledgerStorage.ts)', JSON.stringify(entriesUsers) === JSON.stringify(['lib/ledgerStorage.ts']), entriesUsers)
  check('lib/savings.ts, lib/savingsLedger.ts, lib/clearTransaction.ts are gone', ['savings.ts', 'savingsLedger.ts', 'clearTransaction.ts'].every((f) => !existsSync(root + 'lib/' + f)))
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)
