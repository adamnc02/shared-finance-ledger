// PROMPT-08a Part B — the acceptance gate for reversing Home.tsx's
// `paymentMethod === 'card'` fallthrough in `groupingCategoryId`.
//
// THE BUG (Adam, 2026-09-18, mum's backup): "Tesco - Petrol", £49.20,
// category Car, grouped under Credit Card on the Home page. Switching its
// payment method to Cash grouped it correctly. Root cause: the fallthrough
// conflated a DEBIT card payment (paymentMethod: 'card', no creditCardId)
// with a genuine CREDIT card entity transaction (type: 'credit_card_spend'
// / 'credit_card_payment', always has a creditCardId). Only `type` should
// decide the Credit Card bucket.
//
// This script proves the fix against BOTH real backups, using the two
// fixture rows Adam and this session identified directly in mum's data,
// and reproduces the documented blast-radius counts (BUILD-PLAN.md /
// PROMPT-08a) so any unexpected movement is visible rather than inferred.
//
// It reproduces `groupingCategoryId` locally (Home.tsx doesn't export it),
// same convention as `verify-category-grouping.ts` — keep the two in sync
// with Home.tsx.
//
// FAILS AGAINST PRE-FIX CODE: with the `paymentMethod === 'card'`
// fallthrough restored, `t0DBi_Zp` groups under `category-credit-card`
// instead of `category-seed-car`, and the "rows that move" counts below
// are both 0 instead of 16 / 15.

import { readFileSync } from 'node:fs'
import { CREDIT_CARD_CATEGORY_ID, type AppDataV2, type Transaction } from '../src/types/ledger'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { seededCategoryIdForIcon } from '../src/lib/categories'

let failures = 0
// Sorts object keys so the comparison doesn't care about insertion order —
// the category breakdowns below are built by iterating transactions, so
// their key order is incidental, not meaningful.
function stable(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
  }
  return v
}
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(stable(actual)) === JSON.stringify(stable(expected))
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const LOANS_GROUP_CATEGORY_ID = seededCategoryIdForIcon('loan')
function potGroupCategoryId(potId: string): string {
  return `pot:${potId}`
}
function savingsPotGroupCategoryId(savingsPotId: string): string {
  return `savingspot:${savingsPotId}`
}
// The FIXED rule (2026-09-18) — no `paymentMethod === 'card'` fallthrough.
function groupingCategoryId(t: Transaction): string {
  if (t.type === 'loan_payment') return LOANS_GROUP_CATEGORY_ID
  if (t.type === 'credit_card_payment' || t.type === 'credit_card_spend') return CREDIT_CARD_CATEGORY_ID
  if (t.potId && (t.type === 'pot_deposit' || t.type === 'pot_withdrawal' || t.type === 'transfer')) return potGroupCategoryId(t.potId)
  if (t.savingsPotId && (t.type === 'savings_deposit' || t.type === 'savings_withdrawal' || t.type === 'savings_interest' || t.type === 'transfer')) {
    return savingsPotGroupCategoryId(t.savingsPotId)
  }
  return t.categoryId
}
// The OLD rule, kept here only to compute "what would have happened
// before" for the blast-radius report — never used for a pass/fail check.
function oldGroupingCategoryId(t: Transaction): string {
  if (t.type === 'loan_payment') return LOANS_GROUP_CATEGORY_ID
  if (t.type === 'credit_card_payment' || t.type === 'credit_card_spend') return CREDIT_CARD_CATEGORY_ID
  if (t.paymentMethod === 'card') return CREDIT_CARD_CATEGORY_ID
  if (t.potId && (t.type === 'pot_deposit' || t.type === 'pot_withdrawal' || t.type === 'transfer')) return potGroupCategoryId(t.potId)
  if (t.savingsPotId && (t.type === 'savings_deposit' || t.type === 'savings_withdrawal' || t.type === 'savings_interest' || t.type === 'transfer')) {
    return savingsPotGroupCategoryId(t.savingsPotId)
  }
  return t.categoryId
}

function loadBackup(path: string): AppDataV2 {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  return migrateLedgerData(raw.data ?? raw)
}

const BACKUPS_DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger'
const mum = loadBackup(`${BACKUPS_DIR}/finance-ledger-backup-2026-09-17-mum.json`)
const adam = loadBackup(`${BACKUPS_DIR}/finance-ledger-backup-2026-09-15.json`)

// ── Fixture 1 — Adam's exact reported row ──────────────────────────────
const tescoPetrol = mum.transactions.find((t) => t.id === 't0DBi_Zp')
check('Fixture found: t0DBi_Zp "Tesco - Petrol" exists in mum\'s 2026-09-17 backup', !!tescoPetrol, true)
if (tescoPetrol) {
  check('It is a plain expense, paymentMethod card, no creditCardId', {
    type: tescoPetrol.type,
    paymentMethod: tescoPetrol.paymentMethod,
    creditCardId: tescoPetrol.creditCardId,
    categoryId: tescoPetrol.categoryId,
  }, { type: 'expense', paymentMethod: 'card', creditCardId: undefined, categoryId: 'category-seed-car' })
  check('It now groups under its own category (Car), not Credit Card', groupingCategoryId(tescoPetrol), 'category-seed-car')
  check('Old rule would have put it in Credit Card (proves this is a real behaviour change)', oldGroupingCategoryId(tescoPetrol), CREDIT_CARD_CATEGORY_ID)
}

