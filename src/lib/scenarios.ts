import { addMonths, differenceInCalendarMonths } from 'date-fns'
import type { AppData, Bill, Loan, Scenario, ScenarioTargetKind } from '../types/models'
import type { CreditCard, RecurringTemplate } from '../types/ledger'
import { summarizeLoan, currentLoanMonthlyCost, estimateSettlementFigure, simulateScenarioLoan, scheduleEntryAsOf, baselineLoanSchedule, type ScenarioLoanEvent } from './loans'
import { computeMinimumPaymentAmount, simulateCardPayoffMonths } from './creditCards'
import { costForPerson } from './bills'
import { calculateNetSalary } from './tax'
import { todayIso, toLocalIsoDate, parseLocalDate } from './date'
import { resolveTemplateAmount } from './schedule'
import { monthlyEquivalentCost } from './legacyBridge'
import { savingsPotBalanceAsOf, projectedBalanceAt, projectedTargetDate } from './savingsPotLedger'
import { SAVINGS_CATEGORY_ID } from '../types/ledger'

export interface LoanImpact {
  // Despite the name (kept for minimal disruption to existing call sites),
  // this now covers BOTH loans and credit cards — targetKind says which.
  // loanId/loanName hold the target's real id/name either way.
  loanId: string
  loanName: string
  targetKind: ScenarioTargetKind
  kind: 'payoff' | 'exclude' | 'overpayment'
  originalRemaining: number
  newRemaining: number
  lumpSumApplied: number // 'payoff' only
  overpaymentPerMonth: number // 'overpayment' only
  originalMonthsRemaining: number
  newMonthsRemaining: number
  monthsSaved: number
  fullyPaidOff: boolean
  originalMonthlyCostForPerson: number
  newMonthlyCostForPerson: number
  // Loan targets only (item d) — the projected date the loan finishes
  // once every dated action against it (across the whole combined
  // scenario, not just this one) has landed, read straight off the real
  // amortisation engine. null for credit-card targets, for a loan with no
  // calibratedMonthlyRate to project from, and whenever this record's own
  // action didn't move the date at all.
  newEndDate: string | null
}

export interface SalaryChangeImpact {
  personId: string
  personName: string
  oldNetMonthly: number // actually "per pay period" — named for backward compat, see calculateNetSalary's netPerPeriod
  newNetMonthly: number
  delta: number
}

// One date's changes to a savings pot. Sections build on each other: "before"
// is everything scheduled plus the earlier sections, "after" adds this date.
export interface SavingsPotSection {
  date: string
  lumpSum: number
  withdrawal: number // capped at the pot's expected balance that day
  oldRecurringMonthlyAmount: number | null // null = no deposit change on this date
  newRecurringMonthlyAmount: number | null
  balanceOnDateBefore: number
  balanceOnDateAfter: number
  reachDateBefore: string | null // null: no target, already reached, or not within 30 years
  reachDateAfter: string | null
  monthsSaved: number // positive = sooner, negative = later
  // Only when the pot's targetDate is still ahead and not before this date.
  balanceOnTargetDateBefore: number | null
  balanceOnTargetDateAfter: number | null
  oneOffCash: number // withdrawal − lump sum
  monthlyCashChange: number // old − new monthly deposit
}

// ONE record per savings pot (Adam, 2026-09-17): the pot now, one section
// per date, and a summary of all of them against now. A pot belongs to one
// person, so these figures are the same whoever is viewing; only whether the
// monthly cash change counts toward THIS view's available cash differs (pot
// owner only, like salary_change).
export interface SavingsPotImpact {
  savingsPotId: string
  potName: string
  personId: string

  // ── Now ──
  balanceNow: number
  targetAmount: number | null
  targetDate: string | null
  currentReachDate: string | null
  // Calendar months currentReachDate falls after targetDate (negative = ahead).
  monthsBehindTarget: number | null
  targetReached: boolean

  sections: SavingsPotSection[]

  // ── All changes vs now ──
  finalReachDate: string | null
  totalMonthsSaved: number
  balanceOnTargetDateNow: number | null
  balanceOnTargetDateAfterAll: number | null
  totalOneOffCash: number
  totalMonthlyCashChange: number
}

export interface ScenarioImpact {
  oneOffCashImpact: number // one-time proceeds/costs, including any lump sum beyond what a loan/card needed
  monthlyAvailableBefore: number
  monthlyAvailableAfter: number
  monthlyImpact: number // recurring monthly change, from loans, cards, new/cancelled costs, or a salary change
  loanImpacts: LoanImpact[] // exclusions keep their own card; lump sums/overpayments are in debtImpacts
  salaryChangeImpact: SalaryChangeImpact | null
  savingsPotImpacts: SavingsPotImpact[]
  debtImpacts: DebtImpact[]
}

/** A credit card's monthly cost has no location/split concept (CreditCard.ownerId is the sole owner, always) — so unlike a loan/bill this is either the full amount or nothing, never a partial share. */
function cardMonthlyCostForPerson(card: CreditCard, amount: number, personId: string): number {
  return card.ownerId === personId ? amount : 0
}

/**
 * Calculates the effect of a scenario on a specific person's finances.
 * Handles three shapes of change:
 *  - One-off: a single point-in-time cash gain or cost
 *  - Recurring: an ongoing monthly change (new cost, cancelled cost, salary change)
 *  - Loan/credit-card-specific: paying off (fully/partially), excluding, or overpaying one
 */
