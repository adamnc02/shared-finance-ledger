// Automatic clearing — there is NO tap-to-clear anywhere in the app.
// The moment "today" reaches or passes a scheduled bill/loan/credit-
// card-minimum/salary/joint-share date, it settles on its own: this
// function materializes it into a real, persisted, cleared Transaction.
// Clearing has no side effect of its own: balances are derived from the
// transactions.
//
// Two separate things come due and need settling, and both are covered:
//  1. Anything GENERATED (a scheduled bill/loan/salary/etc. occurrence
//     that only ever existed as a preview, never persisted) — this gets
//     materialized into a real transaction for the first time.
//  2. Anything ALREADY STORED but still pending whose date has now
//     arrived — e.g. a credit card lump payment or ad-hoc expense
//     logged for a future date. Nothing else in the app ever revisits
//     an already-persisted pending transaction, so without this step a
//     future-dated logged payment would stay 'pending' forever even
//     once its date passed — no side effect (like reducing a card's
//     balance) would ever apply, and it would never move into the
//     Cleared section on its own. This is exactly what step 2 fixes.
//
// Pure and idempotent: returns the SAME `data` reference, unchanged,
// when there's nothing new to settle. That's what lets the caller run
// this on every data load/change via a plain reference-equality check
// without risking an infinite update loop — once everything due has been
// settled, a second pass finds nothing left to do and is a no-op.

import { nanoid } from 'nanoid'
import { generateTransactionsForTemplate, resolveOccurrenceAmount, resolveTemplateOccurrenceDate } from './schedule'
import { generateLoanPaymentTransactions, resolveRecurringOverpaymentSource } from './ledgerLoans'
import { generateMinimumPaymentTransactions } from './creditCards'
import { computeNetPayForPeriod, generateSalaryTransactions } from './salaryLedger'
import { resolvePensionOccurrenceAmount, generatePensionTransactions } from './pensionLedger'
import { generateSavingsDepositTransactions, generateSavingsInterestTransactions, generateSavingsWithdrawalTransactions, resolveSavingsPotDepositOccurrenceAmount } from './savingsPotLedger'
import { generatePotDepositTransactions, generatePotOutgoingTransactions, resolvePotDepositOccurrenceAmount } from './potLedger'
import { dedupeKey } from './projection'
import { toLocalIsoDate, parseLocalDate } from './date'
import type { AppDataV2, Transaction } from '../types/ledger'

/**
 * Keeps an ALREADY-MATERIALIZED salary transaction's amount in step with
 * what that pay period's net pay currently computes to.
 *
 * Confirmed as a real gap, not a hypothetical one. Once a payday's date
 * arrives, step 2 below materializes it into a stored, cleared
 * Transaction. From that moment on its dedupeKey suppresses regeneration
 * forever — so attaching a bonus to that period, or correcting the
 * salary it was computed from, changed the figure on the Salary page but
 * left the Home page's balance and ledger showing the old amount, with
 * nothing to indicate the two had diverged. Nothing in the app revisited
 * a stored salary row.
 *
 * Safe to do unconditionally because a salary transaction's amount is
 * fully DERIVED — SalaryOverride is the app's designed and only intended
 * route for "this period's pay was actually £X" (see its comment in
 * types/ledger.ts), so there's no hand-entered value here to trample.
 * Idempotent: once every row agrees with its computed figure, this finds
 * nothing to change and returns the input untouched.
 */
function reconcileSalaryTransactions(data: AppDataV2): AppDataV2 {
  let changed = false
  const transactions = data.transactions.map((t) => {
    if (t.type !== 'salary' || !t.personId) return t
    const person = data.people.find((p) => p.id === t.personId)
    if (!person) return t
    const netPay = computeNetPayForPeriod(person, t.date, data.payCycles.find((pc) => pc.personId === person.id))
    if (netPay === null || netPay <= 0 || netPay === t.amount) return t
    changed = true
    return { ...t, amount: netPay }
  })
  return changed ? { ...data, transactions } : data
}

