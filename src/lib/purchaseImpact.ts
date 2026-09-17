// The date-aware half of the What-if engine, for the 'purchase' action:
// "if I buy this thing, on this date, what will my balance be that day —
// and what will I be left with by the end of that cycle?"
//
// WHY THIS IS A SEPARATE FILE FROM lib/scenarios.ts
//
// lib/scenarios.ts is deliberately date-free. It works on the legacy
// AppData shape produced by legacyBridge.ts and answers two questions:
// "how much does this change my available cash PER MONTH" and "how much
// one-off cash does it move". Neither has a calendar in it — a lump sum
// toward a loan is the same lump sum whenever it happens.
//
// A purchase is the first action where the DATE is the question. Two
// £400 purchases in the same scenario have identical monthly impact and
// identical one-off cash impact, but one on the day before payday and
// one on the day after are completely different propositions, and only
// the real ledger (bills, loans, card minimums, salary, joint shares)
// knows which. So this file works on the REAL AppDataV2 via
// computeProjectionToDate rather than the bridged legacy shape — the
// same engine every figure on the Summary page comes from, so a
// purchase can't quietly disagree with the hero card about what the
// balance is.
//
// The two engines stay complementary rather than overlapping:
// scenarios.ts still counts a purchase in `oneOffCashImpact` (it IS a
// one-off cash movement, and leaving it out would make that figure
// wrong), and this file adds the dated view on top.

import { computeProjectionToDate } from './projection'
import { resolveCycleBounds } from './pensionLedger'
import { isLedgerTransaction, signedAmount } from './runningBalance'
import { toLocalIsoDate } from './date'
import type { AppDataV2, PayCycleConfig } from '../types/ledger'
import type { Scenario } from '../types/models'

const round2 = (n: number) => Math.round(n * 100) / 100

export interface PurchaseImpact {
  actionId: string
  name: string
  date: string // ISO date the money leaves the account
  amount: number
  /** Projected balance on `date` as things stand — before this purchase (but after any EARLIER purchase in the same scenario). */
  balanceOnDateBefore: number
  /** ...and with this purchase taken off. */
  balanceOnDateAfter: number
  cycleStart: string // ISO — the cycle `date` falls in
  cycleEnd: string // ISO
  /** Projected balance at the end of that cycle, before this purchase (but after any earlier one). */
  cycleEndBalanceBefore: number
  /** ...and with this purchase included. */
  cycleEndBalanceAfter: number
  /** True if the purchase itself takes the balance below zero on the day. */
  goesNegativeOnDate: boolean
  /** True if the cycle ends below zero once this purchase is included. Distinct from the above — an affordable-on-the-day purchase can still leave the cycle short. */
  goesNegativeByCycleEnd: boolean
  /** True if `date` is in the past. The figures are still real (the ledger genuinely knows what that day looked like), but "will be" is the wrong tense and the UI says so. */
  isPastDate: boolean
}

/** A purchase action that's complete enough to compute — a date and a positive amount. */
function isUsablePurchase(action: Scenario['actions'][number]): boolean {
  return action.type === 'purchase' && Boolean(action.purchaseDate) && action.value > 0
}

/**
 * Every purchase in `scenario`, each measured against the real projected
 * ledger on its own date.
 *
 * Purchases are applied CUMULATIVELY in date order, which is the only
 * defensible reading once a scenario holds more than one: if you're
 * modelling buying a sofa in March and a fridge in April, April's
 * balance has already had the sofa taken out of it. Evaluating each
 * against an untouched baseline would tell you both are affordable when
 * together they aren't — the exact mistake this action exists to catch.
 * `balanceOnDateBefore` therefore means "before THIS purchase", not
 * "before any purchase"; the two coincide for the first one.
 */
