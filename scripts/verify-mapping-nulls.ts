// PROMPT-09 (2026-09-19) — the PowerSync mapping layer (src/lib/powersync/mapping.ts).
//
// Every real backup (Adam's, mum's two, plus the two fixtures) goes
// app → rows → (the SQLite type round trip) → app and must come back
// deep-equal, in the same array order. And no FK-bound column may ever carry
// '' upward: Postgres rejects it with 23503, which the connector discards,
// silently losing the write (DATA-MODEL-REVIEW §11.1, MIGRATION-LESSONS §27).
//
//  1. round trip, per backup, deep-equal (primaryPersonId aside: per device),
//     and every column written exists in the schema (a misnamed column round-trips
//     fine, and Postgres then rejects it on every retry);
//  2. no '' in any id-shaped column, and household_id on every household row;
//  3. the real '' owner/payee rows (~80 across the two 15 Sep backups) are
//     among those covered, by count, and every one became NULL;
//  4. category ids carry '@<household>' on the way up and lose it coming down;
//  5. derived ids are unique per table (no two app items collapse into one row);
//  6. jsonb columns are canonical: re-ordering their keys (as Postgres does)
//     maps back to the same string;
//  7. the trip through the SERVER round-trips too: jsonb is sent as a JSON
//     value, never the text SQLite holds (a string is stored as a jsonb string
//     and comes back as one — UAT 2026-09-19, Home crashed on a loan).

import { existsSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { toRows, fromRows, canonicalJson, type Rows, type Row } from '../src/lib/powersync/mapping'
import { SYNCED_TABLES, localName, toServerRecord } from '../src/lib/powersync/tables'
import type { AppDataV2 } from '../src/types/ledger'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 1500))
  }
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/'
const backups = [
  DIR + 'finance-ledger-backup-2026-09-15.json',
  DIR + 'finance-ledger-backup-2026-09-15-mum.json',
  DIR + 'finance-ledger-backup-2026-09-17-mum.json',
  new URL('./fixtures/backup-2026-09-02.json', import.meta.url).pathname,
  new URL('./fixtures/backup-2026-09-10-uat.json', import.meta.url).pathname,
]
const HOUSEHOLD = '11111111-2222-3333-4444-555555555555'
const ctx = { householdId: HOUSEHOLD }

/** What a row looks like after a trip through PowerSync's SQLite: booleans are 0/1, everything else as stored. */
function throughSqlite(rows: Rows): Rows {
  const kinds = new Map(SYNCED_TABLES.map((t) => [t.remote, t.columns]))
  const out: Rows = {}
  for (const [table, list] of Object.entries(rows)) {
    const cols = kinds.get(table)!
    out[table] = list.map((r) => {
      const o: Row = { id: r.id }
      for (const [k, v] of Object.entries(r)) {
        if (k === 'id') continue
        o[k] = cols[k] === 'bool' && v !== null ? (v ? 1 : 0) : v
      }
      return o
    })
  }
  return out
}

/**
 * The whole trip through the server: what the connector sends (toServerRecord),
 * what Postgres keeps (jsonb holds whatever JSON VALUE it was sent; a string
 * stays a string), and what PowerSync syncs back down (jsonb as its JSON text,
 * booleans as 1/0). A TEXT column sent where a jsonb value belongs survives the
 * local round trip but not this one (UAT 2026-09-19: Home crashed on a loan).
 */
function throughServer(rows: Rows): Rows {
  const local = throughSqlite(rows)
  const kinds = new Map(SYNCED_TABLES.map((t) => [t.remote, t.columns]))
  const out: Rows = {}
  for (const [table, list] of Object.entries(local)) {
    const cols = kinds.get(table)!
    out[table] = list.map((r) => {
      const { id, ...data } = r
      const sent = toServerRecord(localName(table), data, { dropNulls: true })
      const o: Row = { id }
      for (const c of Object.keys(cols)) {
        const v = sent[c]
        if (v === undefined || v === null) o[c] = null
        else if (cols[c] === 'json') o[c] = JSON.stringify(v) // Postgres jsonb → text on the way down
        else if (cols[c] === 'bool') o[c] = v === true ? 1 : 0
        else o[c] = v as Row[string]
      }
      return o
    })
  }
  return out
}