/**
 * Same reconciliation as reconcileSalaryTransactions above, for
 * 'pension_income' — a materialized transaction's amount can drift from
 * what pensionLedger.ts now computes for that date, the same way a
 * salary transaction can: editing a pension's standing amount (with a
 * real effective-from date, per applyPensionAmountChange) or a single
 * occurrence's override after that date has already cleared. Keyed on
 * sourceId (the specific Pension), not just personId, since one person
 * can own several pensions.
 *
 * UAT 2026-09-10 (mup-samedate-pension) — this used to call the STANDING
 * resolver (`resolvePensionAmount`), which ignores `occurrenceOverrides`
 * entirely — the exact bug class `resolveOccurrenceAmount`/
 * `resolvePensionOccurrenceAmount` fixed for the DISPLAY side on
 * 2026-09-09/2026-09-10, just never applied to this reconciler. Confirmed
 * as a real, actively-destructive gap, not just a missed enhancement: the
 * moment this session's new `applyPensionSingleOccurrenceAmountChange`
 * writes an override for an already-materialized date, the very next
 * autoClear pass (which runs on every data load/change) would recompute
 * this row from the STANDING amount and silently stamp the just-made
 * single-occurrence edit back to the old value — worse than simply never
 * reconciling, since it actively undoes a successful, confirmed edit.
 * Switched to `resolvePensionOccurrenceAmount`, which checks
 * `occurrenceOverrides` first and only falls back to the standing
 * resolver when there isn't one — matching every other reconciler above.
 */
function reconcilePensionTransactions(data: AppDataV2): AppDataV2 {
  let changed = false
  const transactions = data.transactions.map((t) => {
    if (t.type !== 'pension_income' || !t.sourceId) return t
    const pension = data.pensions.find((p) => p.id === t.sourceId)
    if (!pension) return t
    const override = pension.occurrenceOverrides?.find((o) => o.originalDate === t.date)
    if (override?.deleted) return t
    const amount = resolvePensionOccurrenceAmount(pension, t.date)
    if (amount <= 0 || amount === t.amount) return t
    changed = true
    return { ...t, amount }
  })
  return changed ? { ...data, transactions } : data
}

/**
 * Same reconciliation as reconcileSalaryTransactions/reconcilePensionTransactions
 * above, for anything sourced from a RecurringTemplate (bills, recurring
 * transactions, recurring transfers) — confirmed as the SAME gap, newly
 * exposed rather than introduced by the 2026-09-09 unified effective-
 * dating work (UAT ed-bills-all-future/ed-recurring-tx-unchanged): once an
 * occurrence's date arrives, Step 2 below materializes it into a stored,
 * cleared Transaction, and its dedupeKey then suppresses ever regenerating
 * it — so a SECOND same-day edit (e.g. bumping an amount up then back
 * down again before the day is over) left the already-materialized row
 * showing the stale intermediate value forever, with nothing to indicate
 * it had drifted from what the template now resolves to. Safe
 * unconditionally, same reasoning as the salary/pension cases: confirmed
 * there is no UI path anywhere in the app to hand-edit a materialized
 * Transaction's amount when its sourceType is 'recurring_template' — only
 * the owning template itself is ever editable, so there's no hand-entered
 * figure here to trample. 2026-09-14: reconciles `date` the same way, for
 * the same reason — see this function's own comment on the date fix.
 *
 * 2026-09-16 (Adam-reported in UAT, all three surfaces): reconciles
 * `status` too. Step 1 below only ever moves a row pending -> cleared
 * when its date arrives; nothing did the reverse, so moving an
 * already-cleared occurrence's date into the FUTURE left it counting as
 * cleared money that had supposedly already left the account, on a date
 * that has not happened yet. Repro: new bill due yesterday (clears), move
 * it to today (fine), move it to tomorrow (still cleared, still in the
 * cleared balance).
 *
 * Safe because a `recurring_template` row's cleared status is never
 * hand-set: there is no "mark as cleared" path anywhere in the app —
 * autoClearDuePayments is the only thing that clears anything — so for
 * these rows `cleared` can only ever have meant "its date was on or
 * before today". A cleared row dated in the future is therefore always
 * wrong, whatever moved it there, which is why this corrects the state
 * rather than only the transition: a row already stranded by this bug
 * self-heals on the next load, with no migration. The pending -> cleared
 * direction deliberately stays with Step 1, which runs after every
 * reconciler and already handles a date moved back into the past.
 *
 * No side effect needs unwinding: clearing has none. Savings-pot and
 * credit-card balances are derived from the transactions themselves, so
 * flipping the status back to pending is the whole of the correction.
 */
