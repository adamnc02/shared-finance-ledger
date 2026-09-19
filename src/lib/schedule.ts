// Expands a RecurringTemplate's frequency into individual, pending
// Transaction occurrences within a date range (doc Section 3.1 / 4.1:
// "Rebuild" classification — replaces the old app's implicit "monthly,
// due day N" assumption with a real frequency model). Pure/idempotent:
// callers are responsible for deduping against transactions that already
// exist for a given (sourceId, date) pair before inserting the result —
// this file only computes what SHOULD exist in the range, it doesn't
// know what's already been generated.

import { addDays, addMonths, addQuarters, addWeeks, addYears, differenceInCalendarDays } from 'date-fns'
import { nanoid } from 'nanoid'
import type { PayCycleConfig, RecurrenceFrequency, RecurringOccurrenceOverride, RecurringTemplate, Transaction } from '../types/ledger'
import { upcomingPaydays } from './salaryLedger'
import { nextCycleStartAfter } from './payCycle'
import { categoryForTransfer } from './transferLedger'
import { formatFullDate } from './format'
import { earlyMoveLookaheadDays, isOccurrenceAdjusted } from './occurrenceOverrides'

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate()
}

/** Re-applies the anchor date's day-of-month to `date`, clamped to that month's real length (e.g. anchor day 31 in a 30-day month lands on the 30th). */
function clampToAnchorDay(date: Date, anchorDay: number): Date {
  const day = Math.min(anchorDay, daysInMonth(date.getFullYear(), date.getMonth()))
  return new Date(date.getFullYear(), date.getMonth(), day)
}

/** The day of month a monthly/quarterly/annual schedule falls on — see RecurringTemplate.anchorDayOfMonth. */
function scheduleAnchorDay(schedule: { anchorDate: string; anchorDayOfMonth?: number }): number {
  return schedule.anchorDayOfMonth ?? parseLocalDate(schedule.anchorDate).getDate()
}

function nextOccurrence(current: Date, template: Pick<RecurringTemplate, 'frequency' | 'intervalWeeks'>, anchorDay: number): Date {
  switch (template.frequency) {
    case 'weekly':
      return addWeeks(current, 1)
    case 'every_n_weeks':
      return addWeeks(current, Math.max(1, template.intervalWeeks ?? 1))
    case 'monthly':
      return clampToAnchorDay(addMonths(current, 1), anchorDay)
    case 'quarterly':
      return clampToAnchorDay(addQuarters(current, 1), anchorDay)
    case 'annual':
      return clampToAnchorDay(addYears(current, 1), anchorDay)
  }
}

import { toLocalIsoDate as toIso, parseLocalDate } from './date'

// Sanity cap on iterations, independent of the date range — protects
// against a pathological template (e.g. every_n_weeks with an
// accidental interval of 0) spinning forever rather than just returning
// an empty/short result.
const MAX_OCCURRENCES = 2000

/**
 * What `template.amount` resolves to on a specific date, accounting for a
 * scheduled change recorded via amountEffectiveFrom/amountHistory (Bills.tsx's
 * "which payment should this apply from" picker). Mirrors
 * salaryLedger.ts's findApplicableSnapshot: every past value is checked
 * as a candidate, and whichever one's effectiveFrom is the latest that's
 * still on-or-before `dateIso` wins — including the CURRENT amount
 * itself, via its own amountEffectiveFrom, competing on equal footing
 * with the historical entries rather than being asserted as always-latest.
 *
 * Ties (two candidates sharing the exact same effectiveFrom) are broken
 * by RECENCY OF RECORDING, not by date alone — confirmed as a real,
 * not-just-theoretical bug: applyTemplateAmountChange's own "prior value"
 * entry falls back to `template.anchorDate` the first time a bill is ever
 * edited (see that function's comment), and a bill's anchor date is
 * routinely the exact same date the person picks in the "apply from"
 * picker — it's usually the very first, most natural option shown,
 * especially for a bill that hasn't had a real occurrence yet. That
 * collision is not an edge case: it's the single most common edit (drop
 * the amount, apply "from the very next payment"), and without this,
 * whichever candidate happened to land first in the array — always the
 * STALE one, since the true current value is appended last — silently
 * and permanently won every date it was asked about, making the edit the
 * person just made never show up anywhere. `candidates` is built in
 * strict chronological-recording order (amountHistory entries in the
 * order they were appended, then the live amount/amountEffectiveFrom
 * pair last, since that's always the most recent decision) — so on a
 * tie, the LATER array index is the more-recently-recorded, and
 * therefore more authoritative, statement about that date.
 */
export function resolveTemplateAmount(template: RecurringTemplate, dateIso: string): number {
  const candidates: { effectiveFrom: string; amount: number }[] = [...(template.amountHistory ?? [])]
  if (template.amountEffectiveFrom) candidates.push({ effectiveFrom: template.amountEffectiveFrom, amount: template.amount })

  if (candidates.length === 0) return template.amount

  const applicable = candidates
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c.effectiveFrom <= dateIso)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.index - a.index)
  // dateIso predates every recorded change (e.g. asking about a date
  // before the bill's own history begins) — the current amount is the
  // only reasonable answer left, same as an untouched template.
  return applicable[0]?.amount ?? template.amount
}

/**
 * What a SPECIFIC occurrence resolves to, checking `occurrenceOverrides`
 * (a "just a single payment" edit, or any other per-occurrence override)
 * before falling back to `resolveTemplateAmount`'s standing-history walk —
 * the same order walkOccurrences already applies when generating real
 * transactions. UAT 2026-09-09 (ed-bills-just-single) — display-only call
 * sites (the "manage paused payments" preview) were calling
 * resolveTemplateAmount directly, which has no awareness of
 * occurrenceOverrides at all, so a single-occurrence amount change
 * correctly updated the real ledger but silently never showed up there —
 * this is the shared, correct resolver every such display should use
 * instead. `originalDate` is the occurrence's UN-overridden scheduled
 * date (the key occurrenceOverrides itself uses), not a possibly-moved
 * display date.
 */
