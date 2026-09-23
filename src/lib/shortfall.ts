// PROMPT-14 Part 7 (2026-09-22) — "does this account run out of money in the
// next few days?"
//
// 🚨 IT IS THE DIP, NOT AN END-OF-PERIOD BALANCE. Adam, 2026-09-21:
// *"comparing this cycle projection to pending payments, if value dips below
// zero, send alert"*. This walks forward day by day and reports the FIRST day
// the projected running balance goes below zero — which means it fires on an
// account that is perfectly healthy a fortnight later, because the dip is the
// thing that matters. Money that is £200 short on the 12th and £400 up by the
// 28th still bounces a direct debit on the 12th.
//
// Say that out loud here, because the cheap version — compare the projected
// balance at the far end with zero — is one line shorter, looks equivalent,
// and loses the entire feature. `verify-shortfall.ts` carries that exact
// comparison as its control and requires it to MISS a case this one catches.
//
// 🚨 IT IS NOT BOUND TO ANYONE'S PAY CYCLE, AND MUST NOT GO BACK TO BEING SO
// (Adam, 2026-09-23, on a real alert). *"these notifications aren't tied to a
// cycle, they're simply a day-by-day walkthrough, stops when the day-end dips
// below target … doesn't need to be bound to anyone's pay cycle"*.
//
// It used to search the primary person's CURRENT PAY CYCLE, and every part of
// that was wrong for a shared household:
//
//   - the joint account has no cycle of its own, so it borrowed one, and the
//     server has no `primaryPersonId` to borrow from (it is per-device and
//     never syncs — DECISIONS Q3). `shortfallsForHousehold` guessed "the first
//     linked person", off an unordered `select('*')`, so WHOSE cycle the joint
//     account was measured against was effectively random and could flip from
//     one night to the next;
//   - the cycle END leaked into the message as a date — "Nothing more due in
//     before 7 October" — naming a day nothing happens on. Adam read it as a
//     payment date, which is exactly what it looks like;
//   - and the cycle end TRUNCATED the search for money coming in, so a £800
//     deposit one day past the boundary read as "nothing is coming".
//
// 🚨 THE TWO HORIZONS ARE DIFFERENT AND THAT IS THE WHOLE POINT. Adam, same
// message: *"7 day walk ahead, but don't use the same limit for checking next
// incoming money, this is unbounded … next incoming is quite literally the
// next incoming cash"*. The DIP search stops at `SHORTFALL_WALK_DAYS`; every
// question about money arriving — `nextMoneyIn`, `moneyInBefore`,
// `recoversOn` — looks as far ahead as the ledger can be generated. Collapsing
// them back into one window is the regression this comment exists to prevent,
// and it is a silent one: the alert still sends, it just lies about relief.
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
import { parseLocalDate, toLocalIsoDate as toIso } from './date'
import { formatDayMonth } from './format'
import type { AppDataV2, Transaction } from '../types/ledger'

export type WatchedAccountKind = 'personal' | 'pot' | 'joint'

/**
 * How many days ahead the DIP search looks, counting from tomorrow (Adam, 2026-09-23:
 * *"7 day walk ahead"*). A heads-up about something eight days out is not actionable in the way
 * one about Tuesday is, and the alert is nightly — tomorrow's walk sees it anyway.
 *
 * 🚨 THIS BOUNDS THE DIP AND NOTHING ELSE. `nextMoneyIn`, `moneyInBefore` and `recoversOn` are
 * deliberately unbounded; see the file header.
 */
export const SHORTFALL_WALK_DAYS = 7

/**
 * How far the ledger is generated so the unbounded "next money in" has something to find.
 * Three cycles is `projection.ts`'s own standing horizon, so this invents no new limit — it
 * reuses the furthest the app ever projects. If nothing comes in within it, the message says
 * "nothing more due in" with no date, which is honest: that is as far as anything can see.
 */
const GENERATION_HORIZON = 'three_cycles' as const

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
  /**
   * How far below zero this account may go. `0` = no overdraft (PROMPT-15 §0 Q2). Always positive.
   *
   * 🚨 It creates a SECOND floor, and the two mean different things in English — see `Severity`.
   */
  overdraftAmount: number
}