export function calculateScenarioImpact(scenario: Scenario, data: AppData, personId: string, monthlyAvailableBefore: number): ScenarioImpact {
  let oneOffCashImpact = 0
  let monthlyImpact = 0
  const loanImpacts: LoanImpact[] = []
  const savingsPotImpacts: SavingsPotImpact[] = []
  const potActions = new Map<string, { pot: AppData['savingsPots'][number]; actions: DatedPotAction[] }>()
  const today = new Date()
  const todayStr = toLocalIsoDate(today)
  let salaryChangeImpact: SalaryChangeImpact | null = null

  // All keyed by `${kind}:${id}` so a loan and a credit card can never
  // collide even in the (extremely unlikely) event their generated ids
  // matched — every map/set below shares this convention.
  const exclusions = new Set<string>()
  const overpayments = new Map<string, number>()

  // Running balance per target as actions are applied in order, so a second
  // action targeting the same loan/card sees what the first one already
  // used — and so a single sale cascading through several targets in
  // priority order only spends each pound once, rather than every target
  // independently "seeing" its full original balance.
  const workingRemainingMap = new Map<string, number>()
  const lumpSumsApplied = new Map<string, number>()

  // Loan targets ONLY (item d — credit cards keep today's dateless flat
  // math, per Adam's own call on scope). Every dated pay_off_loan/
  // loan_overpayment action against a given loan lands in this ONE list,
  // keyed by loan id, so simulateScenarioLoan can run the real engine
  // once per loan with everything that hits it, in true date order — the
  // same list a second scenario specifying the same dates would build
  // regardless of which action was created first or which scenario it
  // lives in (mergeScenarios already flattens before this function ever
  // runs, so "different scenarios" and "same scenario" are already
  // indistinguishable by the time we're here).
  const loanEventsMap = new Map<string, ScenarioLoanEvent[]>()
  function addLoanEvent(loanId: string, event: ScenarioLoanEvent) {
    const list = loanEventsMap.get(loanId) ?? []
    list.push(event)
    loanEventsMap.set(loanId, list)
  }
  // The latest pay_off_loan (genuine lump-sum, not a materialized
  // recurring-overpayment occurrence) date seen per loan — kept separate
  // from loanEventsMap because "does this fully close the loan" has to be
  // judged against the real early-settlement PREMIUM as of that date
  // (estimateSettlementFigure — scope §13/handoff step 6), which the
  // schedule's own balanceAfter alone doesn't capture: a lump sum landing
  // on the loan's very first synthetic period accrues ~0 period interest
  // (zero elapsed days since the loan's own start), so relying on the
  // schedule alone would silently drop the settlement-premium check this
  // scope already fixed once.
  const lastLumpDateByLoan = new Map<string, string>()
  // BUGFIX (Adam-reported, 2026-09 session) — same idea as
  // lastLumpDateByLoan above, but for the recurring-overpayment action's
  // own start date, so its "new monthly payment"/"remaining" figures
  // below can be read off the schedule at THIS action's own date too,
  // rather than off simulateScenarioLoan's outcome-level
  // remainingAfterEvents/effectiveMonthlyPayment (anchored to the
  // chronologically LAST event across every action sharing this loan —
  // for a recurring overpayment that's always its own ~50-year-out
  // materialized tail, see loan_overpayment's own comment below). Tracks
  // the EARLIEST start date if more than one recurring-overpayment action
  // targets the same loan, since that's the date its combined effect
  // first actually changes anything.
  // CHANGED 2026-09-17 (Adam-reported): this used to track the EARLIEST
  // start date, so a loan with two recurring overpayments starting on
  // different dates (£200 from March, £250 from April) reported the payment
  // as it stands in March — £200 extra, never £450. The steady-state monthly
  // cost, which is what "impact on available cash" means, is the payment once
  // every one of them has started, so this now tracks the LATEST.
  const lastOverpaymentDateByLoan = new Map<string, string>()

  function targetKey(kind: ScenarioTargetKind, id: string): string {
    return `${kind}:${id}`
  }

  // Every dated lump sum / recurring overpayment landing on a debt, kept
  // alongside the untouched loanImpacts above purely so the card can show
  // one section per date (Adam, 2026-09-17: match the savings pot layout).
  // Recorded from INSIDE the pool cascade, so a section's lump sum is the
  // amount that target actually absorbed, not the action's raw value. A
  // credit card has no dated maths, so its actions all land on today.
  const debtActions = new Map<string, { kind: ScenarioTargetKind; id: string; actions: DebtAction[] }>()
  function recordDebtAction(kind: ScenarioTargetKind, id: string, entry: DebtAction) {
    const key = targetKey(kind, id)
    const existing = debtActions.get(key) ?? { kind, id, actions: [] }
    existing.actions.push(entry)
    debtActions.set(key, existing)
  }

  function workingRemaining(kind: ScenarioTargetKind, id: string): number {
    const key = targetKey(kind, id)
    if (!workingRemainingMap.has(key)) {
      if (kind === 'loan') {
        const loan = data.loans.find((l) => l.id === id)
        // The cap on how much of a lump sum this target can genuinely
        // absorb is the real cost to CLOSE it (loan-amortisation-engine
        // scope §6's settlement figure), not its raw remaining balance —
        // once real interest is involved, fully clearing a loan early
        // costs more than what it currently shows as owed. Capping at
        // the smaller, raw-balance figure would make a lump sum spill
        // over into "leftover one-off cash" even when it was genuinely
        // needed to close the loan out (scope §13 / handoff step 6).
        workingRemainingMap.set(key, loan ? estimateSettlementFigure(loan) : 0)
      } else {
        const card = data.creditCards.find((c) => c.id === id)
        workingRemainingMap.set(key, card ? card.currentBalance : 0)
      }
    }
    return workingRemainingMap.get(key)!
  }

  for (const action of scenario.actions) {
    if (action.type === 'sell_asset' || action.type === 'pay_off_loan') {
      const targets = resolveTargets(action)

      if (targets.length === 0) {
        // Unlinked sell_asset is just cash in hand. pay_off_loan with nothing
        // selected does nothing (the form requires a target to save it anyway).
        if (action.type === 'sell_asset') oneOffCashImpact += action.value
        continue
      }

      // Walk the targets in order, clearing each as far as this action's
      // value allows before moving to the next. A target with a manual
      // `amount` takes exactly that much (still capped to what's left in
      // the pool and what the target actually needs); one without an
      // amount auto-takes whatever's left in the pool. Whatever's left
      // after the last target is genuine one-off cash — not double-counted
      // against what any target already used.
      let pool = action.value
      for (const { kind, id, amount } of targets) {
        if (pool <= 0) break
        const remaining = workingRemaining(kind, id)
        const requested = amount != null ? amount : pool
        const applied = round2(Math.min(requested, pool, remaining))
        workingRemainingMap.set(targetKey(kind, id), round2(remaining - applied))
        const key = targetKey(kind, id)
        lumpSumsApplied.set(key, round2((lumpSumsApplied.get(key) ?? 0) + applied))
        pool = round2(pool - applied)

        // Loan targets ALSO get a real, dated event for the engine below
        // — the pool-cascade split itself still uses today's balance to
        // decide HOW MUCH goes where (unchanged), but what happens to the
        // loan afterward is now genuinely simulated from action.date, not
        // assumed to happen today.
        if (applied > 0) {
          recordDebtAction(kind, id, { date: kind === 'loan' ? action.date || todayStr : todayStr, lumpSum: applied, recastMode: action.recastMode ?? 'reduce_term', fromSale: action.type === 'sell_asset' })
          // 2026-09-17 (Adam): a pay_off_loan lump sum is money leaving your
          // own pocket, so it counts against one-off cash the same way a
          // savings pot lump sum does. A sell_asset's proceeds are not: that
          // money arrived with the sale, and only what the targets DIDN'T
          // need stays in hand (the leftover below, unchanged).
          if (action.type === 'pay_off_loan') oneOffCashImpact -= applied
        }
        if (kind === 'loan' && applied > 0) {
          const eventDate = action.date || todayIso()
          addLoanEvent(id, { date: eventDate, amount: applied, recastMode: action.recastMode ?? 'reduce_term' })
          const existing = lastLumpDateByLoan.get(id)
          if (!existing || eventDate > existing) lastLumpDateByLoan.set(id, eventDate)
        }
      }
      // Only a sale leaves cash in hand. Money earmarked for a pay_off_loan
      // that a target didn't need never left the account, so it is neither a
      // gain nor a cost (2026-09-17).
      if (action.type === 'sell_asset') oneOffCashImpact += pool
    } else if (action.type === 'purchase') {
      // Buying something is one-off cash out. The DATED view of the same purchase (what the
      // balance will be on the day, and at the end of that cycle) is
      // computed separately in lib/purchaseImpact.ts — this file has no
      // calendar, by design. Counting it here as well is not a
      // double-count: the two answer different questions and are shown as
      // separate figures.
      oneOffCashImpact -= action.value
    } else if (action.type === 'new_bill' || action.type === 'new_finance_agreement') {
      // Both are ongoing monthly costs — a simple new bill, or a finance
      // agreement's computed monthly payment. Not one-off, and only counts
      // toward this person's available cash based on its location/split,
      // same as a real bill would.
      const virtualBill: Bill = {
        id: `action:${action.id}`,
        name: action.name || (action.type === 'new_finance_agreement' ? 'New finance agreement' : 'New bill'),
        cost: action.value,
        dueDay: 1,
        location: action.location ?? 'personal',
        ownerId: action.ownerId ?? personId,
        payee: action.payee ?? personId,
        payeeSharePercent: action.payeeSharePercent ?? 100,
        category: 'Scenario',
        isStandingOrder: true,
      }
      monthlyImpact -= costForPerson(virtualBill, personId, data.people)
    } else if (action.type === 'exclude_loan') {
      const target = resolveTargets(action)[0]
      if (target) exclusions.add(targetKey(target.kind, target.id))
    } else if (action.type === 'loan_overpayment') {
      const target = resolveTargets(action)[0]
      if (target) {
        const key = targetKey(target.kind, target.id)
        overpayments.set(key, (overpayments.get(key) ?? 0) + action.value)
        if (action.value > 0) recordDebtAction(target.kind, target.id, { date: target.kind === 'loan' ? action.date || todayStr : todayStr, overpayment: action.value })

        // Loan targets: also materialize this as a monthly SERIES of real
        // dated events (recastMode always 'reduce_term' — a recurring
        // overpayment never gets the reduce-monthly choice, see the
        // field's own doc comment in types/models.ts) rather than trying
        // to fit it into the real ledger Loan's single recurringOverpayment
        // slot — that slot can't represent two independent recurring
        // actions landing on the same loan with different start dates, and
        // a combined scenario can genuinely produce that. A materialized
        // series has no such limit: any number of them combine correctly
        // through the exact same one-off-overpayment mechanism the lump
        // sums above already use. Generated out to the synthetic loan's
        // own 600-month safety cap (toSyntheticLedgerLoan) — harmless
        // either way, since buildLoanSchedule's own loop stops consuming
        // events the moment the balance actually reaches zero.
        if (target.kind === 'loan' && action.value > 0) {
          const startDate = action.date || todayIso()
          const existingStart = lastOverpaymentDateByLoan.get(target.id)
          if (!existingStart || startDate > existingStart) lastOverpaymentDateByLoan.set(target.id, startDate)
          const start = parseLocalDate(startDate)
          for (let i = 0; i < 600; i++) {
            addLoanEvent(target.id, { date: toLocalIsoDate(addMonths(start, i)), amount: action.value, recastMode: 'reduce_term' })
          }
        }
      }
    } else if (action.type === 'salary_change') {
      const targetPersonId = action.personId || personId
      const person = data.people.find((p) => p.id === targetPersonId)
      if (person) {
        const oldNetPerPeriod = calculateNetSalary(person.salary).netPerPeriod
        const newNetPerPeriod = calculateNetSalary({ ...person.salary, grossAnnual: action.value }).netPerPeriod
        const delta = newNetPerPeriod - oldNetPerPeriod
        salaryChangeImpact = { personId: targetPersonId, personName: person.name, oldNetMonthly: oldNetPerPeriod, newNetMonthly: newNetPerPeriod, delta }
        // Only affects the available-cash total for the person actually viewing this scenario
        if (targetPersonId === personId) monthlyImpact += delta
      }
    } else if (action.type === 'savings_pot_lump_sum' || action.type === 'savings_pot_withdrawal' || action.type === 'savings_pot_recurring_deposit_change') {
      const pot = data.savingsPots.find((p) => p.id === action.savingsPotId)
      if (!pot) continue
      // Undated (saved before dates existed) or in the past: treated as today.
      const date = action.date && action.date > todayStr ? action.date : todayStr
      const entry = potActions.get(pot.id) ?? { pot, actions: [] }
      entry.actions.push({ date, type: action.type, value: action.value })
      potActions.set(pot.id, entry)
    }
  }

  for (const { pot, actions } of potActions.values()) {
    const impact = buildSavingsPotImpact(pot, actions, today, data)
    savingsPotImpacts.push(impact)
    oneOffCashImpact += impact.totalOneOffCash
    // Counts against the OWNER's available cash only, same rule as
    // salary_change's targetPersonId === personId check.
    if (pot.personId === personId) monthlyImpact += impact.totalMonthlyCashChange
  }

  // --- Lump sum payoffs (now already correctly sequenced/clamped above) ---
  for (const [key, lumpSum] of lumpSumsApplied.entries()) {
    const [kind, id] = key.split(':') as [ScenarioTargetKind, string]

    if (kind === 'loan') {
      const loan = data.loans.find((l) => l.id === id)
      if (!loan) continue

      const original = summarizeLoan(loan)
      // Every dated event that landed on THIS loan — from this action and
      // any other pay_off_loan/loan_overpayment action(s) sharing it —
      // run through the real engine ONCE, in true date order (item d's
      // whole point: two scenarios/actions specifying the same dates must
      // agree, regardless of creation order or which action this
      // particular loanImpact record is "for").
      const outcome = simulateScenarioLoan(loan, loanEventsMap.get(id) ?? [])

      // "Fully paid off" is still judged against the real early-
      // settlement PREMIUM (scope §13/handoff step 6), evaluated as of
      // THIS lump sum's own date — not the schedule's raw balanceAfter,
      // and not today's premium if the lump sum is dated in the future.
      const settlementAsOfLump = estimateSettlementFigure(loan, parseLocalDate(lastLumpDateByLoan.get(id) ?? todayIso()))
      const fullyPaidOff = lumpSum >= settlementAsOfLump
      // BUGFIX (Adam-reported, 2026-09 session — "lump sum was 2000,
      // remaining after shows 0", and no positive monthly-cash impact
      // showing for a reduce_payment lump sum) — outcome.remainingAfterEvents/
      // effectiveMonthlyPayment are anchored to the LAST event across
      // EVERY action sharing this loan, not this lump sum's own date. In
      // a combined scenario with a recurring overpayment also on this
      // loan, that "last event" is a materialized occurrence ~50 years
      // out (loan_overpayment's own 600-month tail below) — by which
      // point the loan is obviously long paid off, collapsing both
      // figures to (near) zero regardless of what THIS lump sum alone
      // actually did. Reading the schedule at the lump sum's OWN landing
      // date (scheduleEntryAsOf) instead gives the balance/payment right
      // after just this event, which is what "Remaining after"/the
      // monthly-cost comparison are actually supposed to show.
      const asOfLump = outcome.hasSchedule ? scheduleEntryAsOf(outcome.schedule, lastLumpDateByLoan.get(id) ?? todayIso()) : undefined
      const newRemaining = fullyPaidOff
        ? 0
        : asOfLump
          ? round2(Math.max(0, asOfLump.balanceAfter))
          : round2(Math.max(0, original.remaining - lumpSum))
      // scheduledPayment ONLY, deliberately not + overpaymentApplied —
      // at the lump sum's OWN landing period, overpaymentApplied is the
      // lump sum itself (a one-off, not an ongoing monthly cost); adding
      // it here would double-count the £2,000 as if it were a recurring
      // charge. See the overpayment loop below for the case where that
      // field DOES need adding — a genuinely recurring event.
      const newMonthlyPayment = fullyPaidOff
        ? 0
        : asOfLump
          ? asOfLump.scheduledPayment
          : original.monthsRemaining > 0
            ? round2(newRemaining / original.monthsRemaining)
            : loan.monthlyPayment
      const newMonthsRemaining = fullyPaidOff ? 0 : outcome.hasSchedule ? outcome.monthsRemaining : original.monthsRemaining
      const newEndDate = fullyPaidOff
        ? null
        : outcome.hasSchedule && outcome.finalPaymentDate !== original.finalPaymentDate
          ? outcome.finalPaymentDate
          : null

      const originalMonthlyCostForPerson = costForPerson(virtualLoanBill(loan, currentLoanMonthlyCost(loan)), personId, data.people)
      const newMonthlyCostForPerson = costForPerson(virtualLoanBill(loan, newMonthlyPayment), personId, data.people)
      // The monthly effect is folded in ONCE per target, from debtImpacts
      // below, not here: a target with both a lump sum and a recurring
      // overpayment used to add "original − after" from each loop, so the
      // original was counted twice (Adam-reported 2026-09-17: clearing
      // mum's Natwest card AND overpaying it netted to £0 monthly, while
      // the card itself correctly showed +£200).


      loanImpacts.push({
        loanId: id,
        loanName: loan.name,
        targetKind: 'loan',
        kind: 'payoff',
        originalRemaining: original.remaining,
        newRemaining,
        lumpSumApplied: lumpSum,
        overpaymentPerMonth: 0,
        originalMonthsRemaining: original.monthsRemaining,
        newMonthsRemaining,
        monthsSaved: Math.max(0, original.monthsRemaining - newMonthsRemaining),
        fullyPaidOff,
        originalMonthlyCostForPerson,
        newMonthlyCostForPerson,
        newEndDate,
      })
    } else {
      const card = data.creditCards.find((c) => c.id === id)
      if (!card) continue

      const newRemaining = round2(Math.max(0, card.currentBalance - lumpSum))
      const fullyPaidOff = newRemaining <= 0

      const originalMinimum = computeMinimumPaymentAmount(card)
      const newMinimum = computeMinimumPaymentAmount({ ...card, currentBalance: newRemaining })
      const originalMonthlyCostForPerson = cardMonthlyCostForPerson(card, originalMinimum, personId)
      const newMonthlyCostForPerson = fullyPaidOff ? 0 : cardMonthlyCostForPerson(card, newMinimum, personId)
      // The monthly effect is folded in ONCE per target, from debtImpacts
      // below, not here: a target with both a lump sum and a recurring
      // overpayment used to add "original − after" from each loop, so the
      // original was counted twice (Adam-reported 2026-09-17: clearing
      // mum's Natwest card AND overpaying it netted to £0 monthly, while
      // the card itself correctly showed +£200).


      const originalPayoff = simulateCardPayoffMonths(card, 0)
      const newPayoff = fullyPaidOff ? { months: 0, totalInterestPaid: 0 } : simulateCardPayoffMonths({ ...card, currentBalance: newRemaining }, 0)

      loanImpacts.push({
        loanId: id,
        loanName: card.name,
        targetKind: 'credit_card',
        kind: 'payoff',
        originalRemaining: card.currentBalance,
        newRemaining,
        lumpSumApplied: lumpSum,
        overpaymentPerMonth: 0,
        originalMonthsRemaining: originalPayoff.months,
        newMonthsRemaining: newPayoff.months,
        monthsSaved: Math.max(0, originalPayoff.months - newPayoff.months),
        fullyPaidOff,
        originalMonthlyCostForPerson,
        newMonthlyCostForPerson,
        newEndDate: null,
      })
    }
  }

  // --- Exclusions: "what if this loan/card just didn't count" ---
  for (const key of exclusions) {
    const [kind, id] = key.split(':') as [ScenarioTargetKind, string]

    if (kind === 'loan') {
      const loan = data.loans.find((l) => l.id === id)
      if (!loan) continue

      const original = summarizeLoan(loan)
      const originalMonthlyCostForPerson = costForPerson(virtualLoanBill(loan, currentLoanMonthlyCost(loan)), personId, data.people)
      monthlyImpact += originalMonthlyCostForPerson

      loanImpacts.push({
        loanId: id,
        loanName: loan.name,
        targetKind: 'loan',
        kind: 'exclude',
        originalRemaining: original.remaining,
        newRemaining: original.remaining, // unchanged — it's excluded from your budget, not paid off
        lumpSumApplied: 0,
        overpaymentPerMonth: 0,
        originalMonthsRemaining: original.monthsRemaining,
        newMonthsRemaining: original.monthsRemaining,
        monthsSaved: 0,
        fullyPaidOff: false,
        originalMonthlyCostForPerson,
        newMonthlyCostForPerson: 0,
        newEndDate: null,
      })
    } else {
      const card = data.creditCards.find((c) => c.id === id)
      if (!card) continue

      const originalMinimum = computeMinimumPaymentAmount(card)
      const originalMonthlyCostForPerson = cardMonthlyCostForPerson(card, originalMinimum, personId)
      monthlyImpact += originalMonthlyCostForPerson
      const payoff = simulateCardPayoffMonths(card, 0)

      loanImpacts.push({
        loanId: id,
        loanName: card.name,
        targetKind: 'credit_card',
        kind: 'exclude',
        originalRemaining: card.currentBalance,
        newRemaining: card.currentBalance,
        lumpSumApplied: 0,
        overpaymentPerMonth: 0,
        originalMonthsRemaining: payoff.months,
        newMonthsRemaining: payoff.months,
        monthsSaved: 0,
        fullyPaidOff: false,
        originalMonthlyCostForPerson,
        newMonthlyCostForPerson: 0,
        newEndDate: null,
      })
    }
  }

  // --- Regular overpayments: an extra amount every month, shortening the term ---
  for (const [key, extraPerMonth] of overpayments.entries()) {
    const [kind, id] = key.split(':') as [ScenarioTargetKind, string]
    if (extraPerMonth <= 0) continue

    if (kind === 'loan') {
      const loan = data.loans.find((l) => l.id === id)
      if (!loan) continue

      const original = summarizeLoan(loan)
      // Same shared per-loan outcome the lump-sum loop above computes —
      // loanEventsMap already has this action's materialized monthly
      // series (and anything else dated against this loan) folded in, so
      // this reads the real, combined result rather than re-deriving a
      // second, isolated one just for this record. A recurring
      // overpayment is always reduce_term (see the field's own doc
      // comment), so unlike a lump sum it never lowers the payment or
      // leaves the principal instantly unchanged — the loan really is
      // being paid down faster from here, which the new figures reflect.
      const outcome = simulateScenarioLoan(loan, loanEventsMap.get(id) ?? [])

      // BUGFIX (Adam-reported, 2026-09 session — no negative monthly-cash
      // impact showing for a £100/month recurring overpayment) — same
      // root cause as the lump-sum loop above: effectiveMonthlyPayment is
      // anchored to this loan's chronologically LAST event (this
      // overpayment's own ~50-year-out materialized tail, in a scenario
      // with nothing else on this loan), not to when this arrangement
      // actually starts. Read off the schedule at the overpayment's own
      // start date instead.
      // BUGFIX (Adam-reported, 2026-09 session — "the Extra Per month
      // label is wrong"/no negative monthly-cash impact showing at all
      // for the recurring overpayment) — asOfStart.scheduledPayment is
      // only the loan's REGULAR contractual payment; for a reduce_term
      // recast (always used for a recurring overpayment — see this
      // field's own doc comment) that figure is UNCHANGED from before,
      // by design. The extra money paid each period shows up in
      // asOfStart.overpaymentApplied instead — NOT recurringOverpaymentApplied
      // (that field is reserved for the loan's own native
      // Loan.recurringOverpayment; a scenario's recurring overpayment is
      // materialized as 600 individual dated events — see the
      // loan_overpayment action above — so the real engine has no way to
      // tell those apart from a genuine one-off lump, and folds them all
      // into overpaymentApplied). Reading scheduledPayment alone made
      // "new monthly payment" look identical to the original, silently
      // erasing the very cost this card exists to show.
      const asOfStart = outcome.hasSchedule ? scheduleEntryAsOf(outcome.schedule, lastOverpaymentDateByLoan.get(id) ?? todayIso()) : undefined
      const fullyPaidOff = outcome.hasSchedule ? outcome.fullyPaidOff : false
      const newMonthlyPayment = asOfStart ? asOfStart.scheduledPayment + asOfStart.overpaymentApplied : loan.monthlyPayment + extraPerMonth
      const newMonthsRemaining = outcome.hasSchedule
        ? outcome.monthsRemaining
        : summarizeLoan({ ...loan, monthlyPayment: newMonthlyPayment }).monthsRemaining
      const newRemaining = asOfStart ? round2(Math.max(0, asOfStart.balanceAfter)) : original.remaining
      const newEndDate = outcome.hasSchedule && outcome.finalPaymentDate !== original.finalPaymentDate ? outcome.finalPaymentDate : null

      const originalMonthlyCostForPerson = costForPerson(virtualLoanBill(loan, currentLoanMonthlyCost(loan)), personId, data.people)
      const newMonthlyCostForPerson = costForPerson(virtualLoanBill(loan, Math.min(newMonthlyPayment, original.remaining)), personId, data.people)
      // The monthly effect is folded in ONCE per target, from debtImpacts
      // below, not here: a target with both a lump sum and a recurring
      // overpayment used to add "original − after" from each loop, so the
      // original was counted twice (Adam-reported 2026-09-17: clearing
      // mum's Natwest card AND overpaying it netted to £0 monthly, while
      // the card itself correctly showed +£200).


      loanImpacts.push({
        loanId: id,
        loanName: loan.name,
        targetKind: 'loan',
        kind: 'overpayment',
        originalRemaining: original.remaining,
        newRemaining,
        lumpSumApplied: 0,
        overpaymentPerMonth: extraPerMonth,
        originalMonthsRemaining: original.monthsRemaining,
        newMonthsRemaining,
        monthsSaved: Math.max(0, original.monthsRemaining - newMonthsRemaining),
        fullyPaidOff,
        originalMonthlyCostForPerson,
        newMonthlyCostForPerson,
        newEndDate,
      })
    } else {
      const card = data.creditCards.find((c) => c.id === id)
      if (!card) continue

      const originalMinimum = computeMinimumPaymentAmount(card)
      const originalMonthlyCostForPerson = cardMonthlyCostForPerson(card, originalMinimum, personId)
      // Actual new monthly outlay — minimum plus the overpayment, capped to
      // what's actually owed (mirrors the loan case's own capping).
      const newMonthlyCostForPerson = cardMonthlyCostForPerson(card, Math.min(originalMinimum + extraPerMonth, card.currentBalance), personId)
      // The monthly effect is folded in ONCE per target, from debtImpacts
      // below, not here: a target with both a lump sum and a recurring
      // overpayment used to add "original − after" from each loop, so the
      // original was counted twice (Adam-reported 2026-09-17: clearing
      // mum's Natwest card AND overpaying it netted to £0 monthly, while
      // the card itself correctly showed +£200).


      const originalPayoff = simulateCardPayoffMonths(card, 0)
      const newPayoff = simulateCardPayoffMonths(card, extraPerMonth)

      loanImpacts.push({
        loanId: id,
        loanName: card.name,
        targetKind: 'credit_card',
        kind: 'overpayment',
        originalRemaining: card.currentBalance,
        newRemaining: card.currentBalance,
        lumpSumApplied: 0,
        overpaymentPerMonth: extraPerMonth,
        originalMonthsRemaining: originalPayoff.months,
        newMonthsRemaining: newPayoff.months,
        monthsSaved: Math.max(0, originalPayoff.months - newPayoff.months),
        fullyPaidOff: false,
        originalMonthlyCostForPerson,
        newMonthlyCostForPerson,
        newEndDate: null,
      })
    }
  }

  // One monthly figure per debt, computed from its final state rather than
  // summed per action — see the note in the payoff/overpayment loops above.
  const debtImpacts = buildDebtImpacts(debtActions, data, personId, todayStr)
  for (const di of debtImpacts) monthlyImpact += di.totalMonthlyCashChange

  return {
    oneOffCashImpact: round2(oneOffCashImpact),
    monthlyAvailableBefore,
    monthlyAvailableAfter: round2(monthlyAvailableBefore + monthlyImpact),
    monthlyImpact: round2(monthlyImpact),
    loanImpacts,
    salaryChangeImpact,
    savingsPotImpacts,
    debtImpacts,
  }
}