export function resolveOccurrenceAmount(template: RecurringTemplate, originalDate: string): number {
  const override = template.occurrenceOverrides?.find((o) => o.originalDate === originalDate)
  if (override?.amount !== undefined) return override.amount
  return resolveTemplateAmount(template, originalDate)
}

/** Whether this occurrence shows the "Adjusted" badge — see isOccurrenceAdjusted. Its natural date is payday-resolved for a follows-payday/cycle-start transfer, so a weekend payday drift is never "adjusted". */
export function templateOccurrenceAdjusted(template: RecurringTemplate, originalDate: string, payCycle?: PayCycleConfig): boolean {
  const override = template.occurrenceOverrides?.find((o) => o.originalDate === originalDate)
  if (!override || override.deleted) return false
  const natural = { date: resolveTemplateOccurrenceDate(originalDate, template, payCycle), amount: resolveTemplateAmount(template, originalDate) }
  return isOccurrenceAdjusted({ date: resolveTemplateOccurrenceDate(override.date ?? originalDate, template, payCycle), amount: override.amount ?? natural.amount }, natural)
}

export interface RawOccurrence {
  originalDate: string // the naturally-scheduled date, before any per-occurrence override AND before any payday/cycle-start resolution
  date: string // the displayed/effective date — resolved against payday/cycle-start (for a follows-payday/follows-cycle-start transfer) and/or overridden
  amount: number
}

/**
 * What a `kind: 'transfer'` template's occurrence date resolves to once
 * `followsPayday`/`followsCycleStart` is taken into account — a
 * follows-payday transfer resolves its date against the actual payday
 * on/after `rawDate`, rather than using that date directly, so a
 * transfer can "land on payday" even when payday itself drifts
 * (weekends/bank holidays, non-monthly pay frequencies); a
 * follows-cycle-start transfer does the same against the person's
 * budgeting-cycle boundary instead (Salary Sorter session, 2026-09) —
 * for someone whose cycle doesn't track payday (PayCycleConfig.
 * cycleStartFollowsPayday can differ from payday entirely). Falls back
 * to `rawDate` untouched if no payCycle was supplied, or the template
 * isn't a transfer, or neither flag is set. followsPayday takes
 * precedence if both are somehow set (the two are meant to be mutually
 * exclusive, enforced by the UI — this is just a defined tie-break
 * rather than an unreachable branch).
 *
 * UAT 2026-09-10 (recurring-payday-date-editing) — this used to live
 * ONLY inside generateTransactionsForTemplate, applied AFTER
 * walkOccurrences returned, so every other consumer of walkOccurrences
 * (templateOccurrencePreviews, and anything built on top of it) saw the
 * raw, unresolved, naturally-walked date instead — the real generated
 * transaction landed correctly, but "Manage upcoming payments" and any
 * other preview surface showed the wrong date for a follows-payday/
 * follows-cycle-start transfer. Extracted here so every caller of
 * walkOccurrences (and scheduledTemplateDates, which does its own
 * separate walk) applies the exact same resolution.
 */
export function resolveTemplateOccurrenceDate(rawDate: string, template: RecurringTemplate, payCycle?: PayCycleConfig): string {
  const isTransferKind = template.kind === 'transfer'
  if (isTransferKind && template.followsPayday && payCycle) {
    return toIso(upcomingPaydays(payCycle, parseLocalDate(rawDate), 1)[0] ?? parseLocalDate(rawDate))
  }
  if (isTransferKind && template.followsCycleStart && payCycle) {
    return toIso(nextCycleStartAfter(parseLocalDate(rawDate), payCycle))
  }
  return rawDate
}

/**
 * 2026-09-17 (Adam-reported) — a follows-payday/follows-cycle-start
 * transfer's occurrence is PAID on its resolved date, which is always
 * later than its natural slot (up to one pay period later). So whether it
 * falls inside a date range has to be decided by that resolved date, not
 * by the slot.
 *
 * Deciding by slot dropped any occurrence whose slot was before the range
 * but whose payday was inside it. Adam's three transfers anchored on
 * 12 Sep, paid on payday 30 Sep: on 17 Sep, every "from today" view
 * skipped September. The transfer card header said "Next 30 Oct", and a
 * savings pot opened on 12 Sep (whose ledger window starts today) had no
 * 30 Sep deposit. "Manage upcoming payments" and the Home ledger start
 * earlier than the slot, so they were right, and disagreed with the rest.
 * It also let in an occurrence whose slot was inside the range but whose
 * payday was after it.
 *
 * Returns the extra look-back to walk from, or null when the template's
 * dates are never moved (every other template: slot === date).
 */
function resolvedRangeLookback(template: RecurringTemplate, rangeStart: Date, payCycle?: PayCycleConfig): Date | null {
  if (template.kind !== 'transfer' || !payCycle || !(template.followsPayday || template.followsCycleStart)) return null
  // One pay period at most separates a slot from its resolved date; two
  // months covers monthly and four-weekly cycles with room to spare.
  return addMonths(rangeStart, -2)
}

