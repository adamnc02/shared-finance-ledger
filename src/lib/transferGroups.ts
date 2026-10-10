// Transactions → Transfers, grouped by where the money comes FROM.
//
// The page shows one tile per From location (Current Account, the joint
// account, each savings pot, each pot), and the transfers leaving it in a
// panel beneath. This file decides which group every transfer belongs to
// and what each tile's figure is. It is a pure function of lists the page
// has ALREADY filtered for visibility (TECHNICAL.md §47 "Household page
// visibility" — a page-level filter that lib/ never applies) — it never
// filters anything itself, so a transfer the page passes in always lands
// in exactly one group.
//
// 🚨 A group is keyed on the transfer's own `fromLocation` /
// `transferFrom`, never on the derived `location` or the flat
// `potId`/`savingsPotId`. Those cannot represent both ends of a Pot → Pot
// transfer, and the derived location says which LEDGER a transfer is on,
// not where it starts (TECHNICAL.md §20 "Transfers").
//
// 🚨 The tile's figure is per PAY CYCLE: what each recurring transfer
// moves in the CURRENT cycle of its OWNER (payCycleForTemplate). Not a
// monthly equivalent, which would be a figure no payment ever matches,
// and not the viewer's cycle — a payday-following transfer lands on its
// owner's payday, whoever is looking (TECHNICAL.md §20).

import type { AppDataV2, RecurringTemplate, Transaction, TransferLocation } from '../types/ledger'
import { buildTransferLocationOptions, transferLocationKey, transferLocationLabel } from './transferLedger'
import { generateTransactionsForTemplate, payCycleForTemplate } from './schedule'
import { resolveCycleBounds } from './pensionLedger'
import { isInEditWindow } from './editWindow'

const round2 = (n: number) => Math.round(n * 100) / 100

export interface TransferDestination {
  key: string
  label: string
  location: TransferLocation
  amount: number
}

export interface TransferGroup {
  /** `transferLocationKey` of the From location — `personal`, `joint`, `pot:<id>`, `savings:<id>`. */
  key: string
  from: TransferLocation
  label: string
  recurring: RecurringTemplate[]
  oneOffs: Transaction[]
  /** What the group's recurring transfers move in the current cycle, each on its owner's cycle. */
  perCycleTotal: number
  /**
   * `perCycleTotal`, split by where it goes, largest first — the tile's bar
   * and the panel's key. Empty when nothing recurring is due this cycle.
   * 🚨 Never filled from one-offs instead: a key above Recurring that
   * describes a cleared one-off, on a tile that says "none due this cycle",
   * reads as an unexplained payment.
   */
  recurringByDestination: TransferDestination[]
}

/** The amount a recurring transfer moves in its owner's cycle containing `asOf`. 0 for a paused template, or one with nothing due this cycle. */
export function transferAmountThisCycle(template: RecurringTemplate, data: AppDataV2, asOf: Date): number {
  const ownerId = template.ownerId || data.primaryPersonId
  const { start, end } = resolveCycleBounds(data, ownerId, asOf)
  const occurrences = generateTransactionsForTemplate(template, start, end, payCycleForTemplate(template, data.payCycles, data.primaryPersonId))
  return round2(occurrences.reduce((sum, o) => sum + o.amount, 0))
}

function byDestination(items: { to: TransferLocation | undefined; amount: number }[], data: AppDataV2): TransferDestination[] {
  const map = new Map<string, TransferDestination>()
  for (const { to, amount } of items) {
    if (!to || amount <= 0) continue
    const key = transferLocationKey(to)
    const d = map.get(key) ?? { key, label: transferLocationLabel(to, data.savingsPots, data.pots ?? []), location: to, amount: 0 }
    d.amount = round2(d.amount + amount)
    map.set(key, d)
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount)
}

/** A transfer with no recorded From is shown, never dropped: it gets a group of its own. */
const UNKNOWN_KEY = 'unknown'

/**
 * Every transfer, in exactly one group. Groups come in the order the
 * transfer pickers list locations (Current Account, Joint, savings pots,
 * pots); a location not in that list (someone else's pot reached through
 * the joint exemption) follows, then any transfer with no From at all.
 * Locations with no transfers get no group.
 */
export function groupTransfersByFrom(recurring: RecurringTemplate[], oneOffs: Transaction[], data: AppDataV2, asOf: Date = new Date()): TransferGroup[] {
  const groups = new Map<string, TransferGroup>()
  const groupFor = (from: TransferLocation | undefined): TransferGroup => {
    const key = from ? transferLocationKey(from) : UNKNOWN_KEY
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        from: from ?? { type: 'personal' },
        label: from ? transferLocationLabel(from, data.savingsPots, data.pots ?? []) : 'Unknown',
        recurring: [],
        oneOffs: [],
        perCycleTotal: 0,
        recurringByDestination: [],
      }
      groups.set(key, g)
    }
    return g
  }

  for (const t of recurring) groupFor(t.transferFrom).recurring.push(t)
  for (const t of oneOffs) groupFor(t.fromLocation).oneOffs.push(t)

  for (const g of groups.values()) {
    const thisCycle = g.recurring.map((t) => ({ to: t.transferTo, amount: transferAmountThisCycle(t, data, asOf) }))
    g.perCycleTotal = round2(thisCycle.reduce((s, x) => s + x.amount, 0))
    g.recurringByDestination = byDestination(thisCycle, data)
  }

  const order = buildTransferLocationOptions(data.savingsPots, data.pots ?? [], !!data.jointAccount, data.primaryPersonId).map((o) => o.key)
  const rank = (key: string) => (key === UNKNOWN_KEY ? Number.MAX_SAFE_INTEGER : order.indexOf(key) === -1 ? order.length : order.indexOf(key))
  return [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key))
}

/**
 * Whether a cleared item has been cleared long enough to fold away. Anything
 * inside the edit window (lib/editWindow.ts, 5 days) stays in view beside the
 * pending items, so a payment that has only just cleared can still be
 * corrected without opening anything. Shared by every list that folds cleared
 * items, so the grace period is one rule, not several.
 */
export function isSettled(dateIso: string, cleared: boolean, asOf: Date = new Date()): boolean {
  return cleared && !isInEditWindow(dateIso, asOf)
}
