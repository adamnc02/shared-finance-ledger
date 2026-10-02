// Page-level visibility when more than one person shares the app.
//
// Once `data.people` holds two or more people, the Wallet, Bills,
// Transactions and Borrowing pages list only what belongs to the person this
// device is (`primaryPersonId`). Anything positively owned by someone else is
// left out of those lists.
//
// 🚨 THIS IS A VIEW FILTER AND NOTHING ELSE. Every engine still receives the
// WHOLE dataset: the projections, auto-clear, the pot and savings-pot
// ledgers, the credit-card replay, the loan schedules, the home hero cards
// and the statement. A row hidden from a list is still paid, still clears,
// still counts against every balance and still syncs. Nothing in this file
// may be used to build an engine's input — see `verify-household-view.ts`,
// which fails if anything under `src/lib` or `src/context` imports it.
//
// THE TRAP: the obvious way to implement this is to filter `data` once, high
// up, and hand the smaller object down. That reads as tidier and it silently
// rewrites the household's money — the other person's bills stop being
// deducted, their pots stop being funded, and every figure on the home page
// quietly becomes a single-person figure. The filter belongs at the `.map`
// that renders a list, and nowhere else.
//
// Three rules that look like edge cases and are not:
//
//  1. UNOWNED IS NOT SOMEONE ELSE'S. An `ownerId` of `''` (or absent) means
//     nobody in particular, and real data is full of it — every joint bill in
//     a two-person household carries `''`. Those rows stay visible to
//     everyone. Hiding them would make a bill nobody can see, which is a bill
//     nobody pays.
//  2. A DANGLING OWNER IS ALSO NOT SOMEONE ELSE'S. An `ownerId` naming a
//     person who no longer exists stays visible, because the alternative is a
//     row that has silently vanished from every page with no way to reach it.
//  3. JOINT IS SHARED. A joint bill, a joint transaction, or a transfer with
//     a joint endpoint is shown whatever its `ownerId` says.

import type { AppDataV2, Transaction } from '../types/ledger'

type People = Pick<AppDataV2, 'people' | 'primaryPersonId'>

/** True once the app holds more than one person, which is what turns the filtering on. */
export function isSharedHousehold(data: Pick<AppDataV2, 'people'>): boolean {
  return data.people.length > 1
}

/**
 * True only when `ownerId` names a person who exists and is NOT the person this
 * device is. Unowned (`''`/absent) and dangling owners both return false — see
 * rules 1 and 2 in this file's header.
 */
export function isSomeoneElses(data: People, ownerId: string | undefined | null): boolean {
  if (!isSharedHousehold(data)) return false
  if (!ownerId) return false
  if (ownerId === data.primaryPersonId) return false
  return data.people.some((p) => p.id === ownerId)
}

/**
 * The rows of `list` a page should show. Always returns a NEW array, so a
 * caller's `.sort()` can never reorder the array it was given — which, for
 * anything reached straight off `data`, would be reordering stored state
 * (array order is load-bearing in effective-dated history: APP-KNOWLEDGE §1.2).
 *
 * `alwaysShow` is the joint exemption: a row it returns true for is kept
 * whatever its owner is.
 */
export function visibleToMe<T>(
  data: People,
  list: readonly T[],
  ownerOf: (row: T) => string | undefined | null,
  alwaysShow?: (row: T) => boolean,
): T[] {
  return list.filter((row) => (alwaysShow?.(row) ?? false) || !isSomeoneElses(data, ownerOf(row)))
}

/**
 * Whether a transaction is shared rather than one person's: its own location is
 * joint, or — for a transfer, whose location is derived and whose authoritative
 * sides are `fromLocation`/`toLocation` (APP-KNOWLEDGE §1.4) — either endpoint
 * is the joint account.
 */
export function touchesJointAccount(t: Transaction): boolean {
  return t.location === 'joint' || t.fromLocation?.type === 'joint' || t.toLocation?.type === 'joint'
}