/**
 * Walks a template's frequency/anchorDate forward across [rangeStart,
 * rangeEnd] and returns every occurrence — shared by
 * generateTransactionsForTemplate (which turns these into full
 * Transaction shapes) and templateOccurrencePreviews (which needs the
 * ORIGINAL date alongside the resolved one, for Expenses.tsx's
 * per-occurrence edit/delete UI). A 'transaction'-kind template's
 * occurrenceOverrides are applied here, once, so both callers see
 * exactly the same resolved schedule — a deleted occurrence is dropped
 * entirely, an edited one carries its overridden date/amount. Templates
 * with kind 'bill' (or absent) never carry occurrenceOverrides, so this
 * is a no-op for them.
 *
 * `payCycle`, when supplied, is threaded into resolveTemplateOccurrenceDate
 * so a follows-payday/follows-cycle-start TRANSFER's displayed `date` is
 * resolved the same way here as generateTransactionsForTemplate always
 * did — `originalDate` (the override-matching key) is deliberately left
 * as the natural, UNRESOLVED date; only `date` (what's actually shown or
 * written to a real Transaction) is resolved. Note this resolves
 * whatever the "natural or overridden" date already is — i.e. even a
 * per-occurrence-moved date gets payday-resolved, matching
 * generateTransactionsForTemplate's pre-existing behaviour exactly.
 */
function walkOccurrences(template: RecurringTemplate, rangeStart: Date, rangeEnd: Date, payCycle?: PayCycleConfig): RawOccurrence[] {
  if (!template.active) return []
  if (rangeEnd < rangeStart) return []

  const anchor = parseLocalDate(template.anchorDate)
  const anchorDay = scheduleAnchorDay(template)
  // See resolvedRangeLookback: a date-moving transfer is range-checked by
  // its resolved date, so the walk starts early enough to reach it.
  const lookback = resolvedRangeLookback(template, rangeStart, payCycle)
  const rangeStartIso = toIso(rangeStart)
  const rangeEndIso = toIso(rangeEnd)
  // Slots past rangeEnd are walked only so an override moving one earlier
  // can bring it into the range — see earlyMoveLookaheadDays.
  const walkEnd = addDays(rangeEnd, earlyMoveLookaheadDays(template.occurrenceOverrides))

  let cursor = anchor
  let iterations = 0
  // Walk forward from the anchor to the start of the range without
  // emitting anything — the anchor itself may be years in the past.
  while (cursor < (lookback ?? rangeStart) && iterations < MAX_OCCURRENCES) {
    cursor = nextOccurrence(cursor, template, anchorDay)
    iterations++
  }

  const results: RawOccurrence[] = []
  while (cursor <= walkEnd && iterations < MAX_OCCURRENCES) {
    const originalDate = toIso(cursor)
    const override = template.occurrenceOverrides?.find((o) => o.originalDate === originalDate)
    if (!override?.deleted) {
      const rawDate = override?.date ?? originalDate
      const date = resolveTemplateOccurrenceDate(rawDate, template, payCycle)
      // Without a lookback, a slot inside the range keeps its old rule (in,
      // even if moved past rangeEnd — the next range's walk would never
      // reach it). But one moved BEFORE rangeStart belongs to the previous
      // range, which now finds it via earlyMoveLookaheadDays; emitting it
      // here too would show it in both. Slots past rangeEnd are in only if
      // moved into the range.
      const slotPastRange = originalDate > rangeEndIso
      const inRange = date >= rangeStartIso && date <= rangeEndIso
      if (lookback || slotPastRange ? inRange : date >= rangeStartIso) {
        results.push({
          originalDate,
          date,
          amount: override?.amount ?? resolveTemplateAmount(template, originalDate),
        })
      }
    }
    cursor = nextOccurrence(cursor, template, anchorDay)
    iterations++
  }

  return results
}

/**
 * `payCycle` is only used for a `kind: 'transfer'` template with
 * `followsPayday: true` OR `followsCycleStart: true` — every other kind
 * ignores it entirely, so existing callers that don't have one to hand
 * (or are generating for a pot/joint account rather than the primary
 * person) can keep omitting it. See TransferLocation/RecurringTemplate.
 * followsPayday/followsCycleStart in types/ledger.ts for the full
 * reasoning. If a template somehow has both set, followsPayday wins —
 * the two are meant to be mutually exclusive (enforced by the UI), this
 * is just a defined tie-break rather than an unreachable branch.
 */
