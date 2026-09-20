// SYNC APP ONLY. Data saved on this device before sign-in existed
// (MIGRATION-LESSONS §24; PROMPT-10 Part 2).
//
// The moment the app reads from PowerSync, anything under the old
// localStorage key becomes invisible, with no error. So an EMPTY household
// (no people after first sync) is offered this device's old data to import.
//
// 🚨 THE OLD KEY IS SHARED, AND THIS FILE ONLY EVER READS IT.
// 'ledger:app-data-v2:v1' on adamnc02.github.io is also where the offline
// personal-ledger app keeps its data: Adam's mum's real, unbacked-up ledger
// on her devices. personal-f's LegacyDataMigration removed its old key after
// import and after "Start fresh"; ported as-is, that would delete the
// offline app's data on any device that has both apps. So:
//   - the old key is read with getItem and nothing else (loadLedgerData,
//     which also runs migrateLedgerData: a pre-feature backup like mum's has
//     no pots/salarySorts/jointAccount and must be backfilled before it is
//     judged or imported, DATA-MODEL-REVIEW §11.8);
//   - "already offered" is recorded under this app's OWN key,
//     'ledger:sync:legacy-offered:<userId>', so it asks once per account;
//   - the offline app's copy is never written, overwritten or removed.
// verify-legacy-migration.ts proves it with a Storage that records every call.
//
// On a device where only the offline app was ever used, this offers THAT
// app's data (Adam, 2026-09-19: fine, and the prompt says so plainly).

import type { AppDataV2 } from '../../types/ledger'
import { STORAGE_KEY, loadLedgerData } from '../ledgerStorage'

export const legacyOfferedKey = (userId: string) => `ledger:sync:legacy-offered:${userId}`

type ReadStorage = Pick<Storage, 'getItem'>
type OfferStorage = Pick<Storage, 'getItem' | 'setItem'>

/**
 * True for data nobody ever entered: at most one person with no salary, and no bills, loans, cards,
 * pensions, pots, transactions or scenarios (the untouched default the offline app starts with).
 * Anything more is offered: offering too often is safer than hiding someone's data.
 */
export function isUntouchedDefault(data: AppDataV2): boolean {
  return (
    data.people.length <= 1 &&
    data.people.every((p) => (p.salaryHistory ?? []).length === 0 && (p.salaryOverrides ?? []).length === 0) &&
    data.recurringTemplates.length === 0 &&
    data.loans.length === 0 &&
    data.creditCards.length === 0 &&
    data.pensions.length === 0 &&
    data.savingsPots.length === 0 &&
    data.pots.length === 0 &&
    data.transactions.length === 0 &&
    data.scenarios.length === 0
  )
}

/**
 * This device's old data, migrated, if there is any worth offering and this account hasn't been
 * offered it yet. Reads the old key; writes nothing anywhere.
 */
export function findLegacyData(storage: ReadStorage, userId: string): AppDataV2 | null {
  try {
    if (storage.getItem(legacyOfferedKey(userId)) !== null) return null
  } catch {
    return null
  }
  const data = loadLedgerData(storage as Storage, STORAGE_KEY)
  if (!data || isUntouchedDefault(data)) return null
  return data
}

/** "Offered once": this app's own key, never the old one. */
export function markLegacyOffered(storage: OfferStorage, userId: string, choice: 'imported' | 'file' | 'fresh' | 'joined'): void {
  try {
    storage.setItem(legacyOfferedKey(userId), JSON.stringify({ at: new Date().toISOString(), choice }))
  } catch {
    // Storage unavailable: it may be offered again, which is harmless.
  }
}

/** A one-line description for the prompt. */
export function describeLedger(data: AppDataV2): string {
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
  return [
    n(data.people.length, 'person', 'people'),
    n(data.recurringTemplates.length, 'bill or recurring payment', 'bills and recurring payments'),
    n(data.loans.length, 'loan'),
    n(data.creditCards.length, 'card'),
    n(data.transactions.length, 'transaction'),
  ].join(' · ')
}
