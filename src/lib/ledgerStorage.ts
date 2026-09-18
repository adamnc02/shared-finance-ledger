// Persistence for the new ledger data model. Deliberately a separate
// storage key from the legacy AppData ('ledger:app-data:v1', see
// storage.ts) — the two live side by side during the rebuild rather than
// one migrating into the other, since the doc treats this as a genuinely
// new application, not an in-place schema migration (Section 4).

import { nanoid } from 'nanoid'
import { SHARED_CARD_COLORS, type AppDataV2, type CreditCard, type PayCycleConfig, type Person, type Transaction } from '../types/ledger'
import { defaultCategories } from './categories'
import { reconcilePersonReferences } from './household'
import { monthlyInterestRate } from './creditCards'
import { toLocalIsoDate } from './date'

const round2 = (n: number) => Math.round(n * 100) / 100

export const STORAGE_KEY = 'ledger:app-data-v2:v1'

// `storage`/`key` are parameters so lib/store/localStorageLedgerStore.ts can
// point these at a separate key (the test app's sync preview) or an
// in-memory Storage (verify-ledger-store.ts). `storage` is resolved inside
// the try, as the bare `localStorage` global always was, so a browser that
// throws on accessing it is still logged rather than thrown.
export function loadLedgerData(storage?: Storage, key: string = STORAGE_KEY): AppDataV2 | null {
  try {
    const raw = (storage ?? localStorage).getItem(key)
    if (!raw) return null
    return migrateLedgerData(JSON.parse(raw))
  } catch (err) {
    console.error('Failed to load ledger data', err)
    return null
  }
}

/**
 * Backfills fields introduced in later schema versions. Also ensures
 * every BUILT-IN category (Credit Card, Income, Bills, Savings) exists —
 * a category list already persisted to localStorage from before one of
 * these was introduced would otherwise never gain it automatically, and
 * every generated transaction that's hard-forced onto it (e.g. every
 * generated pot transfer onto Savings) would show as "Uncategorised"
 * forever. Only ADDS missing built-ins by id; never touches existing
 * categories, built-in or otherwise, so a renamed "Bills" or any
 * user-created category is left completely alone.
 */