interface DatedPotAction {
  date: string
  type: 'savings_pot_lump_sum' | 'savings_pot_withdrawal' | 'savings_pot_recurring_deposit_change'
  value: number
}

interface PotPlan {
  lumps: { date: string; amount: number }[]
  withdrawals: { date: string; amount: number }[]
  recurring: { date: string; monthly: number }[]
}

/**
 * One pot: "now", one section per date, and the all-changes summary.
 * Sections build on each other (Adam, 2026-09-17): a section's "before" is
 * everything scheduled plus the earlier sections; its "after" adds that
 * date's changes.
 *
 * Always via savingsPotLedger.ts's own helpers, with the real recurring
 * templates and the owner's pay cycle (Batch 21, APP-KNOWLEDGE.md §1.13a).
 * Lump sums and withdrawals go in as synthetic activity on their dates:
 * projectedBalanceAt rebuilds the balance from activity and ignores
 * `currentBalance` for future dates. A deposit change goes in as an
 * amountHistory entry on the pot's transfer template, so the real schedule
 * engine applies it from its date.
 */
function buildSavingsPotImpact(pot: AppData['savingsPots'][number], actions: DatedPotAction[], today: Date, data: AppData): SavingsPotImpact {
  const payCycle = data.payCycles.find((c) => c.personId === pot.personId)
  const todayStr = toLocalIsoDate(today)
  const balanceNow = round2(savingsPotBalanceAsOf(pot, data.transactions, today))
  const existingTemplate = data.recurringTemplates.find((t) => t.kind === 'transfer' && t.active && t.transferTo?.type === 'savings' && t.transferTo.savingsPotId === pot.id)
  // The deposit input is monthly; this scales it to the template's own frequency.
  const monthlyPerPayment = existingTemplate && existingTemplate.amount > 0 ? monthlyEquivalentCost(existingTemplate) / existingTemplate.amount : 1

  function activityFor(plan: PotPlan): AppData['transactions'] {
    const base = { categoryId: SAVINGS_CATEGORY_ID, paymentMethod: 'bank_transfer' as const, status: 'pending' as const, location: 'personal' as const, ownerId: pot.personId, savingsPotId: pot.id }
    return [
      ...data.transactions,
      ...plan.lumps.map((l, i) => ({ ...base, id: `what-if:lump:${i}`, date: l.date, amount: l.amount, direction: 'out' as const, type: 'savings_deposit' as const })),
      ...plan.withdrawals.map((w, i) => ({ ...base, id: `what-if:withdrawal:${i}`, date: w.date, amount: w.amount, direction: 'in' as const, type: 'savings_withdrawal' as const })),
    ]
  }

  function templatesFor(plan: PotPlan): RecurringTemplate[] {
    if (plan.recurring.length === 0) return data.recurringTemplates
    const added = plan.recurring.map((r) => ({ effectiveFrom: r.date, amount: round2(r.monthly / monthlyPerPayment) }))
    if (existingTemplate) {
      // The baseline keeps the template's current amount for any date before
      // its own history, exactly as resolveTemplateAmount does unmodified.
      const history = [
        { effectiveFrom: '0000-01-01', amount: existingTemplate.amount },
        ...(existingTemplate.amountHistory ?? []),
        ...(existingTemplate.amountEffectiveFrom ? [{ effectiveFrom: existingTemplate.amountEffectiveFrom, amount: existingTemplate.amount }] : []),
        ...added,
      ]
      const last = history[history.length - 1]
      const hypothetical: RecurringTemplate = { ...existingTemplate, amount: last.amount, amountEffectiveFrom: last.effectiveFrom, amountHistory: history.slice(0, -1) }
      return data.recurringTemplates.map((t) => (t.id === existingTemplate.id ? hypothetical : t))
    }
    const last = added[added.length - 1]
    return [
      ...data.recurringTemplates,
      {
        id: `what-if:deposit:${pot.id}`,
        name: `${pot.name} deposit (what-if)`,
        amount: last.amount,
        amountEffectiveFrom: last.effectiveFrom,
        amountHistory: added.slice(0, -1),
        categoryId: SAVINGS_CATEGORY_ID,
        paymentMethod: 'bank_transfer',
        frequency: 'monthly',
        anchorDate: added[0].effectiveFrom,
        location: 'personal',
        ownerId: pot.personId,
        payee: '',
        payeeSharePercent: 100,
        kind: 'transfer',
        transferFrom: { type: 'personal' },
        transferTo: { type: 'savings', savingsPotId: pot.id },
        active: true,
      },
    ]
  }

  function balanceOn(plan: PotPlan, dateStr: string): number {
    const activity = activityFor(plan)
    if (dateStr <= todayStr) return round2(savingsPotBalanceAsOf(pot, activity, today))
    return round2(projectedBalanceAt(pot, balanceNow, activity, today, parseLocalDate(dateStr), templatesFor(plan), payCycle))
  }

  const targetAmount = pot.targetAmount ? pot.targetAmount : null
  const targetReached = targetAmount !== null && balanceNow >= targetAmount
  function reachDate(plan: PotPlan): string | null {
    if (targetAmount === null || targetReached) return null
    // Changes dated today aren't in balanceNow; later ones are folded in by projectedTargetDate.
    const todayNet = plan.lumps.filter((l) => l.date === todayStr).reduce((s, l) => s + l.amount, 0) - plan.withdrawals.filter((w) => w.date === todayStr).reduce((s, w) => s + w.amount, 0)
    return projectedTargetDate(pot, round2(balanceNow + todayNet), activityFor(plan), today, templatesFor(plan), payCycle)
  }
  const monthsBetween = (from: string | null, to: string | null) => (from && to ? differenceInCalendarMonths(parseLocalDate(from), parseLocalDate(to)) : 0)

  const targetDate = pot.targetDate ?? null
  const targetDateAhead = targetDate !== null && targetDate > todayStr
  const emptyPlan: PotPlan = { lumps: [], withdrawals: [], recurring: [] }
  const currentReachDate = reachDate(emptyPlan)

  let plan = emptyPlan
  let recurringMonthly = existingTemplate ? null : 0
  const sections: SavingsPotSection[] = []
  const dates = [...new Set(actions.map((a) => a.date))].sort()
  for (const date of dates) {
    const before = plan
    const after: PotPlan = { lumps: [...plan.lumps], withdrawals: [...plan.withdrawals], recurring: [...plan.recurring] }
    let lumpSum = 0
    let withdrawal = 0
    let newMonthly: number | null = null
    for (const action of actions.filter((a) => a.date === date)) {
      if (action.type === 'savings_pot_lump_sum') {
        lumpSum = round2(lumpSum + action.value)
        after.lumps.push({ date, amount: action.value })
      } else if (action.type === 'savings_pot_withdrawal') {
        // Capped at the pot's expected balance that day, given everything so far.
        const applied = round2(Math.max(0, Math.min(action.value, balanceOn(after, date))))
        withdrawal = round2(withdrawal + applied)
        if (applied > 0) after.withdrawals.push({ date, amount: applied })
      } else {
        newMonthly = action.value // two changes on one date: the later action wins
      }
    }

    let oldMonthly: number | null = null
    if (newMonthly !== null) {
      oldMonthly = recurringMonthly ?? round2(resolveTemplateAmount(existingTemplate!, date) * monthlyPerPayment)
      after.recurring.push({ date, monthly: newMonthly })
      recurringMonthly = newMonthly
    }

    const reachBefore = reachDate(before)
    const reachAfter = reachDate(after)
    const onTargetDate = targetDateAhead && date <= targetDate!
    sections.push({
      date,
      lumpSum,
      withdrawal,
      oldRecurringMonthlyAmount: oldMonthly,
      newRecurringMonthlyAmount: newMonthly,
      balanceOnDateBefore: balanceOn(before, date),
      balanceOnDateAfter: balanceOn(after, date),
      reachDateBefore: reachBefore,
      reachDateAfter: reachAfter,
      monthsSaved: monthsBetween(reachBefore, reachAfter),
      balanceOnTargetDateBefore: onTargetDate ? balanceOn(before, targetDate!) : null,
      balanceOnTargetDateAfter: onTargetDate ? balanceOn(after, targetDate!) : null,
      oneOffCash: round2(withdrawal - lumpSum),
      monthlyCashChange: newMonthly !== null ? round2((oldMonthly ?? 0) - newMonthly) : 0,
    })
    plan = after
  }

  const finalReachDate = reachDate(plan)
  return {
    savingsPotId: pot.id,
    potName: pot.name,
    personId: pot.personId,
    balanceNow,
    targetAmount,
    targetDate,
    currentReachDate,
    monthsBehindTarget: targetDate && currentReachDate ? differenceInCalendarMonths(parseLocalDate(currentReachDate), parseLocalDate(targetDate)) : null,
    targetReached,
    sections,
    finalReachDate,
    totalMonthsSaved: monthsBetween(currentReachDate, finalReachDate),
    balanceOnTargetDateNow: targetDateAhead ? balanceOn(emptyPlan, targetDate!) : null,
    balanceOnTargetDateAfterAll: targetDateAhead ? balanceOn(plan, targetDate!) : null,
    totalOneOffCash: round2(sections.reduce((s, x) => s + x.oneOffCash, 0)),
    totalMonthlyCashChange: round2(sections.reduce((s, x) => s + x.monthlyCashChange, 0)),
  }
}