/** First differing path, for a readable failure. */
function firstDiff(a: unknown, b: unknown, path = ''): string | null {
  if (isDeepStrictEqual(a, b)) return null
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`)
      if (d) return d
    }
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 200)} ≠ ${JSON.stringify(b)?.slice(0, 200)}`
}

const FK_COLUMNS = new Set([
  'household_id', 'person_id', 'owner_id', 'payee', 'pot_id', 'savings_pot_id', 'credit_card_id', 'loan_id', 'pension_id',
  'recurring_template_id', 'salary_snapshot_id', 'salary_sort_id', 'transaction_id', 'follows_pension_id', 'category_id', 'source_id',
  'interest_destination_savings_pot_id', 'interest_destination_pot_id', 'transfer_from_savings_pot_id', 'transfer_from_pot_id',
  'transfer_to_savings_pot_id', 'transfer_to_pot_id', 'from_savings_pot_id', 'from_pot_id', 'to_savings_pot_id', 'to_pot_id',
  'to_savings_pot_id',
  // PROMPT-13 B2 — id-shaped, mapped through idUp so '' becomes NULL.
  // Deliberately NOT a real FK server-side (§27, see the migration), but it
  // must still never go up as '': an id-shaped '' is how the ~80 ownerId/
  // payee rows were nearly lost.
  'rounding_pot_id',
])