function reconcileRecurringTemplateTransactions(data: AppDataV2, asOfIso: string): AppDataV2 {
  let changed = false
  const transactions = data.transactions.map((t) => {
    if (t.sourceType !== 'recurring_template' || !t.sourceId) return t
    const template = data.recurringTemplates.find((tpl) => tpl.id === t.sourceId)
    if (!template) return t
    // WHICH occurrence this row is. 2026-09-16 (Adam-reported, single-
    // occurrence date move) — this used to be derived purely from the
    // row's CURRENT date, matching either end of a single move
    // (`o.originalDate === t.date || o.date === t.date`), with a comment
    // claiming that made the match idempotent "regardless of which side
    // of a date move this runs on". It is idempotent for exactly ONE
    // move. Move the same occurrence twice (1 Jul -> 5 Jul -> 9 Jul) and
    // the row sits at 5 Jul while the override reads
    // {originalDate: 1 Jul, date: 9 Jul} — neither branch matches,
    // because the intermediate date is recorded nowhere. The row was
    // then stranded forever AND the generator re-materialized the same
    // occurrence at 9 Jul (dedupeKey is keyed on the date too), leaving
    // two cleared rows both counting against the balance. Confirmed for
    // bills, recurring transactions AND recurring transfers — one shared
    // generator, one shared bug. Moving back to the original date
    // duplicated as well, so "undo it" was not a workaround either.
    //
    // The slot now comes from the row's own stamp when it has one, so it
    // survives any number of moves. The date match is kept ONLY to
    // derive the slot for a row materialized before that field existed —
    // such a row can by definition only have been through the one-move
    // case the old code handled, so this reads it correctly — and that
    // row is then stamped below so it never needs deriving again.
    const slot = t.occurrenceOriginalDate ?? template.occurrenceOverrides?.find((o) => o.originalDate === t.date || o.date === t.date)?.originalDate ?? t.date
    // A slot before the anchor belongs to an earlier schedule: after a change
    // from a chosen payment (applyTemplateScheduleChange) the anchor IS that
    // payment. The current rules — a new day, frequency, or follows-payday
    // setting — must not re-date or re-price what was actually paid before it.
    if (slot < template.anchorDate) return stamp(t, slot)
    const override = template.occurrenceOverrides?.find((o) => o.originalDate === slot)
    // A deleted occurrence has no live amount/date to reconcile against —
    // that already-materialized row is a separate, pre-existing gap
    // (deleting a future occurrence doesn't retroactively un-clear a past
    // one), not this fix's concern.
    //
    // Still stamped on the way out when it's missing, so a paused
    // occurrence that is later unpaused is already slot-identified
    // rather than falling back to the date derivation again.
    if (override?.deleted) return stamp(t, slot)
    const amount = override?.amount !== undefined ? override.amount : resolveOccurrenceAmount(template, slot)
    // 2026-09-14 (Adam-reported, joint account bill date change) — this
    // used to only reconcile amount, never date. A per-occurrence date
    // move (applyTemplateSingleOccurrenceDateChange) correctly redirected
    // every NOT-YET-materialized occurrence (walkOccurrences reads the
    // override directly), but an occurrence already materialized into a
    // real, stored Transaction (pending OR cleared) kept its stale .date
    // forever — so it never moved on the Home page ledger list, and Step
    // 1's `t.date > asOfIso` cleared-status check kept comparing against
    // the old date, silently never clearing a bill whose payment date had
    // actually moved to today-or-earlier. Now reconciles both fields in
    // one pass, same "materialized rows are never hand-edited, so this is
    // always safe" reasoning the amount fix already relied on.
    // 2026-09-16 — resolved exactly as the generator resolves it
    // (resolveTemplateOccurrenceDate). This used to be the raw slot/override
    // date, so a follows-payday or follows-cycle-start transfer's stored row
    // (dated on the payday) was moved back to its unadjusted slot on the next
    // load; the generator then no longer found a row on the payday and
    // materialised it again. Every load after payday added another copy
    // (Adam's Bills/Joint/Savings Deposits, from 30 Sep 2026).
    const payCycle = data.payCycles.find((pc) => pc.personId === template.ownerId) ?? data.payCycles.find((pc) => pc.personId === data.primaryPersonId)
    const date = resolveTemplateOccurrenceDate(override?.date ?? slot, template, payCycle)
    // See this function's comment: a generated row dated in the future
    // can never legitimately be cleared. Checked against the resolved
    // `date`, not `t.date`, so the move and the un-clear land in the same
    // pass — and checked as STATE rather than as a transition, so a row
    // already stranded by this bug is corrected even on a pass where its
    // date doesn't change.
    const status: Transaction['status'] = t.status === 'cleared' && date > asOfIso ? 'pending' : t.status
    if (amount <= 0) return stamp(t, slot)
    if (amount === t.amount && date === t.date && status === t.status) return stamp(t, slot)
    changed = true
    return { ...stamp(t, slot), amount, date, status }
  })
  return changed ? { ...data, transactions } : data

  /**
   * Backfills Transaction.occurrenceOriginalDate onto a row that predates
   * the field, using the slot derived above. Deliberately done here on
   * first sight rather than in migrateLedgerData: this reconciler is the
   * one place that already has the owning template to hand, it runs on
   * every load before anything is materialized, and it only ever ADDS a
   * field — no date, amount or status is touched, so it can't disturb an
   * already-cleared row (APP-KNOWLEDGE.md §1.1). Idempotent: once stamped,
   * this returns the row untouched forever after.
   */
  function stamp(t: Transaction, slot: string): Transaction {
    if (t.occurrenceOriginalDate === slot) return t
    changed = true
    return { ...t, occurrenceOriginalDate: slot }
  }
}

