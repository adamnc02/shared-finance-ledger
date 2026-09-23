// PROMPT-06 (2026-09-17) — the LedgerStore interface and the localStorage
// store behind it (DECISIONS-2026-09-15.md Q8 option 2).
//
// A pure refactor for `personal-ledger`, where Adam's mum has real,
// unbacked-up data under 'ledger:app-data-v2:v1'. This proves nothing about
// how that key is read, migrated or written has changed:
//  1. round trip through an in-memory Storage;
//  2. both real backups (plus the two fixtures) load deep-equal to the
//     pre-refactor load: getItem → JSON.parse → migrateLedgerData;
//  3. what `save` writes is byte-identical to JSON.stringify(data), under
//     the real key and nowhere else;
//  4. errors: missing key → null, corrupt JSON → null + logged, a throwing
//     setItem (quota) → logged, never thrown;
//  5. LedgerContext.tsx no longer touches ledgerStorage's load/save or
//     localStorage directly;
//  6. LedgerContextValue's member list matches the snapshot below, so any
//     accidental public API change fails.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { STORAGE_KEY, migrateLedgerData } from '../src/lib/ledgerStorage'
import { createLocalStorageLedgerStore, localStorageLedgerStore } from '../src/lib/store/localStorageLedgerStore'
import { isPromiseLike } from '../src/lib/store/LedgerStore'
import type { AppDataV2 } from '../src/types/ledger'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', detail)
  }
}

class MemoryStorage implements Storage {
  private map = new Map<string, string>()
  setItemCalls = 0
  get length() { return this.map.size }
  clear() { this.map.clear() }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null }
  key(index: number) { return [...this.map.keys()][index] ?? null }
  removeItem(key: string) { this.map.delete(key) }
  setItem(key: string, value: string) { this.setItemCalls++; this.map.set(key, String(value)) }
  keys() { return [...this.map.keys()] }
}

/** Collects console.error calls instead of printing them. */
function captureErrors<T>(fn: () => T): { result: T; errors: unknown[][] } {
  const original = console.error
  const errors: unknown[][] = []
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    return { result: fn(), errors }
  } finally {
    console.error = original
  }
}

function syncLoad(store: ReturnType<typeof createLocalStorageLedgerStore>): AppDataV2 | null {
  const loaded = store.load()
  if (isPromiseLike(loaded)) throw new Error('localStorage store must load synchronously')
  return loaded
}

/** The load as it was before PROMPT-06 (`loadLedgerData()` at de042dd4 / 6b4d9112), against a given Storage. */
function preRefactorLoad(storage: Storage): AppDataV2 | null {
  try {
    const raw = storage.getItem('ledger:app-data-v2:v1')
    if (!raw) return null
    return migrateLedgerData(JSON.parse(raw))
  } catch {
    return null
  }
}

// ── 0. Key ────────────────────────────────────────────────────────────────
console.log('\n0. The key')
check("STORAGE_KEY is still 'ledger:app-data-v2:v1'", STORAGE_KEY === 'ledger:app-data-v2:v1')
check('localStorageLedgerStore is importable without a browser (storage looked up lazily)', typeof localStorageLedgerStore.load === 'function')

// ── 1. Round trip ─────────────────────────────────────────────────────────
console.log('\n1. Round trip through an in-memory Storage')
const backupPaths = [
  '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-15.json',
  '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-15-mum.json',
]
const fixturePaths = [
  new URL('./fixtures/backup-2026-09-02.json', import.meta.url).pathname,
  new URL('./fixtures/backup-2026-09-10-uat.json', import.meta.url).pathname,
]
const readBackup = (path: string): unknown => {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return parsed?.data ?? parsed
}

{
  const storage = new MemoryStorage()
  const store = createLocalStorageLedgerStore({ storage })
  const prev = migrateLedgerData(readBackup(fixturePaths[0]) as AppDataV2)
  const next: AppDataV2 = { ...prev, people: prev.people.map((p, i) => (i === 0 ? { ...p, name: `${p.name} (edited)` } : p)) }
  store.save(next, prev)
  const loaded = syncLoad(store)
  check('save(next, prev) then load() returns next', JSON.stringify(loaded) === JSON.stringify(migrateLedgerData(JSON.parse(JSON.stringify(next)))))
  check('the edit survived the round trip', loaded?.people[0].name.endsWith('(edited)') === true)
  check('load() output is migrated (idempotent under migrateLedgerData)', JSON.stringify(loaded) === JSON.stringify(migrateLedgerData(loaded!)))
}

// ── 2. Real backups read identically ──────────────────────────────────────
console.log("\n2. Real backups load exactly as before (mum's and Adam's data)")
const realFound = backupPaths.filter((p) => existsSync(p))
check('both real backup files are present', realFound.length === 2, backupPaths.filter((p) => !existsSync(p)))
for (const path of [...realFound, ...fixturePaths]) {
  const name = path.split('/').pop()
  const storage = new MemoryStorage()
  storage.setItem('ledger:app-data-v2:v1', JSON.stringify(readBackup(path)))
  const expected = preRefactorLoad(storage)
  const actual = syncLoad(createLocalStorageLedgerStore({ storage }))
  check(`${name}: load() deep-equals the pre-refactor load`, expected !== null && JSON.stringify(actual) === JSON.stringify(expected))
  check(`${name}: load() does not write`, storage.setItemCalls === 1)
}