let emptyOwnerPayee = 0
let emptyOwnerPayeeOn15th = 0
for (const path of backups) {
  const name = path.split('/').pop()!
  console.log(`\n${name}`)
  if (!existsSync(path)) {
    check('file present', false, path)
    continue
  }
  const data: AppDataV2 = parseLedgerBackupJson(readFileSync(path, 'utf8'))
  const rows = toRows(data, ctx)

  // 1. round trip
  const back = fromRows(throughSqlite(rows))
  const { primaryPersonId: _omit, ...raw } = data
  // Three documented, accepted normalisations (mapping.ts header), and nothing else:
  //  - Transaction.payee '' comes back absent (every use compares it with a person id);
  //  - Pot.recurringDeposit* is not synced (superseded, DECISIONS Q7). Only old test
  //    data carries it; counted and reported, and it must be absent from the real backups.
  const potDepositFields = ['recurringDepositAmount', 'recurringDepositDayOfMonth', 'recurringDepositStartDate', 'recurringDepositOverrides'] as const
  const droppedPotDeposits = data.pots.filter((p) => potDepositFields.some((f) => p[f] !== undefined)).length
  //  - an EMPTY optional child list (occurrenceOverrides: [] …) comes back absent: no rows,
  //    no list. The type makes every use guard it (`?? []` / `?.`), and no code compares
  //    one with undefined (grep, 2026-09-19).
  const OPTIONAL_LISTS = ['occurrenceOverrides', 'recurringDepositOverrides', 'interestOverrides', 'minimumPaymentOverrides', 'statementCalibrationLines']
  const dropEmpty = <T extends object>(x: T): T =>
    Object.fromEntries(Object.entries(x).filter(([k, v]) => !(OPTIONAL_LISTS.includes(k) && Array.isArray(v) && v.length === 0))) as T
  for (const key of ['recurringTemplates', 'pensions', 'savingsPots', 'creditCards', 'loans'] as const) {
    ;(raw as Record<string, unknown>)[key] = (raw[key] as object[]).map(dropEmpty)
  }
  const expected = {
    ...raw,
    transactions: raw.transactions.map((t) => {
      if (t.payee !== '') return t
      const { payee: _p, ...rest } = t
      return rest
    }),
    pots: raw.pots.map((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !(potDepositFields as readonly string[]).includes(k)))),
  }
  const diff = firstDiff(back, expected)
  check('app → rows → SQLite → app is deep-equal, same order', diff === null, diff ?? undefined)
  const viaServer = fromRows(throughServer(rows))
  const serverDiff = firstDiff(viaServer, expected)
  check('…and through the server (connector → Postgres jsonb → sync) too', serverDiff === null, serverDiff ?? undefined)
  const jsonCols = SYNCED_TABLES.flatMap((t) => Object.entries(t.columns).filter(([, k]) => k === 'json').map(([c]) => [t.remote, c] as const))
  const sentAsString = jsonCols.flatMap(([table, col]) =>
    throughSqlite(rows)[table].filter((r) => r[col] != null).map((r) => toServerRecord(localName(table), { [col]: r[col] }, { dropNulls: true })[col])
      .filter((v) => typeof v === 'string').map(() => `${table}.${col}`))
  check('no jsonb column is ever sent to Supabase as a string', sentAsString.length === 0, [...new Set(sentAsString)])
  if (name.startsWith('finance-ledger-backup')) check('real backup: no pot carries the superseded recurringDeposit* fields', droppedPotDeposits === 0, droppedPotDeposits)
  else if (droppedPotDeposits) console.log(`    (old test data: ${droppedPotDeposits} pot(s) with superseded recurringDeposit* fields, not synced — DECISIONS Q7)`)

  // 1b. every column written exists (tables.ts is proven equal to the migrations).
  // The round trip alone can't see a misnamed column: toRows and fromRows would agree.
  const unknown = Object.entries(rows).flatMap(([table, list]) => {
    const cols = SYNCED_TABLES.find((t) => t.remote === table)!.columns
    return [...new Set(list.flatMap((r) => Object.keys(r)))].filter((c) => c !== 'id' && !(c in cols)).map((c) => `${table}.${c}`)
  })
  check('every column written exists in the schema', unknown.length === 0, unknown)

  // 2. no '' in FK-bound columns; household on every household row
  const blanks: string[] = []
  const noHousehold: string[] = []
  for (const [table, list] of Object.entries(rows)) {
    const household = SYNCED_TABLES.find((t) => t.remote === table)!.household
    for (const r of list) {
      for (const [k, v] of Object.entries(r)) if (FK_COLUMNS.has(k) && v === '') blanks.push(`${table}.${k} (${r.id})`)
      if (household && r.household_id !== HOUSEHOLD) noHousehold.push(`${table} ${r.id}`)
      if (r.id === '' || r.id == null) blanks.push(`${table}.id`)
    }
  }
  check("no '' in any id-shaped / FK column going up", blanks.length === 0, blanks.slice(0, 10))
  check('every household-scoped row carries household_id', noHousehold.length === 0, noHousehold.slice(0, 5))

  // 3. the real '' rows became NULL
  const sources: [string, { id: string; ownerId?: string; payee?: string }[]][] = [
    ['recurring_templates', data.recurringTemplates], ['loans', data.loans], ['transactions', data.transactions],
  ]
  let here = 0
  let nulled = 0
  for (const [table, items] of sources) {
    const byId = new Map(rows[table].map((r) => [r.id, r]))
    for (const it of items) {
      for (const [field, col] of [['ownerId', 'owner_id'], ['payee', 'payee']] as const) {
        if (it[field] === '') {
          here++
          if (byId.get(it.id)?.[col] === null) nulled++
        }
      }
    }
  }
  emptyOwnerPayee += here
  if (name.includes('2026-09-15')) emptyOwnerPayeeOn15th += here
  check(`${here} real '' ownerId/payee values all went up as NULL`, nulled === here, { here, nulled })

  // 4. category suffix
  const catRows = rows.categories
  check(`all ${catRows.length} category ids end '@<household>'`, catRows.every((r) => r.id.endsWith('@' + HOUSEHOLD)))
  const catCols = ['recurring_templates', 'loans', 'credit_cards', 'transactions'].flatMap((t) => rows[t].map((r) => r.category_id))
  check(`all ${catCols.length} category_id references end '@<household>'`, catCols.every((c) => typeof c === 'string' && c.endsWith('@' + HOUSEHOLD)))
  check('the app sees no suffix after the round trip', back.categories.every((c) => !c.id.includes('@')) && back.transactions.every((t) => !t.categoryId.includes('@')))

  // 5. unique ids per table
  const dupes = Object.entries(rows).flatMap(([t, list]) => {
    const seen = new Set<string>()
    return list.filter((r) => (seen.has(r.id) ? true : (seen.add(r.id), false))).map((r) => `${t}:${r.id}`)
  })
  check('no two items share a row id in any table (derived ids included)', dupes.length === 0, dupes.slice(0, 10))
}