export function migrateLedgerData(data: AppDataV2): AppDataV2 {
  const categories = data.categories ?? []
  const existingIds = new Set(categories.map((c) => c.id))
  const missingBuiltIns = defaultCategories().filter((c) => c.isBuiltIn && !existingIds.has(c.id))

  const backfilled: AppDataV2 = {
    ...data,
    // `recordedSeq` on each SalarySnapshot is backfilled in CURRENT ARRAY
    // ORDER (0, 1, 2 …), which is precisely what makes this
    // behaviour-preserving: array position was already the tie-break for
    // two snapshots sharing an effectiveFrom, so writing that same order
    // down changes nothing today while making it survive the move to a
    // real `salary_snapshots` table, where row order does not exist. See
    // SalarySnapshot.recordedSeq's own comment and
    // DATA-MODEL-REVIEW-2026-09-15.md §11.7a.
    //
    // ⚠️ The array is NOT sorted, reordered or de-duplicated here, and
    // must never be — duplicate effectiveFrom entries are deliberate and
    // sorting would reassign the very indices this reads (§11.7/§11.7b,
    // decided 2026-09-15). `??` not `||`, so an already-backfilled
    // recordedSeq of 0 is kept rather than silently recomputed.
    //
    // `savingsEntries` (legacy savings goals/plans, superseded by SavingsPot
    // on 2026-09-02) is dropped from every person. Nothing could create an
    // entry after that date, and both real backups have none (Q6,
    // DECISIONS-2026-09-15.md), so there is nothing to carry over.
    people: (data.people ?? []).map(({ savingsEntries: _legacySavingsEntries, ...person }: Person & { savingsEntries?: unknown }) => ({
      ...person,
      salaryHistory: (person.salaryHistory ?? []).map((snapshot, index) => ({ ...snapshot, recordedSeq: snapshot.recordedSeq ?? index })),
    })),
    categories: [...categories, ...missingBuiltIns],
    recurringTemplates: data.recurringTemplates ?? [],
    // `active` was introduced by the amortisation-engine work (scope §7),
    // mirroring CreditCard.active — any loan persisted before that field
    // existed backfills to true (still open/ongoing), same reasoning as
    // the built-in-category backfill above: never silently hide or
    // deactivate something the person never touched. Every other new
    // loan field (lender, advanceDate, calibration data) is genuinely
    // optional at the type level and needs no backfill.
    //
    // `principal` is a NEW REQUIRED field (same scope of work) — a loan
    // persisted before it existed has no real record of what was
    // actually borrowed, only monthlyPayment × termMonths (the old flat
    // model's "total payable", which is what the amortisation engine's
    // baseline back-solve would treat as a 0%-interest loan if left as
    // the principal too). Backfilling to that same figure is the only
    // information-preserving default available — it reproduces the old
    // flat model's numbers exactly (0% effective rate) until the person
    // corrects it with the real amount borrowed via the loan's edit view,
    // rather than guessing a non-zero rate from nothing.
    // `color` is backfilled here for the same reason, and by the same
    // mechanism, as savingsPots/pots below: loans gained their own hero
    // card on 2026-09-18 (PROMPT-08a Part C) and so joined the shared
    // palette. Before it, every loan card fell back to its CATEGORY's
    // colour, and loans overwhelmingly share the one seeded "Loan"
    // category — so they all rendered identically. The round-robin
    // continues from after the credit cards, savings pots and pots, so a
    // backfilled loan never lands on a colour one of those already holds.
    loans: backfillSharedCardColors(
      (data.loans ?? []).map((loan) => ({
        ...loan,
        active: loan.active ?? true,
        principal: loan.principal ?? round2(loan.monthlyPayment * loan.termMonths),
      })),
      (data.creditCards?.length ?? 0) + (data.savingsPots?.length ?? 0) + (data.pots?.length ?? 0),
    ),
    // `balanceAsOfDate` is a NEW REQUIRED field (see the comment on
    // CreditCard in types/ledger.ts). It's backfilled to TODAY, and that
    // choice is load-bearing rather than arbitrary: under the old model
    // `currentBalance` was a running total that had ALREADY been
    // decremented by every payment that cleared. Anchoring it to any
    // earlier date would make the new replay subtract those same
    // payments a second time. "As of today" is the one date for which
    // the existing stored figure is, by construction, already correct.
    //
    // The one wrinkle is a card transaction dated TODAY: the old code
    // subtracted it from currentBalance the moment it cleared, and the
    // replay counts anything dated on or before today, so it would land
    // twice. Those are reversed back out below so the anchor represents
    // the balance BEFORE today's activity, which the replay then
    // re-applies. Guarded on `balanceAsOfDate === undefined`, so this
    // runs exactly once per card and re-running migration on
    // already-migrated data is a no-op.
    creditCards: (data.creditCards ?? []).map((card) => (card.balanceAsOfDate ? card : anchorLegacyCardBalance(card, data.transactions ?? []))),
    pensions: data.pensions ?? [],
    // `color` is a NEW REQUIRED field (2026-09-11, shared-palette work —
    // see SHARED_CARD_COLORS's own comment in types/ledger.ts). Every
    // savings pot/pot persisted before it existed shared ONE fixed colour
    // per kind (Home.tsx's old SAVINGS_POT_HERO_COLOR/POT_HERO_COLOR
    // constants) — indistinguishable from each other, and POT_HERO_COLOR
    // happened to collide with Personal's own coral. Backfilled here in
    // array order, continuing the round-robin from wherever the already-
    // coloured credit cards leave off, so an existing pot/savings pot
    // gets a real, stable, non-repeating identity the first time this
    // runs rather than staying on the old collapsed-to-one-colour default.
    savingsPots: backfillSharedCardColors(data.savingsPots ?? [], data.creditCards?.length ?? 0),
    pots: backfillSharedCardColors(data.pots ?? [], (data.creditCards?.length ?? 0) + (data.savingsPots?.length ?? 0)),
    transactions: data.transactions ?? [],
    payCycles: data.payCycles ?? [],
    // Absent on any backup persisted before the Salary Sorter session
    // (2026-09) — defaults to no sorts ever having been done, same as a
    // brand-new household. See SalarySort's own comment in
    // types/ledger.ts.
    salarySorts: data.salarySorts ?? [],
    scenarios: data.scenarios ?? [],
    // Absent on any backup persisted before the joint-account feature —
    // defaults to null (not yet set up), same as a brand-new household.
    // If a joint-location bill/loan already exists in this data,
    // needsJointAccountSetup (lib/jointAccountLedger.ts) picks that up on
    // next render and prompts for it, same as it would for a newly
    // created one — nothing here guesses an opening balance/date.
    jointAccount: data.jointAccount ?? null,
  }

  // Self-heals any bill/loan/card left pointing at a person who no longer
  // exists — see lib/household.ts's reconcilePersonReferences for why.
  return reconcilePersonReferences(backfilled)
}

export function saveLedgerData(data: AppDataV2, storage?: Storage, key: string = STORAGE_KEY): void {
  try {
    (storage ?? localStorage).setItem(key, JSON.stringify(data))
  } catch (err) {
    console.error('Failed to save ledger data', err)
  }
}

