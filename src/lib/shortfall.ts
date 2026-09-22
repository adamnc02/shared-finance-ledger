// PROMPT-14 Part 7 (2026-09-22) — "does this account run out of money at any
// point in the current pay cycle?"
//
// 🚨 IT IS THE DIP, NOT THE END-OF-CYCLE BALANCE. Adam, 2026-09-21:
// *"comparing this cycle projection to pending payments, if value dips below
// zero, send alert"*. This walks the WHOLE current cycle day by day and
// reports the FIRST day the projected running balance goes below zero — which
// means it fires on an account that ends the cycle perfectly healthy, because
// the dip is the thing that matters. Money that is £200 short on the 12th and
// £400 up by the 28th still bounces a direct debit on the 12th.
//
// Say that out loud here, because the cheap version — compare the projected
// END-of-cycle balance with zero — is one line shorter, looks equivalent, and
// loses the entire feature. `verify-shortfall.ts` carries that exact
// comparison as its control and requires it to MISS a case this one catches.
//
// SHARED, and in all three apps deliberately. It is pure arithmetic over the
// existing engines (`computeProjectionToDate`, `computePotProjection`,
// `computeJointAccountProjection`, `buildDailyBalanceSeries`) and it invents
// no maths of its own — which is the whole point: the alert and the number on
// the phone come from the same code. Only DELIVERY (push subscriptions, the
// Account toggle, the Edge Function) is sync-app-only, and none of it is here.
//
// What is watched, and what is deliberately not (§0b Q2, Adam 2026-09-21):
//
//   watched                                   not watched
//   ─────────────────────────────────────     ──────────────────────────────
//   each person's personal current account    SavingsPot — excluded entirely
//   Pot where isCoinJar !== true              Pot where isCoinJar === true
//   the joint account                         credit cards (a balance owed
//                                             is not a balance held)
//
// 🚨 There are TWO pot types. `SavingsPot` and `Pot` are different entities;
// only `Pot` is in scope, and a Coin Jar is a `Pot` with `isCoinJar: true`. A
// Coin Jar reaching zero is the Coin Jar working, not a problem.
//
// Who is told (§0b Q3): the account's OWNER, and joint has two owners. That
// one sentence is the whole recipient rule, and it needs no special-casing —
// which is exactly why Adam chose the symmetrical version. A `Pot` is never
// joint (the type's own comment says so), so a pot alert always has exactly
// one recipient.

import { computeProjectionToDate, horizonCycles } from './projection'
import { computePotProjection } from './potLedger'
import { potSignedAmount } from './potLedger'
import { computeJointAccountProjection, jointAccountSignedAmount } from './jointAccountLedger'
import { buildDailyBalanceSeries, daysBetweenInclusive, isLedgerTransaction, signedAmount } from './runningBalance'
import { toLocalIsoDate as toIso } from './date'
import type { AppDataV2, Transaction } from '../types/ledger'

export type WatchedAccountKind = 'personal' | 'pot' | 'joint'

export interface WatchedAccount {
  kind: WatchedAccountKind
  /** The person id, the pot id, or the literal 'joint' — unique within a household when paired with `kind`. */
  id: string
  /** What the person calls it, for the notification body. */
  name: string
  /**
   * The person ids to notify. One for a personal account or a pot; every person for joint.
   * Person, not user: mapping a person to an account is `people.linked_user_id`, which only the
   * server has, and a person with nobody linked is simply never claimed (§0b Q8).
   */
  personIds: string[]
  /** Which person's pay cycle bounds this account is measured against (pots and joint borrow one). */
  cyclePersonId: string
}

export interface Shortfall {
  account: WatchedAccount
  /** The FIRST day in the cycle the projected running balance is below zero. */
  date: string
  /** How far below zero it goes on that day, as a positive number of pounds. */
  amount: number
  cycleStart: string
  cycleEnd: string
}

/** Every account this household watches, in a stable order. */
export function watchedAccounts(data: AppDataV2): WatchedAccount[] {
  const out: WatchedAccount[] = []

  // A personal current account exists for anyone with a pay cycle — which is
  // everyone, since ledgerStorage defaults one per person.
  for (const person of data.people) {
    if (!data.payCycles.some((c) => c.personId === person.id)) continue
    out.push({ kind: 'personal', id: person.id, name: `${person.name}'s account`, personIds: [person.id], cyclePersonId: person.id })
  }

  for (const pot of data.pots ?? []) {
    if (!pot.active) continue
    if (pot.isCoinJar === true) continue // a Coin Jar emptying is it working
    out.push({ kind: 'pot', id: pot.id, name: pot.name, personIds: [pot.personId], cyclePersonId: pot.personId })
  }

  // Joint alerts BOTH people — the account has two owners, so the same rule
  // gives two recipients with nothing added to it.
  if (data.jointAccount && data.people.length > 0) {
    out.push({
      kind: 'joint',
      id: 'joint',
      name: 'the joint account',
      personIds: data.people.map((p) => p.id),
      cyclePersonId: data.primaryPersonId || data.people[0].id,
    })
  }

  return out
}