/**
 * 🚨 THE TWO SITUATIONS ARE NOT THE SAME THING, and the difference is not one of degree.
 *
 * Adam, 2026-09-22: *"I can't go below zero or below my overdraft limit, so going 712 into a 500
 * overdraft makes no sense, same for below 0."*
 *
 * A balance **cannot pass its floor** — the bank declines the payment. So:
 *
 * - `'overdraft'` describes a state that **really happens**: you dip into a buffer you are allowed
 *   to use. The amount is **how far below zero** you go.
 * - `'shortfall'` describes a state that **cannot happen**: the payment does not go through. The
 *   amount is **how much you are SHORT BY** — how much more money is needed for it to clear.
 *
 * Never describe a balance beyond its floor. "£712.40 into your £500 overdraft" and, with no
 * overdraft, "£212.40 below zero", are both impossible states.
 */
export type Severity = 'overdraft' | 'shortfall'

export interface Shortfall {
  account: WatchedAccount
  /** Which of the two situations this is — see `Severity`. They take different numbers. */
  severity: Severity
  /**
   * The FIRST day in the cycle the projected running balance passes this severity's floor.
   *
   * 🚨 IT IS ALWAYS IN THE FUTURE — the search window starts TOMORROW. Adam, 2026-09-22:
   * *"ignore today, look from tomorrow and report the first dip"*. An alert sent at 20:00 is a
   * heads-up about what is coming; by then today has happened and there is nothing to do about it.
   *
   * 🚨 The BALANCE still carries everything before today — only the SEARCH is narrowed. The walk
   * is built over the whole cycle, so tomorrow's day-end includes every payment that has already
   * gone out. Rebuilding the series from tomorrow instead would silently drop the opening balance
   * and every cleared payment, and report an account as healthy because its history vanished.
   *
   * It stays load-bearing for PROMPT-15's suppression history (Adam, 2026-09-22 — *"get the first
   * notification, as this sets the history check for the 2nd notification"*).
   */
  date: string
  /**
   * A positive number of pounds, meaning **different things** by severity:
   * `'overdraft'` → how far below zero you go. `'shortfall'` → how much you are SHORT BY.
   */
  amount: number
  /**
   * The DIP SEARCH window this was found in — tomorrow, and `SHORTFALL_WALK_DAYS` days after
   * today. Kept on the result so a check can assert the window rather than infer it.
   *
   * 🚨 It is NOT the range the relief fields were found in. `nextMoneyIn`, `moneyInBefore` and
   * `recoversOn` look past `windowEnd` on purpose, and `windowEnd` must never be put into the
   * message as a date — that is precisely the "before 7 October" defect (see the file header).
   */
  windowStart: string
  windowEnd: string
  /**
   * What is going OUT of this account on `date` — the payments that take it under, newest-first by
   * size. Empty when the balance was already below zero before anything was due that day, which is
   * a real case: an account that starts the cycle overdrawn has no single payment to blame.
   */
  causes: { label: string; amount: number }[]
  /**
   * The first day AFTER the dip that anything comes INTO this account, with how much, or null if
   * nothing does before the cycle ends.
   *
   * 🚨 Deliberately ANY incoming amount, not just salary. A transfer in from savings pays a bill
   * exactly as well as a payday does, and calling only salary "income" would tell someone nothing
   * is coming when £300 lands tomorrow.
   */
  nextMoneyIn: { date: string; amount: number } | null
  /**
   * Money arriving BETWEEN tomorrow and the dip — already absorbed into the figure, and mentioned
   * so the alert does not read as "nothing is coming".
   *
   * 🚨 THIS IS THE ONE THE OLD MESSAGE LIED ABOUT. `nextMoneyIn` only looks AFTER the dip, so a
   * deposit landing before it was invisible and the message fell through to "Nothing more due in
   * before X" — literally true, and read as "nothing is coming" when £100 had come and simply was
   * not enough (Adam, 2026-09-22, on a real alert). `date` is null when it spans several days, so
   * the message can say "before then" rather than naming an arbitrary one of them.
   */
  moneyInBefore: { date: string | null; amount: number } | null
  /**
   * The first day after the dip the balance is back at or above the floor, or null if it never is
   * before the cycle ends.
   *
   * 🚨 MONEY ARRIVING IS NOT THE SAME AS RECOVERING, and conflating them is how this alert would
   * start lying reassuringly. Adam, 2026-09-22: *"I may have a scheduled deposit/withdrawal that
   * might not be enough to cover the upcoming scheduled/pending payments"*. A £50 deposit against
   * £500 of payments is money in and still short — so the message leads with THIS, and mentions
   * the deposit only to say it does not clear it.
   *
   * Free to compute, because the day-by-day walk this is read from already exists: the engine is
   * not anchored to the cycle boundary, it visits every day.
   */
  recoversOn: string | null
}