/**
 * Same reconciliation, for Loan-sourced transactions ('loan' — the
 * regular scheduled payment — and 'loan_recurring_overpayment'). Reuses
 * generateLoanPaymentTransactions directly (rather than re-deriving the
 * schedule-walk/real-date logic here) so this can never drift from
 * whatever that function actually generates — cached per loan since a
 * loan with many materialized rows would otherwise rebuild the same full
 * schedule once per row. Confirmed no hand-edit path exists for either
 * sourceType (only 'loan_overpayment'/'loan_settlement' — genuinely
 * hand-logged one-off events — are ever independently editable), so this
 * is safe unconditionally, same as the template/salary/pension cases.
 */
function reconcileLoanTransactions(data: AppDataV2): AppDataV2 {
  let changed = false
  const candidatesByLoan = new Map<string, Omit<Transaction, 'id'>[]>()
  const farFuture = new Date()
  farFuture.setFullYear(farFuture.getFullYear() + 60)
  const transactions = data.transactions.map((t) => {
    if ((t.sourceType !== 'loan' && t.sourceType !== 'loan_recurring_overpayment') || !t.sourceId) return t
    const loan = data.loans.find((l) => l.id === t.sourceId)
    if (!loan) return t
    let candidates = candidatesByLoan.get(loan.id)
    if (!candidates) {
      candidates = generateLoanPaymentTransactions(loan, new Date(0), farFuture)
      candidatesByLoan.set(loan.id, candidates)
    }
    const match = candidates.find((c) => c.sourceType === t.sourceType && c.date === t.date)
    if (!match || match.amount <= 0 || match.amount === t.amount) return t
    changed = true
    return { ...t, amount: match.amount }
  })
  return changed ? { ...data, transactions } : data
}