interface DebtAction {
  date: string
  lumpSum?: number
  overpayment?: number
  recastMode?: 'reduce_term' | 'reduce_payment'
  /** Funded by a sell_asset's proceeds rather than out of pocket, so it costs no cash. */
  fromSale?: boolean
}

/**
 * One date's changes to a loan or credit card, in the same shape the
 * savings pot card uses (Adam, 2026-09-17). Sections build on each other:
 * "before" is the debt with the earlier sections' actions applied, "after"
 * adds this date's.
 */
export interface DebtSection {
  date: string
  lumpSum: number
  recastMode: 'reduce_term' | 'reduce_payment' | null // lump sums only
  newRecurringOverpayment: number | null // extra per month starting this date
  balanceOnDateBefore: number
  balanceOnDateAfter: number
  monthlyPaymentBefore: number
  monthlyPaymentAfter: number
  // Loans only; a credit card's payoff maths has no dates, so it reports
  // months rather than a finish date.
  finishDateBefore: string | null
  finishDateAfter: string | null
  monthsRemainingBefore: number
  monthsRemainingAfter: number
  monthsSaved: number
  fullyPaidOff: boolean
  /** The viewer's own share of the monthly payment change: positive frees cash, negative costs it. */
  monthlyCashChange: number
  /** Money out of pocket on this date: a lump sum paid from your own funds, negative. Zero when a sale funded it. */
  oneOffCash: number
}