export function generateTransactionsForTemplate(
  template: RecurringTemplate,
  rangeStart: Date,
  rangeEnd: Date,
  payCycle?: PayCycleConfig,
): Omit<Transaction, 'id'>[] {
  const isTransactionKind = template.kind === 'transaction'
  const isTransferKind = template.kind === 'transfer'
  const isIncome = isTransactionKind && template.recurringTransactionType === 'income'
  const fromLoc = isTransferKind ? template.transferFrom : undefined
  const toLoc = isTransferKind ? template.transferTo : undefined

  return walkOccurrences(template, rangeStart, rangeEnd, payCycle).map((occ) => {
    return {
      date: occ.date,
      amount: occ.amount,
      direction: isTransferKind ? (fromLoc?.type === 'personal' ? 'out' : 'in') : isTransactionKind ? (isIncome ? 'in' : 'out') : 'out',
      categoryId: isTransferKind ? categoryForTransfer(fromLoc, toLoc) : template.categoryId,
      paymentMethod: template.paymentMethod,
      status: 'pending',
      type: isTransferKind ? 'transfer' : isTransactionKind ? template.recurringTransactionType! : 'bill_payment',
      location: template.location,
      ownerId: template.ownerId,
      payee: template.payee,
      payeeSharePercent: template.payeeSharePercent,
      // Pots backlog item (2026-09-03) — carried straight through only
      // when this template is actually pot-located (a pot-funded bill),
      // OR (2026-09-04) when this is a transfer with a pot on either
      // end — same convention as creditCardId/savingsPotId being set
      // only on the transaction types that need them.
      potId: isTransferKind ? (fromLoc?.type === 'pot' ? fromLoc.potId : toLoc?.type === 'pot' ? toLoc.potId : undefined) : template.location === 'pot' ? template.potId : undefined,
      savingsPotId: isTransferKind ? (fromLoc?.type === 'savings' ? fromLoc.savingsPotId : toLoc?.type === 'savings' ? toLoc.savingsPotId : undefined) : undefined,
      fromLocation: fromLoc,
      toLocation: toLoc,
      followsPayday: isTransferKind ? template.followsPayday : undefined,
      followsCycleStart: isTransferKind ? template.followsCycleStart : undefined,
      sourceType: 'recurring_template',
      sourceId: template.id,
      // 2026-09-16 — the occurrence's natural slot, carried through so a
      // materialized row stays identifiable after its date is moved (and
      // moved again). See Transaction.occurrenceOriginalDate's own
      // comment for the full reasoning. Note this is `occ.originalDate`,
      // NOT `occ.date` — the whole point is that it does not move.
      occurrenceOriginalDate: occ.originalDate,
      // The specific bill's/recurring transaction's/transfer's own name —
      // without this, a row falls back to its category's name for
      // display, which duplicates the category group header when viewed
      // grouped by category (e.g. a "TV" category group whose own rows
      // also just say "TV" instead of "TV License").
      note: template.name,
      personId: isIncome ? template.personId : undefined,
    }
  })
}


/**
 * Every upcoming occurrence for a 'transaction'-kind template, WITH its
 * original scheduled date alongside the possibly-overridden display
 * date/amount — Expenses.tsx's "next 12 upcoming" expand panel uses this
 * (rather than generateTransactionsForTemplate directly) because an
 * edit/delete on one of those rows has to key itself to the ORIGINAL
 * slot (occurrenceOverrides' own key), regardless of what date that
 * occurrence currently displays. 15 years covers even an annual
 * frequency's `count` occurrences comfortably.
 */
export function templateOccurrencePreviews(template: RecurringTemplate, asOfDate: Date, count: number, payCycle?: PayCycleConfig): RawOccurrence[] {
  return walkOccurrences(template, asOfDate, addYears(asOfDate, 15), payCycle).slice(0, count)
}

/**
 * Every calendar date the template's frequency would land on in
 * [rangeStart, rangeEnd] — deliberately IGNORING occurrenceOverrides
 * entirely, unlike walkOccurrences/generateTransactionsForTemplate. This
 * is what the pause picker itself needs to show as candidates: a
 * currently-paused date has to appear in the list so it can be unchecked,
 * which the normal (pause-aware) walk would never surface — a paused
 * date isn't a real occurrence any more, generator-side. Same shape and
 * purpose as savingsPotLedger.ts's scheduledDepositDates (Phase 4 —
 * generalizing the SavingsPot-only pause picker to Bills/Pensions too).
 *
 * `payCycle`, when supplied, resolves each natural date the same way
 * walkOccurrences does for a follows-payday/follows-cycle-start
 * TRANSFER template (UAT 2026-09-10) — this function has its own
 * independent anchor-stepping loop rather than calling walkOccurrences
 * (deliberately, to keep ignoring occurrenceOverrides per the comment
 * above), so it needs the same resolution applied explicitly here too,
 * or the pause picker's candidate dates would disagree with what
 * "Manage upcoming payments" actually shows/generates.
 *
 * UAT 2026-09-11 (manage-upcoming-payments-override-key-bug) — this used
 * to return only the resolved `string[]`, discarding the natural
 * anchor-walked date entirely. Every caller then wrongly used that
 * RESOLVED date as if it were the `originalDate` key that
 * occurrenceOverrides actually store and walkOccurrences actually looks
 * up by, so pausing/amount-editing a follows-payday transfer's next
 * occurrence via "Manage upcoming payments" silently failed to apply
 * (Adam's exact repro). Now returns the same `{ originalDate, date }`
 * pair shape as RawOccurrence — `originalDate` is the natural,
 * unresolved key for override matching, `date` is what should be
 * displayed/sorted by. Callers must key all identity/override
 * operations off `.originalDate` and only use `.date` for display.
 */
export function scheduledTemplateDates(
  template: RecurringTemplate,
  rangeStart: Date,
  rangeEnd: Date,
  payCycle?: PayCycleConfig,
): { originalDate: string; date: string }[] {
  if (rangeEnd < rangeStart) return []
  const anchor = parseLocalDate(template.anchorDate)
  const anchorDay = scheduleAnchorDay(template)
  // Same range rule as walkOccurrences (resolvedRangeLookback).
  const lookback = resolvedRangeLookback(template, rangeStart, payCycle)
  const rangeStartIso = toIso(rangeStart)
  const rangeEndIso = toIso(rangeEnd)
  let cursor = anchor
  let iterations = 0
  while (cursor < (lookback ?? rangeStart) && iterations < MAX_OCCURRENCES) {
    cursor = nextOccurrence(cursor, template, anchorDay)
    iterations++
  }
  const results: { originalDate: string; date: string }[] = []
  while (cursor <= rangeEnd && iterations < MAX_OCCURRENCES) {
    const originalDate = toIso(cursor)
    // 2026-09-16 (Adam-reported, single-occurrence date move) — the
    // occurrence's DISPLAY date honours a per-occurrence date override,
    // exactly as walkOccurrences already does. `originalDate` stays the
    // natural, unresolved key (see this function's own note above, and
    // PausedOccurrencesControl's header: identity keys off .originalDate,
    // only rendering/sorting uses .date).
    //
    // This does NOT undo the "deliberately IGNORING occurrenceOverrides"
    // contract above, which is specifically about `deleted` — a paused
    // date must still be listed so it can be unchecked, so the entry is
    // still emitted here either way. Only `date` reads the override.
    // Before this, "Manage upcoming payments" kept showing a moved
    // occurrence's OLD date on Bills and recurring Transfers (the two
    // call sites with onSaveDate wired that render from this function);
    // recurring Transactions were never affected because their
    // "Next 12 upcoming" panel renders from templateOccurrencePreviews,
    // which goes via walkOccurrences and was already override-aware.
    // Knock-on, now also fixed: PausedOccurrencesControl seeds its date
    // input and its confirm modal's "from" date from this value, so both
    // used to name the stale date.
    const override = template.occurrenceOverrides?.find((o) => o.originalDate === originalDate)
    const date = resolveTemplateOccurrenceDate(override?.date ?? originalDate, template, payCycle)
    if (!lookback || (date >= rangeStartIso && date <= rangeEndIso)) results.push({ originalDate, date })
    cursor = nextOccurrence(cursor, template, anchorDay)
    iterations++
  }
  return results
}