/**
 * A plain `<a download>` click is what iOS Safari renders as its Quick
 * Look preview screen (file icon, "Open in X" / "More..." only) rather
 * than the native Share Sheet — reported 2026-09-15 (Adam: "I'd rather it
 * take me straight to [the Share Sheet]"). `navigator.share` with a real
 * `File` goes straight to the Share Sheet (AirDrop, Messages, Mail, Save
 * to Files, etc.) on platforms that support file sharing. Falls back to
 * the original Blob+anchor download wherever that isn't available
 * (desktop browsers, older iOS/Android) — same resulting file either way.
 */
export async function downloadLedgerBackup(data: AppDataV2): Promise<void> {
  const json = JSON.stringify(data, null, 2)
  const date = toLocalIsoDate(new Date())
  const filename = `finance-ledger-backup-${date}.json`
  const blob = new Blob([json], { type: 'application/json' })
  const file = new File([blob], filename, { type: 'application/json' })

  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean }
  if (nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename })
      return
    } catch (err) {
      // AbortError = the user dismissed the Share Sheet themselves — that's
      // a normal cancel, not a failure, so don't also pop a download prompt.
      if (err instanceof Error && err.name === 'AbortError') return
      // Any other failure: fall through to the plain download below.
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function parseLedgerBackupJson(json: string): AppDataV2 {
  const parsed = JSON.parse(json)
  const raw: unknown = parsed?.data ?? parsed // accept either a wrapped backup or a raw AppDataV2 dump

  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as AppDataV2).people)) {
    throw new Error("This doesn't look like a Finance ledger backup file.")
  }

  return migrateLedgerData(raw as AppDataV2)
}

export function defaultPayCycleConfig(personId: string): PayCycleConfig {
  return {
    personId,
    openingBalance: 0,
    openingBalanceDate: toLocalIsoDate(new Date()),
    paydayDayOfMonth: 28,
    paydayAdjustForNonWorkingDay: true,
    cycleStartDayOfMonth: 1,
  }
}

export function defaultLedgerData(): AppDataV2 {
  const meId = nanoid(8)
  const me: Person = {
    id: meId,
    name: 'Me',
    color: '#ff5b4c',
    salaryHistory: [],
    salaryOverrides: [],
  }

  return {
    primaryPersonId: meId,
    people: [me],
    categories: defaultCategories(),
    recurringTemplates: [],
    loans: [],
    creditCards: [],
    pensions: [],
    savingsPots: [],
    pots: [],
    transactions: [],
    payCycles: [defaultPayCycleConfig(meId)],
    salarySorts: [],
    scenarios: [],
    jointAccount: null,
  }
}

/**
 * One-time backfill of a pre-`balanceAsOfDate` credit card. See the call
 * site in migrateLedgerData for why the anchor date is today and why
 * today's own activity has to be unwound out of the stored figure first.
 *
 * Interest is unwound too, for the same reason the payment is: under the
 * old model a cleared GENERATED minimum payment posted a cycle's interest
 * to the balance before subtracting itself (a clear-time side effect, since removed), so a
 * minimum payment that cleared today left both effects baked in. A logged
 * lump payment never posted interest, so only its amount is reversed.
 */
function anchorLegacyCardBalance(card: CreditCard, transactions: Transaction[]): CreditCard {
  const today = toLocalIsoDate(new Date())
  const todaysActivity = transactions.filter(
    (t) => t.creditCardId === card.id && t.date === today && (t.type === 'credit_card_spend' || t.type === 'credit_card_payment'),
  )

  let balance = card.currentBalance
  // Walk backwards through the day's events, undoing each in turn.
  for (const t of [...todaysActivity].reverse()) {
    if (t.type === 'credit_card_spend') {
      balance = round2(balance - t.amount)
    } else {
      balance = round2(balance + t.amount)
      const wasGeneratedMinimum = t.sourceType !== 'credit_card_lump_payment'
      if (wasGeneratedMinimum && card.interestRatePercent > 0) {
        balance = round2(balance / (1 + monthlyInterestRate(card.interestRatePercent)))
      }
    }
  }

  return { ...card, currentBalance: Math.max(0, balance), balanceAsOfDate: today }
}

/**
 * Backfills a missing `color` on a pre-shared-palette Pot/SavingsPot,
 * continuing SHARED_CARD_COLORS' round-robin from `startIndex` (the count
 * of "card" entities already coloured ahead of this collection — see the
 * call site in migrateLedgerData). Already-coloured entries are left
 * alone; only ones actually missing the field advance the counter, so two
 * runs of migration never reshuffle an already-backfilled colour.
 */
function backfillSharedCardColors<T extends { color?: string }>(items: T[], startIndex: number): (T & { color: string })[] {
  let next = startIndex
  return items.map((item) => {
    if (item.color) return item as T & { color: string }
    const color = SHARED_CARD_COLORS[next % SHARED_CARD_COLORS.length]
    next += 1
    return { ...item, color }
  })
}