export function computePurchaseImpacts(
  data: AppDataV2,
  personId: string,
  payCycle: PayCycleConfig,
  scenario: Scenario,
  asOfDate: Date = new Date(),
): PurchaseImpact[] {
  const purchases = scenario.actions
    .filter(isUsablePurchase)
    .slice()
    .sort((a, b) => (a.purchaseDate! === b.purchaseDate! ? 0 : a.purchaseDate! < b.purchaseDate! ? -1 : 1))

  if (purchases.length === 0) return []

  // Project far enough out to cover the end of the cycle containing the
  // LAST purchase. Derived from the purchases themselves rather than
  // using one of the two named horizons, because a purchase can sit
  // arbitrarily far in the future and a horizon that stopped short would
  // silently omit every bill and payday between the horizon and the
  // purchase date — reporting an inflated balance rather than an error.
  const cycleFor = (iso: string) => resolveCycleBounds(data, personId, parseIsoDate(iso))
  const lastCycleEnd = purchases.reduce((latest, p) => {
    const end = cycleFor(p.purchaseDate!).end
    return end > latest ? end : latest
  }, cycleFor(toLocalIsoDate(asOfDate)).end)

  const projection = computeProjectionToDate(data, personId, payCycle, lastCycleEnd, asOfDate)

  // Balance on a given date, using exactly the rule computeProjection
  // uses for its own projectedBalance: all cleared history (unbounded —
  // an already-cleared payment from last month still counts), plus every
  // pending movement dated on or before the date in question.
  const pending = projection.transactions.filter((t) => t.status === 'pending' && isLedgerTransaction(t))
  const balanceOn = (iso: string) => round2(projection.clearedBalance + pending.filter((t) => t.date <= iso).reduce((sum, t) => sum + signedAmount(t), 0))

  const todayIsoDate = toLocalIsoDate(asOfDate)
  let spentSoFar = 0
  const impacts: PurchaseImpact[] = []

  for (const action of purchases) {
    const date = action.purchaseDate!
    const bounds = cycleFor(date)
    const cycleEnd = toLocalIsoDate(bounds.end)

    const balanceOnDateBefore = round2(balanceOn(date) - spentSoFar)
    const balanceOnDateAfter = round2(balanceOnDateBefore - action.value)
    const cycleEndBalanceBefore = round2(balanceOn(cycleEnd) - spentSoFar)
    const cycleEndBalanceAfter = round2(cycleEndBalanceBefore - action.value)

    impacts.push({
      actionId: action.id,
      name: action.name?.trim() || 'Purchase',
      date,
      amount: action.value,
      balanceOnDateBefore,
      balanceOnDateAfter,
      cycleStart: toLocalIsoDate(bounds.start),
      cycleEnd,
      cycleEndBalanceBefore,
      cycleEndBalanceAfter,
      goesNegativeOnDate: balanceOnDateAfter < 0,
      goesNegativeByCycleEnd: cycleEndBalanceAfter < 0,
      isPastDate: date < todayIsoDate,
    })

    spentSoFar = round2(spentSoFar + action.value)
  }

  return impacts
}

/**
 * Parses an ISO date as LOCAL midnight.
 *
 * `new Date('2026-08-23')` parses as UTC midnight, which in BST is 01:00
 * on the 23rd — harmless — but the same round trip for a date in a
 * negative-offset zone lands on the previous day. Every other date
 * helper in this app goes through toLocalIsoDate for exactly this
 * reason; this is its inverse and belongs to the same rule.
 */
function parseIsoDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** Convenience for the combined/merged view — purchases across several scenarios, still applied cumulatively in date order. */
export function computePurchaseImpactsForScenarios(
  data: AppDataV2,
  personId: string,
  payCycle: PayCycleConfig,
  scenarios: Scenario[],
  asOfDate: Date = new Date(),
): PurchaseImpact[] {
  const merged: Scenario = {
    id: 'combined-purchases',
    name: 'Combined',
    includeInCumulative: false,
    actions: scenarios.flatMap((s) => s.actions),
  }
  return computePurchaseImpacts(data, personId, payCycle, merged, asOfDate)
}