/** Every account this household watches, in a stable order. */
export function watchedAccounts(data: AppDataV2): WatchedAccount[] {
  const out: WatchedAccount[] = []

  // A personal current account exists for anyone with a pay cycle — which is
  // everyone, since ledgerStorage defaults one per person.
  for (const person of data.people) {
    if (!data.payCycles.some((c) => c.personId === person.id)) continue
    const cycle = data.payCycles.find((c) => c.personId === person.id)!
    out.push({ kind: 'personal', id: person.id, name: `${person.name}'s account`, personIds: [person.id], cyclePersonId: person.id, overdraftAmount: cycle.overdraftAmount ?? 0 })
  }

  for (const pot of data.pots ?? []) {
    if (!pot.active) continue
    if (pot.isCoinJar === true) continue // a Coin Jar emptying is it working
    out.push({ kind: 'pot', id: pot.id, name: pot.name, personIds: [pot.personId], cyclePersonId: pot.personId, overdraftAmount: pot.overdraftAmount ?? 0 })
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
      overdraftAmount: data.jointAccount.overdraftAmount ?? 0,
    })
  }

  return out
}

/**
 * The projected running balance for one watched account, for every day of its current pay cycle.
 * Exported so a check can assert the walk itself rather than only its verdict.
 */
/**
 * Everything one watched account's cycle is made of: the days, the transactions the projection
 * produced for it, and the sign function that decides which way each one moves THIS account.
 *
 * Extracted because the alert needs two things from one walk — the day the balance goes under, and
 * what is due on that day. Deriving them separately would be two chances to disagree about which
 * transactions belong to the account.
 */
function accountWalk(
  data: AppDataV2,
  account: WatchedAccount,
  asOfDate: Date,
): { days: string[]; openingBalance: number; transactions: Transaction[]; sign: (t: Transaction) => number; include: (t: Transaction) => boolean } | null {
  // 🚨 `cyclePersonId` survives here for ONE reason only — deciding how far ahead to GENERATE the
  // ledger. It is no longer a boundary, and nothing below compares a date against it. Reintroducing
  // it as a limit brings back every symptom in the file header at once.
  const cycles = horizonCycles(data, account.cyclePersonId, GENERATION_HORIZON, asOfDate)
  const horizonEnd = cycles[cycles.length - 1].end
  // 🚨 The day list runs from the CURRENT CYCLE'S START to the generation horizon — wider at BOTH
  // ends than anything the dip search reads. The near end keeps this series a superset of the one
  // the Trends chart builds for the same account, which `verify-shortfall.ts` §6 asserts and which
  // `cameOutOfOverdraftSince` reads backwards. The far end is what makes "next money in" unbounded.
  // Neither end is a boundary: `buildDailyBalanceSeries` folds every transaction dated on or before
  // each day regardless of where the list starts, so no day-end loses its history.
  const days = daysBetweenInclusive(cycles[0].start, horizonEnd)

  if (account.kind === 'personal') {
    const payCycle = data.payCycles.find((c) => c.personId === account.id)
    if (!payCycle) return null
    const projection = computeProjectionToDate(data, account.id, payCycle, horizonEnd, asOfDate)
    return { days, openingBalance: payCycle.openingBalance, transactions: projection.transactions, sign: signedAmount, include: isLedgerTransaction }
  }

  if (account.kind === 'pot') {
    const pot = (data.pots ?? []).find((p) => p.id === account.id)
    if (!pot) return null
    const projection = computePotProjection(data, pot, GENERATION_HORIZON, asOfDate)
    return { days, openingBalance: pot.openingBalance, transactions: projection.transactions, sign: (t) => potSignedAmount(t, pot.id), include: () => true }
  }

  const projection = computeJointAccountProjection(data, GENERATION_HORIZON, asOfDate)
  if (!projection) return null
  return { days, openingBalance: projection.openingBalance, transactions: projection.transactions, sign: jointAccountSignedAmount, include: () => true }
}

/**
 * The projected running balance for one watched account, for every day of its current pay cycle.
 * Exported so a check can assert the walk itself rather than only its verdict.
 */