console.log('\nAcross the two 2026-09-15 backups (DATA-MODEL-REVIEW §11.1 counted ~80)')
check(`${emptyOwnerPayeeOn15th} '' ownerId/payee values covered (≥ 80)`, emptyOwnerPayeeOn15th >= 80, emptyOwnerPayeeOn15th)
console.log(`  (all five files: ${emptyOwnerPayee})`)

console.log('\njsonb is canonical')
const reordered = JSON.stringify({ z: 1, a: [{ y: 2, b: 3 }] })
check('canonicalJson ignores key order', canonicalJson(JSON.parse(reordered)) === canonicalJson({ a: [{ b: 3, y: 2 }], z: 1 }))
check('canonicalJson drops undefined keys', canonicalJson({ a: 1, b: undefined }) === '{"a":1}')

// ── PROMPT-13 B6 — the six round-up columns ───────────────────────────────
//
// The real backups predate this feature, so none of them exercises these
// columns and every generic check above passes over them vacuously. A
// purpose-built fixture is the only way to prove the round trip, and the
// only way to prove §33 for `round_up_history` specifically.
//
// 🚨 §33 IS THE POINT OF THIS SECTION. PowerSync holds jsonb as TEXT
// locally. A connector that uploads that text as-is stores a JSON STRING in
// the jsonb column — valid JSON, so no error — which syncs back as a
// string, and one JSON.parse yields a string rather than an array. That is
// exactly how a loan's recurringOverpayment crashed Home in UAT on
// 2026-09-19, about 30 seconds after an otherwise perfect import. The
// generic check above would catch it, but only if a row with a history
// exists; this makes sure one does.
console.log('\nPROMPT-13: the six round-up columns')

const jarId = 'jar00001'
const roundUpFixture: AppDataV2 = {
  ...(parseLedgerBackupJson(readFileSync(backups[0], 'utf8')) as AppDataV2),
}
const rupPerson = roundUpFixture.people[0].id
roundUpFixture.pots = [
  {
    id: jarId, personId: rupPerson, name: 'Coin Jar', openingBalance: -5.25, openingDate: '2026-09-01',
    active: true, color: '#f5a524', isCoinJar: true,
  },
  // A control: an ordinary pot alongside it, so `is_coin_jar` is proven to
  // discriminate rather than simply always come back true.
  { id: 'pot00001', personId: rupPerson, name: 'Bills Pot', openingBalance: 100, openingDate: '2026-09-01', active: true, color: '#4cd08a' },
]
roundUpFixture.payCycles = roundUpFixture.payCycles.map((pc, i) =>
  i === 0
    ? {
        ...pc,
        roundUpEnabled: true,
        roundUpEffectiveFrom: '2026-09-01',
        roundUpHistory: [
          { enabled: true, from: '2026-03-01', until: '2026-06-01', nextRuleFrom: '2026-06-01' },
          { enabled: false, from: '2026-06-01', until: '2026-09-01', nextRuleFrom: '2026-09-01' },
        ],
      }
    : pc,
)
roundUpFixture.transactions = [
  // A rounded expense, and a control that was not rounded.
  { ...roundUpFixture.transactions[0], id: 'rup00001', type: 'expense', paymentMethod: 'card', location: 'personal', amount: 8, roundedFrom: 7.5, roundingPotId: jarId },
  { ...roundUpFixture.transactions[0], id: 'rup00002', type: 'expense', paymentMethod: 'cash', location: 'personal', amount: 7.5 },
  // PROMPT-13 B1a — a row that deliberately opted out. Indistinguishable
  // from rup00002 on the server WITHOUT this column, which is the point.
  { ...roundUpFixture.transactions[0], id: 'rup00003', type: 'expense', paymentMethod: 'card', location: 'personal', amount: 7.5, roundUpSkipped: true },
]

const rupRows = toRows(roundUpFixture, ctx)
const rupTxn = rupRows.transactions.find((r) => r.id === 'rup00001')!
const rupTxnPlain = rupRows.transactions.find((r) => r.id === 'rup00002')!
const rupJar = rupRows.pots.find((r) => r.id === jarId)!
const rupOrdinary = rupRows.pots.find((r) => r.id === 'pot00001')!
const rupCycle = rupRows.pay_cycles[0]