/**
 * Given the FULL set of dates the person now wants paused (from a
 * multi-select checklist drawn from scheduledTemplateDates), reconciles
 * occurrenceOverrides to match — a newly-checked date gets `deleted: true`
 * merged onto its existing override entry (if any), an unchecked one has
 * `deleted` cleared from its entry, anything already correct is left
 * alone. Overrides outside the shown window are untouched.
 *
 * UAT 2026-09-11 (bill-pause-after-amount-override) — this used to keep
 * any date/amount-carrying entry as a separate "untouched" record and
 * then unconditionally APPEND a brand-new `{originalDate, deleted: true}`
 * entry alongside it for any date being paused — so an occurrence that
 * already had a single-occurrence amount override ended up with TWO
 * entries sharing the same originalDate. `walkOccurrences`'s `.find()`
 * always matches the FIRST one (the untouched amount-only entry, since it
 * was spread before the new pause entry), so the `deleted: true` entry
 * was silently unreachable and pausing an already-amount-overridden
 * occurrence did nothing. Now MERGES `deleted` onto the SAME entry a
 * prior amount/date override lives on, instead of ever creating a second
 * entry for one date — same merge-in-place pattern
 * applyTemplateSingleOccurrenceAmountChange already uses for the amount
 * side.
 */
export function setPausedTemplateOccurrences(template: RecurringTemplate, windowDates: string[], pausedDates: string[]): Pick<RecurringTemplate, 'occurrenceOverrides'> {
  const windowSet = new Set(windowDates)
  const pausedSet = new Set(pausedDates)
  const outside = (template.occurrenceOverrides ?? []).filter((o) => !windowSet.has(o.originalDate))
  const priorByDate = new Map((template.occurrenceOverrides ?? []).filter((o) => windowSet.has(o.originalDate)).map((o) => [o.originalDate, o]))
  const merged: RecurringOccurrenceOverride[] = []
  for (const originalDate of windowSet) {
    const prior = priorByDate.get(originalDate)
    const isPaused = pausedSet.has(originalDate)
    if (!isPaused && prior?.date === undefined && prior?.amount === undefined) continue
    const entry: RecurringOccurrenceOverride = { originalDate }
    if (prior?.date !== undefined) entry.date = prior.date
    if (prior?.amount !== undefined) entry.amount = prior.amount
    if (isPaused) entry.deleted = true
    merged.push(entry)
  }
  return { occurrenceOverrides: [...outside, ...merged] }
}

/**
 * Builds the patch to apply when a bill's amount changes and the person
 * has picked which payment it should take effect from (Bills.tsx's
 * follow-up picker) — preserves the OLD amount as a history entry so
 * anything before `effectiveFrom` keeps resolving to it, exactly as
 * salaryLedger.ts's snapshot list does for a pay rise.
 *
 * UAT 2026-09-09 (retest2-bills-single-before-allfuture-untouched) — a
 * PERMANENT change now DROPS every existing candidate (every
 * amountHistory entry, and the current amount/amountEffectiveFrom pair)
 * whose OWN effectiveFrom is on/after the new `effectiveFrom`, instead of
 * just appending one more entry on top of whatever's already there.
 * Confirmed as a real, serious bug otherwise, via Adam's own repro: edit
 * a bill to £39 effective 1 Sept, then again to £40 effective 1 Nov, then
 * try to set it back to £37 effective 1 Sept (i.e. an effective date
 * EARLIER than a change that's already recorded further in the future).
 * The naive "always append" version kept the old {effectiveFrom: 1 Nov,
 * amount: £40} entry sitting in history — resolveTemplateAmount always
 * picks the single LATEST effectiveFrom <= the query date, so for any
 * date on/after 1 Nov, that stale, later-dated entry kept OUTRANKING the
 * new 1-Sept change and resurrected the £40 the person had just tried to
 * overwrite. The fix: an entry whose effectiveFrom >= the new
 * effectiveFrom was only ever relevant for dates >= its own
 * effectiveFrom — exactly the range the new change now fully owns — so
 * it can be dropped outright rather than kept around to wrongly compete.
 * Entries with effectiveFrom < the new effectiveFrom are genuinely
 * unaffected (dates before the new change still need them) and are kept
 * as-is. Same "supersede everything from this date forward" fix applied
 * to `occurrenceOverrides`' amount half, for the identical reason.
 */