/** ONE record per loan or credit card a scenario acts on: where it stands now, one section per date, and all changes against now. Excluded debts are not here — they keep their own card (Adam: "leave exclude as it is"). */
export interface DebtImpact {
  targetKind: ScenarioTargetKind
  targetId: string
  targetName: string
  dated: boolean // false for a credit card: its one section is always today
  balanceNow: number
  monthlyPaymentNow: number
  finishDateNow: string | null
  monthsRemainingNow: number
  sections: DebtSection[]
  balanceAfterAll: number
  finishDateAfterAll: string | null
  monthsRemainingAfterAll: number
  totalMonthsSaved: number
  totalLumpSum: number
  totalOneOffCash: number
  totalMonthlyCashChange: number
  fullyPaidOff: boolean
}

/**
 * Builds the sectioned view of every loan/credit card a scenario touches.
 *
 * Deliberately a SEPARATE pass from the loanImpacts loops above, which are
 * untouched: those own every figure that feeds monthlyImpact/
 * oneOffCashImpact (and the verify scripts that guard them), while this
 * only derives what the card displays. The two share their inputs — the
 * amounts here come from the pool cascade itself (recordDebtAction), not a
 * second allocation.
 *
 * A loan runs through the real amortisation engine once per section:
 * simulateScenarioLoan with the actions dated on/before that section
 * ("after") and strictly before it ("before"). A recurring overpayment is
 * materialized the same way the loanImpacts path does, so both agree.
 */