// ── 3. Written bytes ──────────────────────────────────────────────────────
console.log('\n3. What save writes')
for (const path of realFound) {
  const name = path.split('/').pop()
  const storage = new MemoryStorage()
  const data = migrateLedgerData(readBackup(path) as AppDataV2)
  createLocalStorageLedgerStore({ storage }).save(data, data)
  check(`${name}: bytes === JSON.stringify(data)`, storage.getItem('ledger:app-data-v2:v1') === JSON.stringify(data))
  check(`${name}: written under the real key and nowhere else`, JSON.stringify(storage.keys()) === JSON.stringify(['ledger:app-data-v2:v1']))
}
{
  const storage = new MemoryStorage()
  const data = migrateLedgerData(readBackup(fixturePaths[0]) as AppDataV2)
  const preview = createLocalStorageLedgerStore({ storage, key: 'ledger:app-data-v2:v1:sync-preview' })
  preview.save(data, data)
  check('a store given another key never touches the real key', storage.getItem('ledger:app-data-v2:v1') === null && storage.getItem('ledger:app-data-v2:v1:sync-preview') === JSON.stringify(data))
}

// ── 4. Errors ─────────────────────────────────────────────────────────────
console.log('\n4. Errors are logged, never thrown')
{
  const storage = new MemoryStorage()
  const { result, errors } = captureErrors(() => syncLoad(createLocalStorageLedgerStore({ storage })))
  check('missing key → null', result === null)
  check('missing key → nothing logged', errors.length === 0)
}
{
  const storage = new MemoryStorage()
  storage.setItem('ledger:app-data-v2:v1', '{"people": [ not json')
  let threw = false
  let outcome: { result: AppDataV2 | null; errors: unknown[][] } | undefined
  try { outcome = captureErrors(() => syncLoad(createLocalStorageLedgerStore({ storage }))) } catch { threw = true }
  check('corrupt JSON → no throw', !threw)
  check('corrupt JSON → null', outcome?.result === null)
  check('corrupt JSON → logged', outcome?.errors.length === 1 && outcome.errors[0][0] === 'Failed to load ledger data')
  check('corrupt JSON → stored value left untouched', storage.getItem('ledger:app-data-v2:v1') === '{"people": [ not json')
}
{
  const storage = new MemoryStorage()
  storage.getItem = () => { throw new Error('SecurityError: access denied') }
  let threw = false
  let outcome: { result: AppDataV2 | null; errors: unknown[][] } | undefined
  try { outcome = captureErrors(() => syncLoad(createLocalStorageLedgerStore({ storage }))) } catch { threw = true }
  check('getItem throwing → null, logged, no throw', !threw && outcome?.result === null && outcome.errors.length === 1)
}
{
  const storage = new MemoryStorage()
  storage.setItem = () => { throw new Error('QuotaExceededError') }
  const data = migrateLedgerData(readBackup(fixturePaths[0]) as AppDataV2)
  let threw = false
  let errors: unknown[][] = []
  try { errors = captureErrors(() => createLocalStorageLedgerStore({ storage }).save(data, data)).errors } catch { threw = true }
  check('setItem throwing (quota) → no throw', !threw)
  check('setItem throwing (quota) → logged', errors.length === 1 && errors[0][0] === 'Failed to save ledger data')
}

