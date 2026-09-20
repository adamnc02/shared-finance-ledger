// PROMPT-13 Part B — round-ups, and the Coin Jar they fund.
//
// Every rounded-up penny from ad-hoc card spending lands in a pot called
// Coin Jar. A £7.50 shop reads −£8.00 in the personal ledger and +£0.50
// in Coin Jar. £7.50 leaves net worth; 50p moves.
//
// This file owns the RULES — what rounds, to what, and when. The Coin
// Jar's BALANCE is derived in potLedger.ts from the rows this file
// produced. Nothing here writes a second transaction; see
// `Transaction.roundedFrom` in types/ledger.ts for why.
//
// 🚨 The uplift must never reach the personal cash balance. `amount` on a
// rounded expense is ALREADY the rounded figure, so every existing reader
// is correct untouched — the danger is a well-meaning addition, not an
// omission. `verify-coin-jar-balance.ts` pins it.

import type { PayCycleConfig, Pot, Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100

/** The fixed, non-negotiable name of the round-up destination pot (B4). One per person. */
export const COIN_JAR_NAME = 'Coin Jar'

/**
 * What an amount rounds UP to: the next whole pound.
 *
 * `Math.ceil` on an exact pound returns that same pound, which is what
 * gives B1's "an exact £ transaction does not get rounded" for free —
 * £8.00 stays £8.00 and the uplift is zero, so `shouldRoundUp` below
 * rejects it. Adam: "correct, exact £ transactions do not get rounded."
 *
 * The `round2` first is load-bearing against float noise: a stored 7.5
 * that arrived as 7.500000000000001 must not round to £9.
 */
export function roundUpTarget(amount: number): number {
  return Math.ceil(round2(amount))
}

/** The uplift a given amount would contribute to the Coin Jar. Zero for an exact pound. */
export function roundUpUplift(amount: number): number {
  return round2(roundUpTarget(amount) - round2(amount))
}

/**
 * Whether round-ups were switched ON for this person on a given date.
 *
 * Mirrors `paydaysForMonth`'s walk over `paydayHistory` (salaryLedger.ts
 * ~402) deliberately, because the two histories have the same shape and
 * the same hazards: a rule governs from the previous rule's
 * `nextRuleFrom` up to, but not including, its own `until`.
 *
 * A date BEFORE the earliest rule is not enabled. That is what makes
 * "turning it on never reaches back and changes an existing row" (B3)
 * true by construction rather than by remembering to check.
 */
export function roundUpEnabledOn(payCycle: PayCycleConfig | undefined, dateIso: string): boolean {
  if (!payCycle) return false
  const history = payCycle.roundUpHistory ?? []
  const rules: { enabled: boolean; from: string | null; until: string | null }[] = []
  let from: string | null = null
  for (const h of history) {
    // `h.from` over the chained `from`: a history entry knows its own
    // start, and the earliest one MUST NOT default to the beginning of
    // time. See the field's comment in types/ledger.ts — without this,
    // switching rounding off would declare it to have been on for every
    // date before it existed.
    rules.push({ enabled: h.enabled, from: h.from ?? from, until: h.until })
    from = h.nextRuleFrom
  }
  // The current rule runs from whenever it took effect. With no history
  // and no effective-from, an enabled switch has no start date at all —
  // treated as never enabled rather than always, because B4 makes
  // effective-from REQUIRED, so the absent case is malformed data and the
  // safe reading of malformed data is "do not round".
  const currentFrom = payCycle.roundUpEffectiveFrom ?? from
  rules.push({ enabled: (payCycle.roundUpEnabled ?? false) && currentFrom !== null, from: currentFrom, until: null })

  for (const rule of rules) {
    const startsOk = rule.from === null || dateIso >= rule.from
    const endsOk = rule.until === null || dateIso < rule.until
    if (startsOk && endsOk) return rule.enabled
  }
  return false
}

/**
 * B1's predicate, in full. Every clause has its own assertion in
 * `verify-round-up-predicate.ts`, with a control that proves it is doing
 * work.
 *
 *     t.type === 'expense' && t.paymentMethod === 'card' && t.location === 'personal'
 *
 * Adam, 2026-09-20: "Card expenses only." So NOT cash, NOT bank transfer,
 * and not a bill, loan payment, credit-card payment, credit-card spend,
 * transfer, salary or income — nor anything located in a pot or the joint
 * account.
 *
 * The fourth clause, `!t.creditCardId`, is this session's own addition
 * (prompt doc §0c assumption 1) and cannot change behaviour for a
 * correctly-created row: a charge to a credit card is `type:
 * 'credit_card_spend'`, never an expense (Expenses.tsx ~464 routes it
 * through `logCreditCardSpend`). It is here because the EDIT path
 * (~949) can still attach a `creditCardId`, and a credit-card charge is
 * not money leaving the current account, so rounding it would credit the
 * Coin Jar against cash that never moved.
 */
export function shouldRoundUp(
  t: Pick<Transaction, 'type' | 'paymentMethod' | 'location' | 'date' | 'creditCardId' | 'roundUpSkipped'> & { amount: number },
  payCycle: PayCycleConfig | undefined,
): boolean {
  // PROMPT-13 B1a — the per-transaction override, checked first because it
  // beats every other clause: the person has said "not this one".
  if (t.roundUpSkipped) return false
  if (t.type !== 'expense') return false
  if (t.paymentMethod !== 'card') return false
  if (t.location !== 'personal') return false
  if (t.creditCardId) return false
  if (!roundUpEnabledOn(payCycle, t.date)) return false
  // An exact pound contributes nothing, so it is not "rounded" at all —
  // it must not be marked with a roundedFrom equal to its own amount,
  // which would put a £0.00 row on the Coin Jar's ledger.
  return roundUpUplift(t.amount) > 0
}

/**
 * The fields a transaction carries as a result of rounding — or the
 * fields that CLEAR it, when it no longer qualifies.
 *
 * `amount` in, and out, is always the REAL PRICE — what was actually
 * spent (£7.50), not what is stored. Callers hold the price the person
 * typed; this returns what to store.
 *
 * B3: "Editing recomputes." £7.50 → £9.20 becomes £10.00 with an 80p
 * uplift. Adam: "if I have to amend a transaction, it's because I got the
 * price wrong, but my banking app would have handled it correctly." So an
 * edit runs through here again from the real price, which is why the edit
 * form seeds its amount field with `roundedFrom ?? amount` — the person
 * corrects the PRICE, not the rounded figure.
 *
 * The explicit `undefined`s in the negative case matter: they must
 * overwrite a previously-set `roundedFrom`/`roundingPotId` on an edit
 * that stops qualifying (the location changed to a pot, say), not be
 * omitted and leave the old pair in place crediting a jar forever.
 */
export function roundUpFields(
  t: Pick<Transaction, 'type' | 'paymentMethod' | 'location' | 'date' | 'creditCardId' | 'roundUpSkipped'> & { amount: number },
  payCycle: PayCycleConfig | undefined,
  coinJarId: string | undefined,
): { amount: number; roundedFrom: number | undefined; roundingPotId: string | undefined } {
  const price = round2(t.amount)
  if (!coinJarId || !shouldRoundUp({ ...t, amount: price }, payCycle)) {
    return { amount: price, roundedFrom: undefined, roundingPotId: undefined }
  }
  return { amount: roundUpTarget(price), roundedFrom: price, roundingPotId: coinJarId }
}

/**
 * PROMPT-13 B1a — whether the per-transaction "don't round this one"
 * control should be OFFERED for a row at all.
 *
 * Adam, 2026-09-20: *"the per transaction level ability to ignore rounding
 * ONLY if the coin jar exists... an editable field in the transaction form
 * if it's card, personal and expense, and also... a new step in the picker
 * flow - if it's card, personal and expense."*
 *
 * So: a jar exists, rounding is on for that row's own date, and the row is
 * the shape that would otherwise round. Deliberately **not** gated on the
 * amount — an exact pound still shows the control rather than having it
 * appear and vanish as the figure is typed; callers that have nothing to
 * ask (the wizard, where the amount is already fixed) check the uplift
 * themselves.
 *
 * `roundUpSkipped` is deliberately NOT consulted: a row that has opted out
 * must still offer the control, or there would be no way to opt back in.
 */
export function roundUpAvailable(
  t: Pick<Transaction, 'type' | 'paymentMethod' | 'location' | 'date' | 'creditCardId'>,
  payCycle: PayCycleConfig | undefined,
  coinJarId: string | undefined,
): boolean {
  if (!coinJarId) return false
  if (t.type !== 'expense') return false
  if (t.paymentMethod !== 'card') return false
  if (t.location !== 'personal') return false
  if (t.creditCardId) return false
  return roundUpEnabledOn(payCycle, t.date)
}

/**
 * The real price behind a stored row — what the edit form should show,
 * and what any "what did this actually cost" read wants.
 * `amount` for an ordinary row, `roundedFrom` for a rounded one.
 */
export function unroundedAmount(t: Pick<Transaction, 'amount' | 'roundedFrom'>): number {
  return t.roundedFrom ?? t.amount
}

/** The uplift a stored row contributes to its Coin Jar. Zero for everything that was not rounded. */
export function storedUplift(t: Pick<Transaction, 'amount' | 'roundedFrom' | 'roundingPotId'>): number {
  if (t.roundedFrom === undefined || !t.roundingPotId) return 0
  return round2(t.amount - t.roundedFrom)
}

/** That person's Coin Jar, if they have one. One per person (B4). */
export function findCoinJar(pots: Pot[], personId: string): Pot | undefined {
  return pots.find((p) => p.isCoinJar && p.personId === personId)
}

/**
 * The Coin Jar an expense's uplift should feed, at the moment it is
 * logged: the jar belonging to the row's OWNER.
 *
 * §0b Q5 (Adam, 2026-09-20): in a two-person household a personal card
 * expense owned by Ella rounds into ELLA's Coin Jar, and only if Ella
 * herself has round-ups on. Her switch and her jar; there is no
 * household-wide jar. That is why the pay cycle looked up alongside this
 * must be the OWNER's, not the primary person's.
 */
export function coinJarForOwner(pots: Pot[], ownerId: string): Pot | undefined {
  return findCoinJar(pots, ownerId)
}

/**
 * The patch for switching round-ups on or off from a chosen date (B4).
 *
 * Mirrors `changePayday`'s history handling in salaryLedger.ts (~487):
 * the rule being replaced is pushed onto the history with `until` and
 * `nextRuleFrom` set to the effective date, and any earlier rule this
 * change reaches back PAST is superseded and dropped. For a round-up
 * switch the two dates are always the same, because the change is
 * instantaneous — there is no occurrence to re-date.
 *
 * 🚨 IT RETURNS ONLY THE PAY CYCLE. No transaction is touched, ever.
 * B3, confirmed by Adam with one word ("Correct"): turning rounding on or
 * off never reaches back and rewrites an existing row, cleared or
 * pending, and turning it off leaves the jar and every past uplift
 * exactly as they are. `verify-round-up-effective-dates.ts` proves it by
 * comparing the whole transaction list before and after.
 */
export function applyRoundUpChange(
  payCycle: PayCycleConfig,
  enabled: boolean,
  effectiveFrom: string,
): Pick<PayCycleConfig, 'roundUpEnabled' | 'roundUpEffectiveFrom' | 'roundUpHistory'> {
  const superseded = (payCycle.roundUpHistory ?? []).filter((h) => h.until <= effectiveFrom && h.nextRuleFrom <= effectiveFrom)
  const previousFrom = payCycle.roundUpEffectiveFrom ?? superseded[superseded.length - 1]?.nextRuleFrom
  // A change dated at or before the current rule's own start REPLACES it
  // rather than recording it as history: there is no window for the old
  // rule to have governed, and writing a zero-width history entry would
  // leave `roundUpEnabledOn` walking a rule that can never match.
  const history =
    previousFrom !== undefined && effectiveFrom > previousFrom
      ? [...superseded, { enabled: payCycle.roundUpEnabled ?? false, from: previousFrom, until: effectiveFrom, nextRuleFrom: effectiveFrom }]
      : superseded

  return {
    roundUpEnabled: enabled,
    roundUpEffectiveFrom: effectiveFrom,
    roundUpHistory: history.length > 0 ? history : undefined,
  }
}

/**
 * The pots that may FUND something — a bill, a loan payment, a loan
 * overpayment, a credit-card payment, or ad-hoc spending.
 *
 * PROMPT-13 B5, restriction 1 and 4 of 4. A Coin Jar is a pot with
 * things taken away: money goes in from round-ups and comes out only by
 * a deliberate TRANSFER, "in and out, to any location". It never funds
 * an outgoing directly, and nothing is ever spent out of it ad hoc.
 *
 * 🚨 USE THIS FOR FUNDING PICKERS ONLY. `buildTransferLocationOptions`
 * is deliberately NOT filtered through it: transfers in and out are the
 * sanctioned way to move money to and from a jar, and a Coin Jar you
 * cannot empty would be a trap. The Wallet stack and the rebalance
 * targets are likewise unfiltered — the jar has its own card, and a
 * rebalance is a transfer by another name.
 *
 * The generators in potLedger.ts enforce the same rule independently,
 * because "a hidden picker entry is not enforcement".
 */
export function fundablePots(pots: Pot[]): Pot[] {
  return pots.filter((p) => !p.isCoinJar)
}