export function applyTemplateAmountChange(
  template: RecurringTemplate,
  newAmount: number,
  effectiveFrom: string,
): Pick<RecurringTemplate, 'amount' | 'amountEffectiveFrom' | 'amountHistory' | 'occurrenceOverrides'> {
  const priorCandidates = [...(template.amountHistory ?? []), { effectiveFrom: template.amountEffectiveFrom ?? template.anchorDate, amount: template.amount }]
  const amountHistory = priorCandidates.filter((c) => c.effectiveFrom < effectiveFrom)
  const occurrenceOverrides = (template.occurrenceOverrides ?? [])
    .map((o) => (o.originalDate >= effectiveFrom && o.amount !== undefined ? { ...o, amount: undefined } : o))
    .filter((o) => o.date !== undefined || o.amount !== undefined || o.deleted !== undefined)
  return {
    amount: newAmount,
    amountEffectiveFrom: effectiveFrom,
    amountHistory,
    occurrenceOverrides,
  }
}

/**
 * Builds the patch for a SINGLE-occurrence ("just a single payment")
 * amount change — reuses the existing occurrenceOverrides mechanism
 * (already used for pausing/moving one occurrence) rather than inventing
 * a new field, since it already carries exactly this per-occurrence
 * "amount overridden, nothing else about this template touched" shape.
 * Merges onto any existing override for the same slot (e.g. one that was
 * previously moved to a different date) rather than clobbering it.
 */
export function applyTemplateSingleOccurrenceAmountChange(
  template: RecurringTemplate,
  newAmount: number,
  originalDate: string,
): Pick<RecurringTemplate, 'occurrenceOverrides'> {
  const existing = template.occurrenceOverrides ?? []
  const priorEntry = existing.find((o) => o.originalDate === originalDate)
  const withoutThis = existing.filter((o) => o.originalDate !== originalDate)
  return { occurrenceOverrides: [...withoutThis, { ...priorEntry, originalDate, amount: newAmount }] }
}

/**
 * Builds the patch for a SINGLE-occurrence date change — mirrors
 * `applyTemplateSingleOccurrenceAmountChange` exactly, same reasoning:
 * reuses `occurrenceOverrides`'s existing `date` field (already read
 * generically by `walkOccurrences`, see its own comment) rather than a
 * new mechanism. Merges onto any existing override for the same slot
 * (e.g. one that already has an amount override) instead of clobbering
 * it. `newDate` is the natural (pre-payday-resolution) date the caller
 * wants this occurrence to fall on instead — `walkOccurrences` still
 * runs it through the same payday/cycle-start resolution as every other
 * date, exactly like the natural, un-overridden date would be.
 */
export function applyTemplateSingleOccurrenceDateChange(
  template: RecurringTemplate,
  newDate: string,
  originalDate: string,
): Pick<RecurringTemplate, 'occurrenceOverrides'> {
  const existing = template.occurrenceOverrides ?? []
  const priorEntry = existing.find((o) => o.originalDate === originalDate)
  const withoutThis = existing.filter((o) => o.originalDate !== originalDate)
  return { occurrenceOverrides: [...withoutThis, { ...priorEntry, originalDate, date: newDate }] }
}

/**
 * The most recent past occurrence (if any) and the next 3 upcoming ones,
 * for Bills.tsx's "apply this change from which payment?" picker —
 * always computed from the template's CURRENT schedule shape (frequency/
 * anchor), independent of any amount history, since which DATES a bill
 * falls on doesn't change just because its amount did.
 */
export function recentAndUpcomingOccurrences(template: RecurringTemplate, asOfDate: Date, payCycle?: PayCycleConfig): { date: string; isPast: boolean }[] {
  // `payCycle` resolves a follows-payday/cycle-start transfer's dates to the
  // day it actually goes out, as the ledger shows it (2026-09-16).
  const past = generateTransactionsForTemplate(template, addYears(asOfDate, -1), asOfDate, payCycle)
  const upcoming = generateTransactionsForTemplate(template, asOfDate, addYears(asOfDate, 1), payCycle).filter((t) => t.date !== past.at(-1)?.date)

  const result: { date: string; isPast: boolean }[] = []
  if (past.length > 0) result.push({ date: past[past.length - 1].date, isPast: true })
  for (const t of upcoming.slice(0, 3)) result.push({ date: t.date, isPast: false })
  return result
}

/** Convenience constructor for a new template with sensible defaults for fields the create form doesn't ask about directly. */
export function newRecurringTemplate(
  input: Omit<RecurringTemplate, 'id' | 'active'>,
): RecurringTemplate {
  return { id: nanoid(8), active: true, ...input }
}

// ── Schedule change from a chosen payment (2026-09-16, Adam-reported) ──
// Changing a recurring template's due date or frequency "for every payment
// from then on" used to just overwrite `anchorDate`/`frequency`. The chosen
// payment was ignored. Every occurrence is identified by its SLOT, the
// anchor-walked date (APP-KNOWLEDGE §1.5a), so moving the anchor gave every
// already-materialised row a slot the new schedule no longer produces, and
// the generator materialised the whole history again on the new day:
// mum's "Agria Pet Insurance - Pippa" 15th -> 16th left a cleared 15 Sep
// AND a cleared 16 Sep. Same for 21 of her 29 bills, and for recurring
// transactions/transfers, whose edit forms saved the change immediately.
//
// Now, from the chosen payment E:
//  - payments before E keep their date and are never regenerated: the new
//    anchor is the new-schedule slot nearest E, strictly after the last old
//    slot before E, and nothing generates before an anchor;
//  - every stored row and occurrenceOverride from E onwards is re-slotted
//    k-th old slot -> k-th new slot, so the payment on E becomes the first
//    payment on the new schedule rather than a second one. That includes a
//    cleared row: the user chose that payment. A row moved into the future
//    goes back to pending (§1.5b).