// ── 5. Source check ───────────────────────────────────────────────────────
console.log('\n5. LedgerContext.tsx is store-agnostic')
const contextSource = readFileSync(new URL('../src/context/LedgerContext.tsx', import.meta.url), 'utf8')
check('no loadLedgerData', !contextSource.includes('loadLedgerData'))
check('no saveLedgerData', !contextSource.includes('saveLedgerData'))
check('no direct localStorage use', !/\blocalStorage\b/.test(contextSource))
{
  // Code that actually uses the global (`localStorage.x` or `?? localStorage)`), not prose mentioning it.
  const srcRoot = new URL('../src/', import.meta.url).pathname
  const users = (readdirSync(srcRoot, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) => /\blocalStorage\s*[.)]/.test(readFileSync(srcRoot + f, 'utf8')))
  // PROMPT-09: sync-app-only files keep small per-device keys of their own
  // (the person chosen on this device, which account last used the local
  // database, rejected-write log). They exist only in shared-finance-ledger
  // and the test app's /sync/ build, and must never touch the ledger's key.
  const SYNC_ONLY = new Set([
    'components/SyncRoot.tsx', 'components/AccountModal.tsx', 'components/LegacyDataMigration.tsx',
    'components/DuplicatePersonBanner.tsx', 'lib/powersync/connector.ts', 'lib/store/powerSyncLedgerStore.ts',
  ])
  check('src/ uses localStorage in lib/ledgerStorage.ts only (plus the listed sync-only files)',
    JSON.stringify(users.filter((f) => !SYNC_ONLY.has(f))) === JSON.stringify(['lib/ledgerStorage.ts']), users)
  // PROMPT-10 widened this deliberately, and only this far: the sync app has to READ the ledger's
  // own key to rescue data saved before sign-in existed (MIGRATION-LESSONS §24), and that key is
  // shared with the offline app on this origin — Adam's mum's real data. So exactly one sync-only
  // file may name it, it may only read it, and verify-legacy-migration.ts proves the rest.
  const code = (f: string) => readFileSync(srcRoot + f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const READS_LEDGER_KEY = 'lib/powersync/legacyData.ts'
  const namesLedgerKey = (readdirSync(srcRoot, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && SYNC_ONLY.has(f))
    .filter((f) => /ledger:app-data-v2|STORAGE_KEY/.test(code(f)))
  check("no sync-only component mentions the ledger's own key", namesLedgerKey.length === 0, namesLedgerKey)
  // Only the sync app has that file; the offline app runs this same script (it is shared).
  if (existsSync(srcRoot + READS_LEDGER_KEY)) {
    check(`${READS_LEDGER_KEY} reads the ledger key and never writes or removes it`,
      /STORAGE_KEY/.test(code(READS_LEDGER_KEY)) && !/removeItem/.test(code(READS_LEDGER_KEY)) &&
        [...code(READS_LEDGER_KEY).matchAll(/setItem\(([^)]*)\)/g)].every((m) => m[1].includes('legacyOfferedKey')))
  }
}

// ── 6. Public API snapshot ────────────────────────────────────────────────
console.log('\n6. LedgerContextValue public API is unchanged')
// Taken from `main` before PROMPT-06 (de042dd4 test / 6b4d9112 live): 76
// members. PROMPT-13 (2026-09-20) adds `setRoundUp` — 77. The point of
// this snapshot is that a member is never added or removed WITHOUT
// noticing, not that the list never grows: it caught this addition on the
// first run after it was made, which is the behaviour wanted.
const API_SNAPSHOT = [
  'addAdHocTransaction', 'addCategory', 'addCreditCard', 'addLoan', 'addPension', 'addPerson', 'addPot',
  'addRecurringTemplate', 'addRecurringTransfer', 'addSalaryOverride', 'addSalarySnapshot', 'addSavingsPot',
  'addScenario', 'assignCreditCardLocation', 'assignLoanLocation', 'assignLoanRecurringOverpaymentLocation',
  'assignRecurringTemplateLocation', 'calibrateLoanAction', 'changeCardPaymentDay', 'changeLoanStartDate',
  'changePayday', 'changePensionSchedule', 'changeRecurringOverpaymentStartDate', 'changeRecurringTemplateSchedule',
  'clearSalarySort', 'clearSalarySortTarget', 'data', 'deleteWithResolutions', 'importGeneration',
  'setRoundUp', // PROMPT-13 B4 — turns round-ups on/off for one person and creates their Coin Jar
  'logCreditCardLumpPayment', 'logCreditCardSpend', 'logJointDeposit', 'logJointWithdrawal', 'logLoanOverpayment',
  'logPotDeposit', 'logPotWithdrawal', 'logSavingsDeposit', 'logSavingsWithdrawal', 'logTransfer',
  'overrideSavingsInterest', 'removeAllSalaryHistory', 'removeCategory', 'removeCreditCard',
  'removeCreditCardLumpPayment', 'removeLoan', 'removeLoanOverpayment', 'removePension', 'removePerson', 'removePot',
  'removeRecurringTemplate', 'removeSalaryOverride', 'removeSalarySnapshot', 'removeSavingsPot', 'removeScenario',
  'removeTransaction', 'saveSalarySort', 'setData', 'setJointAccountOpening', 'setPrimaryPerson', 'settleLoanAction',
  'updateCategory', 'updateCreditCard', 'updateCreditCardLumpPayment', 'updateCreditCardMinimumCharge', 'updateLoan',
  'updateLoanOverpayment', 'updatePayCycle', 'updatePension', 'updatePerson', 'updatePot', 'updateRecurringTemplate',
  'updateSalaryOverride', 'updateSalarySnapshot', 'updateSavingsPot', 'updateScenario', 'updateTransaction',
]
const interfaceBlock = contextSource.match(/^interface LedgerContextValue \{\n([\s\S]*?)^\}/m)?.[1] ?? ''
const members = [...interfaceBlock.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]).sort()
check('interface block found', interfaceBlock.length > 0)
check(`member list equals the ${API_SNAPSHOT.length}-member snapshot`, JSON.stringify(members) === JSON.stringify([...API_SNAPSHOT].sort()), {
  added: members.filter((m) => !API_SNAPSHOT.includes(m)),
  removed: API_SNAPSHOT.filter((m) => !members.includes(m)),
})
check('useLedgerData() signature unchanged', contextSource.includes('export function useLedgerData(): LedgerContextValue {'))

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)