export function cycleBalanceSeries(data: AppDataV2, account: WatchedAccount, asOfDate: Date): { date: string; balance: number }[] {
  const c = accountWalk(data, account, asOfDate)
  if (!c) return []
  return buildDailyBalanceSeries(c.openingBalance, c.transactions, c.days, c.sign, c.include).map((p) => ({ date: p.date, balance: p.projectedBalance }))
}

/**
 * What a row is called, using the app's OWN convention — `note`, then the category's name, then
 * the bare type — the same fallback chain Home.tsx renders a ledger row with. Deliberately not a
 * prettier label invented here: a notification that names a bill differently from the screen you
 * open to look at it is worse than one that says nothing.
 */
function label(t: Transaction, data: AppDataV2): string {
  return t.note || data.categories.find((c) => c.id === t.categoryId)?.name || t.type
}

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
  const todayIso = toIso(asOfDate)

  // Tomorrow, and the last day the DIP search will look at. The walk itself runs far past this
  // at BOTH ends, which is why these are computed from the date rather than read off the series.
  const day = (offset: number) => toIso(new Date(asOfDate.getFullYear(), asOfDate.getMonth(), asOfDate.getDate() + offset))
  const windowStart = day(1)
  const windowEnd = day(SHORTFALL_WALK_DAYS)

  for (const account of watchedAccounts(data)) {
    const c = accountWalk(data, account, asOfDate)
    if (!c) continue
    // 🚨 The series runs to the GENERATION horizon — every day-end carries everything before it,
    // including today's payments and the opening balance.
    const series = buildDailyBalanceSeries(c.openingBalance, c.transactions, c.days, c.sign, c.include)
    // …but the DIP SEARCH is the next `SHORTFALL_WALK_DAYS` days only, starting tomorrow (Adam,
    // 2026-09-22: "ignore today, look from tomorrow and report the first dip"). Narrowing the
    // search, never the walk, is the whole trick: filter the transactions instead and the balance
    // loses its history — and narrowing the walk to match would truncate `nextMoneyIn` too, which
    // is the defect this design exists to prevent.
    const horizon = series.filter((p) => p.date > todayIso && p.date <= windowEnd)
    const limit = account.overdraftAmount

    // TWO floors, and the more severe one wins (PROMPT-15 §0 Q6).
    //
    // 🚨 `'overdraft'` only exists when there IS an arranged buffer. With no
    // limit, dipping below zero IS running out of money — getting this wrong
    // downgrades a real alert into a heads-up.
    const pastLimit = horizon.find((p) => p.projectedBalance < -limit)
    const belowZero = limit > 0 ? horizon.find((p) => p.projectedBalance < 0) : undefined
    const hit = pastLimit ?? belowZero
    if (!hit) continue
    const severity: Severity = pastLimit ? 'shortfall' : 'overdraft'

    // The floor this severity is about, and the amount measured from it.
    // 'overdraft' → how far below zero. 'shortfall' → how much you are short by.
    const floor = severity === 'shortfall' ? -limit : 0
    const amount = Math.round((floor - hit.projectedBalance) * 100) / 100

    // What is leaving the account THAT DAY. Taken from the same transaction
    // list the balance was walked from, so the alert can never name a payment
    // that did not contribute to the number beside it.
    const causes = c.transactions
      .filter((t) => t.date === hit.date && c.include(t) && c.sign(t) < 0)
      .map((t) => ({ label: label(t, data), amount: Math.round(-c.sign(t) * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount)

    // The next day money arrives, from the same list again, with how much arrives that day in
    // total. 🚨 UNBOUNDED — no `windowEnd` here, deliberately (Adam, 2026-09-23: "next incoming is
    // quite literally the next incoming cash"). A deposit eight days out is still the answer to
    // "when does this get better?", even though a dip eight days out is not yet worth an alert.
    const incoming = c.transactions.filter((t) => t.date > hit.date && c.include(t) && c.sign(t) > 0)
    const nextInDate = incoming.map((t) => t.date).sort()[0] ?? null
    const nextMoneyIn = nextInDate
      ? { date: nextInDate, amount: Math.round(incoming.filter((t) => t.date === nextInDate).reduce((sum, t) => sum + c.sign(t), 0) * 100) / 100 }
      : null

    // Whether it recovers — back within THIS severity's floor, not back above
    // zero. A different line from the dip test, and easy to miss. Unbounded, for the same reason
    // `incoming` is: `series` runs to the generation horizon, not to `windowEnd`.
    const recoversOn = series.find((p) => p.date > hit.date && p.projectedBalance >= floor)?.date ?? null

    // Money landing between tomorrow and the dip. Already inside `amount` —
    // this is only so the message can say it did not cover it.
    const inBefore = c.transactions.filter((t) => t.date > todayIso && t.date < hit.date && c.include(t) && c.sign(t) > 0)
    const inBeforeDates = [...new Set(inBefore.map((t) => t.date))]
    const moneyInBefore = inBefore.length
      ? {
          date: inBeforeDates.length === 1 ? inBeforeDates[0] : null,
          amount: Math.round(inBefore.reduce((sum, t) => sum + c.sign(t), 0) * 100) / 100,
        }
      : null

    out.push({
      account,
      severity,
      date: hit.date,
      amount,
      windowStart,
      windowEnd,
      causes,
      nextMoneyIn,
      moneyInBefore,
      recoversOn,
    })
  }
  return out
}

/**
 * The notification a shortfall becomes. Nothing here is logged server-side (§47): it is built and
 * sent, never stored. **Wording approved by Adam, 2026-09-22.**
 *
 * 🚨 ONE BUILDER, NOT TWO. The severities share the cause-then-relief structure and differ only in
 * which floor they measure from. Two builders would drift; one with a floor parameter cannot.
 *
 * 🚨 IT LEADS WITH THE CAUSE, not the number: "Rent (£850.00) on 12 October takes you £212.40 into
 * your £500 overdraft" is something you can act on.
 *
 * 🚨 NEVER DESCRIBE A BALANCE BEYOND ITS FLOOR. For `'shortfall'` the figure is how much you are
 * SHORT BY — the payment does not go through, so "£712.40 into your £500 overdraft" would be an
 * impossible state (Adam, 2026-09-22).
 */
export function shortfallMessage(shortfall: Shortfall): { title: string; body: string } {
  const on = formatDayMonth(shortfall.date)
  const money = `£${shortfall.amount.toFixed(2)}`
  const { causes, severity, account } = shortfall
  const limit = account.overdraftAmount

  // Where the figure sits. Present tense for a dip still to come, past tense
  // for one that has already happened (PROMPT-14, answered 2026-09-22) — the
  // first dip is kept either way, because it seeds the suppression history.
  const place =
    severity === 'overdraft'
      ? `${money} into your £${limit.toFixed(2).replace(/\.00$/, '')} overdraft`
      : limit > 0
        ? `${money} short, even with your £${limit.toFixed(2).replace(/\.00$/, '')} overdraft`
        : `${money} short`

  // 🚨 "…despite £100 due in on 23 September". Money that landed before the dip
  // is already inside `place`'s figure; saying so is what stops the alert
  // reading as "nothing is coming" when something came and fell short.
  const m = shortfall.moneyInBefore
  const despite = m
    ? m.date
      ? `, despite £${m.amount.toFixed(2)} due in on ${formatDayMonth(m.date)}`
      : `, despite £${m.amount.toFixed(2)} due in before then`
    : ''

  const cause =
    causes.length === 1
      ? `${causes[0].label} (£${causes[0].amount.toFixed(2)}) on ${on} ${severity === 'overdraft' ? 'takes' : 'leaves'} you ${place}${despite}.`
      : causes.length > 1
        ? `${causes.length} payments totalling £${total(causes).toFixed(2)} on ${on} ${severity === 'overdraft' ? 'take' : 'leave'} you ${place}${despite}.`
        : `You'll be ${place} on ${on}${despite}.`

  // 🚨 "You're fine" is carried by the ABSENCE of the middle shape. Weaker
  // than an explicit "back above zero", and a deliberate trade for brevity —
  // so the middle shape must keep appearing whenever the money does not cover
  // it, because it is the only thing distinguishing the two.
  const relief = shortfall.recoversOn
    ? `Next scheduled money in on ${formatDayMonth(shortfall.recoversOn)}.`
    : shortfall.nextMoneyIn
      ? `£${shortfall.nextMoneyIn.amount.toFixed(2)} in on ${formatDayMonth(shortfall.nextMoneyIn.date)}, but you'll still be short after that.`
      : despite
        ? // "more" would contradict the clause that just named some.
          `Nothing else due in.`
        : `Nothing more due in.`

  // 🚨 NO DATE ON THAT LAST LINE, EVER (Adam, 2026-09-23). It used to end "…before 7 October",
  // which was the primary person's cycle end — a boundary, not an event. Adam read it as a payment
  // date and checked what was due that day: an outgoing bill, and nothing coming in. A date here is
  // only honest if something happens on it, and by definition nothing does — this branch is the one
  // where the unbounded search found NOTHING, as far ahead as the ledger goes.

  return {
    // The TITLE carries the severity; the body's structure does not. The
    // second one states the problem outright (Adam, 2026-09-22: "the
    // labelling should be clear here, you don't have enough money").
    title: severity === 'overdraft' ? `${possessive(account)} runs short` : `${possessive(account)}: not enough money`,
    body: `${cause} ${relief}`,
  }
}

const total = (causes: { amount: number }[]) => Math.round(causes.reduce((sum, c) => sum + c.amount, 0) * 100) / 100

/**
 * "Adam's account", "Car Fund", "Your joint account".
 *
 * The joint account is the only one that needs this: its stored name is lower-case prose ("the
 * joint account") because it reads correctly mid-sentence, and a notification TITLE is neither
 * mid-sentence nor lower-case.
 */
function possessive(account: WatchedAccount): string {
  return account.kind === 'joint' ? 'Your joint account' : account.name
}

/**
 * Has this account's CLEARED balance reached £0 or above at any point since `sinceIso`?
 *
 * 🚨 This is the whole of PROMPT-15's Sunday suppression (§0 Q8). Adam: *"if a user was in
 * overdraft at the last notification, and they haven't come out of it since last week, then the
 * notification should not fire the second week."* It makes the heads-up **self-clearing**: quiet
 * for someone who lives in their overdraft, talking again the moment their situation changes.
 *
 * It asks about the **cleared** balance — what actually happened — not about the projection. The
 * alert asks a question about a forecast, but *"have you been in your overdraft all week?"* is a
 * question about reality, and answering it from the alert's own prior output would be circular.
 *
 * 🚨 The known quirk, accepted knowingly (§0 Q8): paid in and straight back out on the same day
 * counts as having come out. That is the safe direction — it errs towards telling you.
 *
 * 🚨 When it cannot tell, it returns TRUE (= came out = do not suppress). Silence is the failure
 * that matters here; a duplicate heads-up is not.
 *
 * It reuses `accountWalk`'s transaction list rather than re-deriving which rows belong to this
 * account — that scoping exists once, and a second copy would drift. `buildDailyBalanceSeries`
 * folds from the opening balance regardless of which days are reported, so a window starting at
 * `sinceIso` still counts everything before it.
 */
export function cameOutOfOverdraftSince(data: AppDataV2, account: WatchedAccount, sinceIso: string, asOfDate: Date): boolean {
  const c = accountWalk(data, account, asOfDate)
  if (!c) return true
  const todayIso = toIso(asOfDate)
  if (sinceIso >= todayIso) return false // told today; nothing has had time to change
  const days = daysBetweenInclusive(parseLocalDate(sinceIso), asOfDate)
  const series = buildDailyBalanceSeries(c.openingBalance, c.transactions, days, c.sign, c.include)
  return series.some((p) => p.date > sinceIso && p.clearedBalance >= 0)
}

/** Sunday, in London. The overdraft heads-up fires weekly; the out-of-money alert is nightly (§0 Q7). */
export function isSunday(londonDate: string): boolean {
  // Noon UTC so no offset can move it across midnight.
  return new Date(`${londonDate}T12:00:00Z`).getUTCDay() === 0
}

/**
 * The dedupe key a shortfall claims before anything is sent.
 *
 * 🚨 THE DATE IS LOAD-BEARING. Listly's keys are event-shaped and carry no date, and they are the
 * worked example being copied — so leaving it out here is the likely mistake. Without it the alert
 * fires once and never again, which kills §0b Q4's "every evening until it clears" outright.
 *
 * 🚨 THE SEVERITY IS LOAD-BEARING TOO, and for a different reason (PROMPT-15 §0 Q7). It is NOT
 * needed for deduping — the date already does that. It is needed so the Sunday suppression can
 * find *the last **overdraft** alert for this account*, which it cannot if both severities share a
 * key shape. I ruled this out once as machinery for an impossible case; the suppression made it
 * necessary.
 *
 * `londonDate` is the date in Europe/London, not UTC: a key built from the UTC date would change
 * day at the wrong moment for half the year.
 */
export function shortfallDedupeKey(shortfall: Shortfall, personId: string, londonDate: string): string {
  return `shortfall:${shortfall.severity}:${shortfall.account.kind}:${shortfall.account.id}:${personId}:${londonDate}`
}