check('transactions.rounded_from goes up as the pre-rounding amount', rupTxn.rounded_from === 7.5, rupTxn.rounded_from)
check('transactions.rounding_pot_id goes up as the jar id', rupTxn.rounding_pot_id === jarId, rupTxn.rounding_pot_id)
check('an unrounded row sends NULL for both, never 0 or \'\'', rupTxnPlain.rounded_from == null && rupTxnPlain.rounding_pot_id == null, [rupTxnPlain.rounded_from, rupTxnPlain.rounding_pot_id])
const rupSkipped = rupRows.transactions.find((r) => r.id === 'rup00003')!
check('transactions.round_up_skipped goes up as true on an opted-out row', rupSkipped.round_up_skipped === true, rupSkipped.round_up_skipped)
check('CONTROL: and is NULL on a row that simply did not qualify', rupTxnPlain.round_up_skipped == null, rupTxnPlain.round_up_skipped)
check('pots.is_coin_jar is set on the jar', rupJar.is_coin_jar === true, rupJar.is_coin_jar)
check('CONTROL: and NOT on an ordinary pot', rupOrdinary.is_coin_jar == null, rupOrdinary.is_coin_jar)
check('pay_cycles.round_up_enabled / _effective_from go up', rupCycle.round_up_enabled === true && rupCycle.round_up_effective_from === '2026-09-01', [rupCycle.round_up_enabled, rupCycle.round_up_effective_from])

// 🚨 §33, stated directly rather than only via the generic sweep.
const historySent = toServerRecord(localName('pay_cycles'), throughSqlite(rupRows).pay_cycles[0], { dropNulls: true }).round_up_history
check('🚨 round_up_history is sent as a JSON VALUE, never a string (§33)', typeof historySent !== 'string', typeof historySent)
check('...and it is the array itself, with both windows intact', Array.isArray(historySent) && (historySent as unknown[]).length === 2, historySent)

// The full trip, through the server's own type handling.
const rupBack = fromRows(throughServer(rupRows))
const backJar = rupBack.pots.find((p) => p.id === jarId)!
const backOrdinary = rupBack.pots.find((p) => p.id === 'pot00001')!
const backCycle = rupBack.payCycles[0]
const backTxn = rupBack.transactions.find((t) => t.id === 'rup00001')!
check('round trip: the jar comes back a jar', backJar.isCoinJar === true, backJar.isCoinJar)
check('round trip: an ordinary pot does NOT come back a jar', backOrdinary.isCoinJar === undefined || backOrdinary.isCoinJar === false, backOrdinary.isCoinJar)
check('round trip: a NEGATIVE opening balance survives (Part C)', backJar.openingBalance === -5.25, backJar.openingBalance)
check('round trip: roundedFrom / roundingPotId survive', backTxn.roundedFrom === 7.5 && backTxn.roundingPotId === jarId, [backTxn.roundedFrom, backTxn.roundingPotId])
// 🚨 If this came back undefined, an edit on the other device would
// silently round a row the person had excluded.
const backSkipped = rupBack.transactions.find((t) => t.id === 'rup00003')!
check('🚨 round trip: roundUpSkipped survives, so the other device does not re-round it', backSkipped.roundUpSkipped === true, backSkipped.roundUpSkipped)
check('round trip: roundUpEnabled / roundUpEffectiveFrom survive', backCycle.roundUpEnabled === true && backCycle.roundUpEffectiveFrom === '2026-09-01', [backCycle.roundUpEnabled, backCycle.roundUpEffectiveFrom])
// 🚨 The crash shape: a history that comes back as a STRING rather than an
// array means §33 has returned. `.length` on a string would be truthy, so
// this asserts the type, not just the presence.
check('🚨 round trip: roundUpHistory comes back as an ARRAY, not a string (§33)', Array.isArray(backCycle.roundUpHistory), typeof backCycle.roundUpHistory)
// `canonicalJson`, not JSON.stringify: Postgres jsonb reorders keys, which
// is the whole reason this file has a canonical comparison (see "jsonb is
// canonical" above). The first run of this check failed on key order alone
// — a real property of jsonb, not a mapping fault.
check(
  '...with both windows, and their `from` dates intact (key order is jsonb\'s to choose)',
  canonicalJson(backCycle.roundUpHistory) === canonicalJson(roundUpFixture.payCycles[0].roundUpHistory),
  backCycle.roundUpHistory,
)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)