/**
 * Same reconciliation as reconcileRecurringTemplateTransactions above, for
 * a SavingsPot's own legacy recurring-deposit mechanism (`type:
 * 'savings_deposit'`, `sourceType: 'savings_pot'`, generated by
 * walkDepositOccurrences off `recurringDepositAmount`/`recurringDepositOverrides`
 * — NOT a `kind: 'transfer'` RecurringTemplate deposit, which already goes
 * through reconcileRecurringTemplateTransactions instead).
 *
 * UAT 2026-09-10 (mup-samedate-savingspot) — confirmed as a real, live gap
 * while retesting this session's brand-new
 * `applySavingsPotSingleDepositAmountChange`: editing an already-
 * materialized (cleared) deposit's single-occurrence amount via the new
 * "Manage upcoming payments" inline row editor wrote the override
 * correctly, but the stored Transaction it was supposed to correct never
 * moved — nothing revisited it, the exact same "stale materialized
 * amount" gap the 2026-09-09 session fixed for salary/pension/recurring-
 * template/loan, just never extended to Pot/SavingsPot when they gained
 * their own single-occurrence write path today. Filtered on `type ===
 * 'savings_deposit'` (not just `sourceType === 'savings_pot'`) since
 * `savings_interest` also uses this sourceType for a generated credit —
 * this reconciler has no business touching that.
 *
 * Deliberately narrower than reconcileRecurringTemplateTransactions/
 * reconcilePensionTransactions: those two entities have a real historized
 * standing-amount change (amountEffectiveFrom/amountHistory), so a
 * materialized row correctly repaints from a plain STANDING change too,
 * not just an explicit override. Pot/SavingsPot's `recurringDepositAmount`
 * has no such history — it's a flat "whatever it is right now" field —
 * and verify-savings-pots.ts's own 2026-09-02 regression test
 * ("Changing the standing rate afterward does NOT repaint the already-
 * materialized January deposit") already established, and Adam already
 * confirmed, that a plain standing-rate change must NOT retroactively
 * rewrite an already-cleared deposit. Only an EXPLICIT single-occurrence
 * override (`.amount !== undefined` for this exact date) is reconciled
 * here — the one write path this session actually added, and the one
 * this fix is for — leaving the pre-existing "materialized is otherwise
 * permanent" behaviour completely untouched.
 */
function reconcileSavingsPotTransactions(data: AppDataV2): AppDataV2 {
  let changed = false
  const transactions = data.transactions.map((t) => {
    if (t.type !== 'savings_deposit' || t.sourceType !== 'savings_pot' || !t.sourceId) return t
    const pot = data.savingsPots.find((p) => p.id === t.sourceId)
    if (!pot) return t
    const override = pot.recurringDepositOverrides?.find((o) => o.originalDate === t.date)
    if (override?.amount === undefined) return t
    const amount = resolveSavingsPotDepositOccurrenceAmount(pot, t.date)
    if (amount <= 0 || amount === t.amount) return t
    changed = true
    return { ...t, amount }
  })
  return changed ? { ...data, transactions } : data
}

/** Same as reconcileSavingsPotTransactions above, for a Pot's own legacy recurring-deposit mechanism (`type: 'pot_deposit'`, `sourceType: 'pot'`) — same "only an explicit single-occurrence override reconciles, a plain standing-rate change does not" scope, for the same reason. */
function reconcilePotTransactions(data: AppDataV2): AppDataV2 {
  let changed = false
  const transactions = data.transactions.map((t) => {
    if (t.type !== 'pot_deposit' || t.sourceType !== 'pot' || !t.sourceId) return t
    const pot = data.pots.find((p) => p.id === t.sourceId)
    if (!pot) return t
    const override = pot.recurringDepositOverrides?.find((o) => o.originalDate === t.date)
    if (override?.amount === undefined) return t
    const amount = resolvePotDepositOccurrenceAmount(pot, t.date)
    if (amount <= 0 || amount === t.amount) return t
    changed = true
    return { ...t, amount }
  })
  return changed ? { ...data, transactions } : data
}