function buildDebtImpacts(
  debtActions: Map<string, { kind: ScenarioTargetKind; id: string; actions: DebtAction[] }>,
  data: AppData,
  personId: string,
  todayStr: string,
): DebtImpact[] {
  const impacts: DebtImpact[] = []

  for (const { kind, id, actions } of debtActions.values()) {
    const dates = [...new Set(actions.map((a) => a.date))].sort()

    if (kind === 'credit_card') {
      const card = data.creditCards.find((c) => c.id === id)
      if (!card) continue
      const lumpSum = round2(actions.reduce((s, a) => s + (a.lumpSum ?? 0), 0))
      const overpayment = round2(actions.reduce((s, a) => s + (a.overpayment ?? 0), 0))
      const balanceAfter = round2(Math.max(0, card.currentBalance - lumpSum))
      const fullyPaidOff = balanceAfter <= 0
      const minimumNow = computeMinimumPaymentAmount(card)
      const paymentAfter = fullyPaidOff ? 0 : round2(Math.min(computeMinimumPaymentAmount({ ...card, currentBalance: balanceAfter }) + overpayment, balanceAfter))
      const payoffNow = simulateCardPayoffMonths(card, 0)
      const payoffAfter = fullyPaidOff ? { months: 0 } : simulateCardPayoffMonths({ ...card, currentBalance: balanceAfter }, overpayment)
      const monthlyCashChange = round2(cardMonthlyCostForPerson(card, minimumNow, personId) - cardMonthlyCostForPerson(card, paymentAfter, personId))
      impacts.push({
        targetKind: kind,
        targetId: id,
        targetName: card.name,
        dated: false,
        balanceNow: card.currentBalance,
        monthlyPaymentNow: minimumNow,
        finishDateNow: null,
        monthsRemainingNow: payoffNow.months,
        sections: [
          {
            date: todayStr,
            lumpSum,
            recastMode: null,
            newRecurringOverpayment: overpayment > 0 ? overpayment : null,
            balanceOnDateBefore: card.currentBalance,
            balanceOnDateAfter: balanceAfter,
            monthlyPaymentBefore: minimumNow,
            monthlyPaymentAfter: paymentAfter,
            finishDateBefore: null,
            finishDateAfter: null,
            monthsRemainingBefore: payoffNow.months,
            monthsRemainingAfter: payoffAfter.months,
            monthsSaved: Math.max(0, payoffNow.months - payoffAfter.months),
            fullyPaidOff,
            monthlyCashChange,
            oneOffCash: round2(-actions.filter((a) => !a.fromSale).reduce((s, a) => s + (a.lumpSum ?? 0), 0)),
          },
        ],
        balanceAfterAll: balanceAfter,
        finishDateAfterAll: null,
        monthsRemainingAfterAll: payoffAfter.months,
        totalMonthsSaved: Math.max(0, payoffNow.months - payoffAfter.months),
        totalLumpSum: lumpSum,
        totalOneOffCash: round2(-actions.filter((a) => !a.fromSale).reduce((s, a) => s + (a.lumpSum ?? 0), 0)),
        totalMonthlyCashChange: monthlyCashChange,
        fullyPaidOff,
      })
      continue
    }

    const loan = data.loans.find((l) => l.id === id)
    if (!loan) continue
    const original = summarizeLoan(loan)

    const eventsFor = (subset: DebtAction[]): ScenarioLoanEvent[] =>
      subset.flatMap((a) => {
        if (a.lumpSum) return [{ date: a.date, amount: a.lumpSum, recastMode: a.recastMode ?? 'reduce_term' }]
        if (!a.overpayment) return []
        // Same 600-month materialization the loanImpacts path uses.
        const start = parseLocalDate(a.date)
        return Array.from({ length: 600 }, (_, i) => ({ date: toLocalIsoDate(addMonths(start, i)), amount: a.overpayment!, recastMode: 'reduce_term' as const }))
      })

    // The state of the loan with a given set of actions applied, read at
    // `date`. The payment is read a month AFTER the section's own date: at
    // the date itself a lump sum still sits in overpaymentApplied, which is
    // a one-off, not the ongoing monthly cost.
    const stateAt = (subset: DebtAction[], date: string) => {
      // With nothing applied yet, the loan still runs down on its own, so
      // "before" reads the untouched schedule at that date — not today's
      // balance (Adam-reported, 2026-09-17: the first section's before/after
      // was today's balance → the balance after the lump AND every payment
      // in between, so a £3,000 lump looked like £4,040).
      const outcome = subset.length > 0 ? simulateScenarioLoan(loan, eventsFor(subset)) : null
      const schedule = outcome?.hasSchedule ? outcome.schedule : baselineLoanSchedule(loan)
      if (schedule.length === 0) {
        return { balance: original.remaining, payment: currentLoanMonthlyCost(loan), finishDate: original.finalPaymentDate, monthsRemaining: original.monthsRemaining, fullyPaidOff: false }
      }
      if (!outcome?.hasSchedule) {
        const atBaseline = scheduleEntryAsOf(schedule, date)
        return {
          balance: round2(Math.max(0, atBaseline?.balanceAfter ?? original.remaining)),
          payment: currentLoanMonthlyCost(loan),
          finishDate: original.finalPaymentDate,
          monthsRemaining: original.monthsRemaining,
          fullyPaidOff: false,
        }
      }
      const atDate = scheduleEntryAsOf(outcome.schedule, date)
      const nextPeriod = scheduleEntryAsOf(outcome.schedule, toLocalIsoDate(addMonths(parseLocalDate(date), 1)))
      const recurringStillRunning = subset.some((a) => a.overpayment && a.date <= date)
      const payment = outcome.fullyPaidOff && (nextPeriod?.balanceAfter ?? 0) <= 0.005 ? 0 : nextPeriod ? round2(nextPeriod.scheduledPayment + (recurringStillRunning ? nextPeriod.overpaymentApplied : 0)) : 0
      return {
        balance: round2(Math.max(0, atDate?.balanceAfter ?? original.remaining)),
        payment,
        finishDate: outcome.finalPaymentDate,
        monthsRemaining: outcome.monthsRemaining,
        fullyPaidOff: outcome.fullyPaidOff,
      }
    }

    const monthlyShare = (payment: number) => costForPerson(virtualLoanBill(loan, payment), personId, data.people)
    const sections: DebtSection[] = []
    for (const date of dates) {
      const before = actions.filter((a) => a.date < date)
      const after = actions.filter((a) => a.date <= date)
      const onDate = actions.filter((a) => a.date === date)
      const stateBefore = stateAt(before, date)
      const stateAfter = stateAt(after, date)
      const lumpSum = round2(onDate.reduce((s, a) => s + (a.lumpSum ?? 0), 0))
      const overpayment = round2(onDate.reduce((s, a) => s + (a.overpayment ?? 0), 0))
      sections.push({
        date,
        lumpSum,
        recastMode: lumpSum > 0 ? onDate.find((a) => a.lumpSum)?.recastMode ?? 'reduce_term' : null,
        newRecurringOverpayment: overpayment > 0 ? overpayment : null,
        balanceOnDateBefore: stateBefore.balance,
        balanceOnDateAfter: stateAfter.balance,
        monthlyPaymentBefore: stateBefore.payment,
        monthlyPaymentAfter: stateAfter.payment,
        finishDateBefore: stateBefore.finishDate,
        finishDateAfter: stateAfter.finishDate,
        monthsRemainingBefore: stateBefore.monthsRemaining,
        monthsRemainingAfter: stateAfter.monthsRemaining,
        monthsSaved: Math.max(0, stateBefore.monthsRemaining - stateAfter.monthsRemaining),
        fullyPaidOff: stateAfter.fullyPaidOff && stateAfter.balance <= 0.005,
        monthlyCashChange: round2(monthlyShare(stateBefore.payment) - monthlyShare(stateAfter.payment)),
        oneOffCash: round2(-onDate.filter((a) => !a.fromSale).reduce((s, a) => s + (a.lumpSum ?? 0), 0)),
      })
    }

    const last = sections[sections.length - 1]
    impacts.push({
      targetKind: kind,
      targetId: id,
      targetName: loan.name,
      dated: true,
      balanceNow: original.remaining,
      monthlyPaymentNow: currentLoanMonthlyCost(loan),
      finishDateNow: original.finalPaymentDate,
      monthsRemainingNow: original.monthsRemaining,
      sections,
      balanceAfterAll: last?.balanceOnDateAfter ?? original.remaining,
      finishDateAfterAll: last?.finishDateAfter ?? original.finalPaymentDate,
      monthsRemainingAfterAll: last?.monthsRemainingAfter ?? original.monthsRemaining,
      totalMonthsSaved: Math.max(0, original.monthsRemaining - (last?.monthsRemainingAfter ?? original.monthsRemaining)),
      totalLumpSum: round2(actions.reduce((s, a) => s + (a.lumpSum ?? 0), 0)),
      totalOneOffCash: round2(sections.reduce((s, x) => s + x.oneOffCash, 0)),
      totalMonthlyCashChange: round2(sections.reduce((s, x) => s + x.monthlyCashChange, 0)),
      fullyPaidOff: (last?.fullyPaidOff ?? false) && (last?.balanceOnDateAfter ?? 1) <= 0.005,
    })
  }

  return impacts
}

