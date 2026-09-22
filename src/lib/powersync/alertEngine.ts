// SYNC APP ONLY. The entry point that gets bundled into the `ledger-alerts`
// Edge Function (PROMPT-14 Part 7; §0b Q5, revised 2026-09-22).
//
// 🚨 THIS FILE IS WHY THERE IS ONLY ONE ENGINE. Q5 originally chose to
// reimplement the projection in SQL and accepted a second implementation of
// the most invariant-heavy code in the app as the price. Then it turned out
// Edge Functions run Deno — TypeScript — and this engine is already
// environment-free: every `verify-*` script runs these exact functions in
// Node. So the server runs the app's own code instead, and the drift risk
// that §0b Q6's parity check existed to contain simply does not exist.
//
// What replaces that risk is mechanical and visible: the function needs a
// BUNDLE of this file, and a bundle can go stale.
// `scripts/build-alert-engine.ts` writes it and
// `scripts/verify-alert-engine-bundle.ts` fails the sweep when the committed
// bundle is no longer what this source produces. A stale bundle is therefore
// loud, where a drifting second engine would have been silent.
//
// 🚨 KEEP THIS FILE A RE-EXPORT AND NOTHING ELSE. Every line of logic added
// here is a line the app itself does not run — which is the second engine
// coming back in through a smaller door. If the alert needs a rule, the rule
// belongs in `src/lib/shortfall.ts`, where the app and the sweep both see it.
//
// It deliberately imports nothing from `src/components/**`, `src/pages/**`,
// `supabaseClient` or `@powersync/*`: the bundle must be pure computation, so
// it can run in Deno with no DOM, no network client and no PowerSync.

import { SYNCED_TABLES } from './tables'

/**
 * Every table the Edge Function must read for one household, in FK order.
 *
 * 🚨 DERIVED, never hand-listed. A hand-maintained list in the function would
 * fall out of step with the schema the first time a table was added, and the
 * symptom would be an alert computed from an incomplete ledger — a confident,
 * wrong number, with nothing to say so. `household: true` is exactly "has a
 * household_id column", which is what the function filters on.
 *
 * `households` itself is excluded by that flag and is not needed: `fromRows`
 * never reads it.
 */
export const ALERT_TABLES: string[] = SYNCED_TABLES.filter((t) => t.household).map((t) => t.remote)

export { fromRows } from './mapping'
export type { Row, Rows, Value } from './mapping'
export { migrateLedgerData } from '../ledgerStorage'
export { findShortfalls, shortfallDedupeKey, shortfallMessage, watchedAccounts, cycleBalanceSeries } from '../shortfall'
export type { Shortfall, WatchedAccount, WatchedAccountKind } from '../shortfall'

import { fromRows, type Rows } from './mapping'
import { migrateLedgerData } from '../ledgerStorage'
import { findShortfalls, shortfallDedupeKey, shortfallMessage, type Shortfall } from '../shortfall'
import type { AppDataV2 } from '../../types/ledger'

/**
 * One household's rows, straight off the server, turned into the shortfalls to alert on.
 *
 * `primaryPersonId` is per DEVICE and never syncs (DECISIONS Q3), so the server genuinely does not
 * have one. It only matters here for which person's pay-cycle bounds the JOINT account borrows
 * (computeJointAccountProjection's own documented convention), so the linked person is used —
 * falling back to the first — and both are the household's own data rather than a guess.
 */
export function shortfallsForHousehold(rows: Rows, asOfDate: Date): { data: AppDataV2; shortfalls: Shortfall[] } {
  const base = fromRows(rows)
  const linked = (rows.people ?? []).find((r) => typeof r.linked_user_id === 'string' && r.linked_user_id)?.id
  const primaryPersonId = (linked && base.people.some((p) => p.id === linked) ? linked : base.people[0]?.id) ?? ''
  const data = migrateLedgerData({ ...base, primaryPersonId })
  return { data, shortfalls: findShortfalls(data, asOfDate) }
}

/**
 * Person id → the user it is linked to, for turning a shortfall's `personIds` into recipients.
 * A person nobody has tapped "Set as me" on is simply absent, and is therefore never claimed —
 * which is how Ella's outstanding phone costs nothing (§0b Q8).
 */
export function linkedUsers(rows: Rows): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows.people ?? []) {
    if (typeof r.linked_user_id === 'string' && r.linked_user_id) out[r.id] = r.linked_user_id
  }
  return out
}

/** Everything the Edge Function needs for one shortfall, in one place, so the function itself holds no rules. */
export function alertsFor(rows: Rows, asOfDate: Date, londonDate: string): {
  personId: string
  userId: string
  dedupeKey: string
  title: string
  body: string
  tag: string
}[] {
  const { shortfalls } = shortfallsForHousehold(rows, asOfDate)
  const users = linkedUsers(rows)
  const out = []
  for (const shortfall of shortfalls) {
    const message = shortfallMessage(shortfall)
    for (const personId of shortfall.account.personIds) {
      const userId = users[personId]
      if (!userId) continue // nobody is linked to this person: never claimed
      out.push({
        personId,
        userId,
        dedupeKey: shortfallDedupeKey(shortfall, personId, londonDate),
        title: message.title,
        body: message.body,
        // 🚨 A NEW TAG EACH DAY. The alert repeats every evening until it
        // clears (§0b Q4), and a notification reusing a tag silently REPLACES
        // yesterday's — which would defeat a daily nudge entirely. The London
        // date is what makes each day's tag its own.
        tag: `shortfall:${shortfall.account.kind}:${shortfall.account.id}:${londonDate}`,
      })
    }
  }
  return out
}