export function autoClearDuePayments(data: AppDataV2, asOf: Date = new Date()): AppDataV2 {
  const asOfIso = toLocalIsoDate(asOf)
  let result = data
  let changed = false

  // Runs FIRST, before anything is settled: a stored salary/pension row
  // that's drifted from its computed value should be corrected whether
  // or not there's also something new coming due this pass.
  const reconciled = reconcilePotTransactions(
    reconcileSavingsPotTransactions(reconcileLoanTransactions(reconcileRecurringTemplateTransactions(reconcilePensionTransactions(reconcileSalaryTransactions(data)), asOfIso))),
  )
  if (reconciled !== data) {
    result = reconciled
    changed = true
  }

  // Step 1 — settle anything already stored that's still pending but due.
  // Applies to every pending transaction regardless of type or owner. It's
  // a status flip only: no transaction type has a clear-time side effect
  // (balances are derived from the transactions themselves).
  for (const t of result.transactions) {
    if (t.status !== 'pending' || t.date > asOfIso) continue
    const cleared: Transaction = { ...t, status: 'cleared' }
    result = { ...result, transactions: result.transactions.map((tx) => (tx.id === t.id ? cleared : tx)) }
    changed = true
  }

  // Step 2 — materialize newly-due GENERATED occurrences that have never existed as a real transaction at all.
  //
  // BUGFIX (2026-09-07, Adam-reported — "duplicate transaction after
  // moving a bill's location back and forth"): dedupeKey already uniquely
  // keys each occurrence by sourceType:sourceId:date "regardless of which
  // entities are on either end" — Step 4 below has always said so in its
  // own comment — but Steps 2 and 3 used to each build their OWN
  // existingKeys set scoped to a single location (`location === 'personal'`
  // for Step 2, `potId === pot.id` for Step 3), rather than sharing one
  // global set. That's exactly the gap this bug fell into: reassigning a
  // bill's location with an effective-from date in the PAST (on/before an
  // already-materialized occurrence) rewrites that stored transaction's
  // `location`/`potId` fields via reassignTransactionsForLocationChange,
  // but if anything about that rewrite didn't apply this pass (e.g. a
  // re-render's autoClear runs before vs. after the rewrite lands, or two
  // reassignments happen in quick succession), the existing transaction
  // could momentarily sit under a location this specific loop wasn't
  // scanning — invisible to that loop's own narrow existingKeys, so it
  // materialized a SECOND real transaction for the same occurrence,
  // rather than recognizing the first one (wherever it currently lives)
  // as already covering it. One shared `globalExistingKeys` set, built
  // once from every stored transaction regardless of location/pot/owner
  // and updated as each step materializes new ones, makes "this
  // occurrence has already been materialized" a single global fact,
  // matching the same principle Step 4's transfers already rely on,
  // rather than three independently-scoped, mutually-blind approximations
  // of it.
  const globalExistingKeys = new Set(result.transactions.map(dedupeKey).filter((k): k is string => k !== null))

  for (const person of result.people) {
    const payCycle = result.payCycles.find((pc) => pc.personId === person.id)
    if (!payCycle) continue

    const rangeStart = parseLocalDate(payCycle.openingBalanceDate)
    if (rangeStart > asOf) continue // nothing before the visibility floor is ever due

    const candidates: Omit<Transaction, 'id'>[] = []
    for (const template of result.recurringTemplates.filter((t) => t.location === 'personal' && t.ownerId === person.id)) {
      candidates.push(...generateTransactionsForTemplate(template, rangeStart, asOf, payCycle))
    }
    // UAT 2026-09-09 (ed-overpay-just-single) — also catches a POT-located
    // loan whose recurring overpayment is independently redirected to
    // 'personal' (same fix, same reasoning, as projection.ts's identical
    // loop — see that file's comment on this exact spot).
    for (const loan of result.loans.filter((l) => l.ownerId === person.id && (l.location === 'personal' || resolveRecurringOverpaymentSource(l).location === 'personal'))) {
      candidates.push(...generateLoanPaymentTransactions(loan, rangeStart, asOf).filter((t) => t.location === 'personal'))
    }
    for (const card of result.creditCards.filter((c) => c.ownerId === person.id)) {
      // Personal rows only; pot-funded ones settle in Step 3 below.
      candidates.push(...generateMinimumPaymentTransactions(card, rangeStart, asOf, result.transactions).filter((t) => t.location === 'personal'))
    }
    candidates.push(...generateSalaryTransactions(person, payCycle, rangeStart, asOf))
    for (const pension of result.pensions.filter((p) => p.personId === person.id)) {
      candidates.push(...generatePensionTransactions(pension, rangeStart, asOf))
    }
    // BUGFIX (2026-09-02, reported by Adam — "monthly deposit rate
    // changing to a number I didn't select"): recurring savings-pot
    // deposits (and their interest) were never wired into THIS
    // materialization loop at all — every other generator here (bills,
    // loans, cards, salary, pension, joint) gets promoted from a
    // synthetic preview into a real, permanent, cleared Transaction the
    // moment its date arrives; savings pot deposits never did. Since
    // nothing ever locked one in, EVERY past occurrence kept being
    // recomputed fresh, on every render, straight off the pot's CURRENT
    // standing recurringDepositAmount — so editing the amount later
    // silently repainted every already-due past deposit to the new
    // figure too, which is almost certainly what looked like "saving
    // changed a number I didn't select." Same generate-then-merge order
    // as computeProjection's equivalent fix: deposits first, then
    // interest against the combined real+just-generated activity, so
    // compounding still resolves correctly the first time a pot is
    // settled after being untouched for a while.
    for (const pot of (result.savingsPots ?? []).filter((p) => p.personId === person.id && p.active)) {
      // Same "don't double-materialize what the top-level loop above
      // already generates" reasoning as projection.ts's identical fix
      // (2026-09-04 session) — transfer-sourced deposits/withdrawals
      // feed realActivity for interest only, never pushed into
      // `candidates` a second time.
      const potDeposits = generateSavingsDepositTransactions(pot, rangeStart, asOf)
      candidates.push(...potDeposits)
      const transferDeposits = generateSavingsDepositTransactions(pot, rangeStart, asOf, result.recurringTemplates, payCycle).filter((t) => t.type === 'transfer')
      const transferWithdrawals = generateSavingsWithdrawalTransactions(pot, rangeStart, asOf, result.recurringTemplates, payCycle)
      const potRealActivity = [
        ...result.transactions,
        ...potDeposits.map((d, i) => ({ ...d, id: `generated:dep-preview:${i}` })),
        ...transferDeposits.map((d, i) => ({ ...d, id: `generated:xfer-dep-preview:${i}` })),
        ...transferWithdrawals.map((d, i) => ({ ...d, id: `generated:xfer-wd-preview:${i}` })),
      ]
      candidates.push(...generateSavingsInterestTransactions(pot, potRealActivity, rangeStart, asOf))
    }
    // Pots backlog item (2026-09-03) — a pot DEPOSIT touches personal
    // cash (see potLedger.ts's file header), so it materializes through
    // this SAME per-person candidates list/existingKeys, same as a
    // savings-pot deposit just above. A pot-funded bill/loan PAYMENT does
    // NOT belong here (it's purely internal to the pot, never touches
    // personal cash) — those are settled by their own pot-scoped pass
    // right below instead, exactly mirroring why generateSavingsInterestTransactions
    // never appears in computeProjection's personal list either.
    for (const pot of (result.pots ?? []).filter((p) => p.personId === person.id && p.active)) {
      candidates.push(...generatePotDepositTransactions(pot, rangeStart, asOf))
    }
    for (const candidate of candidates) {
      if (candidate.date > asOfIso) continue // safety net — generators are already range-bounded to asOf, but never settle a future-dated one
      const key = dedupeKey(candidate)
      if (key && globalExistingKeys.has(key)) continue // already materialized (or logged by hand) — don't duplicate, wherever it currently lives

      const real: Transaction = { ...candidate, id: nanoid(8), status: 'cleared' }
      result = { ...result, transactions: [...result.transactions, real] }
      if (key) globalExistingKeys.add(key)
      changed = true
    }

    // Step 3 — settle this person's own due pot-funded bill/loan
    // payments. Entirely separate from the candidates pass above: these
    // carry location: 'pot', not 'personal' (deliberately — see
    // potLedger.ts's file header, "purely internal to the pot") — but now
    // shares the SAME `globalExistingKeys` set as Step 2 (2026-09-07
    // bugfix, see this function's own comment above `globalExistingKeys`),
    // rather than its own independently-scoped one, so an occurrence
    // already materialized under one location can never be re-
    // materialized again under the other. Nested inside this person's own
    // iteration (rather than a separate top-level loop over every pot)
    // simply so it can reuse this person's own rangeStart/payCycle — a
    // pot always belongs to exactly one person, so there's no case where
    // it needs a different one.
    for (const pot of (result.pots ?? []).filter((p) => p.personId === person.id)) {
      const potCandidates = generatePotOutgoingTransactions(result, pot, rangeStart, asOf)

      for (const candidate of potCandidates) {
        if (candidate.date > asOfIso) continue
        const key = dedupeKey(candidate)
        if (key && globalExistingKeys.has(key)) continue

        const real: Transaction = { ...candidate, id: nanoid(8), status: 'cleared' }
        result = { ...result, transactions: [...result.transactions, real] }
        if (key) globalExistingKeys.add(key)
        changed = true
      }
    }
  }

  // Step 4 — materialize recurring TRANSFERS where NEITHER endpoint is
  // personal (e.g. Pot → Pot, Pot → Savings, Savings → Joint — 2026-09
  // UAT session, "Transfer form From location made editable"). Every
  // other recurring generator above is reached through the per-person
  // 'personal'-scoped loop, but a transfer like this never carries
  // `location: 'personal'` at all (by design — see
  // locationTypeForTransfer's own comment in transferLedger.ts), so it's
  // entirely invisible to that loop and would otherwise exist forever
  // only as a freshly-recomputed preview, never a real settled
  // Transaction. Scoped globally rather than per-person/per-pot —
  // dedupeKey already uniquely keys each occurrence by
  // sourceType:sourceId:date regardless of which entities are on either
  // end, so there's nothing to gain from scoping this any narrower.
  const nonPersonalTransferTemplates = result.recurringTemplates.filter((t) => t.kind === 'transfer' && t.active && t.location !== 'personal')
  if (nonPersonalTransferTemplates.length > 0) {
    const primaryPayCycle = result.payCycles.find((pc) => pc.personId === result.primaryPersonId)
    const transferRangeStart = primaryPayCycle ? parseLocalDate(primaryPayCycle.openingBalanceDate) : new Date(0)
    if (transferRangeStart <= asOf) {
      for (const template of nonPersonalTransferTemplates) {
        const candidates = generateTransactionsForTemplate(template, transferRangeStart, asOf, primaryPayCycle)
        for (const candidate of candidates) {
          if (candidate.date > asOfIso) continue
          const key = dedupeKey(candidate)
          if (key && globalExistingKeys.has(key)) continue

          const real: Transaction = { ...candidate, id: nanoid(8), status: 'cleared' }
          result = { ...result, transactions: [...result.transactions, real] }
          if (key) globalExistingKeys.add(key)
          changed = true
        }
      }
    }
  }

  // Step 5 — materialize joint-location bill/loan occurrences (2026-09-15
  // bugfix, Adam-reported — a joint bill re-added from scratch with a
  // single-occurrence amount override stayed 'pending' in the Joint
  // ledger past its own date). Root cause wasn't specific to that bill or
  // its override at all: every OTHER recurring generator above (personal
  // bills, pot bills, transfers) gets promoted from a preview into a
  // real, cleared Transaction the moment its date arrives — a
  // `location: 'joint'` bill/loan never did, because Step 2's per-person
  // loop only ever looks at `location === 'personal'` templates/loans and
  // Step 4 only ever looks at transfers. computeJointAccountProjection
  // (jointAccountLedger.ts) generates joint bills/loans straight off
  // generateTransactionsForTemplate/generateLoanPaymentTransactions, both
  // of which always return `status: 'pending'` — with nothing here to
  // ever flip a past-due one to 'cleared', EVERY joint-location bill/loan
  // stayed pending forever regardless of date, not just this one.
  // Scoped globally rather than per-person, since a joint-location item
  // isn't owned by any one person's pay cycle — uses the joint account's
  // own `openingBalanceDate` as the range start, the same visibility
  // floor computeJointAccountProjection itself already applies.
  if (result.jointAccount) {
    const jointBillTemplates = result.recurringTemplates.filter((t) => t.location === 'joint')
    const jointLoans = result.loans.filter((l) => l.location === 'joint' && l.active)
    if (jointBillTemplates.length > 0 || jointLoans.length > 0) {
      const jointRangeStart = parseLocalDate(result.jointAccount.openingBalanceDate)
      if (jointRangeStart <= asOf) {
        const jointCandidates: Omit<Transaction, 'id'>[] = []
        for (const template of jointBillTemplates) {
          jointCandidates.push(...generateTransactionsForTemplate(template, jointRangeStart, asOf, result.payCycles.find((pc) => pc.personId === result.primaryPersonId)))
        }
        for (const loan of jointLoans) {
          jointCandidates.push(...generateLoanPaymentTransactions(loan, jointRangeStart, asOf))
        }
        for (const candidate of jointCandidates) {
          if (candidate.date > asOfIso) continue
          const key = dedupeKey(candidate)
          if (key && globalExistingKeys.has(key)) continue

          const real: Transaction = { ...candidate, id: nanoid(8), status: 'cleared' }
          result = { ...result, transactions: [...result.transactions, real] }
          if (key) globalExistingKeys.add(key)
          changed = true
        }
      }
    }
  }

  return changed ? result : data
}