// ── Fixture 2 — the row that must NOT move ─────────────────────────────
// Its own categoryId already IS the Credit Card bucket, so it stays there
// either way — proof the fix respects a row's own category rather than
// special-casing the payment method.
const firRoadPharmacy = mum.transactions.find((t) => t.id === 'OYeNkL0K')
check('Fixture found: OYeNkL0K "Fir Road Pharmacy" exists in mum\'s backup', !!firRoadPharmacy, true)
if (firRoadPharmacy) {
  check('Its own categoryId is already category-credit-card', firRoadPharmacy.categoryId, CREDIT_CARD_CATEGORY_ID)
  check('It still groups under Credit Card after the fix (own category, not special-cased)', groupingCategoryId(firRoadPharmacy), CREDIT_CARD_CATEGORY_ID)
}

// ── Genuine card-entity rows never move ────────────────────────────────
function genuineCardRows(data: AppDataV2): Transaction[] {
  return data.transactions.filter((t) => t.type === 'credit_card_payment' || t.type === 'credit_card_spend')
}
for (const [label, data] of [['mum', mum], ['adam', adam]] as const) {
  const genuine = genuineCardRows(data)
  const unchanged = genuine.every((t) => groupingCategoryId(t) === oldGroupingCategoryId(t) && groupingCategoryId(t) === CREDIT_CARD_CATEGORY_ID)
  check(`${label} backup: all ${genuine.length} genuine credit-card-entity rows still group under Credit Card, unaffected`, unchanged, true)
}

// ── Blast radius — rows the removed fallthrough used to intercept ─────
// "Rows that move" means every row the OLD rule forced into Credit Card
// purely because of `paymentMethod === 'card'` (never a genuine card-
// entity type) — the fallthrough's whole domain — not just the ones whose
// FINAL bucket happens to differ. OYeNkL0K is exactly the distinction: the
// fallthrough caught it, but its own categoryId already IS Credit Card, so
// it lands in the same place either way and is still counted here.
function fallthroughCapturedRows(data: AppDataV2): Transaction[] {
  return data.transactions.filter((t) => t.paymentMethod === 'card' && t.type !== 'credit_card_payment' && t.type !== 'credit_card_spend')
}
function movedRowsByCategory(data: AppDataV2): Record<string, number> {
  const moved: Record<string, number> = {}
  for (const t of fallthroughCapturedRows(data)) {
    const after = groupingCategoryId(t)
    const cat = data.categories.find((c) => c.id === after)
    const label = cat?.name ?? after
    moved[label] = (moved[label] ?? 0) + 1
  }
  return moved
}

const mumMoved = movedRowsByCategory(mum)
const adamMoved = movedRowsByCategory(adam)
const mumTotal = Object.values(mumMoved).reduce((a, b) => a + b, 0)
const adamTotal = Object.values(adamMoved).reduce((a, b) => a + b, 0)

console.log('\n  mum backup — rows moving off Credit Card, by destination category:', JSON.stringify(mumMoved))
console.log('  adam backup — rows moving off Credit Card, by destination category:', JSON.stringify(adamMoved))

check('mum backup: 16 rows move (documented blast radius)', mumTotal, 16)
check('adam backup: 15 rows move (documented blast radius)', adamTotal, 15)
check('mum backup: destination breakdown matches the documented table', mumMoved, { Food: 11, Gaming: 2, Pet: 1, Car: 1, 'Credit Card': 1 })
check('adam backup: destination breakdown matches the documented table', adamMoved, { Food: 5, Shopping: 3, Home: 2, Clothing: 2, Banking: 1, Baby: 1, Takeaway: 1 })

// ── The "no category" case cannot happen, but stays defensive ─────────
function cardPaidWithoutCategory(data: AppDataV2): Transaction[] {
  return data.transactions.filter((t) => t.paymentMethod === 'card' && !t.creditCardId && !t.categoryId)
}
check('mum backup: zero card-paid rows without a categoryId', cardPaidWithoutCategory(mum).length, 0)
check('adam backup: zero card-paid rows without a categoryId', cardPaidWithoutCategory(adam).length, 0)
// Defensive behaviour is still exercised directly, even though real data
// never hits it: an empty categoryId groups under '' , which every
// consumer (CategoryGroupedList's `data.categories.find`) already resolves
// to undefined -> the existing "Uncategorised" fallback, same as any other
// transaction with a blank/deleted category.
check('A card-paid transaction with no categoryId groups under "" (falls through to the existing Uncategorised handling)', groupingCategoryId({
  id: 'synthetic', date: '2026-01-01', amount: 1, direction: 'out', categoryId: '', paymentMethod: 'card', status: 'pending', type: 'expense', location: 'personal', ownerId: '',
} as Transaction), '')

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll card-payment-category-fix checks passed.')
process.exitCode = failures ? 1 : 0