/** A loan's monthly payment represented as a Bill, so it can reuse the same person-split logic. */
function virtualLoanBill(loan: Loan, cost: number): Bill {
  return {
    id: `loan:${loan.id}`,
    name: loan.name,
    cost,
    dueDay: 1,
    location: loan.location,
    payee: loan.payee,
    payeeSharePercent: loan.payeeSharePercent,
    category: 'Loan',
    ownerId: loan.ownerId,
    isStandingOrder: true,
  }
}

/**
 * Same scenario, but the household's combined view rather than one person's:
 * every loan/card/bill/finance-agreement counted at its full value rather
 * than anyone's split share, and a salary change counts regardless of
 * whose it is.
 *
 * Implemented by running the normal per-person calculation once for every
 * person and summing their monthly deltas — the split percentages on every
 * bill and loan always add up to 100% across the household (and a credit
 * card is always 100% its owner's), so summing each person's share back
 * together reconstructs the true, unsplit total. The one-off cash figure
 * and each target's own balance/term fields are identical no matter who
 * they're calculated "for", so those are taken once rather than summed
 * (summing them would multiply by however many people there are).
 */
export function calculateHouseholdScenarioImpact(scenario: Scenario, data: AppData, monthlyAvailableBefore: number): ScenarioImpact {
  const perPerson = data.people.map((p) => calculateScenarioImpact(scenario, data, p.id, 0))

  const oneOffCashImpact = perPerson[0]?.oneOffCashImpact ?? 0
  const monthlyImpact = round2(perPerson.reduce((sum, r) => sum + r.monthlyImpact, 0))

  const loanImpactsByKey = new Map<string, LoanImpact>()
  for (const result of perPerson) {
    for (const li of result.loanImpacts) {
      const key = `${li.targetKind}:${li.loanId}:${li.kind}`
      const existing = loanImpactsByKey.get(key)
      if (existing) {
        existing.originalMonthlyCostForPerson = round2(existing.originalMonthlyCostForPerson + li.originalMonthlyCostForPerson)
        existing.newMonthlyCostForPerson = round2(existing.newMonthlyCostForPerson + li.newMonthlyCostForPerson)
      } else {
        loanImpactsByKey.set(key, { ...li })
      }
    }
  }

  // Same treatment for the sectioned debt cards: every figure except the
  // viewer's own share of the payment is identical across perPerson, so the
  // first result is taken and only monthlyCashChange is summed back up.
  const debtImpactsByKey = new Map<string, DebtImpact>()
  for (const result of perPerson) {
    for (const di of result.debtImpacts) {
      const key = `${di.targetKind}:${di.targetId}`
      const existing = debtImpactsByKey.get(key)
      if (existing) {
        existing.totalMonthlyCashChange = round2(existing.totalMonthlyCashChange + di.totalMonthlyCashChange)
        existing.sections = existing.sections.map((s, i) => ({ ...s, monthlyCashChange: round2(s.monthlyCashChange + (di.sections[i]?.monthlyCashChange ?? 0)) }))
      } else {
        debtImpactsByKey.set(key, { ...di, sections: di.sections.map((s) => ({ ...s })) })
      }
    }
  }

  return {
    oneOffCashImpact,
    monthlyAvailableBefore,
    monthlyAvailableAfter: round2(monthlyAvailableBefore + monthlyImpact),
    monthlyImpact,
    loanImpacts: Array.from(loanImpactsByKey.values()),
    debtImpacts: Array.from(debtImpactsByKey.values()),
    salaryChangeImpact: perPerson.find((r) => r.salaryChangeImpact)?.salaryChangeImpact ?? null,
    // Unlike loanImpacts, these never depend on which person the
    // per-person calc was run "for" (a pot belongs to one person — see
    // SavingsPotImpact's own comment) — every entry is identical across
    // perPerson, so the first is enough, not a sum.
    savingsPotImpacts: perPerson[0]?.savingsPotImpacts ?? [],
  }
}