/**
 * The projected running balance for one watched account, for every day of its current pay cycle.
 * Exported so a check can assert the walk itself rather than only its verdict.
 */
export function cycleBalanceSeries(data: AppDataV2, account: WatchedAccount, asOfDate: Date): { date: string; balance: number }[] {
  const [cycle] = horizonCycles(data, account.cyclePersonId, 'current_cycle', asOfDate)
  const days = daysBetweenInclusive(cycle.start, cycle.end)

  if (account.kind === 'personal') {
    const payCycle = data.payCycles.find((c) => c.personId === account.id)
    if (!payCycle) return []
    const projection = computeProjectionToDate(data, account.id, payCycle, cycle.end, asOfDate)
    return points(buildDailyBalanceSeries(payCycle.openingBalance, projection.transactions, days, signedAmount, isLedgerTransaction))
  }

  if (account.kind === 'pot') {
    const pot = (data.pots ?? []).find((p) => p.id === account.id)
    if (!pot) return []
    const projection = computePotProjection(data, pot, 'current_cycle', asOfDate)
    const sign = (t: Transaction) => potSignedAmount(t, pot.id)
    return points(buildDailyBalanceSeries(pot.openingBalance, projection.transactions, days, sign))
  }

  const projection = computeJointAccountProjection(data, 'current_cycle', asOfDate)
  if (!projection) return []
  return points(buildDailyBalanceSeries(projection.openingBalance, projection.transactions, days, jointAccountSignedAmount))
}

const points = (series: { date: string; projectedBalance: number }[]) => series.map((p) => ({ date: p.date, balance: p.projectedBalance }))

/**
 * Every watched account whose projected running balance dips below zero at some point in the
 * current cycle, with the first day it happens and how far under it goes.
 *
 * An account that never dips is simply absent — there is no "resolved" state to clear and nothing
 * to store. A shortfall that persists is found again tomorrow, which is what makes §0b Q4's
 * "every evening until it clears" fall out of the data rather than out of a state machine.
 */
export function findShortfalls(data: AppDataV2, asOfDate: Date = new Date()): Shortfall[] {
  const out: Shortfall[] = []
  for (const account of watchedAccounts(data)) {
    const [cycle] = horizonCycles(data, account.cyclePersonId, 'current_cycle', asOfDate)
    const series = cycleBalanceSeries(data, account, asOfDate)
    // The FIRST day it goes under, not the worst day and not the last: the
    // question being answered is "when does the money run out".
    const dip = series.find((p) => p.balance < 0)
    if (!dip) continue
    out.push({
      account,
      date: dip.date,
      amount: Math.round(-dip.balance * 100) / 100,
      cycleStart: toIso(cycle.start),
      cycleEnd: toIso(cycle.end),
    })
  }
  return out
}

/** The notification a shortfall becomes. Nothing here is logged server-side (§47): it is built and sent, never stored. */
export function shortfallMessage(shortfall: Shortfall): { title: string; body: string } {
  const on = shortfall.date
  return {
    title: `${shortfall.account.name} runs short`,
    body: `Projected to go £${shortfall.amount.toFixed(2)} below zero on ${on}, before the cycle ends ${shortfall.cycleEnd}.`,
  }
}

/**
 * The dedupe key a shortfall claims before anything is sent.
 *
 * 🚨 THE DATE IS LOAD-BEARING. Listly's keys are event-shaped and carry no date, and they are the
 * worked example being copied — so leaving it out here is the likely mistake. Without it the alert
 * fires once and never again, which kills §0b Q4's "every evening until it clears" outright.
 *
 * `londonDate` is the date in Europe/London, not UTC: at 20:00 BST it is already the next day in
 * neither, but in December a 20:00 London run is 20:00 UTC and in June it is 19:00 UTC, and a key
 * built from the UTC date would change day at the wrong moment.
 */
export function shortfallDedupeKey(shortfall: Shortfall, personId: string, londonDate: string): string {
  return `shortfall:${shortfall.account.kind}:${shortfall.account.id}:${personId}:${londonDate}`
}