export interface TemplateSchedule {
  frequency: RecurrenceFrequency
  intervalWeeks?: number
  anchorDate: string
  anchorDayOfMonth?: number
  /** Transfers only: resolving each date to payday / budgeting-cycle start also moves when payments land. Omitted = unchanged. */
  followsPayday?: boolean
  followsCycleStart?: boolean
}

/** "Monthly from 16 September 2026" — for the schedule row of a change confirmation. */
export function describeSchedule(schedule: TemplateSchedule): string {
  const labels: Record<RecurrenceFrequency, string> = { weekly: 'Weekly', every_n_weeks: 'Every N weeks', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual' }
  const frequency = schedule.frequency === 'every_n_weeks' ? `Every ${schedule.intervalWeeks ?? 1} weeks` : labels[schedule.frequency]
  return `${frequency} from ${formatFullDate(schedule.anchorDate)}`
}

/** Whether two schedules differ in anything that moves a slot. */
export function scheduleDiffers(a: TemplateSchedule, b: TemplateSchedule): { date: boolean; frequency: boolean } {
  return {
    date: a.anchorDate !== b.anchorDate,
    frequency: a.frequency !== b.frequency || (b.frequency === 'every_n_weeks' && (a.intervalWeeks ?? 1) !== (b.intervalWeeks ?? 1)),
  }
}

/** Raw anchor-walked slots (overrides ignored) on/after `fromIso`, up to `untilIso` or `count`. */
function rawSlots(schedule: TemplateSchedule, fromIso: string, limit: { untilIso?: string; count?: number }): string[] {
  const anchor = parseLocalDate(schedule.anchorDate)
  const anchorDay = scheduleAnchorDay(schedule)
  const out: string[] = []
  let cursor = anchor
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const iso = toIso(cursor)
    if (limit.untilIso !== undefined && iso > limit.untilIso) break
    if (limit.count !== undefined && out.length >= limit.count) break
    if (iso >= fromIso) out.push(iso)
    cursor = nextOccurrence(cursor, schedule, anchorDay)
  }
  return out
}

function lastSlotBefore(schedule: TemplateSchedule, beforeIso: string): string | null {
  const anchor = parseLocalDate(schedule.anchorDate)
  const anchorDay = scheduleAnchorDay(schedule)
  let cursor = anchor
  let last: string | null = null
  for (let i = 0; i < MAX_OCCURRENCES && toIso(cursor) < beforeIso; i++) {
    last = toIso(cursor)
    cursor = nextOccurrence(cursor, schedule, anchorDay)
  }
  return last
}

/**
 * The slot on `next`'s schedule nearest to `targetIso`, strictly after
 * `afterIso` (ties → the later one). A day the month can't hold falls on
 * that month's last day; the caller keeps the intended day in
 * anchorDayOfMonth so later months aren't stuck on it.
 */
function nearestSlot(next: TemplateSchedule, targetIso: string, afterIso: string | null): string {
  const target = parseLocalDate(targetIso)
  const anchor = parseLocalDate(next.anchorDate)
  const day = scheduleAnchorDay(next)
  const candidates: Date[] = []
  const monthStart = (k: number) => addMonths(new Date(target.getFullYear(), target.getMonth(), 1), k)
  switch (next.frequency) {
    case 'monthly':
      for (let k = -2; k <= 2; k++) candidates.push(clampToAnchorDay(monthStart(k), day))
      break
    case 'quarterly':
      for (let k = -5; k <= 5; k++) {
        const m = monthStart(k)
        if ((((m.getMonth() - anchor.getMonth()) % 3) + 3) % 3 === 0) candidates.push(clampToAnchorDay(m, day))
      }
      break
    case 'annual':
      for (let k = -1; k <= 2; k++) candidates.push(clampToAnchorDay(new Date(target.getFullYear() + k, anchor.getMonth(), 1), day))
      break
    default: {
      const period = 7 * (next.frequency === 'every_n_weeks' ? Math.max(1, next.intervalWeeks ?? 1) : 1)
      const offset = ((differenceInCalendarDays(target, anchor) % period) + period) % period
      const base = addDays(target, -offset)
      for (let k = -1; k <= 2; k++) candidates.push(addDays(base, k * period))
    }
  }
  const eligible = candidates.map(toIso).filter((iso) => afterIso === null || iso > afterIso)
  eligible.sort((a, b) => {
    const da = Math.abs(differenceInCalendarDays(parseLocalDate(a), target))
    const db = Math.abs(differenceInCalendarDays(parseLocalDate(b), target))
    return da !== db ? da - db : b.localeCompare(a)
  })
  return eligible[0] ?? targetIso
}

/**
 * The slot (occurrenceOverrides key) of the occurrence DISPLAYED on
 * `displayDate`. The "which payment" picker (recentAndUpcomingOccurrences)
 * shows display dates, which differ from the slot once a payment has been
 * moved; keying a single-payment edit on the display date silently wrote
 * an override for a slot that doesn't exist.
 */
export function occurrenceSlotForDate(template: RecurringTemplate, displayDate: string, payCycle?: PayCycleConfig): string {
  const around = scheduledTemplateDates(template, addYears(parseLocalDate(displayDate), -1), addYears(parseLocalDate(displayDate), 1), payCycle)
  return around.find((o) => o.date === displayDate)?.originalDate ?? displayDate
}

/**
 * Applies a due-date and/or frequency change to `template` from the payment
 * the user picked (`effectiveFromDate`, as shown by
 * recentAndUpcomingOccurrences). Returns the template patch and the
 * rewritten transaction list. See the section comment above.
 */