/**
 * Combines several scenarios into one, so their combined effect can be run
 * through calculateScenarioImpact in a single pass. This matters for
 * correctness, not just convenience: if two scenarios both target the same
 * loan/card, their lump sums/overpayments need to be summed together
 * against its real remaining balance, not evaluated independently against
 * the same starting point twice.
 */
export function mergeScenarios(scenarios: Scenario[]): Scenario {
  return {
    id: 'combined',
    name: 'Combined',
    includeInCumulative: false,
    actions: scenarios.flatMap((s) => s.actions),
  }
}

/**
 * Reads an action's loan/credit-card targets, supporting older saved-
 * scenario field shapes from before credit-card targets (or even
 * per-target amounts) existed. Preference order: the current `targets`
 * field; then the old loan-only `loanAllocations`; then an even older
 * `linkedLoanIds` array some saved scenarios may still have; then a
 * single-target `linkedTargetKind`/`linkedTargetId` pair (today's shape
 * for exclude_loan/loan_overpayment); then the oldest single-target shape,
 * `linkedLoanId`. Everything found via a loan-only legacy field is
 * reported as kind: 'loan', since credit cards didn't exist as a target
 * when those fields were the only ones written.
 */
export function resolveTargets(action: Scenario['actions'][number]): { kind: ScenarioTargetKind; id: string; amount?: number }[] {
  if (action.targets?.length) return action.targets
  if (action.loanAllocations?.length) return action.loanAllocations.map((a) => ({ kind: 'loan' as const, id: a.loanId, amount: a.amount }))
  const legacy = action as unknown as { linkedLoanIds?: string[] }
  if (legacy.linkedLoanIds?.length) return legacy.linkedLoanIds.map((loanId) => ({ kind: 'loan' as const, id: loanId }))
  if (action.linkedTargetKind && action.linkedTargetId) return [{ kind: action.linkedTargetKind, id: action.linkedTargetId }]
  if (action.linkedLoanId) return [{ kind: 'loan' as const, id: action.linkedLoanId }]
  return []
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