export function applyTemplateScheduleChange(
  template: RecurringTemplate,
  transactions: Transaction[],
  next: TemplateSchedule,
  effectiveFromDate: string,
  asOfIso: string,
  /** Needed only for a follows-payday/cycle-start transfer, whose picker shows payday-resolved dates. */
  payCycle?: PayCycleConfig,
): {
  patch: Pick<RecurringTemplate, 'frequency' | 'intervalWeeks' | 'anchorDate' | 'anchorDayOfMonth' | 'occurrenceOverrides' | 'amountEffectiveFrom' | 'amountHistory' | 'followsPayday' | 'followsCycleStart'>
  transactions: Transaction[]
} {
  const pickedSlot = occurrenceSlotForDate(template, effectiveFromDate, payCycle)
  // Snap onto the old schedule, so a date that isn't a slot (e.g. before
  // the anchor) can't place the new anchor ahead of the real first slot.
  const fromSlot = rawSlots(template, pickedSlot, { count: 1 })[0] ?? pickedSlot

  // If the date field was edited, it sets the new schedule's day (and, for
  // weekly/quarterly/annual, its weekday or month). If only the frequency
  // changed, the chosen payment is the first payment of the new frequency.
  // The intended day of month stays the template's own when it already was
  // month-based, since that may be a 31st stored on a shorter month.
  const isMonthBased = (f: RecurrenceFrequency) => f === 'monthly' || f === 'quarterly' || f === 'annual'
  const monthBased = isMonthBased(next.frequency)
  const anchorEdited = next.anchorDate !== template.anchorDate
  const intendedDay = anchorEdited
    ? parseLocalDate(next.anchorDate).getDate()
    : isMonthBased(template.frequency)
      ? scheduleAnchorDay(template)
      : parseLocalDate(fromSlot).getDate()
  const phaseAnchor = anchorEdited ? next.anchorDate : fromSlot
  const newAnchor = nearestSlot({ ...next, anchorDate: phaseAnchor, anchorDayOfMonth: intendedDay }, fromSlot, lastSlotBefore(template, fromSlot))
  const anchorDayOfMonth = monthBased && parseLocalDate(newAnchor).getDate() !== intendedDay ? intendedDay : undefined
  const nextSchedule: TemplateSchedule = { frequency: next.frequency, intervalWeeks: next.intervalWeeks, anchorDate: newAnchor, anchorDayOfMonth }

  const isOwnRow = (t: Transaction) => t.sourceType === 'recurring_template' && t.sourceId === template.id
  const slotOf = (t: Transaction) => t.occurrenceOriginalDate ?? t.date
  const keys = [
    ...transactions.filter(isOwnRow).map(slotOf),
    ...(template.occurrenceOverrides ?? []).map((o) => o.originalDate),
    ...(template.amountEffectiveFrom ? [template.amountEffectiveFrom] : []),
    ...(template.amountHistory ?? []).map((h) => h.effectiveFrom),
  ].filter((k) => k >= fromSlot)
  const lastKey = keys.reduce((max, k) => (k > max ? k : max), fromSlot)

  const oldSlots = rawSlots(template, fromSlot, { untilIso: lastKey })
  const newSlots = rawSlots(nextSchedule, newAnchor, { count: oldSlots.length })
  const slotMap = new Map(oldSlots.map((old, i) => [old, newSlots[i]] as const).filter(([, n]) => n !== undefined))

  // An override whose `date` equals its own slot (a single-payment amount
  // edit records one) is not a move, so it follows the slot; a genuine
  // move keeps the date the user chose.
  const overrides = template.occurrenceOverrides?.map((o) => {
    const newSlot = slotMap.get(o.originalDate)
    if (!newSlot) return o
    return { ...o, originalDate: newSlot, ...(o.date !== undefined ? { date: o.date === o.originalDate ? newSlot : o.date } : {}) }
  })

  // An amount change dated on/after the chosen payment is "from the k-th
  // payment", so it moves with that payment's slot. Without this, changing
  // the amount and moving the date EARLIER in one save left the moved
  // payment before the new amount's effectiveFrom, on the old amount.
  const remapBoundary = (iso: string | undefined): string | undefined => {
    if (iso === undefined || iso < fromSlot) return iso
    const firstSlotOnOrAfter = oldSlots.find((slot) => slot >= iso)
    return (firstSlotOnOrAfter && slotMap.get(firstSlotOnOrAfter)) ?? iso
  }

  const rewritten = transactions.map((t) => {
    if (!isOwnRow(t)) return t
    const newSlot = slotMap.get(slotOf(t))
    if (!newSlot) return t
    const date = overrides?.find((o) => o.originalDate === newSlot)?.date ?? newSlot
    const status: Transaction['status'] = t.status === 'cleared' && date > asOfIso ? 'pending' : t.status
    return { ...t, occurrenceOriginalDate: newSlot, date, status }
  })

  return {
    patch: {
      frequency: next.frequency,
      intervalWeeks: next.frequency === 'every_n_weeks' ? next.intervalWeeks : template.intervalWeeks,
      anchorDate: newAnchor,
      anchorDayOfMonth,
      ...(next.followsPayday !== undefined ? { followsPayday: next.followsPayday } : {}),
      ...(next.followsCycleStart !== undefined ? { followsCycleStart: next.followsCycleStart } : {}),
      occurrenceOverrides: overrides,
      amountEffectiveFrom: remapBoundary(template.amountEffectiveFrom),
      amountHistory: template.amountHistory?.map((h) => ({ ...h, effectiveFrom: remapBoundary(h.effectiveFrom)! })),
    },
    transactions: rewritten,
  }
}
